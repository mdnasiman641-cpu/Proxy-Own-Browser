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
  expected: {
    timezone: string | null
    locale: string | null
    userAgent: string
    geolocation?: { latitude: number; longitude: number } | null
  } | null
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
    : notTested(tzExpected)
  if (page && expected && !expected.timezone && timezone.verdict === 'pass') {
    timezone.detail = 'No time zone override: pages show this PC’s time zone.'
  }

  const language = page
    ? compareValue(page.language, expected?.locale ?? null, sameLanguage, 'No language set for this profile; pages use the app default.')
    : notTested(expected?.locale ?? profile.browser.language)
  if (page && page.languages.length > 0) language.detail += ` navigator.languages: ${page.languages.join(', ')}.`

  const userAgent = page
    ? compareValue(page.userAgent, expected?.userAgent ?? null)
    : notTested(expected?.userAgent ?? null)

  const webrtcLocal = page
    ? assessLocalWebRtc(page.webrtc, proxyIp, hasProxy)
    : { ...notTested(null), candidates: [] }

  const webrtcStun = input.stunServer ? assessStun(page ? page.stun : null, proxyIp, hasProxy, input.stunServer) : null

  const secureConnection = assessSecureConnection(page)
  const permission = profile.browser.permissions.geolocation
  const geolocationPermission = assessGeolocationPermission(page, permission)
  const geolocationPosition = assessGeolocationPosition(page, expected?.geolocation ?? null)

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
    webrtcStun,
    secureConnection,
    geolocationPermission,
    geolocationPosition,
    reportedHardware: page?.hardware ?? null
  }
}

function notTested(expected: string | null): DiagnosticCheck {
  return { verdict: 'not-tested', observed: null, expected, detail: 'Open the profile to test what its pages report.' }
}

/** HTTPS pages only load with a certificate Chromium accepted; plain HTTP is not encrypted. */
export function assessSecureConnection(page: PageProbeResult | null): DiagnosticCheck {
  if (!page) return notTested('https')
  let protocol = ''
  try {
    protocol = new URL(page.url).protocol
  } catch {
    // not a URL
  }
  if (protocol === 'https:') {
    return {
      verdict: 'pass',
      observed: page.secureContext === false ? 'https (not a secure context)' : 'https',
      expected: 'https',
      detail: 'The page was loaded over HTTPS with a certificate Chromium accepted (invalid certificates are refused).'
    }
  }
  if (protocol === 'http:') {
    return { verdict: 'warning', observed: 'http', expected: 'https', detail: 'This page is not encrypted; the proxy and the network can read it.' }
  }
  return { verdict: 'not-tested', observed: protocol || null, expected: 'https', detail: 'Open a website in the active tab to test its connection.' }
}

const PERMISSION_STATE: Record<string, string> = { allow: 'granted', block: 'denied', ask: 'prompt' }

export function assessGeolocationPermission(page: PageProbeResult | null, setting: string): DiagnosticCheck {
  const expected = PERMISSION_STATE[setting] ?? null
  if (!page) return notTested(expected)
  const observed = page.geolocationPermission
  if (!observed) return { verdict: 'unknown', observed: null, expected, detail: 'The page could not query the permission.' }
  if (setting === 'ask') {
    return { verdict: 'info', observed, expected: 'asked per site', detail: 'The site is asked once per window; the state depends on your answer.' }
  }
  return observed === expected
    ? { verdict: 'pass', observed, expected, detail: 'Matches the profile’s permission setting.' }
    : { verdict: 'warning', observed, expected, detail: 'The page reports a different permission state than the profile setting.' }
}

/** Distance between two coordinates in kilometres (haversine). */
export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (d: number): number => (d * Math.PI) / 180
  const dLat = rad(b.latitude - a.latitude)
  const dLon = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function assessGeolocationPosition(
  page: PageProbeResult | null,
  expected: { latitude: number; longitude: number } | null
): DiagnosticCheck {
  const expectedText = expected ? `${expected.latitude.toFixed(4)}, ${expected.longitude.toFixed(4)}` : 'no location'
  if (!page) return notTested(expectedText)
  const position = page.geolocationPosition
  if (position === null) {
    return {
      verdict: 'not-tested',
      observed: null,
      expected: expectedText,
      detail: 'Not read: the site does not have the location permission (reading it would ask or be refused).'
    }
  }
  if ('error' in position) {
    return expected
      ? { verdict: 'fail', observed: position.error, expected: expectedText, detail: 'The page did not receive the configured location.' }
      : { verdict: 'pass', observed: position.error, expected: expectedText, detail: 'No location is provided to pages, as configured.' }
  }
  const observed = `${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)} (±${Math.round(position.accuracy)} m)`
  if (!expected) return { verdict: 'info', observed, expected: expectedText, detail: 'The page received a location although none is configured.' }
  return distanceKm(position, expected) < 1
    ? { verdict: 'pass', observed, expected: expectedText, detail: 'The page receives the profile’s configured location.' }
    : { verdict: 'fail', observed, expected: expectedText, detail: 'The page receives a different location than configured.' }
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
    stun: null,
    secureContext: null,
    hardware: null,
    geolocationPermission: null,
    geolocationPosition: null
  }
  try {
    const nav = navigator
    result.secureContext = typeof isSecureContext === 'boolean' ? isSecureContext : null
    result.hardware = {
      hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
      deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      screenWidth: screen.width, screenHeight: screen.height,
      devicePixelRatio: window.devicePixelRatio, platform: nav.platform || null
    }
  } catch (e) {}
  try {
    const state = (await navigator.permissions.query({ name: 'geolocation' })).state
    result.geolocationPermission = state
    // Only read the position when the site already may: reading it otherwise would ask the user.
    if (state === 'granted') {
      result.geolocationPosition = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
          (e) => resolve({ error: e && e.message ? e.message : 'unavailable' }),
          { timeout: 3000, maximumAge: 0 }
        )
      })
    }
  } catch (e) {}
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
    stun: gathered(v.stun),
    secureContext: typeof v.secureContext === 'boolean' ? v.secureContext : null,
    hardware: parseHardware(v.hardware),
    geolocationPermission: typeof v.geolocationPermission === 'string' ? v.geolocationPermission.slice(0, 20) : null,
    geolocationPosition: parsePosition(v.geolocationPosition)
  }
}

const finiteOrNull = (x: unknown, min: number, max: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : null

function parseHardware(value: unknown): PageProbeResult['hardware'] {
  if (!value || typeof value !== 'object') return null
  const h = value as Record<string, unknown>
  return {
    hardwareConcurrency: finiteOrNull(h.hardwareConcurrency, 0, 4096),
    deviceMemory: finiteOrNull(h.deviceMemory, 0, 4096),
    screenWidth: finiteOrNull(h.screenWidth, 0, 100_000),
    screenHeight: finiteOrNull(h.screenHeight, 0, 100_000),
    devicePixelRatio: finiteOrNull(h.devicePixelRatio, 0, 100),
    platform: typeof h.platform === 'string' ? h.platform.slice(0, 64) : null
  }
}

function parsePosition(value: unknown): PageProbeResult['geolocationPosition'] {
  if (!value || typeof value !== 'object') return null
  const p = value as Record<string, unknown>
  if (typeof p.error === 'string') return { error: p.error.slice(0, 200) }
  const latitude = finiteOrNull(p.latitude, -90, 90)
  const longitude = finiteOrNull(p.longitude, -180, 180)
  const accuracy = finiteOrNull(p.accuracy, 0, 10_000_000)
  return latitude === null || longitude === null || accuracy === null ? null : { latitude, longitude, accuracy }
}
