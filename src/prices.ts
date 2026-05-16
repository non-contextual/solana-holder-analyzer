// Token price + liquidity lookup via DexScreener (free, no auth).
//
// Called once after BFS completes with all unique mints found in transfers.
// Mints that return no pairs = no on-chain liquidity = spam tokens.
// The Map drives three downstream uses:
//   1. Ghost node filter: only addresses that transferred priced tokens count
//   2. Edge USD scoring: real price × amount replaces SOL×150 heuristics
//   3. UI: chip labels show "BONK $0.000021", tooltips show real USD values

import { SOL_MINT, STABLE_MINTS, WSOL_MINT } from './helius'

export interface TokenPriceInfo {
  price:     number   // current USD price per token
  liquidity: number   // USD liquidity of the best pair
  symbol:    string   // display symbol
}

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens'
const CHUNK        = 30      // safe URL length (30 × 44 chars ≈ 1320 chars)
const TIMEOUT_MS   = 15_000
const BATCH_DELAY  = 200     // ms between batches — polite to free API

// Dedicated SOL price fetch. DexScreener's batched endpoint returns at most a
// handful of pairs per token across all chains, and the wSOL address is also
// used by Fogo where the same string represents a $0.018 token. When wSOL is
// queried alone the response is the full 30+ Solana pairs and we can safely
// pick the most-liquid one. We special-case this so the SOL spot is always
// the real Solana mainnet number, not whatever survived a batch collision.
async function fetchSolPrice(): Promise<TokenPriceInfo | null> {
  const ac    = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${DEXSCREENER}/${WSOL_MINT}`, {
      headers: { accept: 'application/json' },
      signal:  ac.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { pairs?: Array<{ chainId?: string; baseToken?: { symbol?: string }; priceUsd?: string; liquidity?: { usd?: number } }> }
    let best: TokenPriceInfo | null = null
    for (const pair of data.pairs ?? []) {
      if (pair.chainId !== 'solana') continue
      const price = parseFloat(pair.priceUsd ?? '0')
      const liq   = pair.liquidity?.usd ?? 0
      if (price <= 0) continue
      if (!best || liq > best.liquidity) best = { price, liquidity: liq, symbol: 'SOL' }
    }
    return best
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function getTokenPrices(
  mints: string[],
): Promise<Map<string, TokenPriceInfo>> {
  const result = new Map<string, TokenPriceInfo>()

  // Fetch SOL price reliably in a dedicated call so the batched endpoint's
  // chain collisions (Fogo etc.) can't corrupt it.
  const solInfo = await fetchSolPrice()
  if (solInfo) {
    result.set(SOL_MINT,  { ...solInfo, symbol: 'SOL' })
    result.set(WSOL_MINT, { ...solInfo, symbol: 'wSOL' })
  }

  const toFetch = mints.filter(m => m !== SOL_MINT && m !== WSOL_MINT && !STABLE_MINTS.has(m))
  if (!toFetch.length) return result

  for (let i = 0; i < toFetch.length; i += CHUNK) {
    const batch = toFetch.slice(i, i + CHUNK)
    const ac    = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(`${DEXSCREENER}/${batch.join(',')}`, {
        headers: { accept: 'application/json' },
        signal:  ac.signal,
      })
      if (!res.ok) continue

      interface DsPair {
        chainId?:   string
        baseToken?: { address?: string; symbol?: string }
        priceUsd?:  string
        liquidity?: { usd?: number }
      }
      const data = (await res.json()) as { pairs?: DsPair[] }

      // Per mint: pick the pair with the highest USD liquidity.
      // Filter to Solana mainnet — DexScreener returns pairs across all chains
      // for the same address string, and obscure chains like Fogo also reuse
      // wSOL's mint, which used to silently overwrite the real SOL price with
      // a $0.018 ghost when we picked by liquidity alone.
      const bestLiq = new Map<string, number>()
      for (const pair of data.pairs ?? []) {
        if (pair.chainId && pair.chainId !== 'solana') continue
        const mint  = pair.baseToken?.address
        const price = parseFloat(pair.priceUsd ?? '0')
        const liq   = pair.liquidity?.usd ?? 0
        const sym   = pair.baseToken?.symbol ?? (mint ? mint.slice(0, 6) + '…' : '?')
        if (!mint || price <= 0) continue
        if (liq > (bestLiq.get(mint) ?? 0)) {
          bestLiq.set(mint, liq)
          result.set(mint, { price, liquidity: liq, symbol: sym })
        }
      }
    } catch {
      // Non-fatal: network error or abort — skip this batch
    } finally {
      clearTimeout(timer)
    }

    if (i + CHUNK < toFetch.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY))
    }
  }

  return result
}

// Compute USD value of a transfer with real prices.
// SOL is mirrored from the wSOL DexScreener pair (real spot at scan time).
// Stablecoins use the $1 peg. Unknown tokens with no DexScreener listing return
// 0, which keeps them out of ghost-node counting (spam prevention).
export function realUsdScore(
  mint:      string,
  amount:    number,
  prices:    Map<string, TokenPriceInfo>,
  targetMint?: string,
): number {
  if (mint === SOL_MINT) {
    const sol = prices.get(SOL_MINT) ?? prices.get(WSOL_MINT)
    return sol ? amount * sol.price : amount * 150   // 150 fallback only when DexScreener failed
  }
  if (STABLE_MINTS.has(mint)) return amount
  const info = prices.get(mint)
  if (info)                   return amount * info.price
  // Target token always gets a non-zero score even if unlisted (pre-DEX launch).
  if (targetMint && mint === targetMint) return amount * 0.001
  return 0
}
