# token-analyzer

Solana 代币持仓分析工具 + 多层 transfer 大调查。两个独立工具合一。

## 功能

### Token Analyzer (`/`)
- 输入代币 mint 地址，拉取前 N 大户
- 每个钱包：持仓占供应量 %、USD 价值、Portfolio 总值、Token/Total %、Token/SPL %、Realized PnL、7d/90d 交易代币数
- 多维度过滤（AND/OR 逻辑）：Portfolio 大小、代币集中度、交易活跃度、时间段、共持代币、共同交易代币
- 持仓供应量百分比实时计算（底部 footer 显示筛选后合计）
- 快照存储：保存某时刻分析结果，History 面板随时回看对比

### Transfer Investigation (`/transfers`)
- 直接粘贴钱包地址（任意来源，无需先做代币分析）
- BFS 多层扩展：seed 钱包 → 发现对手方 → 再展开（深度 1-3 层，每层可控扩展数）
- 自动过滤 DEX/程序账户，只展开真实钱包
- D3 力图：节点按层着色（seed=amber/layer1=blue/layer2=mint），边粗细=转账量
- 净流量表：每个地址 × 每种代币的流入/流出/净值
- 双滑块时间轴：爬完全量数据后本地过滤，不重新请求

## 数据源

| 数据 | 来源 |
|------|------|
| 链上持仓者 | Helius RPC (`getProgramAccounts`) |
| 代币供应量 + metadata | Helius RPC + Helius DAS (`getAsset`) |
| Portfolio 总值 + 目标代币 USD 价值 | OKX signed API (`/api/v6/dex/balance/all-token-balances-by-address`) |
| PnL 数据（realized/unrealized、买卖次数） | OKX priapi (`pnl/token-list`，无需签名） |
| 交易历史（7d/90d 唯一代币数） | OKX priapi (`pnl/wallet-profile/trade-history`) |
| Transfer 历史（多层调查） | Helius Enhanced Transactions API (`/v0/addresses/{addr}/transactions`) |

## 快速开始

```bash
cp .env.example .env
# 填入 HELIUS_API_KEY 和 OKX API keys

npm install
npm run dev
# 访问 http://localhost:3456
```

### 所需 API Keys

- **Helius**: [dev.helius.xyz](https://dev.helius.xyz) — 免费套餐够用
- **OKX Web3**: [web3.okx.com/onchain-os/dev-portal](https://web3.okx.com/onchain-os/dev-portal)

### 代理（中国大陆）

OKX API 需要代理。在 `.env` 里设置：

```
HTTPS_PROXY=http://127.0.0.1:10808
```

代理只对 `web3.okx.com` 生效，Helius 直连。

## 项目结构

```
token-analyzer/
├── src/
│   ├── server.ts          # Hono HTTP 服务 + SSE 端点
│   ├── analyzer.ts        # Token 持仓分析主逻辑（BFS 对 OKX + Helius）
│   ├── solana.ts          # Solana RPC（getProgramAccounts, getTokenSupply, DAS）
│   ├── okx.ts             # OKX 签名 API + priapi 客户端
│   ├── helius.ts          # Helius Enhanced Transactions REST API
│   ├── transfer-scan.ts   # 多层 BFS transfer 调查引擎
│   ├── storage.ts         # 快照持久化（data/{mint}/{ts}.json）
│   ├── proxy.ts           # 按域名路由代理（OKX 走代理，Helius 直连）
│   └── types.ts           # TypeScript 类型定义
├── web/
│   ├── index.html         # Token Analyzer 前端（单文件，无构建步骤）
│   └── transfers.html     # Transfer Investigation 前端
├── data/                  # 快照存储目录（git 忽略）
├── .env.example
├── package.json
└── tsconfig.json
```

## 技术栈

- **Backend**: Node.js + TypeScript + Hono (HTTP) + tsx (开发热更新)
- **Frontend**: 纯 HTML/CSS/JS（无框架，无构建），D3.js（力图）
- **Design**: 深色 CRT 风格，amber accent，JetBrains Mono
