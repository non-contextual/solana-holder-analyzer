// Solana RPC helpers — top holders, token supply, token metadata
// Adapted from clique-analyzer with Helius DAS support for metadata

import { PublicKey } from '@solana/web3.js'
import type { TokenInfo } from './types'

const TOKEN_PROGRAM   = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN22_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const MAX_HOLDER_ACCOUNTS = 300_000

export interface OnchainHolder {
  owner:  string
  amount: bigint
}

function splitHeliusAuth(rpcUrl: string): { url: string; headers: Record<string, string> } {
  try {
    const u = new URL(rpcUrl)
    const apiKey = u.searchParams.get('api-key')
    if (apiKey) {
      u.searchParams.delete('api-key')
      return { url: u.toString(), headers: { 'x-api-key': apiKey } }
    }
  } catch { /* not a valid URL */ }
  return { url: rpcUrl, headers: {} }
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const { url, headers } = splitHeliusAuth(rpcUrl)
  // getProgramAccounts returns large payloads on slow networks — give it 120s; others 20s
  const timeoutMs = method === 'getProgramAccounts' ? 120_000 : 20_000
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal:  ac.signal,
    })
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
    const data = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`)
    return data.result
  } finally {
    clearTimeout(to)
  }
}

export async function getTopHolders(
  rpcUrl: string,
  mint:   string,
  topN:   number,
): Promise<OnchainHolder[]> {
  interface RpcAccount {
    account: { data: [string, string] }
  }

  const dataSlice = { offset: 32, length: 40 }
  const optsV1 = {
    encoding: 'base64', commitment: 'confirmed', dataSlice,
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
  }
  const optsV2 = {
    encoding: 'base64', commitment: 'confirmed', dataSlice,
    filters: [{ memcmp: { offset: 0, bytes: mint } }],
  }

  let result = (await rpcCall(rpcUrl, 'getProgramAccounts', [TOKEN_PROGRAM, optsV1])) as RpcAccount[] | null
  if (!result?.length) {
    result = (await rpcCall(rpcUrl, 'getProgramAccounts', [TOKEN22_PROGRAM, optsV2])) as RpcAccount[]
  }
  if (!result?.length) return []

  if (result.length > MAX_HOLDER_ACCOUNTS) {
    throw new Error(`Token has ${result.length.toLocaleString()} holder accounts — too large to analyze`)
  }

  // Decode each token account into (owner, amount).
  const decoded = result
    .map((r) => {
      const buf   = Buffer.from(r.account.data[0], 'base64')
      const owner = new PublicKey(buf.subarray(0, 32)).toBase58()
      return { owner, amount: buf.readBigUInt64LE(32) }
    })
    .filter((h) => h.amount > 0n)

  // Combine balances when one owner holds multiple token accounts for the
  // same mint. This happens in the wild for wallets that have a standard ATA
  // plus extra accounts owned by vault programs, legacy spl-token tools,
  // multi-sig wrappers, etc. Without this dedup the same owner shows up as
  // multiple top-holder rows with different supply % but identical OKX-derived
  // metrics, which is confusing and inflates the holder count.
  const byOwner = new Map<string, bigint>()
  for (const h of decoded) {
    byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0n) + h.amount)
  }

  return [...byOwner.entries()]
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => (a.amount > b.amount ? -1 : 1))
    .slice(0, topN)
}

export async function getTokenSupplyInfo(
  rpcUrl: string,
  mint:   string,
): Promise<{ uiAmount: number; decimals: number }> {
  const result = await rpcCall(rpcUrl, 'getTokenSupply', [mint, { commitment: 'confirmed' }]) as
    { value?: { uiAmount?: number; decimals?: number; uiAmountString?: string } } | null

  const v = result?.value
  if (!v) return { uiAmount: 0, decimals: 0 }
  const uiAmount = v.uiAmountString ? parseFloat(v.uiAmountString) : (v.uiAmount ?? 0)
  return { uiAmount: Number.isFinite(uiAmount) ? uiAmount : 0, decimals: v.decimals ?? 0 }
}

// Helius DAS getAsset — returns token name, symbol, logo
export async function getTokenMeta(
  rpcUrl: string,
  mint:   string,
): Promise<Pick<TokenInfo, 'symbol' | 'name' | 'logoUrl'>> {
  try {
    const { url, headers } = splitHeliusAuth(rpcUrl)
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      result?: {
        content?: {
          metadata?: { name?: string; symbol?: string }
          links?: { image?: string }
        }
      }
    }
    const meta = data.result?.content?.metadata ?? {}
    const logo = data.result?.content?.links?.image
    return {
      symbol:  meta.symbol ?? mint.slice(0, 6) + '…',
      name:    meta.name   ?? mint.slice(0, 8) + '…',
      logoUrl: logo,
    }
  } catch {
    return { symbol: mint.slice(0, 6) + '…', name: mint.slice(0, 8) + '…' }
  }
}

// ── Account type classification ───────────────────────────────────────────────

import type { WalletProfile } from './types'

// Known program owners → badge type
const PROGRAM_OWNERS: Record<string, WalletProfile['accountType']> = {
  // pump.fun
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'bonding_curve', // pump.fun bonding curve
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM':  'bonding_curve', // pump.fun v2
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':  'lp',           // pump.fun AMM (pAMM)
  // Raydium
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'lp',           // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'lp',           // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'lp',           // Raydium CPMM
  'HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8': 'lp',           // Raydium AMM v3
  // Orca
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':  'lp',           // Orca Whirlpool
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1': 'lp',           // Orca v1
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'lp',           // Orca v2
  // Meteora
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':  'lp',          // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vA':  'lp',          // Meteora Dynamic Pools
  'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K':  'lp',          // Meteora vaults
  // Jupiter & other aggregators
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4':  'lp',          // Jupiter v6
  // Other AMMs
  'AMM55ShdkoioYmALzkxgkNRSJaSmQ2sMsERPBnEgKFHx': 'lp',           // Aldrin AMM
  'CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR': 'lp',           // Crema Finance
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY':  'lp',          // Phoenix DEX
  'SSwpkEEexactly4x14VBGBUwZDvBDBdBLiJxGKFdnFpK':  'lp',          // Saber
  // Token programs (raw token account owners)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':   'pda',         // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb':   'pda',         // Token-2022
}

// Batch-fetch account info for a list of addresses.
// Returns a map: address → accountType
export async function getAccountTypes(
  rpcUrl:    string,
  addresses: string[],
): Promise<Map<string, WalletProfile['accountType']>> {
  const result = new Map<string, WalletProfile['accountType']>()
  if (!addresses.length) return result

  // getMultipleAccounts accepts up to 100 addresses
  const CHUNK = 100
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK)
    try {
      const raw = await rpcCall(rpcUrl, 'getMultipleAccounts', [
        chunk,
        { encoding: 'base64', commitment: 'confirmed' },
      ]) as {
        value: Array<{ executable: boolean; owner: string } | null>
      } | null

      const accounts = raw?.value ?? []
      for (let j = 0; j < chunk.length; j++) {
        const addr = chunk[j]
        const acc  = accounts[j]
        if (!acc) { result.set(addr, 'wallet'); continue }

        if (acc.executable) {
          result.set(addr, 'program')
        } else {
          const known = PROGRAM_OWNERS[acc.owner]
          result.set(addr, known ?? 'wallet')
        }
      }
    } catch {
      // on error, mark all as unknown
      for (const addr of chunk) result.set(addr, null)
    }
  }

  return result
}
