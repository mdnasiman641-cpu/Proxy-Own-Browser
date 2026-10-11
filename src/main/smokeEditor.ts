import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { ClearDataResult, ProfileEffectiveConfig } from '@shared/types'
import { defaultUserAgent } from './electron/sessionManager'
import { COOKIE_NAME, COOKIE_URL, pageHas, readCookie, viaDashboard, waitFor, type Check, type Fixtures, type SmokeContext } from './smokeHelpers'

/**
 * Advanced profile settings, end to end: saved settings are applied when the profile opens
 * (startup URLs, window title, language and Accept-Language, custom User-Agent, Do Not Track,
 * manual geolocation, permissions), the launch report and effective configuration say so,
 * an unpacked extension loads into this profile only, cookie clearing touches only the selected
 * profile, restore-previous-tabs works, and the editor UI opens, switches categories and saves.
 */

export const EDITOR_PROFILE = 'Smoke Editor'
const LAT = 23.8103
const LON = 90.4125

function makeExtension(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pob-smoke-ext-'))
  mkdirSync(join(dir, 'js'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'Smoke Marker',
      version: '1.0',
      manifest_version: 3,
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['js/mark.js'], run_at: 'document_end' }]
    })
  )
  writeFileSync(join(dir, 'js', 'mark.js'), "document.documentElement.setAttribute('data-pob-ext', 'smoke')")
  return dir
}

const tabsOf = (ctx: SmokeContext, id: string): WebContents[] => {
  const entry = ctx.windows.windowFor(id)
  return entry ? entry.tabs.values().map((t) => t.view.webContents) : []
}

export async function editorSetupChecks(ctx: SmokeContext, check: Check, f: Fixtures, aId: string): Promise<void> {
  ctx.settings.update({ maxOpenProfiles: 4 })
  const customUa = `${defaultUserAgent()} SmokeCustom/1.0`
  const page = (n: number): string => `${f.echoBase}/page?n=${n}`

  // ---- saved through the same IPC the editor uses ----
  const created = await viaDashboard<{ id: string; partition: string }>(ctx, `window.pob.createProfile(${JSON.stringify({ name: EDITOR_PROFILE })})`)
  const saved = await viaDashboard<{ options: Record<string, unknown>; browser: Record<string, unknown> }>(
    ctx,
    `window.pob.updateProfile(${JSON.stringify(created.id)}, ${JSON.stringify({
      browser: {
        languageMode: 'manual',
        language: 'fr-FR',
        acceptLanguage: 'fr-FR,fr,en',
        timezoneMode: 'manual',
        timezoneManual: 'Asia/Tokyo',
        userAgent: 'custom',
        customUserAgent: customUa,
        geolocationMode: 'manual',
        geoLatitude: LAT,
        geoLongitude: LON,
        permissions: { geolocation: 'allow', notifications: 'block', camera: 'block' }
      },
      options: {
        purpose: 'Smoke',
        startupMode: 'urls',
        startupUrls: [page(90), page(91)],
        showNameInTitle: false,
        doNotTrack: true
      }
    })})`
  )
  check(
    'advanced settings are saved through the editor API',
    saved.options.startupMode === 'urls' && saved.browser.language === 'fr-FR' && saved.browser.geolocationMode === 'manual',
    JSON.stringify({ startup: saved.options.startupMode, lang: saved.browser.language })
  )
  const invalid = (await ctx.getDashboard()!.webContents.executeJavaScript(
    `window.pob.updateProfile(${JSON.stringify(created.id)}, { options: { startupUrls: ['javascript:alert(1)'] } })`
  )) as { ok: boolean; error?: string }
  check('invalid startup URLs are refused', !invalid.ok && /http/.test(invalid.error ?? ''), invalid.error)

  // ---- an unpacked extension for this profile only ----
  const notExtension = mkdtempSync(join(tmpdir(), 'pob-smoke-noext-'))
  let addError = ''
  try {
    await ctx.extensions.add(created.id, notExtension)
  } catch (error) {
    addError = error instanceof Error ? error.message : String(error)
  }
  check('a folder without manifest.json is refused with a clear error', /no manifest\.json/.test(addError), addError)
  const { extension } = await ctx.extensions.add(created.id, makeExtension())
  check('extension installed into the profile (copied into its own folder)', ctx.extensions.list(created.id).length === 1 && ctx.extensions.list(aId).length === 0)

  // ---- applied when the profile opens ----
  const outcome = await ctx.windows.open(created.id)
  const opened = await waitFor(async () => {
    const tabs = tabsOf(ctx, created.id)
    return tabs.length === 2 && tabs.every((t) => !t.isLoading() && /Smoke page 9[01]/.test(t.getTitle()))
  }, 20_000)
  const urls = tabsOf(ctx, created.id).map((t) => t.getURL())
  check('startup URLs open one tab each', opened && urls[0] === page(90) && urls[1] === page(91), `${outcome} ${urls.join(' ')}`)
  const title = ctx.windows.windowFor(created.id)?.window.getTitle() ?? ''
  check('window title without the profile name when that option is off', !title.includes(EDITOR_PROFILE) && title.length > 0, title)

  const tab = tabsOf(ctx, created.id)[0]!
  const env = (await tab.executeJavaScript(`({
    lang: navigator.language,
    langs: navigator.languages.join(','),
    ua: navigator.userAgent,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    notifications: Notification.permission
  })`)) as { lang: string; langs: string; ua: string; tz: string; notifications: string }
  const headers = (await tab.executeJavaScript(`fetch('/headers', { cache: 'no-store' }).then((r) => r.json())`)) as {
    acceptLanguage: string | null
    userAgent: string | null
    dnt: string | null
  }
  check('manual language and Accept-Language reach the page and the server', env.lang === 'fr-FR' && headers.acceptLanguage === 'fr-FR,fr,en', `${env.lang} | ${env.langs} | ${headers.acceptLanguage}`)
  check('custom User-Agent in navigator.userAgent and the request header', env.ua === customUa && headers.userAgent === customUa, env.ua)
  check('manual time zone applied', env.tz === 'Asia/Tokyo', env.tz)
  check('Do Not Track header sent', headers.dnt === '1', String(headers.dnt))
  check('blocked notification permission is reported as denied', env.notifications === 'denied', env.notifications)
  const position = (await tab.executeJavaScript(`new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
    (e) => resolve({ error: e.code + ' ' + e.message }),
    { timeout: 8000 }
  ))`)) as { lat?: number; lon?: number; error?: string }
  check(
    'manual geolocation is what pages receive (location permission allowed)',
    position.lat !== undefined && Math.abs(position.lat - LAT) < 1e-4 && Math.abs((position.lon ?? 0) - LON) < 1e-4,
    JSON.stringify(position)
  )

  const marked = await waitFor(async () => (await tab.executeJavaScript(`document.documentElement.getAttribute('data-pob-ext')`)) === 'smoke', 8000)
  const loaded = ctx.extensions.get(created.id, extension.id)
  check('extension loaded into this profile’s session when it opened', loaded.chromeId !== null && loaded.lastError === null, loaded.lastError ?? loaded.chromeId ?? 'not loaded')
  check('extension content script runs in this profile', marked, undefined, true)
  if (!ctx.windows.isOpen(aId)) await ctx.windows.open(aId, { initialUrl: 'about:blank' })
  const aEntry = ctx.windows.windowFor(aId)!
  ctx.windows.navigate(aEntry, page(92))
  const aTab = ctx.windows.sessionContents(aId)!
  await waitFor(() => aTab.getTitle() === 'Smoke page 92', 15_000)
  const aMarked = await aTab.executeJavaScript(`document.documentElement.getAttribute('data-pob-ext')`)
  check('another profile does not get the extension', aMarked === null && !ctx.extensionLoader.loadedIds(ctx.sessions.sessionFor(ctx.profiles.get(aId).partition)).has(loaded.chromeId ?? '-'), String(aMarked))

  // ---- effective configuration and launch report ----
  const effective = await viaDashboard<ProfileEffectiveConfig>(ctx, `window.pob.effectiveConfig(${JSON.stringify(created.id)})`)
  const report = effective.launchReport?.items ?? []
  const status = (name: string): string | undefined => report.find((i) => i.setting === name)?.status
  check(
    'effective configuration reflects the applied settings',
    effective.open && effective.timezone.value === 'Asia/Tokyo' && effective.language.locale === 'fr-FR' &&
      effective.geolocation?.source === 'manual' && effective.userAgent === customUa && effective.userAgentConflict === null,
    JSON.stringify({ tz: effective.timezone, lang: effective.language.locale, geo: effective.geolocation?.source })
  )
  check(
    'launch report lists what was applied',
    status('Language') === 'applied' && status('Geolocation') === 'applied' && status('Do Not Track') === 'applied' &&
      status('Startup pages') === 'applied' && status('Extension: Smoke Marker') === 'applied',
    report.map((i) => `${i.setting}:${i.status}`).join(', ')
  )

  // ---- cookies: only the selected profile is cleared ----
  const expirationDate = Math.floor(Date.now() / 1000) + 86_400
  const editorSession = ctx.sessions.sessionFor(created.partition)
  await editorSession.cookies.set({ url: COOKIE_URL, name: COOKIE_NAME, value: 'editor', expirationDate })
  await editorSession.cookies.set({ url: 'https://keep.invalid/', name: 'keep', value: '1', expirationDate })
  const aBefore = (await readCookie(ctx, ctx.profiles.get(aId).partition)).join()
  const site = await viaDashboard<ClearDataResult>(ctx, `window.pob.clearProfileData(${JSON.stringify(created.id)}, 'site', 'https://smoke-test.invalid')`)
  const afterSite = await editorSession.cookies.get({})
  check(
    'clearing one site’s data keeps the profile’s other sites',
    site.removedCookies === 1 && !afterSite.some((c) => c.name === COOKIE_NAME) && afterSite.some((c) => c.name === 'keep'),
    site.message
  )
  await viaDashboard<ClearDataResult>(ctx, `window.pob.clearProfileData(${JSON.stringify(created.id)}, 'cookies', null)`)
  const aAfter = (await readCookie(ctx, ctx.profiles.get(aId).partition)).join()
  check(
    'clearing cookies removes them from the selected profile only',
    (await editorSession.cookies.get({})).length === 0 && aBefore === 'alpha' && aAfter === 'alpha',
    `A before ${aBefore}, after ${aAfter}`
  )

  // ---- restore previous tabs ----
  await viaDashboard(ctx, `window.pob.updateProfile(${JSON.stringify(created.id)}, { options: { startupMode: 'restore' } })`)
  const entry = ctx.windows.windowFor(created.id)!
  ctx.windows.navigate(entry, page(93))
  await waitFor(() => tabsOf(ctx, created.id).some((t) => t.getTitle() === 'Smoke page 93'), 15_000)
  ctx.windows.close(created.id)
  await waitFor(() => !ctx.windows.isOpen(created.id))
  const savedTabs = ctx.lastTabs.load(created.id)
  check('open tabs are remembered when the window closes (restore mode)', savedTabs.includes(page(93)) && savedTabs.includes(page(91)), savedTabs.join(' '))

  // ---- the editor UI ----
  await editorUiChecks(ctx, check, created.id, created.partition)
  ctx.settings.update({ maxOpenProfiles: 2 })
}

async function editorUiChecks(ctx: SmokeContext, check: Check, id: string, partition: string): Promise<void> {
  const dash = ctx.getDashboard()!.webContents
  await dash.executeJavaScript(`document.querySelector('[data-nav="profiles"]').click()`)
  await pageHas(dash, '[data-testid="edit-button"]')
  const clicked = await dash.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('[data-row]')].find((r) => r.textContent.includes(${JSON.stringify(EDITOR_PROFILE)}))
    const button = row?.querySelector('[data-testid="edit-button"]')
    button?.click()
    return Boolean(button)
  })()`)
  const shown = clicked && (await pageHas(dash, '[data-testid="profile-editor"]'))
  const tabs = ['general', 'proxy', 'privacy', 'browser', 'hardware', 'extensions', 'advanced', 'diagnostics']
  const visited: string[] = []
  for (const tab of tabs) {
    await dash.executeJavaScript(`document.querySelector('[data-editor-tab="${tab}"]')?.click()`)
    if (await pageHas(dash, `[data-testid="editor-tab-${tab}"]`)) visited.push(tab)
  }
  check('Edit opens the profile editor with all 8 categories', shown && visited.length === tabs.length, visited.join(','))
  const summaryOk = await waitFor(async () =>
    dash.executeJavaScript(`document.querySelector('[data-testid="sum-id"]')?.textContent === ${JSON.stringify(id)} &&
      document.querySelector('[data-testid="sum-partition"]')?.textContent === ${JSON.stringify(partition)} &&
      (document.querySelector('[data-testid="sum-lang"]')?.textContent ?? '').startsWith('fr-FR')`)
  )
  check('configuration summary shows this profile’s saved values', summaryOk)
  const extListed = await pageHas(dash, '[data-testid="editor-tab-extensions"] [data-testid="ext-list"]').catch(() => false)
  // Extensions tab was visited before; go back to it to check the list.
  await dash.executeJavaScript(`document.querySelector('[data-editor-tab="extensions"]')?.click()`)
  const extShown = extListed || (await pageHas(dash, '[data-testid="ext-list"]'))
  check('extensions category lists the profile’s extension', extShown)

  // Edit a field, see the unsaved state, and save.
  await dash.executeJavaScript(`document.querySelector('[data-editor-tab="general"]').click()`)
  await pageHas(dash, '[data-testid="ed-name"]')
  await dash.executeJavaScript(`(() => {
    const input = document.querySelector('[data-testid="ed-name"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(`${EDITOR_PROFILE} 2`)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const dirty = await waitFor(async () => !(await dash.executeJavaScript(`document.querySelector('[data-testid="editor-save"]').disabled`)))
  await dash.executeJavaScript(`document.querySelector('[data-testid="editor-save"]').click()`)
  const renamed = await waitFor(() => ctx.profiles.get(id).name === `${EDITOR_PROFILE} 2`)
  check('editing a field marks unsaved changes; Save stores it', dirty && renamed, ctx.profiles.get(id).name)
  await viaDashboard(ctx, `window.pob.updateProfile(${JSON.stringify(id)}, { name: ${JSON.stringify(EDITOR_PROFILE)} })`)
  await dash.executeJavaScript(`document.querySelector('.editor-header .icon-button')?.click()`)
  await waitFor(async () => !(await dash.executeJavaScript(`Boolean(document.querySelector('[data-testid="profile-editor"]'))`)))
}

/** After the restart: settings persisted, extension and tabs come back when the profile opens. */
export async function editorVerifyChecks(ctx: SmokeContext, check: Check): Promise<void> {
  const profile = ctx.profiles.list().find((p) => p.name === EDITOR_PROFILE)
  if (!profile) {
    check('advanced settings persisted after restart', false, 'profile missing')
    return
  }
  check(
    'advanced settings persisted after restart',
    profile.options.startupMode === 'restore' && profile.options.doNotTrack && !profile.options.showNameInTitle &&
      profile.options.purpose === 'Smoke' && profile.browser.language === 'fr-FR' && profile.browser.acceptLanguage === 'fr-FR,fr,en' &&
      profile.browser.geolocationMode === 'manual' && profile.browser.userAgent === 'custom',
    JSON.stringify({ startup: profile.options.startupMode, lang: profile.browser.language })
  )
  ctx.settings.update({ maxOpenProfiles: 4 })
  await ctx.windows.open(profile.id)
  const restored = await waitFor(() => tabsOf(ctx, profile.id).some((t) => /\/page\?n=93$/.test(t.getURL())), 20_000)
  check('previous tabs are restored after restart', restored, tabsOf(ctx, profile.id).map((t) => t.getURL()).join(' '))
  const ext = ctx.extensions.list(profile.id)[0]
  const report = ctx.windows.launchReport(profile.id)?.items ?? []
  check(
    'the profile’s extension is loaded again after restart',
    Boolean(ext) && report.some((i) => i.setting === 'Extension: Smoke Marker' && i.status === 'applied'),
    report.map((i) => `${i.setting}:${i.status}`).join(', ')
  )
  ctx.windows.close(profile.id)
  await waitFor(() => !ctx.windows.isOpen(profile.id))
  ctx.settings.update({ maxOpenProfiles: 2 })
}
