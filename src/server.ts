import 'dotenv/config'
import { serve }    from '@hono/node-server'
import { Hono }     from 'hono'
import { cors }     from 'hono/cors'
import { join }     from 'path'
import { readFileSync } from 'fs'
import { analyzeToken }    from './analyzer'
import { runTransferScan } from './transfer-scan'
import { saveSnapshot, listSnapshots, listAllSnapshots, loadSnapshot, deleteSnapshot } from './storage'
import { setupProxy }      from './proxy'
import type { SseEvent }   from './types'

setupProxy()

// Surface missing API keys at boot rather than at the first user request.
// Non-fatal: the server still starts (you can serve cached snapshots, static
// HTML, etc.) but you get a clear log line about what will 500.
function checkEnv(): void {
  const okxOk    = !!(process.env.OKX_API_KEY && process.env.OKX_PASSPHRASE && process.env.OKX_SECRET_KEY)
  const heliusOk = !!(process.env.HELIUS_API_KEY || process.env.HELIUS_RPC_URL)
  const fmt = (ok: boolean) => ok ? '✓' : '✗'
  console.log(`Env: OKX ${fmt(okxOk)}  Helius ${fmt(heliusOk)}`)
  if (!okxOk)    console.warn('  ⚠ OKX_API_KEY / OKX_PASSPHRASE / OKX_SECRET_KEY missing — /api/analyze will 500')
  if (!heliusOk) console.warn('  ⚠ HELIUS_API_KEY missing — /api/analyze and /api/transfers will 500')
}
checkEnv()

const app = new Hono()

app.use('/*', cors())

// Serve the single-file frontend
app.get('/', (c) => {
  const html = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8')
  return c.html(html)
})

// Standalone transfer investigation page
app.get('/transfers', (c) => {
  const html = readFileSync(join(__dirname, '..', 'web', 'transfers.html'), 'utf8')
  return c.html(html)
})

// SSE analysis endpoint
// GET /api/analyze?mint=<mint>&topN=<n>
app.get('/api/analyze', async (c) => {
  const mint = c.req.query('mint')?.trim()
  const topN = parseInt(c.req.query('topN') ?? '20', 10)

  if (!mint) return c.json({ error: 'mint param required' }, 400)
  if (isNaN(topN) || topN < 1 || topN > 200) return c.json({ error: 'topN must be 1-200' }, 400)

  const { readable, writable } = new TransformStream<Uint8Array>()
  const writer  = writable.getWriter()
  const encoder = new TextEncoder()

  function send(event: SseEvent) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    writer.write(encoder.encode(data)).catch(() => {})
  }

  // Run analysis in background, don't await
  analyzeToken(mint, topN, send)
    .catch((err) => {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => {
      writer.close().catch(() => {})
    })

  return new Response(readable, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection:      'keep-alive',
    },
  })
})

// SSE transfer-scan endpoint
// GET /api/transfers?wallets=a,b&from=ts&to=ts&depth=2&expand=15
app.get('/api/transfers', async (c) => {
  const walletsParam = c.req.query('wallets')
  const fromTs  = parseInt(c.req.query('from') ?? '0', 10)
  const toTs    = parseInt(c.req.query('to')   ?? String(Math.floor(Date.now() / 1000)), 10)
  const depth   = Math.min(parseInt(c.req.query('depth')  ?? '1', 10), 3)
  const expand  = Math.min(parseInt(c.req.query('expand') ?? '15', 10), 30)
  const apiKey  = process.env.HELIUS_API_KEY ?? ''

  if (!walletsParam) return c.json({ error: 'wallets param required' }, 400)
  if (!apiKey)       return c.json({ error: 'HELIUS_API_KEY not set' }, 500)

  const wallets = walletsParam.split(',').map(w => w.trim()).filter(Boolean).slice(0, 50)

  const { readable, writable } = new TransformStream<Uint8Array>()
  const writer  = writable.getWriter()
  const encoder = new TextEncoder()

  function send(event: unknown) {
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {})
  }

  runTransferScan({ wallets, fromTime: fromTs, toTime: toTs, maxDepth: depth, maxNewPerLayer: expand, apiKey }, send)
    .catch((err) => send({ type: 'scan_error', message: err instanceof Error ? err.message : String(err) }))
    .finally(() => writer.close().catch(() => {}))

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  })
})

// ── Snapshot API ──────────────────────────────────────────────────────────────

// POST /api/snapshots — save a snapshot
app.post('/api/snapshots', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.mint || !body?.wallets || !body?.token) return c.json({ error: 'invalid body' }, 400)
  const snap = { ...body, analyzedAt: body.analyzedAt ?? Date.now() }
  const filename = saveSnapshot(snap)
  return c.json({ ok: true, filename })
})

// GET /api/snapshots?mint=<mint>  — list for a specific mint
// GET /api/snapshots               — list all mints' snapshots
app.get('/api/snapshots', (c) => {
  const mint = c.req.query('mint')
  const list = mint ? listSnapshots(mint) : listAllSnapshots()
  return c.json(list)
})

// GET /api/snapshots/{mint}/{filename}  — load one snapshot
app.get('/api/snapshots/:mint/:filename', (c) => {
  const { mint, filename } = c.req.param()
  const snap = loadSnapshot(mint, filename)
  if (!snap) return c.json({ error: 'not found' }, 404)
  return c.json(snap)
})

// DELETE /api/snapshots/{mint}/{filename}
app.delete('/api/snapshots/:mint/:filename', (c) => {
  const { mint, filename } = c.req.param()
  const ok = deleteSnapshot(mint, filename)
  return c.json({ ok })
})

const port = parseInt(process.env.PORT ?? '3456', 10)
serve({ fetch: app.fetch, port }, () => {
  console.log(`token-analyzer running at http://localhost:${port}`)
})
