import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import type { DuplicateResult, FullBackupOutcome, ProfileNetworkStatus, RuntimeInfo } from '@shared/types'
import { locationChecks } from './smokeLocation'
import {
  httpJson,
  pageHas,
  readCookie,
  viaDashboard,
  waitFor,
  type Check,
  type Fixtures,
  type SmokeContext
} from './smokeHelpers'

/**
 * Phase 4 end-to-end checks: isolation of profiles running at the same time, no direct
 * fallback, proxy/IP/location status, time zone and language per profile, permissions,
 * User-Agent, zoom, window size, unique proxies, and local backup/restore across a restart.
 */

const BACKUP_PASSWORD = 'smoke-backup-password'
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

/** What a page sees: time zone, offset in January, locale, language and User-Agent. */
const ENV_SCRIPT = `JSON.stringify({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  offset: new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset(),
  lang: navigator.language,
  langs: navigator.languages,
  ua: navigator.userAgent
})`

interface PageEnv {
  tz: string
  locale: string
  offset: number
  lang: string
  langs: string[]
  ua: string
}

async function env(contents: WebContents): Promise<PageEnv> {
  return JSON.parse(await contents.executeJavaScript(ENV_SCRIPT)) as PageEnv
}

/** Navigates the profile's active tab to the fixture page `n` and waits for it. */
async function load(ctx: SmokeContext, f: Fixtures, profileId: string, n: number): Promise<WebContents> {
  const entry = ctx.windows.windowFor(profileId)!
  ctx.windows.navigate(entry, `${f.echoBase}/page?n=${n}`)
  const contents = ctx.windows.sessionContents(profileId)!
  await waitFor(() => contents.getTitle() === `Smoke page ${n}`, 15_000)
  return contents
}

function backupFolder(): string {
  return join(app.getPath('userData'), '..', 'smoke-backups')
}

export async function phase4SetupChecks(ctx: SmokeContext, check: Check, f: Fixtures, aId: string, bId: string): Promise<void> {
  ctx.settings.update({ maxOpenProfiles: 4 })
  for (const id of [aId, bId]) {
    if (!ctx.windows.isOpen(id)) await ctx.windows.open(id, { initialUrl: 'about:blank' })
  }
  const a = ctx.profiles.get(aId)
  const b = ctx.profiles.get(bId)

  // ---- isolation while both profiles run at the same time ----
  const tabA = await load(ctx, f, aId, 40)
  const tabB = await load(ctx, f, bId, 41)
  check(
    'two profiles run at the same time with separate sessions',
    ctx.windows.isOpen(aId) && ctx.windows.isOpen(bId) && tabA.session !== tabB.session &&
      tabA.session === ctx.sessions.sessionFor(a.partition) && tabB.session === ctx.sessions.sessionFor(b.partition)
  )
  await tabA.executeJavaScript(`localStorage.setItem('pob', 'A'); true`)
  const bSeesLocal = await tabB.executeJavaScript(`localStorage.getItem('pob')`)
  await tabB.executeJavaScript(`localStorage.setItem('pob', 'B'); true`)
  const aSeesLocal = await tabA.executeJavaScript(`localStorage.getItem('pob')`)
  check('localStorage is not shared between profiles (same site)', bSeesLocal === null && aSeesLocal === 'A', `${bSeesLocal}/${aSeesLocal}`)

  const idbWrite = (value: string): string => `new Promise((resolve, reject) => {
    const r = indexedDB.open('pob-smoke', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('s')
    r.onerror = () => reject(String(r.error))
    r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put(${JSON.stringify(value)}, 'k'); tx.oncomplete = () => resolve(true); tx.onerror = () => reject(String(tx.error)) }
  })`
  const idbRead = `new Promise((resolve, reject) => {
    const r = indexedDB.open('pob-smoke', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('s')
    r.onerror = () => reject(String(r.error))
    r.onsuccess = () => { const g = r.result.transaction('s', 'readonly').objectStore('s').get('k'); g.onsuccess = () => resolve(g.result ?? null); g.onerror = () => reject(String(g.error)) }
  })`
  await tabA.executeJavaScript(idbWrite('A-value'))
  const bSeesIdb = await tabB.executeJavaScript(idbRead)
  check('IndexedDB is not shared between profiles (same site)', bSeesIdb === null, String(bSeesIdb))

  // ---- a failing proxy never falls back to a direct connection ----
  const dead = ctx.profiles.create({
    name: 'Smoke dead proxy',
    proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: f.closedPort, bypassRules: '<-loopback>' },
    // Opened on purpose with a dead proxy, so it must not wait for the automatic time zone.
    browser: { timezoneMode: 'off' }
  })
  await ctx.windows.open(dead.id, { initialUrl: `${f.echoBase}/page?n=777` })
  const deadEntry = ctx.windows.windowFor(dead.id)!
  const errorShown = await waitFor(() => Boolean(ctx.windows.state(deadEntry).error), 15_000)
  const stats = await httpJson<{ paths: string[] }>(`${f.echoBase}/stats`)
  check(
    'a failing proxy never falls back to a direct connection',
    errorShown && !stats.paths.includes('/page?n=777'),
    ctx.windows.state(deadEntry).error ?? 'no error shown'
  )
  ctx.windows.close(dead.id)
  await waitFor(() => !ctx.windows.isOpen(dead.id))
  ctx.profiles.delete(dead.id)

  // ---- proxy status, public IP and location through the profile's own proxy ----
  const proxied = ctx.profiles.create({
    name: 'Smoke Proxy',
    proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: f.authProxyPort, username: f.user, password: f.pass, bypassRules: '<-loopback>' },
    browser: { timezoneMode: 'auto', windowWidth: 1000, windowHeight: 760 }
  })
  const status = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(proxied.id)})`)
  check(
    'IP check uses the profile proxy (proxy exit IP, not this PC)',
    status.proxy.ok && status.ip === f.proxiedIp && status.current,
    `${status.proxy.status} ip=${status.ip}`
  )
  check(
    'IP location and time zone detected through the proxy',
    status.geo.status === 'success' && status.geo.data?.timezone === 'America/New_York' && status.geo.data.city === 'New York',
    `${status.geo.status}: ${status.geo.message}`
  )

  const direct = ctx.profiles.create({ name: 'Smoke direct auto', browser: { timezoneMode: 'auto' } })
  const directStatus = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(direct.id)})`)
  check(
    'a failed location lookup is shown as failed, with no invented values',
    directStatus.proxy.ok && directStatus.geo.status === 'failed' && directStatus.geo.data === null && directStatus.lastValidTimezone === null,
    directStatus.geo.message
  )
  let refused = ''
  try {
    await ctx.windows.open(direct.id)
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  check(
    "automatic time zone: opening is refused when detection fails (never this PC's zone silently)",
    /could not be detected/.test(refused) && !ctx.windows.isOpen(direct.id),
    refused
  )
  ctx.profiles.delete(direct.id)

  // ---- same exit IP warning ----
  const sibling = ctx.profiles.create({
    name: 'Smoke same exit',
    proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: f.sameExitProxyPort, bypassRules: '<-loopback>' }
  })
  const siblingStatus = await viaDashboard<ProfileNetworkStatus>(ctx, `window.pob.checkNetwork(${JSON.stringify(sibling.id)})`)
  check(
    'two profiles with the same public exit IP are flagged',
    siblingStatus.sameExitIpAs.some((p) => p.id === proxied.id),
    JSON.stringify(siblingStatus.sameExitIpAs)
  )
  ctx.profiles.delete(sibling.id)

  // ---- automatic time zone applied to pages; window size from the profile ----
  await ctx.windows.open(proxied.id, { initialUrl: 'about:blank' })
  const tabP = await load(ctx, f, proxied.id, 50)
  const envP = await env(tabP)
  check('automatic time zone applied to pages (America/New_York)', envP.tz === 'America/New_York' && envP.offset === 300, JSON.stringify(envP))
  const [w = 0, h = 0] = ctx.windows.windowFor(proxied.id)!.window.getSize()
  check('window opens with the profile window size', Math.abs(w - 1000) <= 40 && Math.abs(h - 760) <= 40, `${w}x${h}`)

  // ---- manual time zone, language and permissions on profile A (open), B unaffected ----
  await viaDashboard(
    ctx,
    `window.pob.updateProfile(${JSON.stringify(aId)}, { browser: { timezoneMode: 'manual', timezoneManual: 'Asia/Tokyo', language: 'bn-BD', permissions: { notifications: 'allow' } } })`
  )
  const tabA2 = await load(ctx, f, aId, 42)
  const envA = await env(tabA2)
  check('manual time zone applied to an open profile (Asia/Tokyo)', envA.tz === 'Asia/Tokyo' && envA.offset === -540, JSON.stringify(envA))
  check('profile language sets the page locale (Intl)', envA.locale.toLowerCase().startsWith('bn'), envA.locale)
  const headersA = (await tabA2.executeJavaScript(`fetch('/headers').then((r) => r.json())`)) as { acceptLanguage: string | null }
  check('profile language sets the Accept-Language header', (headersA.acceptLanguage ?? '').startsWith('bn-BD'), headersA.acceptLanguage ?? 'none')
  check(
    'navigator.language(s) follow the profile language',
    envA.lang === 'bn-BD' && JSON.stringify(envA.langs) === '["bn-BD","bn","en"]',
    `navigator.language=${envA.lang}; navigator.languages=${JSON.stringify(envA.langs)}`
  )
  const tabB2 = await load(ctx, f, bId, 43)
  const envB = await env(tabB2)
  const headersB = (await tabB2.executeJavaScript(`fetch('/headers').then((r) => r.json())`)) as { acceptLanguage: string | null }
  check(
    "other profiles keep their own time zone and language",
    envB.tz === HOST_TZ && !(headersB.acceptLanguage ?? '').startsWith('bn'),
    `${envB.tz} (this PC: ${HOST_TZ}), ${headersB.acceptLanguage}`
  )
  const permission = `navigator.permissions.query({ name: 'notifications' }).then((p) => p.state)`
  const permA = await tabA2.executeJavaScript(permission)
  const permB = await tabB2.executeJavaScript(permission)
  check('site permissions are set per profile', permA === 'granted' && permB !== 'granted', `A=${permA} B=${permB}`)

  // ---- User-Agent (real runtime only) and zoom ----
  const runtime = await viaDashboard<RuntimeInfo>(ctx, 'window.pob.runtimeInfo()')
  check(
    'reported browser versions are the real runtime',
    runtime.electron === process.versions.electron && runtime.chrome === process.versions.chrome &&
      envA.ua.includes(`Chrome/${process.versions.chrome}`),
    `Electron ${runtime.electron}, Chromium ${runtime.chrome}`
  )
  await viaDashboard(ctx, `window.pob.updateProfile(${JSON.stringify(bId)}, { browser: { userAgent: 'chrome', zoomPercent: 150 } })`)
  const tabB3 = await load(ctx, f, bId, 44)
  const envB3 = await env(tabB3)
  check(
    "'Chrome' User-Agent keeps the real Chromium version and drops the Electron token",
    !envB3.ua.includes('Electron/') && envB3.ua.includes(`Chrome/${process.versions.chrome}`) && envA.ua.includes('Electron/'),
    envB3.ua
  )
  check('zoom applies per profile', Math.abs(tabB3.getZoomFactor() - 1.5) < 0.01 && Math.abs(tabA2.getZoomFactor() - 1) < 0.01, `${tabB3.getZoomFactor()} / ${tabA2.getZoomFactor()}`)
  await viaDashboard(ctx, `window.pob.updateProfile(${JSON.stringify(bId)}, { browser: { userAgent: 'default', zoomPercent: 100 } })`)

  // ---- unique proxy assignment ----
  ctx.settings.update({ requireUniqueProxy: true })
  const sharedInput = JSON.stringify({
    name: 'Smoke shared proxy',
    proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: f.authProxyPort, username: f.user, password: f.pass }
  })
  const blocked = (await ctx.getDashboard()!.webContents.executeJavaScript(`window.pob.createProfile(${sharedInput})`)) as { ok: boolean; error?: string }
  check('unique proxy assignment blocks reuse without confirmation', !blocked.ok && /already assigned/.test(blocked.error ?? ''), blocked.error)
  const allowed = await viaDashboard<{ id: string }>(ctx, `window.pob.createProfile(${sharedInput}, { allowSharedProxy: true })`)
  check('reuse is allowed after explicit confirmation', Boolean(allowed.id))
  ctx.profiles.delete(allowed.id)
  ctx.settings.update({ requireUniqueProxy: false })

  // ---- local backups (folder on this PC), scheduled because the profiles are in use ----
  ctx.settings.update({ backupFolder: backupFolder() })
  const metadata = await viaDashboard<{ fileName: string; status: string }>(ctx, `window.pob.backupMetadata('all')`)
  check('metadata backup written to the chosen local folder', metadata.status === 'success' && /^POB_metadata_all-profiles_/.test(metadata.fileName), metadata.fileName)
  const full = await viaDashboard<FullBackupOutcome[]>(
    ctx,
    `window.pob.backupFull({ profileIds: [${JSON.stringify(bId)}], password: ${JSON.stringify(BACKUP_PASSWORD)} })`
  )
  check('full backup of a profile in use is scheduled for the next start', full[0]?.status === 'scheduled', full[0]?.message)
  const dup = await viaDashboard<DuplicateResult>(
    ctx,
    `window.pob.duplicateProfile(${JSON.stringify(aId)}, { name: 'Smoke A copy', mode: 'settings-and-data', copyProxy: true })`
  )
  check(
    'duplicating with data never shares storage (new partition; copy scheduled while in use)',
    dup.data === 'scheduled' && dup.profile.partition !== a.partition && dup.profile.browser.timezoneManual === 'Asia/Tokyo',
    dup.details.join(' ')
  )
  const settingsOnly = await viaDashboard<DuplicateResult>(
    ctx,
    `window.pob.duplicateProfile(${JSON.stringify(aId)}, { name: 'Smoke A settings', mode: 'settings', copyProxy: false })`
  )
  check(
    'duplicating settings only starts with empty browser data',
    settingsOnly.data === 'not-requested' && (await readCookie(ctx, settingsOnly.profile.partition)).length === 0
  )
  ctx.profiles.delete(settingsOnly.profile.id)

  await locationChecks(ctx, check, f, proxied.id)

  // ---- dashboard pages for the new features render (the UI is in Bangla at this point) ----
  const dash = ctx.getDashboard()!.webContents
  await dash.executeJavaScript(`document.querySelector('[data-nav="profiles"]').click()`)
  await pageHas(dash, '[data-testid="details-button"]')
  await dash.executeJavaScript(`document.querySelector('[data-testid="details-button"]').click()`)
  const detailsShown =
    (await pageHas(dash, '[data-testid="profile-details"] [data-testid="network-panel"]')) &&
    (await pageHas(dash, '[data-testid="browser-settings"]')) &&
    (await pageHas(dash, '[data-testid="runtime-panel"]'))
  const banglaHeading = await dash.executeJavaScript(
    `document.querySelector('[data-testid="network-panel"] h2')?.textContent ?? ''`
  )
  check('profile details page shows network, browser settings and runtime panels', detailsShown, banglaHeading)
  check('new pages are translated (Bangla)', banglaHeading === 'প্রক্সি ও আইপি অবস্থা', banglaHeading)
  const panelsShown =
    (await pageHas(dash, '[data-testid="diagnostics-panel"]')) &&
    (await pageHas(dash, '[data-testid="storage-panel"]')) &&
    (await pageHas(dash, '[data-testid="backup-facts"]')) &&
    (await pageHas(dash, '[data-testid="webrtc-setting"]'))
  await dash.executeJavaScript(`document.querySelector('[data-testid="run-diagnostics"]').click()`)
  const diagRendered = await pageHas(dash, '[data-testid="diag-dns"][data-verdict]')
  const diagHeading = await dash.executeJavaScript(`document.querySelector('[data-testid="diagnostics-panel"] h2')?.textContent ?? ''`)
  check(
    'details page shows diagnostics (with results), own-vs-shared storage, backup status and the WebRTC setting',
    panelsShown && diagRendered && diagHeading === 'ডায়াগনস্টিকস',
    diagHeading
  )
  await dash.executeJavaScript(`document.querySelector('[data-nav="backup"]').click()`)
  const backupShown = (await pageHas(dash, '[data-testid="backup-folder"]')) && (await pageHas(dash, '[data-testid="backup-files"] table'))
  const folderText = await dash.executeJavaScript(`document.querySelector('[data-testid="backup-folder"] .mono')?.textContent ?? ''`)
  check('backup page lists the local backup folder and its backups', backupShown && folderText === backupFolder(), folderText)

  ctx.windows.close(proxied.id)
  await waitFor(() => !ctx.windows.isOpen(proxied.id))
  ctx.settings.update({ maxOpenProfiles: 2 })
}

/**
 * Runs first in the restart stage, before anything opens profile A's session, so A's full
 * backup can be made immediately.
 */
export async function phase4VerifyChecks(ctx: SmokeContext, check: Check, f: Fixtures | null): Promise<void> {
  const all = ctx.profiles.list()
  const a = all.find((p) => p.name === 'Smoke A')!
  const b = all.find((p) => p.name === 'Smoke B')!
  const copy = all.find((p) => p.name === 'Smoke A copy')
  const proxied = all.find((p) => p.name === 'Smoke Proxy')
  const notes = ctx.startupNotes.join('\n')

  check(
    'scheduled backup and data copy ran at start-up, before profiles opened',
    /Scheduled full backup of "Smoke B" completed/.test(notes) && /Browser data copied into "Smoke A copy"/.test(notes),
    notes || 'no start-up notes'
  )
  check(
    'browser settings persisted after restart',
    a.browser.timezoneMode === 'manual' && a.browser.timezoneManual === 'Asia/Tokyo' && a.browser.language === 'bn-BD' &&
      proxied?.browser.timezoneMode === 'auto'
  )
  const net = proxied ? ctx.network.status(proxied.id) : null
  check(
    'proxy/IP status and detected time zone persisted after restart',
    net?.current === true && net.ip === f?.proxiedIp && net.lastValidTimezone === 'America/New_York',
    JSON.stringify({ ip: net?.ip, tz: net?.lastValidTimezone })
  )

  // Full backup of a profile that was not used in this run: made and verified immediately.
  const [outcome] = await ctx.backupCenter.backupFull([a.id], BACKUP_PASSWORD)
  check('full backup of a closed profile completes and is verified', outcome?.status === 'success', outcome?.message)
  const fileA = join(ctx.settings.get().backupFolder!, outcome?.fileName ?? 'missing')
  const backups = await ctx.backupCenter.listBackups()
  const scheduledB = backups.find((x) => x.kind === 'full' && x.profiles[0]?.id === b.id)
  const verifyB = scheduledB ? await ctx.backupCenter.verify(scheduledB.path, BACKUP_PASSWORD) : null
  check('the scheduled backup exists and its checksums verify', verifyB?.ok === true, verifyB?.message)
  const wrong = await ctx.backupCenter.verify(fileA, 'not-the-password')
  check('a wrong backup password is rejected', !wrong.ok && /password is not correct/.test(wrong.message), wrong.message)
  const bStatus = ctx.backupCenter.backupStatus()
  check(
    'each profile shows its own backup status (after the scheduled backup ran at start-up)',
    bStatus[a.id]?.lastFullAt !== null && bStatus[b.id]?.lastFullAt !== null && bStatus[b.id]?.fullScheduled === false,
    JSON.stringify({ a: bStatus[a.id], b: bStatus[b.id] })
  )

  // A damaged copy is rejected and the original profile is not touched.
  const damaged = fileA.replace(/\.pobfull$/, '-damaged.pobfull')
  const bytes = readFileSync(fileA)
  bytes[bytes.length - 64] ^= 0xff
  writeFileSync(damaged, bytes)
  let damagedError = ''
  try {
    await ctx.backupCenter.restore({ path: damaged, target: 'original', password: BACKUP_PASSWORD })
  } catch (error) {
    damagedError = error instanceof Error ? error.message : String(error)
  }
  check('a damaged backup is rejected before anything is changed', /damaged or was modified/.test(damagedError), damagedError)

  // Restore as a new profile: new id and partition, same cookies.
  const restored = await ctx.backupCenter.restore({ path: fileA, target: 'new', password: BACKUP_PASSWORD })
  const fresh = restored.profileIds[0] ? ctx.profiles.get(restored.profileIds[0]) : null
  check(
    'restore as a new profile gets a new id and partition',
    restored.status === 'success' && fresh !== null && fresh.id !== a.id && fresh.partition !== a.partition,
    restored.message
  )
  check('restored profile has the backed-up cookie', fresh !== null && (await readCookie(ctx, fresh.partition)).join() === 'alpha')
  if (copy) {
    check(
      'duplicated profile received the copied data in its own partition',
      copy.partition !== a.partition && (await readCookie(ctx, copy.partition)).join() === 'alpha'
    )
  } else {
    check('duplicated profile received the copied data in its own partition', false, 'profile missing')
  }
  check('backup history records backups and restores', ctx.backupCenter.history().length >= 4)

  // After restart: A's site data, manual time zone; the proxied profile's automatic zone.
  if (f) {
    await ctx.windows.open(a.id, { initialUrl: 'about:blank' })
    const tabA = await load(ctx, f, a.id, 60)
    const envA = await env(tabA)
    const local = await tabA.executeJavaScript(`localStorage.getItem('pob')`)
    check('site storage and manual time zone restored after restart', local === 'A' && envA.tz === 'Asia/Tokyo', `${local} ${envA.tz}`)
    ctx.windows.close(a.id)
    await waitFor(() => !ctx.windows.isOpen(a.id))
    if (proxied) {
      await ctx.windows.open(proxied.id, { initialUrl: 'about:blank' })
      const envP = await env(await load(ctx, f, proxied.id, 61))
      check('automatic time zone applied after restart', envP.tz === 'America/New_York', envP.tz)
      ctx.windows.close(proxied.id)
      await waitFor(() => !ctx.windows.isOpen(proxied.id))
    }
  }
}
