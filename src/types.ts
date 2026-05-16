export interface TokenInfo {
  mint:     string
  symbol:   string
  name:     string
  decimals: number
  supply:   number
  logoUrl?: string
}

export interface WalletProfile {
  address:  string
  rank:     number

  rawAmount: string
  balance:   number   // UI-formatted
  supplyPct: number   // 0-100

  // target-token PnL (null when wallet got token via transfer rather than DEX trade)
  balanceUsd:              number | null
  balanceUsdEstimated:     boolean        // true = derived from inferred price, not OKX
  realizedPnl:             number | null
  unrealizedPnl:           number | null
  totalPnl:                number | null
  realizedPnlPct:          number | null
  totalPnlPct:             number | null
  buyVolumeSol:            number | null
  sellVolumeSol:           number | null
  totalTxBuy:              number | null
  totalTxSell:             number | null
  holdingTimestamp:        number | null   // ms
  holdAmountPctForMaxHold: number | null

  // portfolio metrics
  portfolioTotalUsd: number | null
  splTotalUsd:       number | null
  tokenPctOfTotal:   number | null
  tokenPctOfSpl:     number | null

  // activity metrics
  uniqueTokens7d:  number | null
  uniqueTokens90d: number | null

  // all token mints held (for co-holder filter)
  allMints: string[]
  // tokens traded in last 90d (for co-trades filter)
  tradedMints: string[]

  // on-chain account type
  accountType: 'wallet' | 'program' | 'bonding_curve' | 'lp' | 'pda' | 'closed' | null
}

// Token commonly held across multiple analyzed wallets (for co-holder dropdown)
export interface SharedToken {
  mint:     string
  symbol:   string
  logoUrl:  string
  count:    number   // number of wallets that hold this token
  // Total USD across the wallets that hold this token. 0 for the co-trades
  // list (priapi trade history doesn't carry USD per row), populated only
  // for co-holds (OKX signed balance rows do).
  totalUsd: number
}

export interface ProgressEvent { type: 'progress'; done: number; total: number; address: string }
export interface WalletEvent   { type: 'wallet';   wallet: WalletProfile }
export interface CompleteEvent {
  type:               'complete'
  token:              TokenInfo
  tokenPrice:         number | null
  sharedTokens:       SharedToken[]   // co-held: currently holding
  sharedTradedTokens: SharedToken[]   // co-traded: traded in last 90d
}
export interface ErrorEvent    { type: 'error';    message: string }

export type SseEvent = ProgressEvent | WalletEvent | CompleteEvent | ErrorEvent
