// Helius Enhanced Transactions REST API
// GET https://api.helius.xyz/v0/addresses/{address}/transactions
//
// Returns parsed tx data with nativeTransfers + tokenTransfers.
// Used by transfer-scan.ts for multi-layer BFS transfer investigation.

const HELIUS_REST = 'https://api.helius.xyz/v0'
export const PAGE_SIZE = 100
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
// wSOL has a real DexScreener pair, so we use it as the source of truth for the
// SOL/USD spot. Native SOL transfers carry the SOL_MINT sentinel; after the
// price fetch we mirror the wSOL price onto that sentinel so both legs (native
// and wrapped) share the same valuation.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'

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

// Rough USD-equivalent score used ONLY during in-flight BFS counterparty ranking,
// before real DexScreener prices have been fetched. The 150 placeholder is fine
// here because the value is consumed by relative sort comparisons inside
// `counterpartyScores`. Final user-visible USD values go through `realUsdScore`
// in prices.ts, which uses the real wSOL spot pulled at scan time.
export function tokenUsdScore(mint: string, amount: number): number {
  if (mint === SOL_MINT)        return amount * 150
  if (STABLE_MINTS.has(mint))   return amount
  return 0
}

export interface RawTransfer {
  txHash:    string
  timestamp: number   // unix seconds
  from:      string
  to:        string
  mint:      string   // 'SOL' or SPL mint address
  symbol:    string
  amount:    number   // UI-formatted
  // Helius tx classification. `type` is one of TRANSFER / SWAP / NFT_SALE / ...,
  // `source` is the DeFi protocol that emitted it (JUPITER / RAYDIUM / PUMP_FUN /
  // SYSTEM_PROGRAM ...). We carry both through so the UI can show "via Jupiter"
  // instead of just an arrow. Optional so older snapshots without this data
  // still parse.
  txType?:   string
  txSource?: string
}

interface HeliusTx {
  signature:       string
  timestamp:       number
  type?:           string
  source?:         string
  nativeTransfers: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>
  tokenTransfers:  Array<{ fromUserAccount: string; toUserAccount: string; fromTokenAccount?: string; toTokenAccount?: string; mint: string; tokenAmount: number; tokenStandard?: string }>
  accountData?:    Array<{ account: string; nativeBalanceChange?: number; tokenBalanceChanges?: unknown[] }>
}

// Helius transaction types that represent direct wallet-to-wallet transfers.
// Filtering by type server-side avoids fetching swap/NFT/compute-budget txs
// that would never produce relevant edges. This typically reduces pages by 5-10×
// for active DeFi wallets where transfers are a minority of all activity.
const TRANSFER_TYPES = 'TRANSFER'

async function fetchPage(
  address:    string,
  apiKey:     string,
  fromTime:   number,
  toTime:     number,
  before?:    string,
  abortSig?:  AbortSignal,
): Promise<HeliusTx[]> {
  const qs = new URLSearchParams({
    'api-key':  apiKey,
    limit:      String(PAGE_SIZE),
    type:       TRANSFER_TYPES,
    'gte-time': String(fromTime),   // server-side lower bound — no need to paginate past it
    'lte-time': String(toTime),     // server-side upper bound
  })
  if (before) qs.set('before', before)
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS)
  // Forward outer aborts (e.g. SSE client disconnect) so we don't keep paginating.
  const onOuter = () => ac.abort()
  abortSig?.addEventListener('abort', onOuter)
  try {
    const res = await fetch(`${HELIUS_REST}/addresses/${address}/transactions?${qs}`, { signal: ac.signal })
    if (res.status === 429) throw Object.assign(new Error('Helius 429'), { status: 429 })
    // Surface transient upstream failures so the caller can retry with backoff.
    if (res.status >= 500 && res.status < 600) throw Object.assign(new Error(`Helius HTTP ${res.status}`), { status: res.status, transient: true })
    if (!res.ok) throw new Error(`Helius HTTP ${res.status}`)
    return (await res.json()) as HeliusTx[]
  } finally {
    clearTimeout(to)
    abortSig?.removeEventListener('abort', onOuter)
  }
}

/**
 * Fetch all transfers for `address` in [fromTime, toTime] (unix seconds).
 * Uses server-side type=TRANSFER + time filters so we only get relevant pages.
 */
export async function fetchWalletTransfers(
  address:     string,
  fromTime:    number,
  toTime:      number,
  apiKey:      string,
  onProgress?: (count: number) => void,
  maxPages = 50,
  abortSig?:   AbortSignal,
): Promise<RawTransfer[]> {
  const results: RawTransfer[] = []
  let cursor: string | undefined
  let attempts = 0
  let pages = 0

  while (true) {
    if (abortSig?.aborted) break
    let page: HeliusTx[]
    try {
      page = await fetchPage(address, apiKey, fromTime, toTime, cursor, abortSig)
    } catch (err: any) {
      // Backoff for 429 and transient 5xx alike. Bare network errors (no
      // status) are also worth one retry — they're usually upstream blips.
      const retriable = err?.status === 429 || err?.transient === true || err?.status === undefined
      if (retriable && attempts < 3) {
        attempts++
        await new Promise(r => setTimeout(r, 2_000 * attempts + Math.random() * 1_500))
        continue
      }
      throw err
    }
    attempts = 0

    if (!page.length) break
    // No reachedStart check needed — gte-time filter ensures the API only returns
    // txs within the window. We paginate until empty or maxPages hit.

    for (const tx of page) {
      // Defensive bounds check in case the API returns a tx slightly outside range
      if (tx.timestamp < fromTime || tx.timestamp > toTime) continue

      // Token-account leak guard. Helius's enhanced parser sometimes surfaces
      // a temporary SPL token account (e.g. a wSOL ATA opened mid-swap) in the
      // `fromUserAccount` / `toUserAccount` field of a *native* transfer — the
      // 0.00203928 SOL rent funding looks identical to a regular SOL send.
      // The hard signal that an address is a token account, not an owner, is
      // that the same address shows up in `fromTokenAccount` or `toTokenAccount`
      // somewhere in the same tx. Collect those and refuse to treat them as
      // user wallets on the native side.
      const tokenAccounts = new Set<string>()
      for (const t of tx.tokenTransfers ?? []) {
        if (t.fromTokenAccount) tokenAccounts.add(t.fromTokenAccount)
        if (t.toTokenAccount)   tokenAccounts.add(t.toTokenAccount)
      }

      for (const t of tx.nativeTransfers ?? []) {
        if (!t.fromUserAccount || !t.toUserAccount) continue
        if (t.fromUserAccount === t.toUserAccount) continue
        // Drop everything below 0.0001 SOL (100k lamports). At this scale the
        // transfer is almost certainly address poisoning ("vanity dust" sent to
        // lookalike addresses) or fee-routing leftover, not a meaningful user
        // interaction. Real funding / payments are virtually always ≥ rent
        // exempt (~0.0009 SOL).
        if (t.amount < 100_000) continue
        if (tokenAccounts.has(t.fromUserAccount) || tokenAccounts.has(t.toUserAccount)) continue
        results.push({ txHash: tx.signature, timestamp: tx.timestamp, from: t.fromUserAccount, to: t.toUserAccount, mint: SOL_MINT, symbol: 'SOL', amount: t.amount / 1e9, txType: tx.type, txSource: tx.source })
      }

      for (const t of tx.tokenTransfers ?? []) {
        if (!t.fromUserAccount || !t.toUserAccount || !t.mint) continue
        if (t.fromUserAccount === t.toUserAccount) continue
        if (t.tokenStandard && !['Fungible', 'FungibleAsset'].includes(t.tokenStandard)) continue
        if (t.tokenAmount <= 0) continue
        if (tokenAccounts.has(t.fromUserAccount) || tokenAccounts.has(t.toUserAccount)) continue
        results.push({ txHash: tx.signature, timestamp: tx.timestamp, from: t.fromUserAccount, to: t.toUserAccount, mint: t.mint, symbol: symbolFor(t.mint), amount: t.tokenAmount, txType: tx.type, txSource: tx.source })
      }
    }

    onProgress?.(results.length)
    pages++
    if (page.length < PAGE_SIZE || pages >= maxPages) break
    cursor = page[page.length - 1].signature
  }

  return results
}
