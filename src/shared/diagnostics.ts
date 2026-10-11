import type { WebRtcPolicy } from './browserConfig'
import type { ProxyConfig } from './types'

/**
 * Profile diagnostics. Every item carries the value a test actually observed, the value the
 * profile is configured to have, and a verdict:
 * - `pass`: the test observed the expected value.
 * - `fail`: the test established a mismatch (for WebRTC: an address was actually exposed).
 * - `warning`: observed and worth knowing, but not a mismatch.
 * - `unknown`: this test could not establish the answer.
 * - `info`: nothing is configured to compare with; the observed value is shown as is.
 * A set of passing checks is not proof of anonymity; it only covers what was tested.
 */
export type DiagnosticVerdict = 'pass' | 'fail' | 'warning' | 'unknown' | 'info'

export interface DiagnosticCheck {
  verdict: DiagnosticVerdict
  observed: string | null
  expected: string | null
  /** Short English explanation; the dashboard shows its own translated label next to it. */
  detail: string
}

export type CandidateKind = 'mdns' | 'private-ip' | 'public-ip' | 'unknown'

export interface IceCandidateInfo {
  /** host, srflx, prflx or relay. */
  type: string
  protocol: string
  address: string
  kind: CandidateKind
}

/** What the probe script reported from inside a page of the profile (an isolated world). */
export interface PageProbeResult {
  url: string
  timezone: string | null
  language: string | null
  languages: string[]
  userAgent: string | null
  webrtc: { error: string | null; candidates: string[] } | null
  stun: { error: string | null; candidates: string[] } | null
}

export interface ProfileDiagnostics {
  profileId: string
  ranAt: string
  /** The profile window was open, so page tests ran in one of its tabs. */
  pageTested: boolean
  pageUrl: string | null
  /** Why the page tests could not run although the profile is open. */
  pageProblem: string | null
  partition: DiagnosticCheck
  proxyRoute: DiagnosticCheck
  proxyConnection: DiagnosticCheck
  publicIp: DiagnosticCheck
  dns: DiagnosticCheck
  timezone: DiagnosticCheck
  language: DiagnosticCheck
  userAgent: DiagnosticCheck
  webrtcPolicy: WebRtcPolicy
  webrtcLocal: DiagnosticCheck & { candidates: IceCandidateInfo[] }
  /** Only when the user asked for the STUN test. */
  webrtcStun: (DiagnosticCheck & { candidates: IceCandidateInfo[]; server: string }) | null
}

/**
 * Public STUN server used only when the user explicitly starts the STUN test. It learns the
 * address the UDP packet came from — that is what the test is about.
 */
export const DEFAULT_STUN_SERVER = 'stun:stun.l.google.com:19302'

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Private, loopback, link-local or otherwise non-public address. */
export function isPrivateAddress(address: string): boolean {
  const v4 = IPV4.exec(address)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  const v6 = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (!v6.includes(':')) return false
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
}

export function classifyAddress(address: string): CandidateKind {
  if (!address) return 'unknown'
  if (/\.local$/i.test(address)) return 'mdns'
  if (IPV4.test(address) || address.includes(':')) return isPrivateAddress(address) ? 'private-ip' : 'public-ip'
  return 'unknown'
}

/**
 * Parses an ICE candidate line such as
 * `candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0`.
 */
export function parseCandidate(line: string): IceCandidateInfo | null {
  const parts = line.replace(/^a=/, '').trim().split(/\s+/)
  if (parts.length < 8 || !parts[0]!.startsWith('candidate:')) return null
  const typIndex = parts.indexOf('typ')
  if (typIndex < 0 || typIndex + 1 >= parts.length) return null
  const address = parts[4]!
  return { type: parts[typIndex + 1]!, protocol: parts[2]!.toLowerCase(), address, kind: classifyAddress(address) }
}

export function parseCandidates(lines: readonly string[]): IceCandidateInfo[] {
  const seen = new Set<string>()
  const result: IceCandidateInfo[] = []
  for (const line of lines) {
    const parsed = parseCandidate(line)
    if (!parsed) continue
    const key = `${parsed.type}|${parsed.protocol}|${parsed.address}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(parsed)
  }
  return result
}

/**
 * Local WebRTC test (no servers contacted): which addresses a page could read from host
 * candidates. mDNS names hide local addresses; a raw private address is a warning; a raw
 * public address different from the proxy's exit IP is a failure the test has observed.
 */
export function assessLocalWebRtc(
  probe: PageProbeResult['webrtc'],
  proxyIp: string | null,
  hasProxy: boolean
): DiagnosticCheck & { candidates: IceCandidateInfo[] } {
  if (!probe) {
    return { verdict: 'unknown', observed: null, expected: null, detail: 'The page test did not run.', candidates: [] }
  }
  if (probe.error) {
    return { verdict: 'unknown', observed: null, expected: null, detail: `WebRTC could not be tested: ${probe.error}`, candidates: [] }
  }
  const candidates = parseCandidates(probe.candidates)
  const raw = candidates.filter((c) => c.kind === 'private-ip' || c.kind === 'public-ip')
  const exposedPublic = candidates.filter((c) => c.kind === 'public-ip' && c.address !== proxyIp)
  const observed = candidates.length === 0 ? 'no candidates' : candidates.map((c) => `${c.type} ${c.address}`).join(', ')
  if (exposedPublic.length > 0 && hasProxy) {
    return {
      verdict: 'fail',
      observed,
      expected: 'no public address other than the proxy exit IP',
      detail: `Pages can read the public address ${exposedPublic.map((c) => c.address).join(', ')} of this PC through WebRTC.`,
      candidates
    }
  }
  if (raw.length > 0) {
    return {
      verdict: 'warning',
      observed,
      expected: 'local addresses hidden (mDNS) or none',
      detail: `Pages can read the local network address ${raw.map((c) => c.address).join(', ')} through WebRTC. It is not the public IP.`,
      candidates
    }
  }
  return {
    verdict: 'pass',
    observed,
    expected: 'local addresses hidden (mDNS) or none',
    detail:
      candidates.length === 0
        ? 'WebRTC gathered no local addresses.'
        : 'Local addresses are hidden behind random .local names.',
    candidates
  }
}

/**
 * STUN test: the server reports the public address our UDP packet came from (server-reflexive
 * candidates). Only an address that differs from the proxy exit IP is reported as exposed.
 */
export function assessStun(
  probe: PageProbeResult['stun'],
  proxyIp: string | null,
  hasProxy: boolean,
  server: string
): DiagnosticCheck & { candidates: IceCandidateInfo[]; server: string } {
  if (!probe) {
    return { verdict: 'unknown', observed: null, expected: null, detail: 'The STUN test did not run.', candidates: [], server }
  }
  if (probe.error) {
    return { verdict: 'unknown', observed: null, expected: null, detail: `The STUN test failed: ${probe.error}`, candidates: [], server }
  }
  const candidates = parseCandidates(probe.candidates)
  const reflexive = [...new Set(candidates.filter((c) => c.type === 'srflx' || c.type === 'prflx').map((c) => c.address))]
  const expected = hasProxy ? (proxyIp ? `no address, or only ${proxyIp}` : 'no address, or only the proxy exit IP') : null
  if (reflexive.length === 0) {
    return {
      verdict: hasProxy ? 'pass' : 'info',
      observed: 'no address',
      expected,
      detail:
        'The STUN server did not report an address for this profile (no direct UDP route was used, or the server did not answer). This test did not reveal an IP.',
      candidates,
      server
    }
  }
  if (!hasProxy) {
    return {
      verdict: 'info',
      observed: reflexive.join(', '),
      expected: null,
      detail: 'This profile has no proxy; the STUN server saw this connection’s own public address, as expected.',
      candidates,
      server
    }
  }
  if (!proxyIp) {
    return {
      verdict: 'unknown',
      observed: reflexive.join(', '),
      expected,
      detail: 'The proxy exit IP is not known yet, so the STUN result cannot be compared. Refresh IP & location first.',
      candidates,
      server
    }
  }
  const different = reflexive.filter((ip) => ip !== proxyIp)
  if (different.length > 0) {
    return {
      verdict: 'fail',
      observed: reflexive.join(', '),
      expected,
      detail: `WebRTC revealed ${different.join(', ')} to the STUN server — not the proxy exit IP ${proxyIp}. Websites can see this address the same way.`,
      candidates,
      server
    }
  }
  return {
    verdict: 'pass',
    observed: reflexive.join(', '),
    expected,
    detail: 'The STUN server saw only the proxy exit IP.',
    candidates,
    server
  }
}

/**
 * Where host names are resolved, from the proxy type: Chromium hands host names to HTTP, HTTPS
 * and SOCKS5 proxies, and resolves them on this PC for SOCKS4. `proxyReachedHost` is evidence
 * that a request by host name went through the proxy (the latest IP check). Whether this PC's
 * DNS server also saw a lookup cannot be observed from the app, so that part stays unknown.
 */
export function assessDns(proxy: ProxyConfig | null, proxyReachedHost: boolean | null): DiagnosticCheck {
  if (!proxy) {
    return {
      verdict: 'info',
      observed: 'this PC’s DNS',
      expected: null,
      detail: 'No proxy: host names are resolved by this PC’s DNS settings.'
    }
  }
  const bypass = proxy.bypassRules.trim()
  const bypassNote = bypass ? ` Addresses matching the bypass rules (${bypass}) skip the proxy and use this PC’s DNS.` : ''
  if (proxy.protocol === 'socks4') {
    return {
      verdict: 'warning',
      observed: 'resolved on this PC',
      expected: 'resolved by the proxy',
      detail: `SOCKS4 cannot carry host names, so Chromium resolves them with this PC’s DNS before connecting through the proxy. Use SOCKS5 or HTTP to let the proxy resolve them.${bypassNote}`
    }
  }
  const observed = proxyReachedHost ? 'host names sent to the proxy' : null
  return {
    verdict: proxyReachedHost ? (bypass ? 'warning' : 'pass') : 'unknown',
    observed,
    expected: 'resolved by the proxy',
    detail:
      (proxyReachedHost
        ? 'The latest IP check reached a service by host name through the proxy, so the proxy resolved it. Whether this PC’s DNS server also saw lookups cannot be observed by the app (unknown).'
        : 'With this proxy type Chromium sends host names to the proxy, but no successful check has confirmed it yet. Refresh IP & location to test.') + bypassNote
  }
}

/** Compares an observed page value with the configured one. */
export function compareValue(
  observed: string | null,
  expected: string | null,
  equal: (a: string, b: string) => boolean = (a, b) => a === b,
  notConfigured = 'Not set for this profile; the app default applies.'
): DiagnosticCheck {
  if (observed === null) return { verdict: 'unknown', observed, expected, detail: 'The page did not report a value.' }
  if (expected === null) return { verdict: 'info', observed, expected, detail: notConfigured }
  return equal(observed, expected)
    ? { verdict: 'pass', observed, expected, detail: 'Matches the profile setting.' }
    : { verdict: 'fail', observed, expected, detail: 'Differs from the profile setting.' }
}

/**
 * Checks that Chromium's resolved proxy for the profile's session (e.g. "PROXY 1.2.3.4:8080")
 * matches the configured proxy. "DIRECT" with a configured proxy is a failure.
 */
export function assessProxyRoute(proxy: ProxyConfig | null, resolved: string | null): DiagnosticCheck {
  const expected = proxy ? `${proxy.protocol.toUpperCase()} ${proxy.host}:${proxy.port}` : 'DIRECT'
  if (resolved === null) {
    return { verdict: 'unknown', observed: null, expected, detail: 'Open the profile to read the proxy its browser session is using.' }
  }
  const value = resolved.trim()
  if (!proxy) {
    return value === 'DIRECT'
      ? { verdict: 'pass', observed: value, expected, detail: 'No proxy is configured and the session connects directly.' }
      : { verdict: 'fail', observed: value, expected, detail: 'No proxy is configured, but the session uses one.' }
  }
  const first = value.split(';')[0]!.trim()
  const hostPort = `${proxy.host}:${proxy.port}`.toLowerCase()
  if (first.toLowerCase().endsWith(hostPort) && !/^DIRECT/i.test(first)) {
    const fallback = /;\s*DIRECT/i.test(value)
    return fallback
      ? { verdict: 'fail', observed: value, expected, detail: 'The session would fall back to a direct connection.' }
      : { verdict: 'pass', observed: value, expected, detail: 'The browser session sends its traffic to the configured proxy.' }
  }
  return { verdict: 'fail', observed: value, expected, detail: 'The browser session is not using the configured proxy.' }
}
