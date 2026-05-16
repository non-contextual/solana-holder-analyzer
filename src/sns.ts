// Reverse-lookup of Solana Name Service (SNS) domains for a wallet address.
// Bonfida's public REST endpoint takes an owner address and returns every
// .sol domain that owner holds. Free, no API key, but per-request — so we
// rate-limit to avoid hammering them when sweeping a 250-node graph.
//
// Coverage is partial (maybe 5-10% of wallets own an SNS domain), but the
// hits are high-signal: a wallet owning "solcasinobetter.sol" or
// "binance-deposit.sol" tells the analyst more than any heuristic could.

const BONFIDA = 'https://sns-api.bonfida.com/v2/user/domains'
const TIMEOUT_MS = 8_000
const CONCURRENCY = 6   // ~6 req/s — polite to a free public API

export interface SnsLookup {
  domains:  string[]   // sorted by length asc (shorter = more memorable / older / more authoritative)
  primary:  string | undefined   // shortest, used as the "label" suggestion
}

async function fetchOne(address: string, abortSig?: AbortSignal): Promise<string[]> {
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS)
  const onOuter = () => ac.abort()
  abortSig?.addEventListener('abort', onOuter)
  try {
    const res = await fetch(`${BONFIDA}/${address}`, { signal: ac.signal })
    if (!res.ok) return []
    const data = (await res.json()) as Record<string, string[]>
    return data[address] ?? []
  } catch {
    return []   // any error → no domains (don't block the whole sweep)
  } finally {
    clearTimeout(to)
    abortSig?.removeEventListener('abort', onOuter)
  }
}

/**
 * Batch SNS reverse-lookup. Returns a Map keyed by address, values include
 * every .sol domain owned and a shorthand "primary" domain that callers can
 * surface as the label.
 *
 * Implemented as a worker pool over `addresses` to keep concurrent fetches
 * to a polite limit. Skipped addresses (no domains, or fetch error) are not
 * inserted into the result map.
 */
export async function lookupSnsDomains(
  addresses: string[],
  abortSig?: AbortSignal,
): Promise<Map<string, SnsLookup>> {
  const result = new Map<string, SnsLookup>()
  if (!addresses.length) return result

  let cursor = 0
  async function worker() {
    while (cursor < addresses.length) {
      if (abortSig?.aborted) return
      const i = cursor++
      const addr = addresses[i]
      const domains = await fetchOne(addr, abortSig)
      if (!domains.length) continue
      const sorted = [...domains].sort((a, b) => a.length - b.length)
      result.set(addr, { domains: sorted, primary: sorted[0] })
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker))
  return result
}

// Heuristic guess of entity type from an SNS domain string. Useful when we
// have a domain but no manual override — saves the analyst a step.
// Returns null when the name doesn't pattern-match anything specific; the
// caller still has the raw domain to surface as text.
export function entityTypeFromDomain(domain: string): 'cex' | 'bridge' | 'mixer' | 'protocol' | null {
  // Strip stylistic separators (emoji, dots, dashes) before keyword matching.
  // Domains like '🫦sexonsol🫦dot🫦com🫦' would otherwise miss the 'com' / brand
  // hint. Lowercased, only letters/digits remain for the regex check.
  const d = domain.toLowerCase().replace(/[^a-z0-9]/g, '')
  // CEX / casino / exchange hints — both real crypto exchanges AND on-chain
  // casinos (stake, flip.gg, rollbit etc.) because they look identical from
  // a flow-analysis perspective: hot wallets with high turnover.
  if (/(stake|casino|bet|gamble|flipgg|rollbit|shuffle|crashbit|hilo|cardgames|exchange|cex|deposit|hotwallet|trading|binance|okx|kucoin|gateio|kraken|coinbase|bitget|bybit|mexc|cryptocom|huobi|htx|upbit|hashkey)/.test(d)) return 'cex'
  // Bridge / cross-chain hints
  if (/(bridge|wormhole|stargate|allbridge|debridge|mayan|across|portal|chainflip|relay)/.test(d)) return 'bridge'
  // Mixer / privacy hints
  if (/(mix|tornado|shielded|private|anon|cyclos)/.test(d)) return 'mixer'
  // Known DeFi protocols
  if (/(jupiter|raydium|orca|meteora|jito|marinade|drift|phoenix|kamino|mango|tensor|magiceden)/.test(d)) return 'protocol'
  return null
}
