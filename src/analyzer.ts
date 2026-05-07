import { getTopHolders, getTokenSupplyInfo, getTokenMeta, getAccountTypes } from './solana'
import { getWalletBalances, getTokenPnlData, getTradeStats }                from './okx'
import type { WalletProfile, TokenInfo, SharedToken, SseEvent }             from './types'

const CONCURRENCY = 5

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
        if (t.mint && t.symbol) mintMeta.set(t.mint, { symbol: t.symbol, logoUrl: '' })
        mintCount.set(t.mint, (mintCount.get(t.mint) ?? 0) + 1)
      }
      if (tokenPrice == null && balances.targetTokenPrice != null && balances.targetTokenPrice > 0) {
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
    const balanceUsd   = balances?.targetBalanceUsd ?? (pnl ? parseFloat(pnl.balanceUsd) : null)
    const portfolioUsd = balances?.portfolioTotalUsd ?? null
    const splUsd       = balances?.splTotalUsd ?? null

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
      holdingTimestamp:        pnl?.holdingTime ? pnl.holdingTime * 1000 : null,
      holdAmountPctForMaxHold: pnl?.holdAmountPctForMaxHold ?? null,

      portfolioTotalUsd: portfolioUsd,
      splTotalUsd:       splUsd,
      tokenPctOfTotal:   (balanceUsd != null && portfolioUsd != null && portfolioUsd > 0)
        ? (balanceUsd / portfolioUsd) * 100 : null,
      tokenPctOfSpl:     (balanceUsd != null && splUsd != null && splUsd > 0)
        ? (balanceUsd / splUsd) * 100 : null,

      uniqueTokens7d:  tradeStats?.uniqueTokens7d  ?? null,
      uniqueTokens90d: tradeStats?.uniqueTokens90d ?? null,

      allMints:    balances?.allMints ?? [],
      tradedMints: tradeStats?.tradedMints90d ?? [],
      accountType: accountTypes.get(holder.owner) ?? null,
    }

    done++
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
      .slice(0, 150)
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
