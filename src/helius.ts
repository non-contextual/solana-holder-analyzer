// Helius Enhanced Transactions REST API
// GET https://api.helius.xyz/v0/addresses/{address}/transactions
//
// Returns parsed tx data with nativeTransfers + tokenTransfers.
// Used by transfer-scan.ts for multi-layer BFS transfer investigation.

const HELIUS_REST = 'https://api.helius.xyz/v0'
const PAGE_SIZE   = 100
const TIMEOUT_MS  = 25_000

// Known DEX/program addresses — exclude from BFS expansion (not user wallets)
export const PROGRAM_LABELS: Record<string, string> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':  'pump.fun AMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun BC',
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM':  'pump.fun BC v2',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4':  'Jupiter v6',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':  'Orca',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':  'Meteora DLMM',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vA':  'Meteora Pools',
  '11111111111111111111111111111111':               'System',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':   'Token Program',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb':   'Token-2022',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS':  'ATA Program',
  'ComputeBudget111111111111111111111111111111':     'Compute Budget',
  'Vote111111111111111111111111111111111111111p8':   'Vote Program',
}

export const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
])

export const SOL_MINT = 'SOL'

// Known mint → symbol
const KNOWN_SYMBOLS: Record<string, string> = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA': 'USDS',
  'So11111111111111111111111111111111111111112':   'wSOL',
}

export function registerSymbol(mint: string, symbol: string): void {
  if (!KNOWN_SYMBOLS[mint] && symbol && !symbol.endsWith('…')) {
    KNOWN_SYMBOLS[mint] = symbol
  }
}

export function symbolFor(mint: string): string {
  if (mint === SOL_MINT) return 'SOL'
  return KNOWN_SYMBOLS[mint] ?? mint.slice(0, 6) + '…'
}

export function isProgram(address: string): boolean {
  return address in PROGRAM_LABELS
}

export interface RawTransfer {
  txHash:    string
  timestamp: number   // unix seconds
  from:      string
  to:        string
  mint:      string   // 'SOL' or SPL mint address
  symbol:    string
  amount:    number   // UI-formatted
}

interface HeliusTx {
  signature:       string
  timestamp:       number
  nativeTransfers: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>
  tokenTransfers:  Array<{ fromUserAccount: string; toUserAccount: string; mint: string; tokenAmount: number; tokenStandard?: string }>
}

async function fetchPage(address: string, apiKey: string, before?: string): Promise<HeliusTx[]> {
  const qs = new URLSearchParams({ 'api-key': apiKey, limit: String(PAGE_SIZE) })
  if (before) qs.set('before', before)
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${HELIUS_REST}/addresses/${address}/transactions?${qs}`, { signal: ac.signal })
    if (res.status === 429) throw Object.assign(new Error('Helius 429'), { status: 429 })
    if (!res.ok) throw new Error(`Helius HTTP ${res.status}`)
    return (await res.json()) as HeliusTx[]
  } finally {
    clearTimeout(to)
  }
}

/**
 * Fetch all transfers for `address` in [fromTime, toTime] (unix seconds).
 * Paginates until past start time or no more pages.
 */
export async function fetchWalletTransfers(
  address:     string,
  fromTime:    number,
  toTime:      number,
  apiKey:      string,
  onProgress?: (count: number) => void,
): Promise<RawTransfer[]> {
  const results: RawTransfer[] = []
  let cursor: string | undefined
  let attempts = 0

  while (true) {
    let page: HeliusTx[]
    try {
      page = await fetchPage(address, apiKey, cursor)
    } catch (err: any) {
      if (err?.status === 429 && attempts < 3) {
        attempts++
        await new Promise(r => setTimeout(r, 3_000 + Math.random() * 2_000))
        continue
      }
      throw err
    }
    attempts = 0

    if (!page.length) break
    let reachedStart = false

    for (const tx of page) {
      if (tx.timestamp < fromTime) { reachedStart = true; break }
      if (tx.timestamp > toTime) continue

      for (const t of tx.nativeTransfers ?? []) {
        if (!t.fromUserAccount || !t.toUserAccount) continue
        if (t.fromUserAccount === t.toUserAccount) continue
        if (t.amount < 1000) continue   // ignore dust < 0.000001 SOL
        results.push({ txHash: tx.signature, timestamp: tx.timestamp, from: t.fromUserAccount, to: t.toUserAccount, mint: SOL_MINT, symbol: 'SOL', amount: t.amount / 1e9 })
      }

      for (const t of tx.tokenTransfers ?? []) {
        if (!t.fromUserAccount || !t.toUserAccount || !t.mint) continue
        if (t.fromUserAccount === t.toUserAccount) continue
        if (t.tokenStandard && !['Fungible', 'FungibleAsset'].includes(t.tokenStandard)) continue
        if (t.tokenAmount <= 0) continue
        results.push({ txHash: tx.signature, timestamp: tx.timestamp, from: t.fromUserAccount, to: t.toUserAccount, mint: t.mint, symbol: symbolFor(t.mint), amount: t.tokenAmount })
      }
    }

    onProgress?.(results.length)
    if (reachedStart || page.length < PAGE_SIZE) break
    cursor = page[page.length - 1].signature
  }

  return results
}
