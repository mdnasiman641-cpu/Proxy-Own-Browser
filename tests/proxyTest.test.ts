import { describe, expect, it } from 'vitest'
import {
  FetchError,
  SYNTHETIC_CODES,
  canReuseStoredPassword,
  classifyNetworkError,
  extractIp,
  isConfiguredProxyHost,
  isIpAddress,
  netErrorCode,
  routeLabel,
  runProxyTest,
  type Fetcher,
  type IpCheckEndpoint
} from '../src/main/services/proxyTest'

const JSON_EP: IpCheckEndpoint = { url: 'https://ip.example/json', format: 'json' }
const TEXT_EP: IpCheckEndpoint = { url: 'https://ip2.example/', format: 'text' }

/** Fetcher that replays scripted outcomes and records the URLs requested. */
function scripted(...outcomes: (FetchError | { status: number; body: string } | 'hang')[]) {
  const calls: string[] = []
  const fetcher: Fetcher = (url) => {
    calls.push(url)
    const next = outcomes.shift()
    if (next === undefined) return Promise.reject(new Error('unexpected call'))
    if (next === 'hang') return new Promise(() => {})
    if (next instanceof FetchError) return Promise.reject(next)
    return Promise.resolve(next)
  }
  return { fetcher, calls }
}

const netError = (code: string): FetchError => new FetchError(`net::${code}`, code)

describe('IP parsing', () => {
  it.each(['1.2.3.4', '203.0.113.7', '255.255.255.255', '::1', '2001:db8::1', 'fe80::1:2:3'])(
    'accepts %s',
    (ip) => expect(isIpAddress(ip)).toBe(true)
  )

  it.each(['', '256.1.1.1', '1.2.3', 'example.com', '1::2::3', '<html>', '1.2.3.4 extra'])(
    'rejects %j',
    (ip) => expect(isIpAddress(ip)).toBe(false)
  )

  it('extracts the IP from JSON and text responses', () => {
    expect(extractIp('{"ip":"203.0.113.7"}', 'json')).toBe('203.0.113.7')
    expect(extractIp('203.0.113.7\n', 'text')).toBe('203.0.113.7')
    expect(extractIp('{"ip":"not-an-ip"}', 'json')).toBeNull()
    expect(extractIp('{"address":"1.2.3.4"}', 'json')).toBeNull()
    expect(extractIp('<html>blocked</html>', 'text')).toBeNull()
    expect(extractIp('not json', 'json')).toBeNull()
  })
})

describe('network error classification', () => {
  it('reads codes from Electron error messages', () => {
    expect(netErrorCode('net::ERR_PROXY_CONNECTION_FAILED')).toBe('ERR_PROXY_CONNECTION_FAILED')
    expect(netErrorCode('something odd')).toBe('ERR_FAILED')
  })

  it.each<[string, string, boolean]>([
    ['ERR_PROXY_CONNECTION_FAILED', 'proxy-unreachable', false],
    ['ERR_CONNECTION_REFUSED', 'proxy-unreachable', false],
    [SYNTHETIC_CODES.timeout, 'timeout', true],
    ['ERR_TIMED_OUT', 'timeout', true],
    [SYNTHETIC_CODES.authRequired, 'auth-required', false],
    [SYNTHETIC_CODES.authRejected, 'auth-failed', false],
    ['ERR_TUNNEL_CONNECTION_FAILED', 'proxy-error', true],
    ['ERR_NAME_NOT_RESOLVED', 'dns-failed', true],
    ['ERR_CERT_AUTHORITY_INVALID', 'tls-error', false],
    ['ERR_INTERNET_DISCONNECTED', 'network-error', false],
    ['ERR_SOMETHING_NEW', 'network-error', true]
  ])('%s → %s', (code, status, tryNext) => {
    const c = classifyNetworkError(code)
    expect(c.status).toBe(status)
    expect(c.tryNextEndpoint).toBe(tryNext)
    expect(c.message.length).toBeGreaterThan(10)
  })
})

describe('runProxyTest', () => {
  const route = 'HTTP 1.2.3.4:8080 (auth)'

  it('reports success with IP and response time only after a valid response', async () => {
    let t = 1000
    const { fetcher } = scripted({ status: 200, body: '{"ip":"203.0.113.7"}' })
    const result = await runProxyTest({
      fetcher,
      route,
      endpoints: [JSON_EP],
      now: () => (t += 120),
      clock: () => new Date('2026-10-11T00:00:00Z')
    })
    expect(result).toEqual({
      ok: true,
      status: 'success',
      message: 'Connected. Public IP address is 203.0.113.7.',
      ip: '203.0.113.7',
      responseTimeMs: 120,
      endpoint: 'ip.example',
      route,
      testedAt: '2026-10-11T00:00:00.000Z'
    })
  })

  it('never reports success for a 2xx response without a valid IP', async () => {
    const { fetcher } = scripted({ status: 200, body: '<html>captive portal</html>' })
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP] })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('invalid-response')
    expect(result.ip).toBeNull()
  })

  it('falls back to the next service when one is down', async () => {
    const { fetcher, calls } = scripted({ status: 503, body: 'busy' }, { status: 200, body: '198.51.100.4\n' })
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP, TEXT_EP] })
    expect(result.ok).toBe(true)
    expect(result.ip).toBe('198.51.100.4')
    expect(result.endpoint).toBe('ip2.example')
    expect(calls).toEqual([JSON_EP.url, TEXT_EP.url])
  })

  it('reports the last failure when every service fails', async () => {
    const { fetcher } = scripted({ status: 503, body: '' }, { status: 502, body: '' })
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP, TEXT_EP] })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('http-error')
    expect(result.message).toContain('502')
  })

  it('stops immediately when the proxy itself is unreachable', async () => {
    const { fetcher, calls } = scripted(netError('ERR_PROXY_CONNECTION_FAILED'))
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP, TEXT_EP] })
    expect(result.status).toBe('proxy-unreachable')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('reports rejected credentials without trying other services', async () => {
    const { fetcher, calls } = scripted(new FetchError('x', SYNTHETIC_CODES.authRejected))
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP, TEXT_EP] })
    expect(result.status).toBe('auth-failed')
    expect(calls).toHaveLength(1)
  })

  it('treats an HTTP 407 answer as an authentication failure', async () => {
    const { fetcher } = scripted({ status: 407, body: '' })
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP, TEXT_EP] })
    expect(result.status).toBe('auth-failed')
  })

  it('times out a fetcher that never answers, within the overall budget', async () => {
    const { fetcher, calls } = scripted('hang', 'hang')
    const started = Date.now()
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP, TEXT_EP], timeoutMs: 150 })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(false)
    expect(result.status).toBe('timeout')
    expect(elapsed < 1000).toBe(true)
    // The whole budget was used by the first hanging request.
    expect(calls).toHaveLength(1)
  })

  it('passes the remaining time budget to each attempt', async () => {
    const budgets: number[] = []
    let t = 0
    const fetcher: Fetcher = (_url, timeoutMs) => {
      budgets.push(timeoutMs)
      t += 400
      return Promise.reject(netError('ERR_TUNNEL_CONNECTION_FAILED'))
    }
    const result = await runProxyTest({ fetcher, route, endpoints: [JSON_EP, TEXT_EP], timeoutMs: 1000, now: () => t })
    expect(budgets).toEqual([1000, 600])
    expect(result.status).toBe('proxy-error')
  })

  it('reports a configuration problem when no service is configured', async () => {
    const { fetcher } = scripted()
    const result = await runProxyTest({ fetcher, route, endpoints: [] })
    expect(result.status).toBe('invalid-config')
    expect(result.ok).toBe(false)
  })

  it('never includes credentials in the result', async () => {
    const { fetcher } = scripted(netError('ERR_PROXY_CONNECTION_FAILED'))
    const result = await runProxyTest({ fetcher, route: routeLabel({ protocol: 'http', host: 'p.net', port: 80, username: 'alice', hasPassword: true, bypassRules: '' }), endpoints: [JSON_EP] })
    expect(JSON.stringify(result)).not.toContain('alice')
    expect(result.route).toBe('HTTP p.net:80 (auth)')
  })
})

describe('credential safety helpers', () => {
  const saved = { protocol: 'http' as const, host: 'Proxy.Example.com', port: 8080, username: 'bob' }

  it('reuses a saved password only for the same proxy server and username', () => {
    expect(canReuseStoredPassword(saved, { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'bob' })).toBe(true)
    expect(canReuseStoredPassword(saved, { protocol: 'http', host: 'evil.example.com', port: 8080, username: 'bob' })).toBe(false)
    expect(canReuseStoredPassword(saved, { protocol: 'http', host: 'proxy.example.com', port: 8081, username: 'bob' })).toBe(false)
    expect(canReuseStoredPassword(saved, { protocol: 'https', host: 'proxy.example.com', port: 8080, username: 'bob' })).toBe(false)
    expect(canReuseStoredPassword(saved, { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'alice' })).toBe(false)
    expect(canReuseStoredPassword(null, { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'bob' })).toBe(false)
  })

  it('only answers auth challenges from the configured proxy host', () => {
    expect(isConfiguredProxyHost('PROXY.example.com', 'proxy.example.com')).toBe(true)
    expect(isConfiguredProxyHost('[2001:db8::1]', '2001:db8::1')).toBe(true)
    expect(isConfiguredProxyHost('api.ipify.org', 'proxy.example.com')).toBe(false)
  })
})
