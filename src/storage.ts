// Snapshot persistence — saves/loads analysis results as JSON files.
// File layout: data/{mint}/{timestamp_ms}.json
// The `data/` directory lives next to `src/` in the project root.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import type { WalletProfile, TokenInfo, SharedToken } from './types'

// Prevent path traversal: mint must be base58 (alphanumeric, no slashes/dots)
function validateMint(mint: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new Error(`Invalid mint address: ${mint}`)
  }
}
// Filename must be "{digits}.json" — nothing else
function validateFilename(filename: string): void {
  if (!/^\d+\.json$/.test(basename(filename))) {
    throw new Error(`Invalid snapshot filename: ${filename}`)
  }
}

export interface Snapshot {
  mint:       string
  analyzedAt: number      // unix ms
  token:      TokenInfo
  wallets:    WalletProfile[]
  note?:      string      // optional user label
  // Cohort-level dropdowns. Optional for backward compatibility with snapshots
  // saved before these were persisted; loader falls back to [].
  sharedTokens?:       SharedToken[]
  sharedTradedTokens?: SharedToken[]
}

export interface SnapshotMeta {
  mint:       string
  analyzedAt: number
  filename:   string
  walletCount: number
  note?:      string
  tokenSymbol: string
}

function dataDir(): string {
  return join(__dirname, '..', 'data')
}

function mintDir(mint: string): string {
  return join(dataDir(), mint)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function saveSnapshot(snapshot: Snapshot): string {
  validateMint(snapshot.mint)
  ensureDir(mintDir(snapshot.mint))
  const filename = `${snapshot.analyzedAt}.json`
  const path = join(mintDir(snapshot.mint), filename)
  writeFileSync(path, JSON.stringify(snapshot), 'utf8')
  return filename
}

export function listSnapshots(mint: string): SnapshotMeta[] {
  const dir = mintDir(mint)
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Snapshot
        return {
          mint:        raw.mint,
          analyzedAt:  raw.analyzedAt,
          filename:    f,
          walletCount: raw.wallets.length,
          note:        raw.note,
          tokenSymbol: raw.token.symbol,
        }
      } catch {
        return null
      }
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => b!.analyzedAt - a!.analyzedAt)  // newest first
}

export function listAllSnapshots(): SnapshotMeta[] {
  const dir = dataDir()
  if (!existsSync(dir)) return []

  const all: SnapshotMeta[] = []
  for (const mint of readdirSync(dir)) {
    all.push(...listSnapshots(mint))
  }
  return all.sort((a, b) => b.analyzedAt - a.analyzedAt)
}

export function loadSnapshot(mint: string, filename: string): Snapshot | null {
  validateMint(mint); validateFilename(filename)
  const path = join(mintDir(mint), filename)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Snapshot
  } catch {
    return null
  }
}

export function deleteSnapshot(mint: string, filename: string): boolean {
  validateMint(mint); validateFilename(filename)
  const path = join(mintDir(mint), filename)
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

// ── Transfer scan snapshots ───────────────────────────────────────────────────
// Stored in data/transfers/{timestamp}.json

function transferDir(): string {
  return join(dataDir(), '_transfers')
}

export interface TransferSnapshotMeta {
  filename:  string
  savedAt:   number
  wallets:   string[]   // first 3 seed addresses
  note?:     string
  nodeCount: number
}

export function saveTransferSnapshot(snap: Record<string, unknown>): string {
  const dir = transferDir()
  ensureDir(dir)
  const ts  = Date.now()
  const filename = `${ts}.json`
  writeFileSync(join(dir, filename), JSON.stringify({ ...snap, savedAt: ts }), 'utf8')
  return filename
}

export function listTransferSnapshots(): TransferSnapshotMeta[] {
  const dir = transferDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => /^\d+\.json$/.test(f))
    .sort().reverse()
    .slice(0, 50)
    .map(f => {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        return {
          filename:  f,
          savedAt:   raw.savedAt ?? 0,
          wallets:   (raw.wallets ?? []).slice(0, 3),
          note:      raw.note,
          nodeCount: raw.graph?.nodes?.length ?? 0,
        } as TransferSnapshotMeta
      } catch { return null }
    })
    .filter((m): m is TransferSnapshotMeta => m !== null)
}

export function loadTransferSnapshot(filename: string): Record<string, unknown> | null {
  validateFilename(filename)
  const path = join(transferDir(), filename)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function deleteTransferSnapshot(filename: string): boolean {
  validateFilename(filename)
  const path = join(transferDir(), filename)
  if (!existsSync(path)) return false
  try { unlinkSync(path); return true } catch { return false }
}
