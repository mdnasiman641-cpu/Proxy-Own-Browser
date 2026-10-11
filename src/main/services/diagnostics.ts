import {
  assessDns,
  assessLocalWebRtc,
  assessProxyRoute,
  assessStun,
  compareValue,
  type DiagnosticCheck,
  type PageProbeResult,
  type ProfileDiagnostics
} from '@shared/diagnostics'
import type { Profile, ProfileNetworkStatus } from '@shared/types'

export interface DiagnosticsInput {
  profile: Profile
  network: ProfileNetworkStatus | null
  /** Null when the profile is not open (page tests need one of its tabs). */
  page: PageProbeResult | null
  /** Chromium's resolved proxy for the session, e.g. "PROXY 1.2.3.4:8080"; null when unknown. */
  resolvedProxy: string | null
  /** Partition of the session the tested page actually runs in; null when not tested. */
  pagePartition: string | null
  /** Values the open window applies; null when the profile is not open. */
  expected: { timezone: string | null; locale: string | null; userAgent: string } | null
  /** This PC's time zone (what pages show when no override is applied). */
  systemTimezone: string
  stunServer: string | null
  /** Why the page test could not run, when the profile is open. */
  pageProblem?: string | null
  now: Date
}

function canonicalZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return zone
  }
}

const sameLanguage = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Combines stored network results with what the page reported into one diagnostics report.
 * Each section only states what its own test established.
 */
export function buildDiagnostics(input: DiagnosticsInput): ProfileDiagnostics {
  const { profile, network, page, expected } = input
  const hasProxy = Boolean(profile.proxy)
  const current = network?.current ? network : null
  const proxyIp = current?.proxy.ok ? current.ip : null

  const partition: DiagnosticCheck =
    input.pagePartition === null
      ? { verdict: 'info', observed: null, expected: profile.partition, detail: 'Open the profile to confirm which session its pages run in.' }
      : input.pagePartition === profile.partition
        ? { verdict: 'pass', observed: input.pagePartition, expected: profile.partition, detail: 'Pages run in this profile’s own session.' }
        : { verdict: 'fail', observed: input.pagePartition, expected: profile.partition, detail: 'Pages run in a different session than this profile’s.' }

  const proxyConnection: DiagnosticCheck = !hasProxy
    ? { verdict: 'info', observed: 'direct connection', expected: null, detail: 'This profile has no proxy.' }
    : !current
      ? {
          verdict: 'unknown',
          observed: null,
          expected: 'connected',
          detail: network ? 'The last test was made for a different proxy setting. Refresh IP & location.' : 'Not tested yet. Refresh IP & location.'
        }
      : current.proxy.ok
        ? {
            verdict: 'pass',
            observed: current.proxy.responseTimeMs !== null ? `connected (${current.proxy.responseTimeMs} ms)` : 'connected',
            expected: 'connected',
            detail: `Tested ${current.checkedAt}.`
          }
        : { verdict: 'fail', observed: current.proxy.status, expected: 'connected', detail: current.proxy.message }

  const publicIp: DiagnosticCheck = !current
    ? { verdict: 'unknown', observed: null, expected: null, detail: 'No current IP check for this profile’s proxy setting.' }
    : current.ip
      ? {
          verdict: current.sameExitIpAs.length > 0 ? 'warning' : 'info',
          observed: current.ip,
          expected: null,
          detail:
            current.sameExitIpAs.length > 0
              ? `Also the exit IP of: ${current.sameExitIpAs.map((p) => p.name).join(', ')}.`
              : `Reported by an IP echo service through ${hasProxy ? 'the proxy' : 'this connection'} at ${current.checkedAt}.`
        }
      : { verdict: 'unknown', observed: null, expected: null, detail: current.proxy.message }

  const proxyReachedHost = current ? current.proxy.ok : null
  const dns = assessDns(profile.proxy, proxyReachedHost)

  const tzExpected = expected ? (expected.timezone ?? input.systemTimezone) : null
  const timezone = page
    ? compareValue(page.timezone, tzExpected, (a, b) => canonicalZone(a) === canonicalZone(b))
    : { verdict: 'unknown' as const, observed: null, expected: tzExpected, detail: 'Open the profile to test what its pages report.' }
  if (page && expected && !expected.timezone && timezone.verdict === 'pass') {
    timezone.detail = 'No time zone override: pages show this PC’s time zone.'
  }

  const language = page
    ? compareValue(page.language, expected?.locale ?? null, sameLanguage, 'No language set for this profile; pages use the app default.')
    : { verdict: 'unknown' as const, observed: null, expected: expected?.locale ?? profile.browser.language, detail: 'Open the profile to test what its pages report.' }
  if (page && page.languages.length > 0) language.detail += ` navigator.languages: ${page.languages.join(', ')}.`

  const userAgent = page
    ? compareValue(page.userAgent, expected?.userAgent ?? null)
    : { verdict: 'unknown' as const, observed: null, expected: expected?.userAgent ?? null, detail: 'Open the profile to test what its pages report.' }

  const webrtcLocal = page
    ? assessLocalWebRtc(page.webrtc, proxyIp, hasProxy)
    : { verdict: 'unknown' as const, observed: null, expected: null, detail: 'Open the profile to test WebRTC in its pages.', candidates: [] }

  const webrtcStun = input.stunServer ? assessStun(page ? page.stun : null, proxyIp, hasProxy, input.stunServer) : null

  return {
    profileId: profile.id,
    ranAt: input.now.toISOString(),
    pageTested: page !== null,
    pageUrl: page?.url ?? null,
    pageProblem: input.pageProblem ?? null,
    partition,
    proxyRoute: assessProxyRoute(profile.proxy, input.resolvedProxy),
    proxyConnection,
    publicIp,
    dns,
    timezone,
    language,
    userAgent,
    webrtcPolicy: profile.browser.webrtcPolicy,
    webrtcLocal,
    webrtcStun
  }
}

/** Gathering time per WebRTC test inside the page. */
export const WEBRTC_GATHER_MS = 4000

/**
 * Script run in an isolated world of a profile page. It reads the page's own view of time zone,
 * language and User-Agent, and gathers WebRTC candidates: first with no servers (nothing leaves
 * the PC), then — only when a STUN server is given — against that server.
 */
export function probeScript(stunServer: string | null, gatherMs = WEBRTC_GATHER_MS): string {
  return `(async () => {
  const gather = (iceServers) => new Promise((resolve) => {
    if (typeof RTCPeerConnection !== 'function') { resolve({ error: 'RTCPeerConnection is not available', candidates: [] }); return }
    let pc
    try { pc = new RTCPeerConnection({ iceServers }) } catch (e) { resolve({ error: String((e && e.message) || e), candidates: [] }); return }
    const candidates = []
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { pc.close() } catch (e) {}
      resolve({ error: error || null, candidates })
    }
    const timer = setTimeout(() => finish(null), ${Math.max(500, Math.floor(gatherMs))})
    pc.onicecandidate = (event) => {
      if (event.candidate) { if (event.candidate.candidate) candidates.push(event.candidate.candidate) }
      else finish(null)
    }
    try { pc.createDataChannel('pob-diagnostics') } catch (e) {}
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch((e) => finish(String((e && e.message) || e)))
  })
  const result = {
    url: String(location.href),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    language: navigator.language || null,
    languages: Array.from(navigator.languages || []),
    userAgent: navigator.userAgent || null,
    webrtc: null,
    stun: null
  }
  result.webrtc = await gather([])
  ${stunServer ? `result.stun = await gather([{ urls: ${JSON.stringify(stunServer)} }])` : ''}
  return result
})()`
}

/** Validates the probe's answer; anything unexpected becomes null (reported as unknown). */
export function parseProbeResult(value: unknown): PageProbeResult | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const str = (x: unknown, max = 2000): string | null => (typeof x === 'string' ? x.slice(0, max) : null)
  const gathered = (x: unknown): PageProbeResult['webrtc'] => {
    if (!x || typeof x !== 'object') return null
    const g = x as Record<string, unknown>
    const candidates = Array.isArray(g.candidates) ? g.candidates.filter((c): c is string => typeof c === 'string').slice(0, 50).map((c) => c.slice(0, 300)) : []
    return { error: str(g.error, 300), candidates }
  }
  return {
    url: str(v.url) ?? '',
    timezone: str(v.timezone, 64),
    language: str(v.language, 64),
    languages: Array.isArray(v.languages) ? v.languages.filter((l): l is string => typeof l === 'string').slice(0, 20).map((l) => l.slice(0, 64)) : [],
    userAgent: str(v.userAgent, 500),
    webrtc: gathered(v.webrtc),
    stun: gathered(v.stun)
  }
}
