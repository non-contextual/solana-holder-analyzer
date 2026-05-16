// Wallet intelligence: entity labels + behavioral analysis
//
// Three-layer approach:
// 1. Hardcoded KNOWN_ENTITIES — major CEXes / bridges / protocols. Edited
//    via code review since they're security-relevant (Binance, etc.).
// 2. User-curated labels in data/labels.json — analysts append entities they
//    identify in the wild (stake.com hot wallet, niche bridges, …). Loaded
//    lazily so editing the file doesn't require a server restart.
// 3. Behavioral heuristics from transfer patterns — cex-like / mixer-like /
//    bot-like, computed per scan from the actual transfer set.
// Layer 1 and 2 merge into the runtime lookup with user labels taking
// precedence on collision (so an analyst can override a stale hardcoded entry).

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { RawTransfer } from './helius'
import type { GraphNode } from './transfer-scan'

export type EntityType = 'cex' | 'mixer' | 'protocol' | 'sanctioned' | 'whale' | 'bot' | 'bridge'

export interface EntityLabel {
  name:  string
  type:  EntityType
  note?: string
}

// ── Static known entities (Solana mainnet) ────────────────────────────────────
// Sources: Solscan labels, SolanaFM entity registry, public blockchain research.
// Add/update as needed — addresses are immutable once labeled on-chain.
export const KNOWN_ENTITIES: Record<string, EntityLabel> = {
  // ── Binance ──
  '5tzFkiKscXHK5ZXCGbXZxdw7gA3djnjE4RSwRRCXZqDe': { name: 'Binance',  type: 'cex' },
  'DtmE9D2CSB4L5D6A15mr4Ry8E8VHtAXKqJ6xRGixXVXD': { name: 'Binance',  type: 'cex', note: 'Hot wallet 2' },
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': { name: 'Binance',  type: 'cex' },
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': { name: 'Binance',  type: 'cex' },

  // ── OKX ──
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5': { name: 'OKX',      type: 'cex' },
  '3n1kpnFY38fRqXQYFYGTHSGHLBVfMqXuzXKhV7VTnhpj': { name: 'OKX',      type: 'cex', note: 'Hot wallet' },

  // ── Coinbase ──
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7ek7':  { name: 'Coinbase', type: 'cex' },

  // ── Bybit ──
  'A7SB78R8wqDJhijZhsYYaLjfmKDfHjWbN4Qjh7hKLPuH': { name: 'Bybit',    type: 'cex' },

  // ── Bitget ──
  'DVh5Bm5n8NJCpvh3Wkr1GBQ9Kq1FN9xQjF4R3ZaWTW8': { name: 'Bitget',   type: 'cex' },

  // ── Kraken ──
  'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6': { name: 'Kraken',   type: 'cex' },

  // ── Upbit ──
  'CtpGEGCHYtWv8wPFXwSaXLjbTJGHDn9YkE2Ks1T1CrLG': { name: 'Upbit',    type: 'cex' },

  // ── Gate.io ──
  'HkH1Gdgxcq45tH9xYdBhJcbxFdGbGEMEcETMijVkVCWj': { name: 'Gate.io',  type: 'cex' },

  // ── Cross-chain bridges ──
  'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb':  { name: 'Wormhole',    type: 'bridge' },
  'WnFt12ZrnzZrFZkt2xsNsaNWoQribnuQ5B5FrDbwDhD':  { name: 'Wormhole Token Bridge', type: 'bridge' },
  'jCebN34bUfdeUYJT13J1yG16XWQpt5ai1WF1g5t8XMb':  { name: 'deBridge',    type: 'bridge' },
  'DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsyD712YBH': { name: 'Allbridge',   type: 'bridge' },
  'HxhWkVpk5NS4Ltg5nij2G671CKXFRKPK8vy271Ub4uEK': { name: 'Allbridge Core', type: 'bridge' },
  'MayanCoRe3L4EkyKxgJFWjH3FJMxjP1KLWnmGVBHzxb':  { name: 'Mayan Finance', type: 'bridge' },
  'BrdgNJB3JSQfJq5JzPpfBEsL3C1b7VEHF4QEm8fFwgHB': { name: 'Stargate',    type: 'bridge' },
  'AcMNFMEXLEMhbMFXe4oqFnJ3T16cNqkx2xPDZmoBjZMr': { name: 'Across Protocol', type: 'bridge' },

  // ── Solana staking / protocol ──
  'Jito4APyf642JPeW1UUa9is4AY6wLPwMqmm4PY1j4MG':  { name: 'Jito Tips',  type: 'protocol' },
  'mpa4abUkjQoAvPzREkh5Mo75hZhPFQ2FSH6w7dWKuQ5':  { name: 'Marinade',   type: 'protocol' },
}

// ── User-curated label store ──────────────────────────────────────────────────
// data/labels.json layout: { "address": { name, type, note?, addedAt? } }
// Reads + caches the file content; getEntityLabel() merges the cache with
// KNOWN_ENTITIES. Reload is automatic when the file's mtime changes (cheap
// stat call), so an analyst can edit the file or hit POST /api/labels and
// the next scan picks it up without a restart.
interface LabelStore {
  data:  Record<string, EntityLabel & { addedAt?: number }>
  mtime: number
}
let _labelStore: LabelStore | null = null
function labelsPath(): string {
  // Resolve to data/labels.json next to data/_transfers (already used by storage.ts)
  return join(__dirname, '..', 'data', 'labels.json')
}
function loadCustomLabels(): Record<string, EntityLabel & { addedAt?: number }> {
  const path = labelsPath()
  if (!existsSync(path)) {
    _labelStore = { data: {}, mtime: 0 }
    return {}
  }
  try {
    const stat = require('fs').statSync(path)
    if (_labelStore && _labelStore.mtime === stat.mtimeMs) return _labelStore.data
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, EntityLabel & { addedAt?: number }>
    _labelStore = { data: parsed, mtime: stat.mtimeMs }
    return parsed
  } catch (err) {
    console.warn('[labels] failed to load custom labels:', (err as Error).message)
    return {}
  }
}
export function getEntityLabel(address: string): EntityLabel | undefined {
  // User labels win on collision so an analyst can correct stale hardcoded
  // entries without a code change.
  const custom = loadCustomLabels()
  return custom[address] ?? KNOWN_ENTITIES[address]
}

// Append/update a label. Used by the POST /api/labels endpoint.
export function saveCustomLabel(address: string, label: EntityLabel): void {
  const path = labelsPath()
  let current: Record<string, EntityLabel & { addedAt?: number }> = {}
  if (existsSync(path)) {
    try { current = JSON.parse(readFileSync(path, 'utf8')) } catch { /* start fresh */ }
  }
  current[address] = { ...label, addedAt: Date.now() }
  writeFileSync(path, JSON.stringify(current, null, 2), 'utf8')
  _labelStore = null   // invalidate cache so the next load sees the new content
}

export function deleteCustomLabel(address: string): boolean {
  const path = labelsPath()
  if (!existsSync(path)) return false
  let current: Record<string, EntityLabel> = {}
  try { current = JSON.parse(readFileSync(path, 'utf8')) } catch { return false }
  if (!(address in current)) return false
  delete current[address]
  writeFileSync(path, JSON.stringify(current, null, 2), 'utf8')
  _labelStore = null
  return true
}

export function listCustomLabels(): Record<string, EntityLabel & { addedAt?: number }> {
  return { ...loadCustomLabels() }
}

// ── Behavioral analysis ───────────────────────────────────────────────────────

// ── Rate-based behavioral stats ───────────────────────────────────────────────
// All temporal metrics are normalized to per-hour or per-tx so they're
// comparable regardless of the observation window.

export interface WalletStats {
  address:         string
  inDegree:        number   // unique senders
  outDegree:       number   // unique receivers
  txCount:         number
  txPerHour:       number   // sustained rate — key bot signal
  interTxMean:     number   // mean seconds between consecutive txs (sorted by time)
  interTxCV:       number   // coeff. of variation of inter-tx intervals
                            //   low (<0.3) = clock-like regularity → bot
  burstRatio:      number   // fraction of txs within 60s of previous → burst score
  amountCV:        number   // coeff. of variation of amounts; low = fixed amounts
  uniqueCPRatio:   number   // unique counterparties / txCount; high = scatter
  timeSpanHours:   number
}

export interface WalletIntelligence {
  address:      string
  staticLabel?: EntityLabel
  behaviorTags: string[]    // ordered by confidence
  riskScore:    number      // 0–100
  summary:      string      // one-liner for UI
  stats?:       Partial<WalletStats>
}

function mean(vals: number[]): number {
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
}

function cv(vals: number[]): number {
  if (vals.length < 2) return 1
  const m = mean(vals)
  if (m === 0) return 1
  const s = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length)
  return s / m
}

export function computeWalletStats(
  address:   string,
  transfers: RawTransfer[],
  // Optional pre-built address → transfers index. When analyzing many wallets
  // against the same transfer set, building this once turns the naive O(N×M)
  // per-wallet filter into O(M) total. Falls back to a filter if not supplied.
  byAddress?: Map<string, RawTransfer[]>,
): WalletStats {
  const candidates = byAddress?.get(address) ?? transfers
  const inTxs  = candidates.filter(t => t.to   === address)
  const outTxs = candidates.filter(t => t.from === address)
  const all    = [...inTxs, ...outTxs]

  const empty: WalletStats = { address, inDegree: 0, outDegree: 0, txCount: 0, txPerHour: 0, interTxMean: 0, interTxCV: 1, burstRatio: 0, amountCV: 1, uniqueCPRatio: 1, timeSpanHours: 0 }
  if (all.length < 2) return empty

  const inAddrs  = new Set(inTxs.map(t => t.from))
  const outAddrs = new Set(outTxs.map(t => t.to))
  const allAddrs = new Set([...inTxs.map(t => t.from), ...outTxs.map(t => t.to)])
  const amounts  = all.map(t => t.amount)

  // Sort by timestamp to compute inter-tx intervals
  const sorted   = [...all].sort((a, b) => a.timestamp - b.timestamp)
  const ts       = sorted.map(t => t.timestamp)
  const span     = (ts[ts.length - 1] - ts[0]) / 3600   // hours

  const intervals = ts.slice(1).map((t, i) => t - ts[i])   // seconds between consecutive txs
  const burstCount = intervals.filter(dt => dt <= 60).length

  return {
    address,
    inDegree:      inAddrs.size,
    outDegree:     outAddrs.size,
    txCount:       all.length,
    txPerHour:     span > 0 ? all.length / span : 0,
    interTxMean:   mean(intervals),
    interTxCV:     cv(intervals),   // < 0.3 → machine-like regularity
    burstRatio:    intervals.length > 0 ? burstCount / intervals.length : 0,
    amountCV:      cv(amounts),     // < 0.15 → fixed amounts
    uniqueCPRatio: all.length > 0 ? allAddrs.size / all.length : 1,
    timeSpanHours: span,
  }
}

export function analyzeWallet(
  address:   string,
  transfers: RawTransfer[],
  _layer:    number,
  byAddress?: Map<string, RawTransfer[]>,
): WalletIntelligence {
  const staticLabel = getEntityLabel(address)
  const tags: string[] = []
  let riskScore = 0
  const notes: string[] = []

  if (staticLabel) {
    riskScore += staticLabel.type === 'sanctioned' ? 100
               : staticLabel.type === 'mixer'      ? 90
               : staticLabel.type === 'cex'        ? 70
               : staticLabel.type === 'bridge'     ? 40
               : 30
    tags.push(staticLabel.type)
    notes.push(staticLabel.name)
    return { address, staticLabel, behaviorTags: tags, riskScore: Math.min(riskScore, 100), summary: notes.join(' · ') }
  }

  const s = computeWalletStats(address, transfers, byAddress)
  if (s.txCount < 3) {
    return { address, behaviorTags: [], riskScore: 0, summary: 'insufficient data' }
  }

  // ── Rate signals ────────────────────────────────────────────────────────────

  // Sustained high tx rate: humans rarely exceed 5/hr consistently
  if (s.txPerHour > 30) { tags.push('bot-rate'); riskScore += 40; notes.push(`${s.txPerHour.toFixed(0)} tx/hr`) }
  else if (s.txPerHour > 10) { tags.push('high-rate'); riskScore += 20; notes.push(`${s.txPerHour.toFixed(0)} tx/hr`) }
  else if (s.txPerHour > 3) { riskScore += 5 }

  // Clock-like inter-tx regularity: low CV of intervals = machine precision
  if (s.interTxCV < 0.15 && s.txCount > 8) {
    tags.push('clock-like'); riskScore += 35
    notes.push(`interval CV=${s.interTxCV.toFixed(2)} (machine-regular)`)
  } else if (s.interTxCV < 0.3 && s.txCount > 12) {
    tags.push('semi-regular'); riskScore += 15
    notes.push(`interval CV=${s.interTxCV.toFixed(2)}`)
  }

  // Burst: many txs within 60s windows
  if (s.burstRatio > 0.7) { tags.push('burst-sender'); riskScore += 25; notes.push(`${(s.burstRatio*100).toFixed(0)}% txs in 60s bursts`) }
  else if (s.burstRatio > 0.4) { tags.push('partial-burst'); riskScore += 10 }

  // ── Amount signals ──────────────────────────────────────────────────────────

  // Very low amount variability: automated fixed-amount transfers
  if (s.amountCV < 0.1 && s.txCount > 6) {
    tags.push('fixed-amounts'); riskScore += 30
    notes.push(`amount CV=${s.amountCV.toFixed(2)} (nearly identical amounts)`)
  } else if (s.amountCV < 0.25 && s.txCount > 10) {
    tags.push('uniform-amounts'); riskScore += 10
  }

  // ── Topology signals ────────────────────────────────────────────────────────

  // High unique counterparty ratio with large out-degree → scatter (CEX withdraw / mixer output)
  if (s.uniqueCPRatio > 0.85 && s.outDegree > 30) {
    tags.push('scatter'); riskScore += 30
    notes.push(`scatters to ${s.outDegree} unique addresses`)
  }

  // High fan-in from many distinct sources → exchange deposit or aggregator
  if (s.inDegree > 50) { tags.push('high-fan-in'); riskScore += 20; notes.push(`received from ${s.inDegree} addresses`) }

  // ── Composite patterns ──────────────────────────────────────────────────────

  // Strong bot signal: high rate + clock-like + fixed amounts
  if (tags.includes('bot-rate') || (tags.includes('high-rate') && tags.includes('clock-like'))) {
    if (!tags.includes('bot-like')) tags.unshift('bot-like')
    riskScore = Math.max(riskScore, 70)
    if (!notes.some(n => n.includes('bot'))) notes.unshift('automated/bot behavior')
  }

  // CEX withdrawal pattern: scatter + fixed amounts + high rate
  if (tags.includes('scatter') && (tags.includes('fixed-amounts') || tags.includes('uniform-amounts'))) {
    if (!tags.includes('cex-like')) tags.unshift('cex-like')
    riskScore = Math.max(riskScore, 65)
    if (!notes.some(n => n.includes('CEX'))) notes.unshift('suspected CEX withdrawal address')
  }

  // Mixer pattern: balanced in/out + fixed amounts + scatter
  if (s.inDegree > 5 && s.outDegree > 5 && Math.abs(s.inDegree - s.outDegree) / Math.max(s.inDegree, s.outDegree) < 0.4
      && (tags.includes('fixed-amounts') || tags.includes('uniform-amounts'))
      && s.uniqueCPRatio > 0.6) {
    if (!tags.includes('mixer-like')) tags.unshift('mixer-like')
    riskScore = Math.max(riskScore, 75)
    if (!notes.some(n => n.includes('mixer'))) notes.unshift('mixer-like: balanced in/out with uniform amounts')
  }

  const summary = notes.length ? notes.join(' · ') : 'no notable pattern'
  return { address, staticLabel, behaviorTags: tags, riskScore: Math.min(riskScore, 100), summary, stats: { txPerHour: s.txPerHour, interTxCV: s.interTxCV, burstRatio: s.burstRatio, amountCV: s.amountCV, outDegree: s.outDegree } }
}

export async function analyzeAllWallets(
  nodes:     GraphNode[],
  transfers: RawTransfer[],
): Promise<Map<string, WalletIntelligence>> {
  // Build a single address → transfers index up front so each per-wallet
  // analysis runs against a small bucket instead of scanning all transfers.
  // For typical scans (~30k transfers, ~3k wallets) this drops a multi-second
  // O(N×M) loop to under a second.
  const byAddress = new Map<string, RawTransfer[]>()
  for (const t of transfers) {
    if (t.from) {
      const arr = byAddress.get(t.from); if (arr) arr.push(t); else byAddress.set(t.from, [t])
    }
    if (t.to && t.to !== t.from) {
      const arr = byAddress.get(t.to); if (arr) arr.push(t); else byAddress.set(t.to, [t])
    }
  }

  const result = new Map<string, WalletIntelligence>()
  for (const node of nodes) {
    // Layer 99 (external) nodes are usually transient — most have just 1-2
    // transfers, not enough for meaningful behavior signal. But they can be
    // known CEX/bridge addresses (static label), and any layer-99 node that
    // touched 5+ transfers in this scan window is worth analyzing because
    // that's where "CEX deposit one hop from the seed" patterns live.
    if (node.layer > 3) {
      const txs = byAddress.get(node.address) ?? []
      if (!getEntityLabel(node.address) && txs.length < 5) continue
    }
    const intel = analyzeWallet(node.address, transfers, node.layer, byAddress)
    if (intel.riskScore > 0 || intel.staticLabel || intel.behaviorTags.length) {
      result.set(node.address, intel)
    }
  }
  return result
}
