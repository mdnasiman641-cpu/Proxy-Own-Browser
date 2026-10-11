import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BROWSER_CONFIG,
  acceptLanguageFor,
  chromeUserAgent,
  isValidLanguageTag,
  isValidTimeZone,
  parseStoredBrowserConfig
} from '../src/shared/browserConfig'
import { proxyEndpointKey } from '../src/shared/proxy'
import { parseGeoResponse, runGeoLookup } from '../src/main/services/geoLookup'
import { GEO_CACHE_MS, LAUNCH_RECHECK_MS, NetworkService, TIMEZONE_CACHE_MS, type RouteChecker } from '../src/main/services/networkService'
import { FetchError } from '../src/main/services/proxyTest'
import { assessPressure } from '../src/main/services/resourcePressure'
import type { GeoLookupResult } from '../src/main/services/geoLookup'
import type { ProxyTestResult } from '../src/shared/types'
import { createApp, createService } from './helpers'

const IPWHOIS_NY = JSON.stringify({
  ip: '203.0.113.7',
  success: true,
  country: 'United States',
  country_code: 'US',
  region: 'New York',
  city: 'New York',
  latitude: 40.71,
  longitude: -74.0,
  timezone: { id: 'America/New_York', utc: '-04:00' }
})

const proxyOk = (ip: string): ProxyTestResult => ({
  ok: true,
  status: 'success',
  message: `Connected. Public IP address is ${ip}.`,
  ip,
  responseTimeMs: 20,
  endpoint: 'test',
  route: 'test',
  testedAt: new Date().toISOString()
})
const proxyFail: ProxyTestResult = { ...proxyOk('x'), ok: false, status: 'proxy-unreachable', message: 'Could not connect to the proxy server.', ip: null }
const geoOk = (ip: string, timezone: string | null): GeoLookupResult => ({
  status: 'success',
  message: 'Located',
  data: { ip, country: 'X', countryCode: 'XX', region: null, city: null, latitude: null, longitude: null, timezone, isp: null, org: null, asn: null, provider: 'test' }
})

/** A checker whose answers the test controls; records which targets it was asked about. */
function fakeChecker() {
  /** `geo` records whether a location lookup was actually made for that check. */
  const calls: { key: string; host: string | null; geo: boolean }[] = []
  let next: { proxy: ProxyTestResult; geo: GeoLookupResult | null } = { proxy: proxyOk('203.0.113.7'), geo: geoOk('203.0.113.7', 'America/New_York') }
  const checker: RouteChecker = {
    async check(key, target, options) {
      const ip = next.proxy.ip
      const wantGeo = typeof options.geo === 'function' ? next.proxy.ok && ip !== null && options.geo(ip) : options.geo
      calls.push({ key, host: target.proxy?.host ?? null, geo: wantGeo && next.proxy.ok })
      return { proxy: next.proxy, geo: wantGeo && next.proxy.ok ? next.geo : null }
    }
  }
  return { checker, calls, answer: (a: typeof next) => (next = a) }
}

async function networkApp(now: () => Date = () => new Date()) {
  const app = await createApp()
  const fake = fakeChecker()
  const network = new NetworkService({
    db: app.db,
    profiles: app.service,
    checker: fake.checker,
    geoEnabled: () => app.settings.get().ipGeolocation,
    logger: { info() {}, warn() {}, error() {} },
    now
  })
  return { ...app, network, fake }
}

const PROXY = { enabled: true, protocol: 'http' as const, host: '10.0.0.1', port: 8080 }

describe('browser settings', () => {
  it('validates languages and IANA time zones', () => {
    expect(isValidTimeZone('Asia/Dhaka')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('Mars/Base')).toBe(false)
    expect(isValidTimeZone('../../etc')).toBe(false)
    expect(isValidLanguageTag('bn-BD')).toBe(true)
    expect(isValidLanguageTag('en')).toBe(true)
    expect(isValidLanguageTag('not a language')).toBe(false)
    expect(acceptLanguageFor('bn-BD')).toBe('bn-BD,bn,en')
    expect(acceptLanguageFor('en-US')).toBe('en-US,en')
    expect(acceptLanguageFor('en')).toBe('en')
  })

  it('reads damaged stored settings field by field', () => {
    expect(parseStoredBrowserConfig('not json')).toEqual(DEFAULT_BROWSER_CONFIG)
    const parsed = parseStoredBrowserConfig({ zoomPercent: 9999, language: 'bn-BD', permissions: { media: 'allow', camera: 'allow' } })
    expect(parsed.zoomPercent).toBe(100)
    expect(parsed.language).toBe('bn-BD')
    expect(parsed.permissions).toEqual({ ...DEFAULT_BROWSER_CONFIG.permissions, media: 'allow' })
    // Manual mode without a zone is not usable; it falls back to "off".
    expect(parseStoredBrowserConfig({ timezoneMode: 'manual' }).timezoneMode).toBe('off')
  })

  it('stores per-profile settings independently and rejects invalid ones', async () => {
    const app = await createApp()
    const a = app.service.create({ name: 'A', browser: { timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka', language: 'bn-BD' } })
    const b = app.service.create({ name: 'B' })
    expect(app.service.get(b.id).browser).toEqual(DEFAULT_BROWSER_CONFIG)
    app.service.update(b.id, { browser: { zoomPercent: 150, permissions: { notifications: 'allow' } } })
    expect(app.service.get(a.id).browser).toMatchObject({ timezoneManual: 'Asia/Dhaka', zoomPercent: 100, permissions: { notifications: 'block' } })
    expect(app.service.get(b.id).browser).toMatchObject({ zoomPercent: 150, permissions: { notifications: 'allow' } })
    expect(() => app.service.update(a.id, { browser: { timezoneMode: 'manual', timezoneManual: null } })).toThrow(/Choose a time zone/)
    expect(() => app.service.update(a.id, { browser: { timezoneManual: 'Nowhere/City' } })).toThrow(/Unknown time zone/)
    expect(() => app.service.update(a.id, { browser: { windowWidth: 10 } })).toThrow(/at least/)
    expect(() => app.service.update(a.id, { browser: { cpuCores: 64 } as never })).toThrow()
  })

  it('builds the plain Chrome User-Agent from the real one without changing versions', () => {
    const electron =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ProxyOwnBrowser/0.4.0 Chrome/140.0.7339.41 Electron/44.7.0 Safari/537.36'
    const chrome = chromeUserAgent(electron, 'Proxy Own Browser')
    expect(chrome).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36')
    expect(chrome).toContain('Chrome/140.0.7339.41')
  })
})

describe('unique proxy assignment', () => {
  it('normalizes proxy endpoints without credentials', () => {
    expect(proxyEndpointKey({ host: 'Proxy.Example.com.', port: 80, username: 'u1' })).toBe('proxy.example.com:80|u1')
    expect(proxyEndpointKey(null)).toBe('direct')
  })

  it('warns about shared proxies only when the option is on, and allows an explicit override', async () => {
    let unique = false
    const { service } = await createService({ requireUniqueProxy: () => unique })
    const a = service.create({ name: 'A', proxy: PROXY })
    const b = service.create({ name: 'B', proxy: { ...PROXY, host: '10.0.0.1' } }) // allowed while off
    expect(service.findProxyConflicts(a.proxy, a.id)).toEqual([{ id: b.id, name: 'B' }])

    unique = true
    expect(() => service.create({ name: 'C', proxy: { ...PROXY, host: '10.0.0.1' } })).toThrow(/already assigned to "A", "B"/)
    expect(service.create({ name: 'C', proxy: PROXY }, { allowSharedProxy: true }).proxy?.host).toBe('10.0.0.1')
    // Different username = different endpoint.
    expect(service.create({ name: 'D', proxy: { ...PROXY, username: 'other', password: 'p' } }).proxy?.username).toBe('other')
    // Editing other fields of a profile that already shares a proxy still works.
    expect(service.update(b.id, { notes: 'still fine' }).notes).toBe('still fine')
    // Changing one profile's proxy never changes another's.
    service.update(a.id, { proxy: { ...PROXY, host: '10.9.9.9' } })
    expect(service.get(b.id).proxy?.host).toBe('10.0.0.1')
  })
})

describe('IP location lookup', () => {
  it('parses ipwho.is and ipapi.co answers without inventing values', () => {
    const ny = parseGeoResponse(IPWHOIS_NY, 'ipwhois', 'ipwho.is').data!
    expect(ny).toMatchObject({ ip: '203.0.113.7', country: 'United States', countryCode: 'US', city: 'New York', timezone: 'America/New_York' })
    const ipapi = parseGeoResponse(JSON.stringify({ ip: '198.51.100.4', country_name: 'Bangladesh', country_code: 'BD', region: 'Dhaka Division', city: 'Dhaka', timezone: 'Asia/Dhaka', latitude: 23.7, longitude: 90.4 }), 'ipapi', 'ipapi.co').data!
    expect(ipapi).toMatchObject({ country: 'Bangladesh', timezone: 'Asia/Dhaka' })
    const noTz = parseGeoResponse(JSON.stringify({ ip: '198.51.100.4', success: true, timezone: { id: 'Fake/Zone' } }), 'ipwhois', 'x').data!
    expect(noTz.timezone).toBeNull()
    expect(noTz.city).toBeNull()
    expect(parseGeoResponse(JSON.stringify({ success: false, message: 'reserved range' }), 'ipwhois', 'x')).toEqual({ data: null, reason: 'reserved range' })
    expect(parseGeoResponse('<html>', 'ipapi', 'x').data).toBeNull()
  })

  it('reports failure (never a made-up location) when every service fails', async () => {
    const result = await runGeoLookup({
      fetcher: async (url) => {
        if (url.includes('ipwho')) throw new FetchError('x', 'ERR_TIMED_OUT')
        return { status: 429, body: '' }
      }
    })
    expect(result.status).toBe('failed')
    expect(result.data).toBeNull()
    expect(result.message).toMatch(/rate-limiting/)
    const ok = await runGeoLookup({ fetcher: async () => ({ status: 200, body: IPWHOIS_NY }) })
    expect(ok).toMatchObject({ status: 'success', data: { timezone: 'America/New_York' } })
  })
})

describe('proxy status and automatic time zone', () => {
  it('checks through the profile’s own proxy and stores the result per profile', async () => {
    const app = await networkApp()
    const a = app.service.create({ name: 'A', proxy: PROXY })
    const b = app.service.create({ name: 'B' })
    const status = await app.network.check(a.id)
    expect(app.fake.calls[0]).toMatchObject({ host: '10.0.0.1', geo: true })
    expect(status).toMatchObject({ current: true, ip: '203.0.113.7', proxy: { ok: true }, geo: { status: 'success', data: { timezone: 'America/New_York' } } })
    expect(app.network.status(b.id)).toBeNull()

    // A proxy change makes the stored result out of date instead of reusing it.
    app.service.update(a.id, { proxy: { ...PROXY, host: '10.0.0.2' } })
    expect(app.network.status(a.id)!.current).toBe(false)
  })

  it('does not look up the location when the proxy fails, and never reports a fallback IP', async () => {
    const app = await networkApp()
    const a = app.service.create({ name: 'A', proxy: PROXY })
    app.fake.answer({ proxy: proxyFail, geo: null })
    const status = await app.network.check(a.id)
    expect(status.proxy.ok).toBe(false)
    expect(status.ip).toBeNull()
    expect(status.geo.status).toBe('skipped')
    expect(status.geo.data).toBeNull()
  })

  it('warns when two profiles exit through the same public IP', async () => {
    const app = await networkApp()
    const a = app.service.create({ name: 'A', proxy: PROXY })
    const b = app.service.create({ name: 'B', proxy: { ...PROXY, host: '10.0.0.2' } })
    await app.network.check(a.id)
    await app.network.check(b.id)
    expect(app.network.status(a.id)!.sameExitIpAs).toEqual([{ id: b.id, name: 'B' }])
    app.fake.answer({ proxy: proxyOk('198.51.100.9'), geo: geoOk('198.51.100.9', 'Asia/Dhaka') })
    await app.network.check(b.id)
    expect(app.network.status(a.id)!.sameExitIpAs).toEqual([])
  })

  it('notes when the exit IP changed between the IP check and the location lookup', async () => {
    const app = await networkApp()
    const a = app.service.create({ name: 'A', proxy: PROXY })
    app.fake.answer({ proxy: proxyOk('203.0.113.7'), geo: geoOk('203.0.113.99', 'America/Chicago') })
    expect((await app.network.check(a.id)).geo.message).toMatch(/changed between the two checks/)
  })

  it('applies manual and automatic time zones, and refuses to guess when detection fails', async () => {
    let clock = new Date('2026-10-11T00:00:00Z')
    const app = await networkApp(() => clock)
    const manual = app.service.create({ name: 'M', browser: { timezoneMode: 'manual', timezoneManual: 'Europe/Berlin', language: 'de-DE' } })
    expect(await app.network.planLaunch(manual.id)).toMatchObject({ timezone: 'Europe/Berlin', timezoneSource: 'manual', locale: 'de-DE' })
    const off = app.service.create({ name: 'O' })
    expect(await app.network.planLaunch(off.id)).toMatchObject({ timezone: null, timezoneSource: 'off' })
    expect(app.fake.calls).toHaveLength(0)

    const auto = app.service.create({ name: 'A', proxy: PROXY, browser: { timezoneMode: 'auto' } })
    expect(await app.network.planLaunch(auto.id)).toMatchObject({ timezone: 'America/New_York', timezoneSource: 'auto' })
    // Cached: no new lookup within the cache period.
    await app.network.planLaunch(auto.id)
    expect(app.fake.calls).toHaveLength(1)

    // Later, the lookup fails: the last valid zone for this proxy is used, with a warning.
    clock = new Date(clock.getTime() + TIMEZONE_CACHE_MS + 1000)
    app.fake.answer({ proxy: proxyOk('203.0.113.7'), geo: { status: 'failed', message: 'IP location lookup failed — timeout', data: null } })
    const stale = await app.network.planLaunch(auto.id)
    expect(stale.timezone).toBe('America/New_York')
    expect(stale.warnings[0]).toMatch(/Could not refresh the time zone/)
    expect(app.network.status(auto.id)!.lastValidTimezone).toBe('America/New_York')

    // New proxy and detection fails: the old proxy's zone is not used, and opening is refused.
    app.service.update(auto.id, { proxy: { ...PROXY, host: '10.0.0.5' } })
    await expect(app.network.planLaunch(auto.id)).rejects.toThrow(/could not be detected.*different proxy/)

    // Proxy down: also refused, with the proxy's own error.
    app.fake.answer({ proxy: proxyFail, geo: null })
    await expect(app.network.planLaunch(auto.id)).rejects.toThrow(/Could not connect to the proxy server/)
  })

  it('refuses automatic mode when location lookups are turned off', async () => {
    const app = await networkApp()
    app.settings.update({ ipGeolocation: false })
    const auto = app.service.create({ name: 'A', browser: { timezoneMode: 'auto' } })
    await expect(app.network.planLaunch(auto.id)).rejects.toThrow(/turned off/)
    const status = await app.network.check(auto.id)
    expect(status.geo.status).toBe('skipped')
  })
})

describe('IP location caching, rotation and isolation', () => {
  it('reads ISP, organization and ASN when the service reports them', () => {
    const data = parseGeoResponse(
      JSON.stringify({ ip: '203.0.113.7', success: true, country: 'US', connection: { asn: 13335, org: 'Example Org', isp: 'Example ISP' }, timezone: { id: 'America/Chicago' } }),
      'ipwhois',
      'ipwho.is'
    ).data!
    expect(data).toMatchObject({ isp: 'Example ISP', org: 'Example Org', asn: 'AS13335', timezone: 'America/Chicago' })
    const ipapi = parseGeoResponse(JSON.stringify({ ip: '198.51.100.4', org: 'Some Telecom', asn: 'AS64500' }), 'ipapi', 'ipapi.co').data!
    expect(ipapi).toMatchObject({ isp: null, org: 'Some Telecom', asn: 'AS64500', timezone: null, city: null })
  })

  it('reuses the location for the same exit IP, looks it up again for a new IP or on manual refresh', async () => {
    let clock = new Date('2026-10-11T00:00:00Z')
    const app = await networkApp(() => clock)
    const a = app.service.create({ name: 'A', proxy: PROXY })
    await app.network.check(a.id)
    expect(app.fake.calls.at(-1)!.geo).toBe(true)

    clock = new Date(clock.getTime() + 60_000)
    const cached = await app.network.check(a.id)
    expect(app.fake.calls.at(-1)!.geo).toBe(false)
    expect(cached).toMatchObject({ geoReused: true, ip: '203.0.113.7', geo: { status: 'success', data: { timezone: 'America/New_York' } } })
    expect(cached.geoCheckedAt).toBe('2026-10-11T00:00:00.000Z')

    const forced = await app.network.check(a.id, { force: true })
    expect(app.fake.calls.at(-1)!.geo).toBe(true)
    expect(forced.geoReused).toBe(false)

    // The proxy rotates to a new exit IP: noticed, remembered, and located again.
    app.fake.answer({ proxy: proxyOk('198.51.100.9'), geo: geoOk('198.51.100.9', 'America/Chicago') })
    const rotated = await app.network.check(a.id)
    expect(app.fake.calls.at(-1)!.geo).toBe(true)
    expect(rotated).toMatchObject({ ip: '198.51.100.9', previousIp: '203.0.113.7', geo: { data: { timezone: 'America/Chicago' } }, lastValidTimezone: 'America/Chicago' })
    expect(rotated.ipChangedAt).toBe(clock.toISOString())

    // After the cache period the same IP is looked up again.
    clock = new Date(clock.getTime() + GEO_CACHE_MS + 1000)
    await app.network.check(a.id)
    expect(app.fake.calls.at(-1)!.geo).toBe(true)
  })

  it('rechecks the exit IP when an automatic-time-zone profile opens after a while', async () => {
    let clock = new Date('2026-10-11T00:00:00Z')
    const app = await networkApp(() => clock)
    const a = app.service.create({ name: 'A', proxy: PROXY })
    expect(a.browser.timezoneMode).toBe('auto')
    await app.network.planLaunch(a.id)
    const calls = app.fake.calls.length
    await app.network.planLaunch(a.id)
    expect(app.fake.calls.length).toBe(calls) // fresh: no request
    clock = new Date(clock.getTime() + LAUNCH_RECHECK_MS + 1000)
    app.fake.answer({ proxy: proxyOk('198.51.100.9'), geo: geoOk('198.51.100.9', 'Europe/Berlin') })
    expect((await app.network.planLaunch(a.id)).timezone).toBe('Europe/Berlin')
  })

  it('a check stores only that profile\'s result and never copies it to another profile', async () => {
    const app = await networkApp()
    const a = app.service.create({ name: 'A', proxy: PROXY })
    const b = app.service.create({ name: 'B', proxy: { ...PROXY, host: '10.0.0.2' } })
    app.fake.answer({ proxy: proxyOk('198.51.100.9'), geo: geoOk('198.51.100.9', 'Europe/Berlin') })
    await app.network.check(b.id)
    const bBefore = JSON.stringify(app.network.status(b.id))
    app.fake.answer({ proxy: proxyOk('203.0.113.7'), geo: geoOk('203.0.113.7', 'America/New_York') })
    await app.network.check(a.id)
    expect(JSON.stringify(app.network.status(b.id))).toBe(bBefore)
    expect(app.network.status(a.id)!.geo.data!.timezone).toBe('America/New_York')
    expect(app.network.status(b.id)!.geo.data!.timezone).toBe('Europe/Berlin')
    expect(app.fake.calls.map((c) => c.host)).toEqual(['10.0.0.2', '10.0.0.1'])
  })

  it('reports a location-service timeout as a failure and keeps the last valid time zone', async () => {
    const result = await runGeoLookup({
      fetcher: () => new Promise(() => {}),
      timeoutMs: 50
    })
    expect(result).toMatchObject({ status: 'failed', data: null })
    expect(result.message).toMatch(/did not answer in time/)

    const app = await networkApp()
    const a = app.service.create({ name: 'A', proxy: PROXY })
    await app.network.check(a.id)
    app.fake.answer({ proxy: proxyOk('203.0.113.7'), geo: result })
    const failed = await app.network.check(a.id, { force: true })
    expect(failed).toMatchObject({ geo: { status: 'failed', data: null }, lastValidTimezone: 'America/New_York', lastValidTimezoneCurrent: true })
  })

  it('switches to the automatic time zone when a proxy is configured for the first time', async () => {
    const app = await createApp()
    const plain = app.service.create({ name: 'Plain' })
    expect(plain.browser.timezoneMode).toBe('off')
    expect(app.service.update(plain.id, { proxy: PROXY }).browser.timezoneMode).toBe('auto')
    const manual = app.service.create({ name: 'Manual', browser: { timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka' } })
    expect(app.service.update(manual.id, { proxy: PROXY }).browser.timezoneMode).toBe('manual')
    const explicitOff = app.service.create({ name: 'Off', proxy: PROXY, browser: { timezoneMode: 'off' } })
    expect(explicitOff.browser.timezoneMode).toBe('off')
  })
})

describe('resource pressure', () => {
  it('warns on low free memory without suggesting automatic action', () => {
    expect(assessPressure({ totalMemoryMb: 16000, freeMemoryMb: 8000, appMemoryMb: 900, openWindows: 2, maxOpenProfiles: 2 })).toEqual({ level: 'ok', messages: [] })
    expect(assessPressure({ totalMemoryMb: 16000, freeMemoryMb: 2500, appMemoryMb: 900, openWindows: 1, maxOpenProfiles: 2 }).level).toBe('warning')
    const high = assessPressure({ totalMemoryMb: 8000, freeMemoryMb: 500, appMemoryMb: 4500, openWindows: 3, maxOpenProfiles: 3 })
    expect(high.level).toBe('high')
    expect(high.messages.length).toBeGreaterThan(1)
  })
})
