// OKX API utilities
//
// Two data sources:
// 1. Signed API /api/v6/dex/balance/all-token-balances-by-address
//    → ALL current balances (incl. tokens received via transfer, no pagination)
//    → Used for: target token balanceUsd, portfolioTotalUsd, splTotalUsd, allMints
//
// 2. priapi pnl/token-list (no auth)
//    → Only DEX-traded tokens (misses transfer-acquired tokens)
//    → Used for: PnL data (realized/unrealized, buy/sell counts, holdingTime)
//
// 3. priapi pnl/wallet-profile/trade-history (no auth)
//    → Recent trade counts for uniqueTokens7d / uniqueTokens90d

import crypto from 'crypto'

const BASE       = 'https://web3.okx.com'
const TIMEOUT_MS = 20_000
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',    // USDT
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',    // USDS
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',   // PYUSD
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',   // EURC
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM',    // USDCet
])
const SOL_MINTS = new Set([
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  '',
])

// ── OKX signing + rate-limit handling ────────────────────────────────────────
//
// OKX signed API rate limit: ~5 req/s observed in testing (Start-up tier).
// Token bucket: refills at RATE tokens/s, holds up to BURST tokens max.
// Callers queue and wait for a token — no thundering-herd retries needed.

function sign(ts: string, method: string, path: string): string {
  const secret = process.env.OKX_SECRET_KEY
  if (!secret) throw new Error('OKX_SECRET_KEY missing')
  return crypto.createHmac('sha256', secret).update(ts + method + path + '').digest('base64')
}

// Token bucket rate limiter for signed API calls
const RATE  = 2          // tokens added per second — OKX signed API sustains ~2 req/s
const BURST = 3          // max tokens held (allows initial burst of 3 before throttling)

let   tokens     = BURST
let   lastRefil  = Date.now()
let   drainTimer: ReturnType<typeof setTimeout> | null = null
const waitQueue: Array<() => void> = []

function refill(): void {
  const now  = Date.now()
  tokens     = Math.min(BURST, tokens + (now - lastRefil) / 1000 * RATE)
  lastRefil  = now
}

// One shared timer drives all queue draining — no competing timeouts.
function scheduleDrain(): void {
  if (drainTimer !== null) return
  const ms   = Math.ceil(Math.max(0, 1 - tokens) / RATE * 1000)
  drainTimer = setTimeout(() => {
    drainTimer = null
    drainQueue()
  }, ms)
}

function drainQueue(): void {
  refill()
  while (waitQueue.length > 0 && tokens >= 1) {
    tokens--
    waitQueue.shift()!()
  }
  if (waitQueue.length > 0) scheduleDrain()
}

function acquireToken(): Promise<void> {
  refill()
  if (tokens >= 1) { tokens--; return Promise.resolve() }
  return new Promise(resolve => {
    waitQueue.push(resolve)
    scheduleDrain()
  })
}

async function okxSignedGet<T>(path: string, maxRetries = 3): Promise<T> {
  const apiKey     = process.env.OKX_API_KEY
  const passphrase = process.env.OKX_PASSPHRASE
  if (!apiKey || !passphrase || !process.env.OKX_SECRET_KEY) throw new Error('OKX keys missing')

  // One token per logical request, not per HTTP attempt. Previously every retry
  // re-consumed a bucket token, which compounded backoff time during 429 storms
  // (the very situation where we want to be MORE conservative, not less).
  await acquireToken()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ts = new Date().toISOString()
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(BASE + path, {
        headers: {
          'Content-Type':         'application/json',
          'OK-ACCESS-KEY':        apiKey,
          'OK-ACCESS-SIGN':       sign(ts, 'GET', path),
          'OK-ACCESS-PASSPHRASE': passphrase,
          'OK-ACCESS-TIMESTAMP':  ts,
        },
        signal: ac.signal,
      })
      clearTimeout(to)

      if (res.status === 429) {
        // Bucket miscalibrated or OKX server-side limit — back off and retry
        if (attempt < maxRetries) {
          const wait = 2_000 + Math.random() * 2_000
          console.log(`[OKX] 429 — bucket needs wider margin, waiting ${(wait/1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})`)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        throw new Error('OKX 429: rate limit exceeded after retries')
      }

      if (!res.ok) throw new Error(`OKX HTTP ${res.status}`)
      const body = (await res.json()) as { code: string; msg?: string; data?: T }
      if (body.code !== '0') throw new Error(`OKX ${body.code}: ${body.msg ?? 'unknown'}`)
      return body.data as T
    } catch (err: any) {
      clearTimeout(to)
      if (attempt < maxRetries && err?.name !== 'AbortError') {
        await new Promise(r => setTimeout(r, 1_000 * (attempt + 1)))
        continue
      }
      throw err
    }
  }
  throw new Error('OKX: max retries exceeded')
}

// ── Signed balance API ────────────────────────────────────────────────────────

export interface MintEntry { mint: string; symbol: string; logoUrl: string }

export interface WalletBalances {
  targetBalanceUsd:  number | null   // USD value of target token position (null if not held)
  targetTokenPrice:  number | null   // USD per token (null if not held)
  portfolioTotalUsd: number          // sum of all token USD values
  splTotalUsd:       number          // portfolio excl. SOL and stablecoins
  allMints:          string[]        // for fast co-holder filter lookup
  allTokens:         MintEntry[]     // mint + symbol + logo for dropdown
}

interface SignedRow {
  symbol:               string
  balance:              string   // UI-formatted amount
  tokenPrice:           string   // USD per token
  tokenContractAddress: string   // '' for native SOL
  chainIndex:           string
}

export async function getWalletBalances(
  walletAddress: string,
  targetMint:    string,
  chainId        = '501',
): Promise<WalletBalances> {
  const qs   = new URLSearchParams({ address: walletAddress, chains: chainId, excludeRiskToken: '0' })
  const path = `/api/v6/dex/balance/all-token-balances-by-address?${qs}`

  const data = await okxSignedGet<[{ tokenAssets?: SignedRow[] }]>(path)
  const raw  = data?.[0]?.tokenAssets ?? []

  let portfolioTotalUsd  = 0
  let splTotalUsd        = 0
  let targetBalanceUsd   = null as number | null
  let targetTokenPrice   = null as number | null
  const allMints: string[]    = []
  const allTokens: MintEntry[] = []

  for (const r of raw) {
    const bal   = parseFloat(r.balance  ?? '0')
    const price = parseFloat(r.tokenPrice ?? '0')
    const usd   = Number.isFinite(bal) && Number.isFinite(price) ? bal * price : 0
    const mint  = r.tokenContractAddress ?? ''

    portfolioTotalUsd += usd
    allMints.push(mint)
    allTokens.push({ mint, symbol: r.symbol ?? '', logoUrl: '' })

    if (!SOL_MINTS.has(mint) && !STABLECOIN_MINTS.has(mint)) {
      splTotalUsd += usd
    }

    if (mint === targetMint) {
      targetBalanceUsd  = usd
      targetTokenPrice  = Number.isFinite(price) ? price : null
    }
  }

  return { targetBalanceUsd, targetTokenPrice, portfolioTotalUsd, splTotalUsd, allMints, allTokens }
}

// ── priapi helper ─────────────────────────────────────────────────────────────

interface PriApiResponse<T> { code: number; msg?: string; data?: T }

async function priGet<T>(path: string, params: Record<string, string>, referer: string): Promise<T> {
  const qs = new URLSearchParams({ ...params, t: String(Date.now()) })
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res  = await fetch(`${BASE}${path}?${qs}`, {
      headers: { accept: 'application/json', 'app-type': 'web', referer, 'user-agent': UA, 'x-cdn': BASE },
      signal: ac.signal,
    })
    const body = (await res.json()) as PriApiResponse<T>
    if (body.code !== 0) throw new Error(`OKX priapi ${body.code}: ${body.msg ?? 'unknown'}`)
    return body.data as T
  } finally {
    clearTimeout(to)
  }
}

// ── pnl/token-list: PnL data only (for target token) ─────────────────────────

export interface OkxTokenPnl {
  tokenContractAddress:    string
  tokenSymbol:             string
  tokenLogoUrl:            string
  balance:                 string
  balanceUsd:              string
  realizedPnl:             string
  realizedPnlPercentage:   string
  unrealizedPnl:           string
  totalPnl:                string
  totalPnlPercentage:      string
  buyVolume:               string
  sellVolume:              string
  totalTxBuy:              number
  totalTxSell:             number
  holdingTime:             number   // unix SECONDS
  holdAmountPctForMaxHold: number
  riskLevel:               number
  riskControlLevel:        number
  latestTime:              number
}

interface TokenListPage { tokenList: OkxTokenPnl[]; hasNext: boolean; offset: number }

// Search pnl/token-list for the target mint (up to maxPages pages).
// 3 pages × 100 tokens = 300 token search depth, plenty for top holders since
// priapi sorts by USD value desc and we're querying their largest positions.
// Loop also short-circuits on hasNext=false, so wallets with <300 tokens
// finish in 1–2 calls.
export async function getTokenPnlData(
  walletAddress: string,
  targetMint:    string,
  maxPages       = 3,
): Promise<OkxTokenPnl | null> {
  let offset = 0
  const limit = '100'

  for (let page = 0; page < maxPages; page++) {
    const data = await priGet<TokenListPage>(
      '/priapi/v1/dx/market/v2/pnl/token-list',
      {
        chainId: '501', walletAddress,
        sortType: '1', isAsc: 'false',
        offset: String(offset), limit,
        pageIndex: String(page + 1), pageSize: limit,
      },
      `${BASE}/portfolio/${walletAddress}/analysis`,
    )
    const found = data.tokenList?.find((t) => t.tokenContractAddress === targetMint)
    if (found) return found
    if (!data.hasNext) break
    offset = data.offset ?? (offset + parseInt(limit))
  }
  return null
}

// ── Trade history: unique token counts ───────────────────────────────────────

interface TradeHistoryPage {
  rows?: Array<{ tokenContractAddress: string; blockTime: string }>
  hasNext?: boolean
}

export interface TradeStats {
  uniqueTokens7d:  number
  uniqueTokens90d: number
  tradedMints90d:  string[]   // all mints traded in last 90d (for co-trades dropdown)
}

export async function getTradeStats(walletAddress: string): Promise<TradeStats> {
  const now       = Date.now()
  const days7ago  = now - 7  * 24 * 3600 * 1000
  const days90ago = now - 90 * 24 * 3600 * 1000

  const trades: Array<{ mint: string; time: number }> = []
  let blockTimeMax = now + 86400_000

  for (let i = 0; i < 3 && trades.length < 300; i++) {
    const page = await priGet<TradeHistoryPage>(
      '/priapi/v1/dx/market/v2/pnl/wallet-profile/trade-history',
      { walletAddress, chainId: '501', pageSize: '100', tradeType: '1,2', filterRisk: 'true',
        blockTimeMin: String(days90ago), blockTimeMax: String(blockTimeMax) },
      `${BASE}/portfolio/${walletAddress}/history`,
    )
    const rows = page.rows ?? []
    if (!rows.length) break
    for (const r of rows) trades.push({ mint: r.tokenContractAddress, time: Number(r.blockTime) })
    if (!page.hasNext) break
    blockTimeMax = Number(rows[rows.length - 1].blockTime) - 1
  }

  const mints90d = [...new Set(trades.map(t => t.mint))]
  return {
    uniqueTokens7d:  new Set(trades.filter(t => t.time >= days7ago).map(t => t.mint)).size,
    uniqueTokens90d: mints90d.length,
    tradedMints90d:  mints90d,
  }
}
