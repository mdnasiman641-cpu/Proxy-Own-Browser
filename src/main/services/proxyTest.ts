import { describeProxy } from '@shared/proxy'
import type { ProxyConfig, ProxyTestResult, ProxyTestStatus } from '@shared/types'

/**
 * Public IP-check services, tried in order. Both are HTTPS, so an HTTP proxy only sees an
 * encrypted CONNECT tunnel, and neither ever receives proxy credentials (those go only to
 * the proxy server itself, and only when it asks for them).
 */
export const IP_CHECK_ENDPOINTS: readonly IpCheckEndpoint[] = [
  { url: 'https://api.ipify.org/?format=json', format: 'json' },
  { url: 'https://checkip.amazonaws.com/', format: 'text' }
]

export interface IpCheckEndpoint {
  url: string
  /** `json` expects `{"ip": "…"}`, `text` expects the bare address. */
  format: 'json' | 'text'
}

export const DEFAULT_PROXY_TEST_TIMEOUT_MS = 15_000
/** Bodies larger than this are not IP-check or IP-location responses; the fetcher stops reading. */
export const MAX_RESPONSE_BYTES = 16_384

export interface FetchResponse {
  status: number
  body: string
}

/**
 * Performs one GET request through the proxy under test. Must reject with a `FetchError`
 * carrying a Chromium net error code (e.g. `ERR_PROXY_CONNECTION_FAILED`) or one of the
 * synthetic codes below.
 */
export type Fetcher = (url: string, timeoutMs: number) => Promise<FetchResponse>

export const SYNTHETIC_CODES = {
  timeout: 'TIMEOUT',
  authRequired: 'PROXY_AUTH_REQUIRED',
  authRejected: 'PROXY_AUTH_REJECTED',
  tooLarge: 'RESPONSE_TOO_LARGE'
} as const

export class FetchError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'FetchError'
  }
}

/** Extracts a code such as `ERR_TIMED_OUT` from Electron's `net::ERR_TIMED_OUT` messages. */
export function netErrorCode(message: string): string {
  return /(ERR_[A-Z0-9_]+)/.exec(message)?.[1] ?? 'ERR_FAILED'
}

interface Classification {
  status: ProxyTestStatus
  message: string
  /** Whether trying the next IP-check service might succeed. */
  tryNextEndpoint: boolean
}

/** Maps a network error code to a user-facing explanation. */
export function classifyNetworkError(code: string): Classification {
  switch (code) {
    case SYNTHETIC_CODES.timeout:
    case 'ERR_TIMED_OUT':
    case 'ERR_CONNECTION_TIMED_OUT':
      return {
        status: 'timeout',
        message: 'The proxy did not respond in time. It may be offline, overloaded or blocking this connection.',
        tryNextEndpoint: true
      }
    case 'ERR_PROXY_CONNECTION_FAILED':
    case 'ERR_SOCKS_CONNECTION_FAILED':
    case 'ERR_CONNECTION_REFUSED':
      return {
        status: 'proxy-unreachable',
        message: 'Could not connect to the proxy server. Check the host, port and proxy type.',
        tryNextEndpoint: false
      }
    case SYNTHETIC_CODES.authRequired:
      return {
        status: 'auth-required',
        message: 'The proxy requires a username and password, but none are saved for it.',
        tryNextEndpoint: false
      }
    case SYNTHETIC_CODES.authRejected:
    case 'ERR_PROXY_AUTH_UNSUPPORTED':
    case 'ERR_PROXY_AUTH_REQUESTED':
    case 'ERR_INVALID_AUTH_CREDENTIALS':
      return {
        status: 'auth-failed',
        message: 'The proxy rejected the username or password.',
        tryNextEndpoint: false
      }
    case 'ERR_TUNNEL_CONNECTION_FAILED':
    case 'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE':
    case 'ERR_PROXY_CERTIFICATE_INVALID':
      return {
        status: 'proxy-error',
        message: 'The proxy accepted the connection but could not reach the test website.',
        tryNextEndpoint: true
      }
    case 'ERR_NAME_NOT_RESOLVED':
    case 'ERR_NAME_RESOLUTION_FAILED':
      return {
        status: 'dns-failed',
        message: 'A host name could not be resolved. Check the proxy host name.',
        tryNextEndpoint: true
      }
    case 'ERR_INTERNET_DISCONNECTED':
    case 'ERR_NETWORK_CHANGED':
      return {
        status: 'network-error',
        message: 'This computer appears to be offline.',
        tryNextEndpoint: false
      }
    case SYNTHETIC_CODES.tooLarge:
      return {
        status: 'invalid-response',
        message: 'The test website returned an unexpected response.',
        tryNextEndpoint: true
      }
    default:
      if (code.startsWith('ERR_CERT_') || code.startsWith('ERR_SSL_')) {
        return {
          status: 'tls-error',
          message:
            'The secure connection failed certificate checks. The proxy may be intercepting HTTPS traffic.',
          tryNextEndpoint: false
        }
      }
      return {
        status: 'network-error',
        message: `The connection failed (${code}).`,
        tryNextEndpoint: true
      }
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^(?=.*:)[0-9a-f:]{2,39}(?:\.\d{1,3}){0,4}$/i

export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true
  if (!IPV6.test(value)) return false
  // At most one "::" and at most 8 groups.
  const doubleColons = value.split('::').length - 1
  return doubleColons <= 1 && value.split(':').length <= 8
}

/** Returns the IP address from an IP-check response body, or null if it is not one. */
export function extractIp(body: string, format: IpCheckEndpoint['format']): string | null {
  let candidate: unknown
  if (format === 'json') {
    try {
      candidate = (JSON.parse(body) as { ip?: unknown }).ip
    } catch {
      return null
    }
  } else {
    candidate = body.trim()
  }
  return typeof candidate === 'string' && isIpAddress(candidate.trim()) ? candidate.trim() : null
}

export interface RunProxyTestOptions {
  fetcher: Fetcher
  route: string
  endpoints?: readonly IpCheckEndpoint[]
  /** Total time budget for the whole test, across all endpoints. */
  timeoutMs?: number
  now?: () => number
  clock?: () => Date
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Rejects after `ms` with a timeout FetchError, so a misbehaving fetcher can never hang a test. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FetchError('Timed out', SYNTHETIC_CODES.timeout)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Makes real requests through the proxy until one IP-check service returns a valid address.
 * Success is reported only for an HTTP 2xx response whose body contains a valid IP address.
 */
export async function runProxyTest(options: RunProxyTestOptions): Promise<ProxyTestResult> {
  const endpoints = options.endpoints ?? IP_CHECK_ENDPOINTS
  const budget = options.timeoutMs ?? DEFAULT_PROXY_TEST_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  const clock = options.clock ?? (() => new Date())
  const started = now()

  const result = (
    status: ProxyTestStatus,
    message: string,
    endpoint: string | null,
    extra: Partial<Pick<ProxyTestResult, 'ip' | 'responseTimeMs'>> = {}
  ): ProxyTestResult => ({
    ok: status === 'success',
    status,
    message,
    ip: extra.ip ?? null,
    responseTimeMs: extra.responseTimeMs ?? null,
    endpoint,
    route: options.route,
    testedAt: clock().toISOString()
  })

  if (endpoints.length === 0) {
    return result('invalid-config', 'No IP-check service is configured.', null)
  }

  let last: ProxyTestResult | null = null
  for (const endpoint of endpoints) {
    const remaining = budget - (now() - started)
    if (remaining <= 0) break
    const host = hostOf(endpoint.url)
    const attemptStart = now()
    try {
      const response = await withDeadline(options.fetcher(endpoint.url, remaining), remaining)
      const elapsed = Math.max(0, Math.round(now() - attemptStart))
      if (response.status === 407) {
        const c = classifyNetworkError(SYNTHETIC_CODES.authRejected)
        return result(c.status, c.message, host)
      }
      if (response.status < 200 || response.status >= 300) {
        last = result(
          'http-error',
          `The test website answered with HTTP ${response.status}.`,
          host
        )
        continue
      }
      const ip = extractIp(response.body, endpoint.format)
      if (!ip) {
        last = result('invalid-response', 'The test website returned an unexpected response.', host)
        continue
      }
      return result('success', `Connected. Public IP address is ${ip}.`, host, {
        ip,
        responseTimeMs: elapsed
      })
    } catch (error) {
      const code = error instanceof FetchError ? error.code : 'ERR_FAILED'
      const c = classifyNetworkError(code)
      last = result(c.status, c.message, host)
      if (!c.tryNextEndpoint) return last
    }
  }

  if (!last) {
    const c = classifyNetworkError(SYNTHETIC_CODES.timeout)
    return result(c.status, c.message, null)
  }
  return last
}

/** Label for the network route being tested (never includes credentials). */
export function routeLabel(proxy: ProxyConfig | null): string {
  return describeProxy(proxy) ?? 'Direct connection (no proxy)'
}

/**
 * A saved proxy password may only be reused for an unsaved draft that points at exactly the
 * same proxy server and account — otherwise the password could be sent to a different host.
 */
export function canReuseStoredPassword(
  saved: Pick<ProxyConfig, 'protocol' | 'host' | 'port' | 'username'> | null,
  draft: { protocol?: string; host?: string; port?: number; username?: string }
): boolean {
  if (!saved?.username) return false
  return (
    saved.protocol === draft.protocol &&
    saved.host.toLowerCase() === (draft.host ?? '').trim().toLowerCase() &&
    saved.port === draft.port &&
    saved.username === (draft.username ?? '').trim()
  )
}

/** Whether a proxy auth challenge comes from the proxy server we configured. */
export function isConfiguredProxyHost(challengeHost: string, proxyHost: string): boolean {
  const normalize = (h: string): string => h.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalize(challengeHost) === normalize(proxyHost)
}
