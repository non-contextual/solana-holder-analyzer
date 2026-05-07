// Per-domain proxy routing — only OKX goes through HTTPS_PROXY, Helius goes direct

import { Agent, Dispatcher, ProxyAgent } from 'undici'

const PROXY_HOSTS = ['web3.okx.com', 'www.okx.com']

class HostRoutingDispatcher extends Dispatcher {
  constructor(
    private proxyAgent:  ProxyAgent,
    private directAgent: Agent,
    private match:       (host: string) => boolean,
  ) { super() }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    let host = ''
    try {
      const origin = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString() ?? ''
      host = new URL(origin).hostname
    } catch { /* default to direct */ }
    return (this.match(host) ? this.proxyAgent : this.directAgent).dispatch(opts, handler)
  }

  async close()   { await Promise.all([this.proxyAgent.close(),   this.directAgent.close()])   }
  async destroy() { await Promise.all([this.proxyAgent.destroy(), this.directAgent.destroy()]) }
}

export function setupProxy(): void {
  const url = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!url) return

  const undici = require('undici') as typeof import('undici')
  undici.setGlobalDispatcher(
    new HostRoutingDispatcher(
      new ProxyAgent(url),
      new Agent(),
      (host) => PROXY_HOSTS.some((p) => host === p || host.endsWith('.' + p)),
    ),
  )

  console.log(`Proxy active: ${url} (OKX only, Helius goes direct)`)
}
