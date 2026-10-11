import type { WebContents } from 'electron'
import type { BrowserTimezoneReport, ProfileNetworkStatus } from '@shared/types'
import { httpJson, pageHas, viaDashboard, waitFor, type Check, type Fixtures, type SmokeContext } from './smokeHelpers'

/**
 * Proxy IP location & automatic time zone, end to end: two profiles on different proxies open at
 * the same time, each showing and applying the location of its own proxy's exit IP; a proxy
 * change in one leaves the other alone; rotating exit IPs, cached lookups, manual refresh, and
 * location-service failures and timeouts.
 */

const TZ_SCRIPT = 'Intl.DateTimeFormat().resolvedOptions().timeZone'

async function loadPage(ctx: SmokeContext, f: Fixtures, profileId: string, n: number): Promise<WebContents> {
  const entry = ctx.windows.windowFor(profileId)!
  ctx.windows.navigate(entry, `${f.echoBase}/page?n=${n}`)
  const contents = ctx.windows.sessionContents(profileId)!
  await waitFor(() => contents.getTitle() === `Smoke page ${n}`, 15_000)
  return contents
}

/** The exit IP a page itself sees (fetched from inside the page, through its profile's proxy). */
async function pageIp(contents: WebContents): Promise<string> {
  const result = (await contents.executeJavaScript(`fetch('/ip', { cache: 'no-store' }).then((r) => r.json())`)) as { ip: string }
  return result.ip
}

export async function locationChecks(ctx: SmokeContext, check: Check, f: Fixtures, nyId: string): Promise<void> {
  const ny = f.exits.ny!
  const chi = f.exits.chi!
  const labA = f.exits['lab-a']!
  const labB = f.exits['lab-b']!
  const geoRequests = async (): Promise<number> => (await httpJson<{ geoRequests: number }>(`${f.echoBase}/stats`)).geoRequests

  // A profile created through the dashboard with a proxy gets the automatic time zone and is
  // checked right away (in the background).
  const created = await viaDashboard<{ id: string; browser: { timezoneMode: string } }>(
    ctx,
    `window.pob.createProfile(${JSON.stringify({
      name: 'Smoke Chicago',
      proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: f.openProxyPort, bypassRules: '<-loopback>' }
    })})`
  )
  check('a new profile with a proxy uses the automatic time zone', created.browser.timezoneMode === 'auto', created.browser.timezoneMode)
  const detected = await waitFor(() => ctx.network.status(created.id)?.geo.data?.timezone === chi.timezone, 10_000)
  check('location and time zone are detected as soon as the proxy is configured', detected, JSON.stringify(ctx.network.status(created.id)?.geo.data))

  // Each profile's stored result is its own proxy's exit.
  const nyStatus = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(nyId)})`)
  const chiStatus = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(created.id)})`)
  check(
    'two proxies: each profile shows the IP, city, ISP and time zone of its own proxy',
    nyStatus.ip === ny.ip && nyStatus.geo.data?.city === ny.city && nyStatus.geo.data?.isp === ny.isp && nyStatus.geo.data?.timezone === ny.timezone &&
      chiStatus.ip === chi.ip && chiStatus.geo.data?.city === chi.city && chiStatus.geo.data?.isp === chi.isp && chiStatus.geo.data?.timezone === chi.timezone,
    `${nyStatus.ip} ${nyStatus.geo.data?.city} ${nyStatus.geo.data?.timezone} | ${chiStatus.ip} ${chiStatus.geo.data?.city} ${chiStatus.geo.data?.timezone}`
  )
  check('different proxies are not flagged as sharing an exit IP', !chiStatus.sameExitIpAs.some((p) => p.id === nyId))

  // Both open at the same time; each page sees its own proxy's IP and time zone.
  await ctx.windows.open(created.id, { initialUrl: 'about:blank' })
  const nyTab = await loadPage(ctx, f, nyId, 70)
  const chiTab = await loadPage(ctx, f, created.id, 71)
  const [nyTz, chiTz, nyPageIp, chiPageIp] = await Promise.all([
    nyTab.executeJavaScript(TZ_SCRIPT),
    chiTab.executeJavaScript(TZ_SCRIPT),
    pageIp(nyTab),
    pageIp(chiTab)
  ])
  check(
    'simultaneous profiles: Intl time zone in each page matches its own proxy location',
    nyTz === ny.timezone && chiTz === chi.timezone,
    `${nyTz} / ${chiTz}`
  )
  check('simultaneous profiles: each page reaches the internet through its own proxy', nyPageIp === ny.ip && chiPageIp === chi.ip, `${nyPageIp} / ${chiPageIp}`)
  const reportsOk = await waitFor(async () => {
    const r = await viaDashboard<Record<string, BrowserTimezoneReport>>(ctx, 'window.pob.reportedTimezones()')
    return r[nyId]?.reported === ny.timezone && r[nyId]!.matches && r[created.id]?.reported === chi.timezone && r[created.id]!.matches
  })
  check('the app verifies the time zone pages report in each open window', reportsOk)

  // The Proxies & location page lists each profile's own values.
  const dash = ctx.getDashboard()!.webContents
  await dash.executeJavaScript(`document.querySelector('[data-nav="proxy"]').click()`)
  await pageHas(dash, `[data-testid="location-row-${created.id}"]`)
  const rowText = (id: string, cell: string): Promise<string> =>
    dash.executeJavaScript(`document.querySelector('[data-testid="location-row-${id}"] [data-testid="${cell}"]')?.textContent ?? ''`)
  const rowsOk = await waitFor(
    async () =>
      (await rowText(nyId, 'row-ip')) === ny.ip &&
      (await rowText(created.id, 'row-ip')) === chi.ip &&
      (await rowText(nyId, 'row-tz')) === ny.timezone &&
      (await rowText(created.id, 'row-tz')) === chi.timezone
  )
  const clock = await dash.executeJavaScript(
    `document.querySelector('[data-testid="location-row-${created.id}"] [data-testid="local-time"]')?.textContent ?? ''`
  )
  check('location page shows each profile’s own IP, time zone and local time', rowsOk && /GMT-[56]/.test(clock), clock)

  // Changing one profile's proxy re-detects only that profile; the other is untouched.
  const nyBefore = JSON.stringify({ browser: ctx.profiles.get(nyId).browser, proxy: ctx.profiles.get(nyId).proxy, net: ctx.network.status(nyId) })
  await viaDashboard(
    ctx,
    `window.pob.updateProfile(${JSON.stringify(created.id)}, { proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: ${f.labProxyPort}, bypassRules: '<-loopback>' } })`
  )
  const labTab = await loadPage(ctx, f, created.id, 72)
  const labTz = await labTab.executeJavaScript(TZ_SCRIPT)
  const nyAfter = JSON.stringify({ browser: ctx.profiles.get(nyId).browser, proxy: ctx.profiles.get(nyId).proxy, net: ctx.network.status(nyId) })
  check(
    'changing one profile’s proxy re-detects its location and time zone (open window updated)',
    labTz === labA.timezone && ctx.network.status(created.id)?.ip === labA.ip,
    `${labTz} ${ctx.network.status(created.id)?.ip}`
  )
  check('the other profile’s proxy, settings and detected location are unchanged', nyBefore === nyAfter)

  // Cached: the same exit IP does not trigger a new location lookup...
  const before = await geoRequests()
  const cached = await ctx.network.check(created.id)
  check('the location is reused while the exit IP is unchanged (no new lookup)', cached.geoReused && (await geoRequests()) === before && cached.geo.data?.timezone === labA.timezone)

  // ...but a rotated IP is noticed and looked up again.
  await httpJson(`${f.echoBase}/lab?exit=lab-b`)
  const rotated = await ctx.network.check(created.id)
  check(
    'a rotating proxy’s new exit IP is detected and its location looked up again',
    rotated.ip === labB.ip && rotated.previousIp === labA.ip && rotated.geo.data?.timezone === labB.timezone && !rotated.geoReused,
    `${rotated.previousIp} -> ${rotated.ip} ${rotated.geo.data?.timezone}`
  )
  check('a missing city is reported as unknown, not invented', rotated.geo.data?.city === null && rotated.geo.data?.country === 'Germany')

  // Manual refresh always asks the service again, even for the same IP.
  const beforeRefresh = await geoRequests()
  const refreshed = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(created.id)})`)
  check('Refresh IP & location always looks the location up again', !refreshed.geoReused && (await geoRequests()) === beforeRefresh + 1)

  // Location service fails: an error is shown and the last valid time zone is kept and used.
  await httpJson(`${f.echoBase}/lab?geo=fail`)
  const failed = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(created.id)})`)
  const planAfterFailure = await ctx.network.planLaunch(created.id)
  check(
    'location service failure: error shown, nothing invented, last valid time zone kept',
    failed.proxy.ok && failed.geo.status === 'failed' && failed.geo.data === null && failed.lastValidTimezone === labB.timezone &&
      planAfterFailure.timezone === labB.timezone,
    failed.geo.message
  )

  // Location service never answers: the lookup times out (3 s in this test) with the same result.
  await httpJson(`${f.echoBase}/lab?geo=hang`)
  const started = Date.now()
  const timedOut = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(created.id)})`)
  const elapsed = Date.now() - started
  check(
    'location service timeout: reported as failed within the time limit, last valid time zone kept',
    timedOut.geo.status === 'failed' && /did not answer in time|did not respond in time/i.test(timedOut.geo.message) && elapsed < 9000 &&
      timedOut.lastValidTimezone === labB.timezone,
    `${elapsed} ms: ${timedOut.geo.message}`
  )
  await httpJson(`${f.echoBase}/lab?geo=ok&exit=lab-a`)

  ctx.windows.close(created.id)
  await waitFor(() => !ctx.windows.isOpen(created.id))
  ctx.profiles.delete(created.id)
}
