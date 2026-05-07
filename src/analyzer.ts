import { getTopHolders, getTokenSupplyInfo, getTokenMeta, getAccountTypes } from './solana'
import { getWalletBalances, getTokenPnlData, getTradeStats }                from './okx'
import type { WalletProfile, TokenInfo, SharedToken, SseEvent }             from './types'

const CONCURRENCY = 5

// Cap for the co-held / co-traded dropdowns. Pure UI affordance — anything
// past ~150 entries is unusable in a dropdown, even with search.
const SHARED_LIST_LIMIT = 150

// OKX returns holdingTime as unix SECONDS (per their docs / observed). Defensive
// against a future API change to milliseconds: anything past 1e12 (year 2001+
// in millis) is already in millis; below that it's seconds, multiply by 1000.
function holdingTimeToMillis(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000
}

function getRpcUrl(): string {
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL
  const key = process.env.HELIUS_API_KEY
  if (!key) throw new Error('HELIUS_API_KEY is not set in environment')
  return `https://mainnet.helius-rpc.com/?api-key=${key}`
}

async function pMap<T>(arr: T[], fn: (item: T, idx: number) => Promise<void>, concurrency: number) {
  let next = 0
  async function worker() { while (next < arr.length) { const i = next++; await fn(arr[i], i) } }
  await Promise.all(Array.from({ length: Math.min(concurrency, arr.length) }, worker))
}

export async function analyzeToken(
  mint:    string,
  topN:    number,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const rpcUrl = getRpcUrl()

  const [holders, supply] = await Promise.all([
    getTopHolders(rpcUrl, mint, topN),
    getTokenSupplyInfo(rpcUrl, mint),
  ])

  if (!holders.length) {
    onEvent({ type: 'error', message: 'No holders found for this mint. Check the address.' })
    return
  }

  const accountTypes = await getAccountTypes(rpcUrl, holders.map(h => h.owner)).catch(() => new Map())

  const mintMeta       = new Map<string, { symbol: string; logoUrl: string }>()
  const mintCount      = new Map<string, number>()   // co-holds: currently held
  const tradedCount    = new Map<string, number>()   // co-trades: traded in 90d

  let tokenPrice: number | null = null

  const total = holders.length
  let done    = 0

  await pMap(holders, async (holder, idx) => {
    // Announce work-in-progress so the UI can show "Analyzing X…".
    // done is unchanged here; it advances only after the wallet finishes below.
    onEvent({ type: 'progress', done, total, address: holder.owner })

    const balance   = Number(holder.amount) / Math.pow(10, supply.decimals)
    const supplyPct = supply.uiAmount > 0 ? (balance / supply.uiAmount) * 100 : 0

    // Fetch all three data sources in parallel
    const [balances, pnl, tradeStats] = await Promise.all([
      getWalletBalances(holder.owner, mint).catch(() => null),
      getTokenPnlData(holder.owner, mint).catch(() => null),
      getTradeStats(holder.owner).catch(() => null),
    ])

    // Collect mint→symbol for co-holds dropdown
    if (balances) {
      for (const t of balances.allTokens) {
        // Native SOL comes through with mint='' from OKX — skip it. The previous
        // version still incremented mintCount for empty strings and relied on
        // buildSharedList to filter them out at the end (wasted memory + reads).
        if (!t.mint) continue
        if (t.symbol) mintMeta.set(t.mint, { symbol: t.symbol, logoUrl: '' })
        mintCount.set(t.mint, (mintCount.get(t.mint) ?? 0) + 1)
      }
      // Last-write-wins: each wallet's OKX response carries a fresh price snapshot,
      // and pMap completion order ≈ fetch return order, so overwriting gives us the
      // newest known price by the time the run ends. Fixes a stale-price bug where
      // the first wallet to return locked in a price for the whole run, even when
      // later wallets had data 5–30s newer (meaningful for meme coins).
      if (balances.targetTokenPrice != null && balances.targetTokenPrice > 0) {
        tokenPrice = balances.targetTokenPrice
      }
    }

    // Collect traded mints for co-trades dropdown (free — already in tradeStats)
    if (tradeStats?.tradedMints90d) {
      for (const m of tradeStats.tradedMints90d) {
        if (m && m !== mint) {
          // Try to get symbol from mintMeta (populated by balances above)
          tradedCount.set(m, (tradedCount.get(m) ?? 0) + 1)
        }
      }
    }

    // Use signed API as primary source for balanceUsd; fall back to pnl/token-list
    // when the wallet doesn't appear in OKX's signed token list. Common for PDAs,
    // vaults, and certain LP positions where OKX's discoverable balances miss the
    // target token but priapi still has trade history for it.
    const balanceUsdSigned = balances?.targetBalanceUsd ?? null
    const balanceUsd       = balanceUsdSigned ?? (pnl ? parseFloat(pnl.balanceUsd) : null)
    const portfolioUsd     = balances?.portfolioTotalUsd ?? null
    const splUsd           = balances?.splTotalUsd ?? null

    const profile: WalletProfile = {
      address:   holder.owner,
      rank:      idx + 1,
      rawAmount: holder.amount.toString(),
      balance,
      supplyPct,

      balanceUsd,
      balanceUsdEstimated: false,   // signed API is authoritative — no estimation needed

      realizedPnl:             pnl ? parseFloat(pnl.realizedPnl)           : null,
      unrealizedPnl:           pnl ? parseFloat(pnl.unrealizedPnl)         : null,
      totalPnl:                pnl ? parseFloat(pnl.totalPnl)              : null,
      realizedPnlPct:          pnl ? parseFloat(pnl.realizedPnlPercentage) : null,
      totalPnlPct:             pnl ? parseFloat(pnl.totalPnlPercentage)    : null,
      buyVolumeSol:            pnl ? parseFloat(pnl.buyVolume)             : null,
      sellVolumeSol:           pnl ? parseFloat(pnl.sellVolume)            : null,
      totalTxBuy:              pnl?.totalTxBuy              ?? null,
      totalTxSell:             pnl?.totalTxSell             ?? null,
      holdingTimestamp:        pnl?.holdingTime ? holdingTimeToMillis(pnl.holdingTime) : null,
      holdAmountPctForMaxHold: pnl?.holdAmountPctForMaxHold ?? null,

      portfolioTotalUsd: portfolioUsd,
      splTotalUsd:       splUsd,
      // Source-consistency gate: only compute portfolio-share ratios when the
      // numerator (target balance USD) and denominator (portfolio / SPL USD) come
      // from the SAME OKX signed snapshot. If we had to fall back to priapi for the
      // numerator, the two USD values use different price bases and timestamps —
      // for PDAs the typical pathology is a $13K priapi position over a $0.18
      // signed-portfolio (OKX only sees the dust SOL the PDA holds), giving
      // ratios in the millions of percent. Returning null here keeps these rows
      // out of cohort averages instead of polluting them.
      tokenPctOfTotal:   (balanceUsdSigned != null && portfolioUsd != null && portfolioUsd > 0)
        ? (balanceUsdSigned / portfolioUsd) * 100 : null,
      tokenPctOfSpl:     (balanceUsdSigned != null && splUsd != null && splUsd > 0)
        ? (balanceUsdSigned / splUsd) * 100 : null,

      uniqueTokens7d:  tradeStats?.uniqueTokens7d  ?? null,
      uniqueTokens90d: tradeStats?.uniqueTokens90d ?? null,

      allMints:    balances?.allMints ?? [],
      tradedMints: tradeStats?.tradedMints90d ?? [],
      accountType: accountTypes.get(holder.owner) ?? null,
    }

    done++
    // Emit progress AFTER done advances so the UI bar grows monotonically.
    // Without this, the only progress events were sent BEFORE done++ — so the
    // bar would never reach 100% from progress alone, only from wallet events.
    onEvent({ type: 'progress', done, total, address: holder.owner })
    onEvent({ type: 'wallet', wallet: profile })
  }, CONCURRENCY)

  function buildSharedList(countMap: Map<string, number>): SharedToken[] {
    return [...countMap.entries()]
      .filter(([m]) => m !== mint && m !== '')
      .map(([m, count]) => {
        const meta = mintMeta.get(m) ?? { symbol: m.slice(0, 6) + '…', logoUrl: '' }
        return { mint: m, symbol: meta.symbol, logoUrl: meta.logoUrl, count }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, SHARED_LIST_LIMIT)
  }

  const sharedTokens       = buildSharedList(mintCount)    // co-holds
  const sharedTradedTokens = buildSharedList(tradedCount)  // co-trades (90d history)

  const meta      = await getTokenMeta(rpcUrl, mint)
  const tokenInfo: TokenInfo = {
    mint, symbol: meta.symbol, name: meta.name,
    decimals: supply.decimals, supply: supply.uiAmount, logoUrl: meta.logoUrl,
  }

  onEvent({ type: 'complete', token: tokenInfo, tokenPrice, sharedTokens, sharedTradedTokens })
}
