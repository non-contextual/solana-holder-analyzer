// Multi-layer BFS transfer investigation
//
// Layer 0: seed wallets (from token analysis)
// Layer 1: counterparties discovered in Layer 0's transfers
// Layer 2: counterparties discovered in Layer 1's NEW transfers
// ...
//
// At each layer, expand only the top maxNewPerLayer addresses by transfer volume
// to prevent graph explosion. Programs/DEX routers are excluded from expansion.

import { fetchWalletTransfers, isProgram, symbolFor, RawTransfer } from './helius'

export interface TransferScanOptions {
  wallets:         string[]   // seed wallets
  fromTime:        number     // unix seconds
  toTime:          number     // unix seconds
  maxDepth:        number     // 1, 2, or 3
  maxNewPerLayer:  number     // max new wallets to expand per layer (default 15)
  apiKey:          string
}

export interface GraphNode {
  address: string
  label:   string   // short display name or known program name
  layer:   number   // 0 = seed, 1, 2, ...
  isSeed:  boolean
}

export interface GraphEdge {
  from:      string
  to:        string
  mint:      string
  symbol:    string
  amount:    number   // net flow: positive = from→to
  txCount:   number
}

export interface TransferGraph {
  nodes:     GraphNode[]
  edges:     GraphEdge[]           // aggregated net flows between nodes
  transfers: RawTransfer[]         // all raw transfers (for time-range slider)
  timeRange: { min: number; max: number }
}

// SSE events
export type ScanEvent =
  | { type: 'scan_layer';    layer: number; count: number; total: number }
  | { type: 'scan_wallet';   address: string; layer: number; done: number; total: number }
  | { type: 'scan_expand';   layer: number; newCount: number; discovered: number }
  | { type: 'scan_graph';    graph: TransferGraph }
  | { type: 'scan_error';    message: string }

function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

// Aggregate volume per counterparty for a given wallet's transfers
function counterpartyVolumes(
  walletAddr: string,
  transfers: RawTransfer[],
): Map<string, number> {
  const vols = new Map<string, number>()
  for (const t of transfers) {
    const other = t.from === walletAddr ? t.to : t.from
    if (!other || other === walletAddr) continue
    // Weight stablecoins and SOL by amount (treat as ~$1/unit for simplicity)
    vols.set(other, (vols.get(other) ?? 0) + t.amount)
  }
  return vols
}

// Build deduplicated edge map: (from,to,mint) → {amount, txCount}
function buildEdges(
  allTransfers: RawTransfer[],
  nodeSet: Set<string>,
): GraphEdge[] {
  // key: `from|to|mint` normalized (smaller addr first for dedup)
  const edgeMap = new Map<string, { a: string; b: string; mint: string; symbol: string; flow: number; txCount: number }>()

  for (const t of allTransfers) {
    // Only include edges where at least one endpoint is a tracked node
    if (!nodeSet.has(t.from) && !nodeSet.has(t.to)) continue

    const [a, b, sign] = t.from < t.to
      ? [t.from, t.to, 1]
      : [t.to, t.from, -1]

    const key = `${a}|${b}|${t.mint}`
    const existing = edgeMap.get(key)
    if (existing) {
      existing.flow     += t.amount * sign
      existing.txCount  += 1
    } else {
      edgeMap.set(key, { a, b, mint: t.mint, symbol: t.symbol, flow: t.amount * sign, txCount: 1 })
    }
  }

  return [...edgeMap.values()].map(e => ({
    from:    e.flow >= 0 ? e.a : e.b,
    to:      e.flow >= 0 ? e.b : e.a,
    mint:    e.mint,
    symbol:  e.symbol,
    amount:  Math.abs(e.flow),
    txCount: e.txCount,
  }))
}

const SCAN_CONCURRENCY = 3

async function pMap<T>(arr: T[], fn: (item: T, idx: number) => Promise<void>, concurrency: number) {
  let next = 0
  async function worker() { while (next < arr.length) { const i = next++; await fn(arr[i], i) } }
  await Promise.all(Array.from({ length: Math.min(concurrency, arr.length) }, worker))
}

export async function runTransferScan(
  opts:    TransferScanOptions,
  onEvent: (e: ScanEvent) => void,
): Promise<void> {
  const { wallets, fromTime, toTime, maxDepth, maxNewPerLayer, apiKey } = opts

  const visited    = new Set<string>()   // addresses already scanned
  const allTransfers: RawTransfer[] = []
  const nodeMap    = new Map<string, GraphNode>()

  // Seed nodes (layer 0)
  for (const addr of wallets) {
    visited.add(addr)
    nodeMap.set(addr, { address: addr, label: shortAddr(addr), layer: 0, isSeed: true })
  }

  let frontier = [...wallets]

  for (let layer = 0; layer <= maxDepth && frontier.length > 0; layer++) {
    onEvent({ type: 'scan_layer', layer, count: 0, total: frontier.length })

    const layerTransfers: RawTransfer[] = []
    let done = 0

    // Scan each wallet in this layer's frontier
    await pMap(frontier, async (addr, _) => {
      onEvent({ type: 'scan_wallet', address: addr, layer, done, total: frontier.length })
      try {
        const txs = await fetchWalletTransfers(addr, fromTime, toTime, apiKey)
        layerTransfers.push(...txs)
        allTransfers.push(...txs)
      } catch (err) {
        // Non-fatal: log and continue
        console.warn(`[scan] ${addr} failed:`, (err as Error).message)
      }
      done++
      onEvent({ type: 'scan_wallet', address: addr, layer, done, total: frontier.length })
    }, SCAN_CONCURRENCY)

    // Discover new addresses from this layer's transfers
    if (layer < maxDepth) {
      // Aggregate volume per counterparty across all scanned wallets in this layer
      const volMap = new Map<string, number>()
      for (const addr of frontier) {
        const vols = counterpartyVolumes(addr, layerTransfers)
        for (const [other, vol] of vols) {
          if (visited.has(other)) continue
          if (isProgram(other)) continue
          volMap.set(other, (volMap.get(other) ?? 0) + vol)
        }
      }

      // Pick top maxNewPerLayer by volume
      const newFrontier = [...volMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxNewPerLayer)
        .map(([addr]) => addr)

      onEvent({ type: 'scan_expand', layer, newCount: newFrontier.length, discovered: volMap.size })

      for (const addr of newFrontier) {
        visited.add(addr)
        nodeMap.set(addr, { address: addr, label: shortAddr(addr), layer: layer + 1, isSeed: false })
      }
      frontier = newFrontier
    } else {
      frontier = []
    }
  }

  // Also add external nodes (not scanned but appear as endpoints in transfers)
  const nodeSet = new Set(nodeMap.keys())
  for (const t of allTransfers) {
    for (const addr of [t.from, t.to]) {
      if (!nodeMap.has(addr)) {
        nodeMap.set(addr, { address: addr, label: shortAddr(addr), layer: maxDepth + 1, isSeed: false })
        nodeSet.add(addr)
      }
    }
  }

  const edges = buildEdges(allTransfers, nodeSet)

  const timestamps = allTransfers.map(t => t.timestamp)
  const graph: TransferGraph = {
    nodes: [...nodeMap.values()],
    edges,
    transfers: allTransfers,
    timeRange: {
      min: timestamps.length ? Math.min(...timestamps) : fromTime,
      max: timestamps.length ? Math.max(...timestamps) : toTime,
    },
  }

  onEvent({ type: 'scan_graph', graph })
}
