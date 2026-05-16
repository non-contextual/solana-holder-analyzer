// Multi-layer BFS transfer investigation
//
// Layer 0: seed wallets (from token analysis)
// Layer 1: counterparties discovered in Layer 0's transfers
// ...
//
// Design goals:
// - Progressive: emits scan_partial after each layer for live rendering
// - Cheap: per-layer page limits reduce Helius API calls drastically
// - Signal: USD-normalized scoring + target-token ×1000 bias for BFS
// - Clean: dynamic program detection + real price lookup drops spam
// - Priced: DexScreener batch lookup after BFS gives real USD values
//   and kills ghost nodes from no-liquidity spam token senders

import { fetchWalletTransfers, isProgram, tokenUsdScore, PAGE_SIZE, RawTransfer } from './helius'
import { getAccountTypes } from './solana'
import { getWalletBalances } from './okx'
import { getTokenPrices, realUsdScore, TokenPriceInfo } from './prices'
import { analyzeAllWallets, KNOWN_ENTITIES, WalletIntelligence } from './labels'

// Terminal entity types — we surface them as nodes (so the user sees "this
// money went to Binance") but never fan out from them. Otherwise BFS pulls
// in tens of thousands of unrelated CEX customers.
const TERMINAL_ENTITY_TYPES: ReadonlySet<string> = new Set(['cex', 'bridge', 'mixer', 'sanctioned'])

// Behavior tags that, by themselves, justify keeping a node visible even if
// the address has no priced path back to the seed. Anything outside this set
// is treated as ambient noise and pruned post-BFS.
// 'closed' is intentionally NOT here — most closed accounts in a typical scan
// are tiny dust receivers that happened to be drained; surfacing all 800+ of
// them would re-flood the graph. We still tag closed accounts that survive
// for other reasons (layer 1-3 OR USD floor) so the user can see the marker
// where it carries real meaning (e.g. a layer-1 treasury that was drained).
const FEATURE_BEHAVIOR_TAGS: ReadonlySet<string> = new Set([
  'cex-like', 'mixer-like', 'bot-like', 'scatter', 'high-fan-in', 'high-fan-out',
])

// USD floors for "this address has a meaningful relationship with the seed".
// Layer 2-3 are BFS-promoted (already filtered by counterparty scoring) so
// they get a loose budget. Layer 99 (ghost ring) is much larger and most
// entries are dust pendants — 1 priced edge of $5-$25 that adds zero
// investigative value. So layer 99 splits the rule by edge count:
//   - 2+ priced edges → real bridge in the seed's neighborhood (low floor)
//   - 1 priced edge   → must be a single large transfer to count (high floor)
// Feature-flagged nodes (static label or strong behavior tag) bypass these
// floors and survive on label alone.
const SEED_PATH_USD_FLOOR_INTERNAL  = 1.0    // layer 2-3 (BFS-promoted)
const SEED_PATH_USD_FLOOR_GHOST_MUL = 10.0   // layer 99 with ≥2 priced edges
const SEED_PATH_USD_FLOOR_GHOST_ONE = 100.0  // layer 99 with exactly 1 priced edge
const GHOST_NODE_USD_FLOOR          = 5.0    // ghost entry gate (was 1.0 in v1)

export interface TransferScanOptions {
  wallets:        string[]
  fromTime:       number
  toTime:         number
  maxDepth:       number
  maxNewPerLayer: number
  apiKey:         string
  targetMint?:    string
  rpcUrl?:        string
  abortSig?:      AbortSignal
}

export interface GraphNode {
  address: string
  label:   string
  layer:   number
  isSeed:  boolean
}

export interface GraphEdge {
  from:     string
  to:       string
  mint:     string
  symbol:   string
  amount:   number    // net flow in token units
  usdScore: number    // real USD value (using DexScreener prices where known)
  txCount:  number
}

export interface WalletOkxData {
  address:        string
  portfolioUsd:   number
  splUsd:         number
  targetTokenUsd: number | null
  targetTokenPct: number | null
}

// Per-node summary of how it relates to ANY seed in the scan. This is what
// an analyst wants front-and-center — "I clicked this address because I want
// to know its relationship with the target wallet, not its global footprint".
// All USD values are real (using DexScreener prices when available); flows
// from non-priced transfers are excluded.
export interface SeedRelation {
  directInUsd:     number   // USD this address received DIRECTLY from a seed
  directOutUsd:    number   // USD this address sent DIRECTLY to a seed
  directTxCount:   number   // number of direct transfers (priced or not)
  indirectInUsd:   number   // USD via 1-hop intermediaries → from seed (bottleneck-min)
  indirectOutUsd:  number   // USD via 1-hop intermediaries → to seed (bottleneck-min)
  firstTs:         number | null   // earliest direct-or-1-hop interaction with seed network
  lastTs:          number | null
  hopDistance:     number   // shortest priced-edge distance to any seed (0=is seed, 1=direct…)
}

export interface TransferGraph {
  nodes:        GraphNode[]
  edges:        GraphEdge[]
  transfers:    RawTransfer[]
  timeRange:    { min: number; max: number }
  targetMint:   string | undefined
  seedRelation?: Record<string, SeedRelation>   // address → relationship summary
}

// Sentinel layer for ghost/external nodes (discovered after BFS via priced edges).
// The UI checks `n.layer >= 99` to apply external styling (smaller radius, dimmer
// opacity, "External" label, outer-ring layout) and to honor the Ext: on/off toggle.
// Keep this in sync with the same constant on the client side.
export const EXTERNAL_LAYER = 99

// SSE events
export type ScanEvent =
  | { type: 'scan_layer';   layer: number; count: number; total: number }
  | { type: 'scan_wallet';  address: string; layer: number; done: number; total: number }
  | { type: 'scan_expand';  layer: number; newCount: number; discovered: number }
  | { type: 'scan_partial'; layer: number; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'scan_prices';  prices: Record<string, { price: number; liquidity: number; symbol: string }> }
  | { type: 'scan_graph';   graph: TransferGraph }
  | { type: 'wallet_okx';   data: WalletOkxData }
  | { type: 'scan_suspects'; suspects: Array<{ address: string; score: number; reason: string }> }
  | { type: 'wallet_intel'; intel: Record<string, WalletIntelligence> }   // entity labels + behavior tags
  | { type: 'scan_hot';     address: string; layer: number; counterparties: number; txCount: number; cappedPages: boolean }
  | { type: 'scan_error';   message: string }

const LAYER_MAX_PAGES = [10, 3, 2, 1]

// "High-fan-out wallet" detector. Threshold of unique counterparties seen for
// a single scanned wallet in its layer's transfers. CEX hot wallets, market-
// maker bots, aggregator routers, and airdrop dispensers all blow through this
// while real users / whales / traders virtually never do (a human with 200+
// distinct counterparties in a multi-day window is doing automated work). When
// a frontier wallet crosses this line, we keep it in the graph but refuse to
// use its counterparty list to spawn the next BFS layer — that branch is pure
// API spend with no signal.
const HOT_UNIQUE_CP_THRESHOLD = 200

function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

// BFS counterparty scoring: USD-normalized + target-token ×1000 bias.
// Uses the heuristic tokenUsdScore during scanning (price data not yet available),
// then the graph is rebuilt with real prices after the DexScreener lookup.
function counterpartyScores(
  walletAddr: string,
  transfers:  RawTransfer[],
  targetMint: string | undefined,
): Map<string, number> {
  const scores = new Map<string, number>()
  for (const t of transfers) {
    const other = t.from === walletAddr ? t.to : t.from
    if (!other || other === walletAddr) continue
    let score = tokenUsdScore(t.mint, t.amount)
    if (targetMint && t.mint === targetMint) score = Math.max(score, 1) * 1000
    scores.set(other, (scores.get(other) ?? 0) + score)
  }
  return scores
}

// Build edges with real USD scores from DexScreener prices.
function buildEdges(
  allTransfers: RawTransfer[],
  nodeSet:      Set<string>,
  prices:       Map<string, TokenPriceInfo>,
  targetMint:   string | undefined,
): GraphEdge[] {
  const edgeMap = new Map<string, {
    a: string; b: string; mint: string; symbol: string
    flow: number; usdFlow: number; txCount: number
  }>()

  for (const t of allTransfers) {
    if (!nodeSet.has(t.from) && !nodeSet.has(t.to)) continue
    const [a, b, sign] = t.from < t.to ? [t.from, t.to, 1] : [t.to, t.from, -1]
    const key = `${a}|${b}|${t.mint}`
    const usd = realUsdScore(t.mint, t.amount, prices, targetMint)
    const ex  = edgeMap.get(key)
    if (ex) { ex.flow += t.amount * sign; ex.usdFlow += usd; ex.txCount++ }
    else edgeMap.set(key, { a, b, mint: t.mint, symbol: t.symbol, flow: t.amount * sign, usdFlow: usd, txCount: 1 })
  }

  return [...edgeMap.values()].map(e => ({
    from:     e.flow >= 0 ? e.a : e.b,
    to:       e.flow >= 0 ? e.b : e.a,
    mint:     e.mint,
    symbol:   e.symbol,
    amount:   Math.abs(e.flow),
    usdScore: e.usdFlow,
    txCount:  e.txCount,
  }))
}

// Partial graph during scan uses heuristic scores (price data not yet available)
function buildEdgesHeuristic(
  allTransfers: RawTransfer[],
  nodeSet:      Set<string>,
  targetMint:   string | undefined,
): GraphEdge[] {
  const edgeMap = new Map<string, {
    a: string; b: string; mint: string; symbol: string
    flow: number; usdFlow: number; txCount: number
  }>()
  for (const t of allTransfers) {
    if (!nodeSet.has(t.from) && !nodeSet.has(t.to)) continue
    const [a, b, sign] = t.from < t.to ? [t.from, t.to, 1] : [t.to, t.from, -1]
    const key = `${a}|${b}|${t.mint}`
    const usd = tokenUsdScore(t.mint, t.amount) || (targetMint && t.mint === targetMint ? t.amount : 0)
    const ex  = edgeMap.get(key)
    if (ex) { ex.flow += t.amount * sign; ex.usdFlow += usd; ex.txCount++ }
    else edgeMap.set(key, { a, b, mint: t.mint, symbol: t.symbol, flow: t.amount * sign, usdFlow: usd, txCount: 1 })
  }
  return [...edgeMap.values()].map(e => ({
    from: e.flow >= 0 ? e.a : e.b, to: e.flow >= 0 ? e.b : e.a,
    mint: e.mint, symbol: e.symbol, amount: Math.abs(e.flow), usdScore: e.usdFlow, txCount: e.txCount,
  }))
}

// Cheap 2-hop seed-reachability check on the priced-edge graph. For the post-
// BFS noise prune we want to know "does this node have at least $X of priced
// flow that touches a seed within 2 hops?" Full graph BFS over hundreds of
// nodes per address would be wasteful — and 2 hops is the relevant horizon
// because the BFS frontier is bounded by maxDepth anyway. The returned map
// is keyed by address; the value is the sum of priced USD on edges that lie
// on a length-1 (direct) or length-2 (via one intermediary) path to any seed.
function computeSeedConnectedUsd(edges: GraphEdge[], seeds: Set<string>): Map<string, number> {
  const incidentUsd = new Map<string, Map<string, number>>()  // addr → neighbor → usd
  for (const e of edges) {
    if (!e.usdScore || e.usdScore <= 0) continue
    if (!incidentUsd.has(e.from)) incidentUsd.set(e.from, new Map())
    if (!incidentUsd.has(e.to))   incidentUsd.set(e.to,   new Map())
    incidentUsd.get(e.from)!.set(e.to,   (incidentUsd.get(e.from)!.get(e.to)   ?? 0) + e.usdScore)
    incidentUsd.get(e.to)!.set(e.from,   (incidentUsd.get(e.to)!.get(e.from)   ?? 0) + e.usdScore)
  }

  const result = new Map<string, number>()
  for (const [addr, neighbors] of incidentUsd) {
    if (seeds.has(addr)) continue
    let usd = 0
    for (const [nb, edgeUsd] of neighbors) {
      if (seeds.has(nb)) {
        usd += edgeUsd                                          // direct seed edge
      } else {
        // Indirect: take the minimum of (this addr ↔ nb) and (nb ↔ any seed),
        // since flow can't exceed the bottleneck. Sum across all paths.
        const nbN = incidentUsd.get(nb)
        if (!nbN) continue
        let nbToSeed = 0
        for (const [nb2, e2] of nbN) if (seeds.has(nb2)) nbToSeed += e2
        if (nbToSeed > 0) usd += Math.min(edgeUsd, nbToSeed)
      }
    }
    result.set(addr, usd)
  }
  return result
}

// Compute the "this address's relationship with the seed" summary for every
// surviving address. Three buckets of activity matter here:
//   1. Direct edges with the seed itself — strongest signal
//   2. 1-hop indirect (this addr ↔ X ↔ seed) — relevant for mid-graph nodes
//   3. Shortest hop distance to any seed — gives a "how far away" reading
// We only count priced transfers for USD figures so spam dust doesn't inflate
// the relationship. The hop distance falls back to BFS over priced edges so
// it works for layer-99 ghost nodes too (their layer numbers are arbitrary).
function computeSeedRelations(
  addrs:      Set<string>,
  seeds:      Set<string>,
  transfers:  RawTransfer[],
  edges:      GraphEdge[],
  prices:     Map<string, TokenPriceInfo>,
  targetMint: string | undefined,
): Record<string, SeedRelation> {
  // Build neighbor map from priced edges only — for hop distance + 1-hop sums.
  const nbrUsd = new Map<string, Map<string, number>>()
  for (const e of edges) {
    if (!e.usdScore || e.usdScore <= 0) continue
    if (!nbrUsd.has(e.from)) nbrUsd.set(e.from, new Map())
    if (!nbrUsd.has(e.to))   nbrUsd.set(e.to,   new Map())
    nbrUsd.get(e.from)!.set(e.to,   (nbrUsd.get(e.from)!.get(e.to)   ?? 0) + e.usdScore)
    nbrUsd.get(e.to)!.set(e.from,   (nbrUsd.get(e.to)!.get(e.from)   ?? 0) + e.usdScore)
  }

  // BFS once from the seed set to derive hop distance for every reachable addr.
  const hop = new Map<string, number>()
  const queue: string[] = []
  for (const s of seeds) { hop.set(s, 0); queue.push(s) }
  while (queue.length) {
    const cur = queue.shift()!
    const d = hop.get(cur)!
    const ns = nbrUsd.get(cur)
    if (!ns) continue
    for (const nb of ns.keys()) {
      if (hop.has(nb)) continue
      hop.set(nb, d + 1)
      queue.push(nb)
    }
  }

  // Aggregate per-address direct + indirect USD flows + interaction timestamps.
  const result: Record<string, SeedRelation> = {}
  for (const addr of addrs) {
    if (seeds.has(addr)) {
      result[addr] = { directInUsd: 0, directOutUsd: 0, directTxCount: 0, indirectInUsd: 0, indirectOutUsd: 0, firstTs: null, lastTs: null, hopDistance: 0 }
      continue
    }
    let directIn = 0, directOut = 0, directTx = 0
    let firstTs: number | null = null, lastTs: number | null = null

    for (const t of transfers) {
      const involvesMe   = (t.from === addr) || (t.to === addr)
      const otherIsSeed  = involvesMe && (seeds.has(t.from) || seeds.has(t.to))
      if (!otherIsSeed) continue
      const usd = realUsdScore(t.mint, t.amount, prices, targetMint) || 0
      if (t.to === addr) directIn  += usd
      else               directOut += usd
      directTx++
      if (firstTs === null || t.timestamp < firstTs) firstTs = t.timestamp
      if (lastTs  === null || t.timestamp > lastTs)  lastTs  = t.timestamp
    }

    // Indirect (1-hop via an intermediary): for every neighbor of `addr` that
    // is also a neighbor of a seed, attribute min(addr→nb, nb→seed) to the
    // indirect bucket. This is the same bottleneck reasoning as the prune.
    let indirectIn = 0, indirectOut = 0
    const myNbrs = nbrUsd.get(addr)
    if (myNbrs) {
      for (const [nb, addrNbUsd] of myNbrs) {
        if (seeds.has(nb)) continue   // direct edges already accounted
        const nbNbrs = nbrUsd.get(nb)
        if (!nbNbrs) continue
        let nbToSeed = 0
        for (const [nb2, e2] of nbNbrs) if (seeds.has(nb2)) nbToSeed += e2
        if (nbToSeed <= 0) continue
        const contribution = Math.min(addrNbUsd, nbToSeed)
        // Direction split: we don't have per-edge direction for the intermediate
        // hop (edges are bidirectional in nbrUsd), so split evenly. Good enough
        // for "is there significant indirect connection" purposes.
        indirectIn  += contribution / 2
        indirectOut += contribution / 2
      }
    }

    result[addr] = {
      directInUsd:    +directIn.toFixed(2),
      directOutUsd:   +directOut.toFixed(2),
      directTxCount:  directTx,
      indirectInUsd:  +indirectIn.toFixed(2),
      indirectOutUsd: +indirectOut.toFixed(2),
      firstTs,
      lastTs,
      hopDistance:    hop.get(addr) ?? Infinity,
    }
  }
  return result
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
  const { wallets, fromTime, toTime, maxDepth, maxNewPerLayer, apiKey, targetMint, rpcUrl, abortSig } = opts

  const visited    = new Set<string>()
  const allTransfers: RawTransfer[] = []
  const nodeMap    = new Map<string, GraphNode>()

  for (const addr of wallets) {
    visited.add(addr)
    nodeMap.set(addr, { address: addr, label: shortAddr(addr), layer: 0, isSeed: true })
  }

  let frontier = [...wallets]

  for (let layer = 0; layer <= maxDepth && frontier.length > 0; layer++) {
    if (abortSig?.aborted) return
    onEvent({ type: 'scan_layer', layer, count: 0, total: frontier.length })
    const layerTransfers: RawTransfer[] = []
    let done = 0
    const maxPages = LAYER_MAX_PAGES[Math.min(layer, LAYER_MAX_PAGES.length - 1)]

    await pMap(frontier, async (addr) => {
      if (abortSig?.aborted) return
      onEvent({ type: 'scan_wallet', address: addr, layer, done, total: frontier.length })
      try {
        const txs = await fetchWalletTransfers(addr, fromTime, toTime, apiKey, undefined, maxPages, abortSig)
        layerTransfers.push(...txs)
        allTransfers.push(...txs)
      } catch (err) {
        console.warn(`[scan] ${addr} failed:`, (err as Error).message)
      }
      done++
      onEvent({ type: 'scan_wallet', address: addr, layer, done, total: frontier.length })
    }, SCAN_CONCURRENCY)
    if (abortSig?.aborted) return

    // Emit partial graph with heuristic prices for progressive rendering
    const partialNodeSet = new Set(nodeMap.keys())
    onEvent({
      type:  'scan_partial',
      layer,
      nodes: [...nodeMap.values()],
      edges: buildEdgesHeuristic(allTransfers, partialNodeSet, targetMint),
    })

    if (layer < maxDepth) {
      // ── Auto-skip high-fan-out wallets + AMM pools ─────────────────────────
      // No extra API calls: detection runs entirely against the transfers we
      // already pulled this layer. Two patterns are filtered:
      //   1. CEX hot wallets / market makers / routers — many unique counterparties
      //      or hit page cap with broad fan-out.
      //   2. AMM pools / bonding curves — in/out tx counts balanced (each swap
      //      arrives and leaves once), counterparty sets overlap heavily, and
      //      only 2-3 token mints appear (typically base/quote). The static
      //      PROGRAM_OWNERS table only knows ~13 specific pools; this heuristic
      //      catches the long tail (new DEXs, custom Bison/Solfi/etc. pools)
      //      without needing the list to be maintained.
      // Both kinds get kept in the graph as nodes but never seed the next BFS
      // layer — their counterparty lists are pure noise from the user's POV.
      const pageCap = maxPages * PAGE_SIZE
      const skipExpansion = new Set<string>()
      for (const addr of frontier) {
        const inCps = new Set<string>(), outCps = new Set<string>()
        const inMints = new Set<string>(), outMints = new Set<string>()
        let inCount = 0, outCount = 0
        for (const t of layerTransfers) {
          if (t.from === addr) { outCps.add(t.to);   outMints.add(t.mint); outCount++ }
          else if (t.to === addr) { inCps.add(t.from); inMints.add(t.mint); inCount++ }
        }
        const total      = inCount + outCount
        const allCps     = new Set([...inCps, ...outCps])
        const cappedPages = total >= pageCap

        // (1) High fan-out
        if (allCps.size >= HOT_UNIQUE_CP_THRESHOLD || (cappedPages && allCps.size >= 50)) {
          skipExpansion.add(addr)
          onEvent({ type: 'scan_hot', address: addr, layer, counterparties: allCps.size, txCount: total, cappedPages })
          console.log(`[scan] skip-expand ${addr.slice(0,8)}… layer=${layer} hot cps=${allCps.size} tx=${total}${cappedPages ? ' (page-capped)' : ''}`)
          continue
        }

        const inOutRatio = Math.min(inCount, outCount) / Math.max(inCount, outCount, 1)
        let overlap = 0
        for (const a of inCps) if (outCps.has(a)) overlap++
        const unionSize = new Set([...inCps, ...outCps]).size
        const jaccard = unionSize > 0 ? overlap / unionSize : 0
        const distinctMints = new Set([...inMints, ...outMints]).size

        // (2) Classic pool signature: balanced flow + symmetric counterparties + narrow mint set.
        if (inCount >= 5 && outCount >= 5 && inOutRatio >= 0.7 && jaccard >= 0.5 && distinctMints <= 4) {
          skipExpansion.add(addr)
          onEvent({ type: 'scan_hot', address: addr, layer, counterparties: allCps.size, txCount: total, cappedPages: false })
          console.log(`[scan] skip-expand ${addr.slice(0,8)}… layer=${layer} pool-like in/out=${inCount}/${outCount} jaccard=${jaccard.toFixed(2)} mints=${distinctMints}`)
          continue
        }

        // (3) Single-leg LP / bonding-curve account: in-cp set == out-cp set,
        // both of size 1, single mint. Common for Odin.fun-style per-position
        // PDAs that route every trade through one fixed counterparty. The
        // classic pool detector misses these because ratio can be way off
        // (e.g. 75 in vs 226 out), but the "exactly one counterparty on each
        // side and they're the same address" pattern is conclusive.
        if (inCps.size === 1 && outCps.size === 1 && jaccard === 1 && distinctMints === 1 && total >= 10) {
          skipExpansion.add(addr)
          onEvent({ type: 'scan_hot', address: addr, layer, counterparties: allCps.size, txCount: total, cappedPages: false })
          console.log(`[scan] skip-expand ${addr.slice(0,8)}… layer=${layer} single-leg in/out=${inCount}/${outCount} mint=${[...inMints][0]?.slice(0,6)}`)
          continue
        }

        // (4) Router / aggregator hub: many distinct counterparties on each
        // side, multiple mints, no jaccard overlap (asymmetric flow). The
        // wallet acts as a multi-token relay rather than a P2P participant.
        if (allCps.size >= 80 && distinctMints >= 4 && inOutRatio >= 0.4 && jaccard < 0.2) {
          skipExpansion.add(addr)
          onEvent({ type: 'scan_hot', address: addr, layer, counterparties: allCps.size, txCount: total, cappedPages: false })
          console.log(`[scan] skip-expand ${addr.slice(0,8)}… layer=${layer} router cps=${allCps.size} mints=${distinctMints} ratio=${inOutRatio.toFixed(2)}`)
          continue
        }

        // (5) Market-maker / arb bot: balanced in/out, high overlap of
        // counterparties (same pool addresses on both sides), wide token mix.
        // Distinct from a single-pool LP — these touch 5+ different mints.
        if (inCount >= 30 && outCount >= 30 && inOutRatio >= 0.9 && jaccard >= 0.8 && distinctMints >= 5) {
          skipExpansion.add(addr)
          onEvent({ type: 'scan_hot', address: addr, layer, counterparties: allCps.size, txCount: total, cappedPages: false })
          console.log(`[scan] skip-expand ${addr.slice(0,8)}… layer=${layer} mm/arb in/out=${inCount}/${outCount} jaccard=${jaccard.toFixed(2)} mints=${distinctMints}`)
          continue
        }

        // (6) Fanout disperser: massively asymmetric outflow to many distinct
        // recipients. Treasury distributions, reward batchers, airdroppers.
        // The hot rule already catches anything ≥ 200 cps, but this catches
        // the ≥100-cp distributors with limited in-flow that the hot rule
        // misses on the boundary.
        if (outCps.size >= 100 && outCps.size / (inCount + 1) >= 50) {
          skipExpansion.add(addr)
          onEvent({ type: 'scan_hot', address: addr, layer, counterparties: allCps.size, txCount: total, cappedPages: false })
          console.log(`[scan] skip-expand ${addr.slice(0,8)}… layer=${layer} disperser out=${outCount}→${outCps.size} in=${inCount}`)
          continue
        }
      }

      const scoreMap = new Map<string, number>()
      for (const addr of frontier) {
        if (skipExpansion.has(addr)) continue
        const scores = counterpartyScores(addr, layerTransfers, targetMint)
        for (const [other, score] of scores) {
          if (visited.has(other)) continue
          if (isProgram(other)) continue
          scoreMap.set(other, (scoreMap.get(other) ?? 0) + score)
        }
      }

      // Candidate-level pool prefilter: even before we spend Helius pages
      // promoting a candidate, look at how it appeared inside this layer's
      // transfers. A pool serving the current frontier shows the same
      // in/out symmetry signature as a scanned pool, just measured from one
      // side. Catches pools that would otherwise enter the next BFS layer
      // and waste a full page allocation (e.g. 65ZHSArs… at layer 3).
      for (const cand of [...scoreMap.keys()]) {
        const inCps = new Set<string>(), outCps = new Set<string>()
        const mints = new Set<string>()
        let inCount = 0, outCount = 0
        for (const t of layerTransfers) {
          if (t.from === cand) { outCps.add(t.to);   mints.add(t.mint); outCount++ }
          else if (t.to === cand) { inCps.add(t.from); mints.add(t.mint); inCount++ }
        }
        if (inCount < 5 || outCount < 5) continue
        const ratio = Math.min(inCount, outCount) / Math.max(inCount, outCount)
        let overlap = 0
        for (const a of inCps) if (outCps.has(a)) overlap++
        const union = new Set([...inCps, ...outCps]).size
        const jaccard = union > 0 ? overlap / union : 0
        if (ratio >= 0.7 && jaccard >= 0.5 && mints.size <= 4) {
          scoreMap.delete(cand)
          console.log(`[scan] prefilter-pool ${cand.slice(0,8)}… layer=${layer+1} in/out=${inCount}/${outCount} jaccard=${jaccard.toFixed(2)} mints=${mints.size}`)
        }
      }

      if (rpcUrl && scoreMap.size > 0) {
        try {
          const types = await getAccountTypes(rpcUrl, [...scoreMap.keys()])
          for (const [addr, type] of types) {
            if (type === 'program' || type === 'lp' || type === 'bonding_curve') scoreMap.delete(addr)
            // Note: 'closed' (account doesn't exist on chain) used to be dropped
            // along with null, but closed accounts are actually a strong
            // investigative signal (treasury account drained + rent-recovered).
            // We keep them in BFS so the UI can flag them as "已关闭". `null`
            // means the RPC call itself failed for this batch, drop those.
            if (type === null) scoreMap.delete(addr)
          }
        } catch { /* fall back to static list */ }
      }

      // Static-label terminals (Binance, Wormhole, …): always surface them as
      // graph nodes so the user can see "the funds went to Binance", but never
      // expand from them. Fetching a CEX hot wallet's transfer history would
      // pull in tens of thousands of unrelated user deposits — pure noise.
      const terminalNodes: string[] = []
      for (const addr of [...scoreMap.keys()]) {
        const lbl = KNOWN_ENTITIES[addr]
        if (lbl && TERMINAL_ENTITY_TYPES.has(lbl.type)) {
          terminalNodes.push(addr)
          scoreMap.delete(addr)
        }
      }
      for (const addr of terminalNodes) {
        visited.add(addr)
        nodeMap.set(addr, { address: addr, label: shortAddr(addr), layer: layer + 1, isSeed: false })
        console.log(`[scan] terminal ${addr.slice(0,8)}… ${KNOWN_ENTITIES[addr].name} (no expansion)`)
      }

      const newFrontier = [...scoreMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxNewPerLayer)
        .map(([addr]) => addr)

      onEvent({ type: 'scan_expand', layer, newCount: newFrontier.length, discovered: scoreMap.size })

      for (const addr of newFrontier) {
        visited.add(addr)
        nodeMap.set(addr, { address: addr, label: shortAddr(addr), layer: layer + 1, isSeed: false })
      }
      frontier = newFrontier
    } else {
      frontier = []
    }
  }

  // ── Price lookup (DexScreener batch, free, no auth) ─────────────────────────
  // After BFS: collect all unique mints, fetch real prices once.
  // Tokens with no DexScreener pair = no liquidity = spam candidates.
  const uniqueMints = [...new Set(allTransfers.map(t => t.mint))]
  let tokenPrices = new Map<string, TokenPriceInfo>()
  try {
    tokenPrices = await getTokenPrices(uniqueMints)
    onEvent({
      type:   'scan_prices',
      prices: Object.fromEntries(
        [...tokenPrices.entries()].map(([m, v]) => [m, v])
      ),
    })
    console.log(`[scan] prices fetched: ${tokenPrices.size}/${uniqueMints.length} mints priced`)
  } catch (err) {
    console.warn('[scan] price lookup failed, using heuristics:', (err as Error).message)
  }

  // ── Ghost nodes: priced USD floor instead of raw appearance count ───────────
  // Previously "≥2 priced transfers" counted a 0.001 SOL ($0.20) dust drop as
  // signal. That flooded layer 99 with hundreds of disperser recipients. The
  // new floor — total priced USD flow ≥ $SEED_PATH_USD_FLOOR — keeps the
  // visual graph anchored on addresses with real seed-related flow.
  // Target token always counts regardless of USD (pre-DEX launches still hit 0).
  const nodeSet = new Set(nodeMap.keys())
  const extUsd    = new Map<string, number>()  // cumulative priced USD touched
  const extTarget = new Set<string>()

  for (const t of allTransfers) {
    const isTarget = targetMint && t.mint === targetMint
    const usd      = realUsdScore(t.mint, t.amount, tokenPrices, targetMint)
    if (!isTarget && usd === 0) continue

    for (const addr of [t.from, t.to]) {
      if (nodeSet.has(addr)) continue
      extUsd.set(addr, (extUsd.get(addr) ?? 0) + usd)
      if (isTarget) extTarget.add(addr)
    }
  }

  for (const [addr, usdTotal] of extUsd) {
    if (usdTotal >= GHOST_NODE_USD_FLOOR || extTarget.has(addr)) {
      nodeMap.set(addr, { address: addr, label: shortAddr(addr), layer: EXTERNAL_LAYER, isSeed: false })
      nodeSet.add(addr)
    }
  }

  // Build final edges with real USD scores
  const edges = buildEdges(allTransfers, nodeSet, tokenPrices, targetMint)

  // ── Wallet intel up front (before noise prune) ──────────────────────────────
  // Move intel computation here so the prune pass below can use feature tags
  // to save nodes from deletion. Previously it ran after scan_graph emission,
  // which meant feature labels arrived too late to influence survival.
  let intelMap = new Map<string, WalletIntelligence>()
  try {
    intelMap = await analyzeAllWallets([...nodeMap.values()], allTransfers)
  } catch (err) {
    console.warn('[scan] wallet intel failed:', (err as Error).message)
  }

  // ── Closed-account sweep (runs BEFORE the prune so 'closed' tag participates) ─
  // Some addresses appear in the transfer history but no longer exist on chain
  // (treasury / disperser / temporary multi-sig drained to 0 lamports, rent
  // reclaimed). The transfers are real but the account itself is gone. Flag
  // them as feature so the prune keeps them visible — this is high-signal
  // forensic info, not noise.
  if (rpcUrl && nodeMap.size > 0) {
    try {
      const types = await getAccountTypes(rpcUrl, [...nodeMap.keys()])
      let closedCount = 0
      for (const [addr, type] of types) {
        if (type !== 'closed') continue
        closedCount++
        const existing = intelMap.get(addr)
        if (existing) {
          if (!existing.behaviorTags.includes('closed')) existing.behaviorTags.unshift('closed')
        } else {
          intelMap.set(addr, {
            address:      addr,
            behaviorTags: ['closed'],
            riskScore:    20,
            summary:      '账户已关闭（drained + rent reclaimed）',
          })
        }
      }
      if (closedCount > 0) console.log(`[scan] closed accounts: flagged ${closedCount} drained address(es)`)
    } catch (err) {
      console.warn('[scan] closed-account sweep failed:', (err as Error).message)
    }
  }

  // ── Noise prune ─────────────────────────────────────────────────────────────
  // Final survival rule: a non-seed node survives iff it has either
  //   (a) a feature flag — static entity label OR a featuring behavior tag, OR
  //   (b) a priced-USD edge sum that connects it (directly or via 1 hop) back
  //       to a seed, totalling ≥ SEED_PATH_USD_FLOOR.
  // Layer 1 nodes are always kept (they're direct counterparties; that's the
  // whole point of the scan). Layer ≥ 2 and layer 99 are subject to the rule.
  const seedSet = new Set(wallets)
  const seedConnectedUsd = computeSeedConnectedUsd(edges, seedSet)

  // Count "anchored" priced edges per address — edges where the *other* endpoint
  // is a tracked node (layer 0-3). For layer-99 ghost nodes this measures how
  // many real points in the seed's neighborhood they touch. A ghost with 1
  // anchored edge is a pendant; ghost-to-ghost edges don't count because the
  // other end may itself be pruned, leaving the pendant. Tracked nodes
  // themselves always have at least one anchored edge by construction.
  const trackedAddrs = new Set<string>()
  for (const n of nodeMap.values()) {
    if (n.layer !== EXTERNAL_LAYER) trackedAddrs.add(n.address)
  }
  const anchoredEdgeCount = new Map<string, number>()
  for (const e of edges) {
    if (!e.usdScore || e.usdScore <= 0) continue
    const ft = trackedAddrs.has(e.from), tt = trackedAddrs.has(e.to)
    if (tt) anchoredEdgeCount.set(e.from, (anchoredEdgeCount.get(e.from) ?? 0) + 1)
    if (ft) anchoredEdgeCount.set(e.to,   (anchoredEdgeCount.get(e.to)   ?? 0) + 1)
  }

  const survivors = new Map<string, GraphNode>()
  for (const n of nodeMap.values()) {
    if (n.isSeed || n.layer === 1) {
      survivors.set(n.address, n)
      continue
    }
    const intel = intelMap.get(n.address)
    const hasFeature = !!intel?.staticLabel ||
                       (intel?.behaviorTags ?? []).some(t => FEATURE_BEHAVIOR_TAGS.has(t))
    const seedUsd = seedConnectedUsd.get(n.address) ?? 0

    let floor: number
    if (n.layer === EXTERNAL_LAYER) {
      const eCount = anchoredEdgeCount.get(n.address) ?? 0
      floor = eCount >= 2 ? SEED_PATH_USD_FLOOR_GHOST_MUL : SEED_PATH_USD_FLOOR_GHOST_ONE
    } else {
      floor = SEED_PATH_USD_FLOOR_INTERNAL
    }
    if (hasFeature || seedUsd >= floor) survivors.set(n.address, n)
  }
  const droppedCount = nodeMap.size - survivors.size
  console.log(`[scan] noise prune: kept ${survivors.size}/${nodeMap.size} nodes (dropped ${droppedCount})`)

  const survivingAddrSet = new Set(survivors.keys())
  const survivingEdges = edges.filter(e => survivingAddrSet.has(e.from) && survivingAddrSet.has(e.to))

  // ── Per-node seed relationship ──────────────────────────────────────────────
  // What an analyst actually wants when they click an address: how does THIS
  // address relate to the SEED, not its global footprint. We compute it once
  // here and attach to the graph so the sidebar + table can both render it.
  const seedRelation = computeSeedRelations(survivingAddrSet, seedSet, allTransfers, edges, tokenPrices, targetMint)

  const timestamps = allTransfers.map(t => t.timestamp)
  const graph: TransferGraph = {
    nodes: [...survivors.values()],
    edges: survivingEdges,
    transfers: allTransfers,
    timeRange: {
      min: timestamps.length ? Math.min(...timestamps) : fromTime,
      max: timestamps.length ? Math.max(...timestamps) : toTime,
    },
    targetMint,
    seedRelation,
  }
  onEvent({ type: 'scan_graph', graph })

  // ── Emit wallet intel (already computed above for the prune pass) ───────────
  if (intelMap.size > 0) {
    // Filter intel down to surviving nodes so UI doesn't reference dropped addrs.
    const filtered = new Map<string, WalletIntelligence>()
    for (const addr of survivors.keys()) {
      const v = intelMap.get(addr)
      if (v) filtered.set(addr, v)
    }
    onEvent({ type: 'wallet_intel', intel: Object.fromEntries(filtered) })
    const flagged = [...filtered.values()].filter(w => w.riskScore > 40).length
    console.log(`[scan] wallet intel: ${filtered.size} wallets analyzed, ${flagged} flagged`)
  }

  // ── OKX enrichment (optional, requires OKX API keys) ────────────────────────
  const hasOkx = !!(process.env.OKX_API_KEY && process.env.OKX_PASSPHRASE && process.env.OKX_SECRET_KEY)
  if (hasOkx && targetMint) {
    const discoveredWallets = [...survivors.values()]
      .filter(n => !n.isSeed && n.layer <= maxDepth)
      .map(n => n.address)

    const okxResults: WalletOkxData[] = []

    for (const addr of discoveredWallets) {
      if (abortSig?.aborted) return
      try {
        const wb = await getWalletBalances(addr, targetMint)
        const targetTokenPct = wb.targetBalanceUsd != null && wb.splTotalUsd > 0
          ? (wb.targetBalanceUsd / wb.splTotalUsd) * 100
          : null
        const data: WalletOkxData = {
          address:        addr,
          portfolioUsd:   wb.portfolioTotalUsd,
          splUsd:         wb.splTotalUsd,
          targetTokenUsd: wb.targetBalanceUsd,
          targetTokenPct,
        }
        okxResults.push(data)
        onEvent({ type: 'wallet_okx', data })
      } catch (err) {
        console.warn(`[scan-okx] ${addr.slice(0, 8)} failed:`, (err as Error).message)
      }
    }

    const suspects = okxResults
      .filter(w => w.targetTokenUsd != null && w.targetTokenUsd > 1)
      .map(w => {
        let score = 0
        const reasons: string[] = []
        if (w.targetTokenPct != null && w.targetTokenPct > 60) { score += 3; reasons.push(`${w.targetTokenPct.toFixed(0)}% of SPL in target`) }
        if (w.targetTokenPct != null && w.targetTokenPct > 30) { score += 1 }
        if (w.portfolioUsd < 5000 && w.targetTokenUsd != null && w.targetTokenUsd > 100) { score += 2; reasons.push('small wallet, concentrated position') }
        return { address: w.address, score, reason: reasons.join(' · ') }
      })
      .filter(s => s.score >= 2)
      .sort((a, b) => b.score - a.score)

    if (suspects.length > 0) onEvent({ type: 'scan_suspects', suspects })
  }
}
