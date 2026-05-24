# Solana Holder Analyzer

Solana token holder analysis + multi-hop transfer investigation. Two tools in one.

[中文文档](README.zh-CN.md)

## Features

### Token Analyzer (`/`)
- Enter a token mint address, fetch the top N holders
- Per wallet: supply %, USD value, portfolio total, Token/Total %, Token/SPL %, Realized PnL, 7d/90d traded token count
- Multi-dimensional filters (AND/OR logic): portfolio size, token concentration, trading activity, time range, co-held tokens, co-traded tokens
- Live supply % calculation — footer shows filtered cohort total
- Snapshot storage: save analysis state at any point, compare across time in the History panel

### Transfer Investigation (`/transfers`)
- Paste wallet addresses directly (no prior token analysis required)
- BFS multi-hop expansion: seed wallets → counterparties → further expansion (depth 1–3, configurable per layer)
- Auto-filters DEX/program accounts — only real wallets are expanded
- D3 force graph: nodes colored by layer (seed=amber / layer1=blue / layer2=mint), edge thickness = transfer volume
- Net flow table: inflow / outflow / net per address × token
- Dual-slider timeline: fetch full data once, filter locally without re-fetching

## Data Sources

| Data | Source |
|------|--------|
| On-chain holders | Helius RPC (`getProgramAccounts`) |
| Token supply + metadata | Helius RPC + Helius DAS (`getAsset`) |
| Portfolio total + target token USD value | OKX signed API (`/api/v6/dex/balance/all-token-balances-by-address`) |
| PnL (realized/unrealized, buy/sell counts) | OKX priapi (`pnl/token-list`, no signing required) |
| Trade history (7d/90d unique token count) | OKX priapi (`pnl/wallet-profile/trade-history`) |
| Transfer history (multi-hop investigation) | Helius Enhanced Transactions API (`/v0/addresses/{addr}/transactions`) |

## Quick Start

```bash
cp .env.example .env
# Fill in HELIUS_API_KEY and OKX API keys

npm install
npm run dev
# Open http://localhost:3456
```

### Required API Keys

- **Helius**: [dev.helius.xyz](https://dev.helius.xyz) — free tier is sufficient
- **OKX Web3**: [web3.okx.com/onchain-os/dev-portal](https://web3.okx.com/onchain-os/dev-portal)

### Proxy (mainland China)

OKX API requires a proxy. Set in `.env`:

```
HTTPS_PROXY=http://127.0.0.1:10808
```

The proxy applies only to `web3.okx.com`; Helius connects directly.

## Project Structure

```
token-analyzer/
├── src/
│   ├── server.ts          # Hono HTTP server + SSE endpoints
│   ├── analyzer.ts        # Token holder analysis (BFS over OKX + Helius)
│   ├── solana.ts          # Solana RPC (getProgramAccounts, getTokenSupply, DAS)
│   ├── okx.ts             # OKX signed API + priapi client
│   ├── helius.ts          # Helius Enhanced Transactions REST API
│   ├── transfer-scan.ts   # Multi-hop BFS transfer investigation engine
│   ├── storage.ts         # Snapshot persistence (data/{mint}/{ts}.json)
│   ├── proxy.ts           # Domain-based proxy routing (OKX proxied, Helius direct)
│   └── types.ts           # TypeScript type definitions
├── web/
│   ├── index.html         # Token Analyzer frontend (single file, no build step)
│   └── transfers.html     # Transfer Investigation frontend
├── data/                  # Snapshot storage (git-ignored)
├── .env.example
├── package.json
└── tsconfig.json
```

## Tech Stack

- **Backend**: Node.js + TypeScript + Hono (HTTP) + tsx (dev hot-reload)
- **Frontend**: Vanilla HTML/CSS/JS (no framework, no build), D3.js (force graph)
- **Design**: Dark CRT aesthetic, amber accent, JetBrains Mono
