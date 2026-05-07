// Snapshot persistence — saves/loads analysis results as JSON files.
// File layout: data/{mint}/{timestamp_ms}.json
// The `data/` directory lives next to `src/` in the project root.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import type { WalletProfile, TokenInfo } from './types'

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
    require('fs').unlinkSync(path)
    return true
  } catch {
    return false
  }
}
