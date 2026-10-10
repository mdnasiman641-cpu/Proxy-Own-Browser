import { readFileSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { join } from 'node:path'
import { app, type BrowserWindow, type WebContents } from 'electron'
import type { ProxyTestResult } from '@shared/types'
import type { Logger } from './services/logger'
import type { ProfileService } from './services/profileService'
import type { ProfileWindowManager } from './electron/profileWindows'
import type { ProxyTester } from './electron/proxyTester'
import type { SessionManager } from './electron/sessionManager'

/**
 * Automated end-to-end check run by `npm run smoke` (scripts/smoke-test.mjs) against an
 * isolated temporary data folder and local fixture servers. Inert unless POB_SMOKE_TEST is set.
 *
 *   stage "setup":  profiles, windows, duplicate opens, concurrency limit, tabs, crash recovery,
 *                   proxy tests (success / auth / timeout / unreachable), cookies
 *   stage "verify": after a full app restart, each profile restored only its own cookie
 */
interface SmokeContext {
  stage: string
  resultFile: string
  profiles: ProfileService
  sessions: SessionManager
  windows: ProfileWindowManager
  proxyTester: ProxyTester
  getDashboard: () => BrowserWindow | null
  logger: Logger
}

interface Fixtures {
  echoBase: string
  authProxyPort: number
  openProxyPort: number
  challengeProxyPort: number
  blackholePort: number
  closedPort: number
  proxiedIp: string
  user: string
  pass: string
}

const COOKIE_URL = 'https://smoke-test.invalid/'
const COOKIE_NAME = 'pob_smoke'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function waitForLoad(contents: WebContents, timeoutMs = 20_000): Promise<void> {
  if (!contents.isLoading()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for page load')), timeoutMs)
    contents.once('did-stop-loading', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Polls until `predicate` is true (or the time runs out) and returns the final value. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return true
    await sleep(150)
  }
  return Boolean(await predicate())
}

async function pageHas(contents: WebContents, selector: string): Promise<boolean> {
  return waitFor(
    () => contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}) !== null`),
    10_000
  )
}

async function readCookie(ctx: SmokeContext, partition: string): Promise<string[]> {
  const cookies = await ctx.sessions.sessionFor(partition).cookies.get({ name: COOKIE_NAME })
  return cookies.map((c) => c.value).sort()
}

function httpJson(url: string): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve(JSON.parse(body) as Record<string, number>))
    }).on('error', reject)
  })
}

export async function runSmokeTest(ctx: SmokeContext): Promise<void> {
  const checks: { name: string; passed: boolean; detail?: string }[] = []
  const check = (name: string, passed: boolean, detail?: string): void => {
    checks.push({ name, passed, ...(detail ? { detail } : {}) })
  }
  const fixtures = process.env.POB_SMOKE_FIXTURES
    ? (JSON.parse(process.env.POB_SMOKE_FIXTURES) as Fixtures)
    : null

  try {
    const dashboard = ctx.getDashboard()
    if (dashboard) {
      await waitForLoad(dashboard.webContents)
      check('dashboard renders', await pageHas(dashboard.webContents, '[data-testid="app-shell"]'))
      check(
        'dashboard preload API available',
        await dashboard.webContents.executeJavaScript(`typeof window.pob?.listProfiles === 'function'`)
      )
    } else {
      check('dashboard renders', false, 'no dashboard window')
    }

    if (ctx.stage === 'setup') {
      await setupStage(ctx, check, fixtures)
    } else if (ctx.stage === 'verify') {
      const all = ctx.profiles.list()
      const a = all.find((p) => p.name === 'Smoke A')
      const b = all.find((p) => p.name === 'Smoke B')
      check('profiles restored from SQLite', all.length === 2 && Boolean(a && b), `${all.length} profiles`)
      check('proxy settings restored', b?.proxy?.host === '127.0.0.1' && b.proxy.port === 9)
      if (a && b) {
        check('profile A cookie restored after restart', (await readCookie(ctx, a.partition)).join() === 'alpha')
        check('profile B cookie restored after restart', (await readCookie(ctx, b.partition)).join() === 'beta')
        await ctx.windows.open(a.id, { initialUrl: 'about:blank' })
        check('profile window reopens after restart', ctx.windows.isOpen(a.id))
      }
    } else {
      check('known stage', false, ctx.stage)
    }
  } catch (error) {
    check('no unexpected errors', false, error instanceof Error ? error.message : String(error))
  }

  const passed = checks.every((c) => c.passed)
  writeFileSync(ctx.resultFile, JSON.stringify({ stage: ctx.stage, passed, checks }, null, 2))
  ctx.logger.info(`Smoke test stage ${ctx.stage}: ${passed ? 'passed' : 'FAILED'}`)
  ctx.windows.closeAll()
  setTimeout(() => app.quit(), 300)
}

type Check = (name: string, passed: boolean, detail?: string) => void

async function setupStage(ctx: SmokeContext, check: Check, fixtures: Fixtures | null): Promise<void> {
  check('starts with no profiles', ctx.profiles.count() === 0)
  const a = ctx.profiles.create({ name: 'Smoke A' })
  const b = ctx.profiles.create({
    name: 'Smoke B',
    // Loopback stays exempt (Chromium default), so B can load local test pages directly.
    proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 9 }
  })
  check('partitions are unique', a.partition !== b.partition)

  // --- duplicate launch attempts and the concurrency limit ---
  const outcomes = await Promise.all([
    ctx.windows.open(a.id, { initialUrl: 'about:blank' }),
    ctx.windows.open(a.id, { initialUrl: 'about:blank' })
  ])
  check(
    'simultaneous opens of one profile create a single window',
    ctx.windows.openIds().length === 1 && outcomes.includes('opened') && outcomes.includes('joined'),
    outcomes.join(', ')
  )
  check('opening an open profile focuses it', (await ctx.windows.open(a.id)) === 'focused')

  await ctx.windows.open(b.id, { initialUrl: 'about:blank' })
  check('two profile windows open', ctx.windows.openIds().length === 2)

  const c = ctx.profiles.create({ name: 'Smoke C' })
  let limited = false
  try {
    await ctx.windows.open(c.id, { initialUrl: 'about:blank' })
  } catch {
    limited = true
  }
  check('concurrent window limit enforced (default 2)', limited && ctx.windows.openIds().length === 2)
  ctx.profiles.delete(c.id)

  // --- toolbar ---
  const toolbarA = ctx.windows.toolbarContents(a.id)
  let toolbarName = ''
  if (toolbarA) {
    await waitForLoad(toolbarA)
    await waitFor(async () => {
      toolbarName = await toolbarA.executeJavaScript(
        `document.querySelector('.profile-info .name')?.textContent ?? ''`
      )
      return toolbarName === 'Smoke A'
    })
  }
  check('toolbar receives profile state over IPC', toolbarName === 'Smoke A', toolbarName)

  const viewA = ctx.windows.sessionContents(a.id)
  check('profile A web view uses its own session', viewA?.session === ctx.sessions.sessionFor(a.partition))

  // --- cookies (verified again after restart) ---
  const expirationDate = Math.floor(Date.now() / 1000) + 86_400
  await ctx.sessions
    .sessionFor(a.partition)
    .cookies.set({ url: COOKIE_URL, name: COOKIE_NAME, value: 'alpha', expirationDate })
  await ctx.sessions
    .sessionFor(b.partition)
    .cookies.set({ url: COOKIE_URL, name: COOKIE_NAME, value: 'beta', expirationDate })
  check('profile A sees only its cookie', (await readCookie(ctx, a.partition)).join() === 'alpha')
  check('profile B sees only its cookie', (await readCookie(ctx, b.partition)).join() === 'beta')

  if (fixtures) {
    await tabChecks(ctx, check, fixtures, a.id, b.id)
    await proxyChecks(ctx, check, fixtures)
  } else {
    check('fixtures available', false, 'POB_SMOKE_FIXTURES not set')
  }

  // --- resource usage (informational numbers, sanity-checked) ---
  const usage = ctx.windows.resourceUsage()
  check(
    'resource usage reported',
    usage.totalMemoryMb > 0 && usage.processCount > 0 && usage.openWindows === ctx.windows.openIds().length,
    `${usage.totalMemoryMb} MB, ${usage.processCount} processes, ${usage.openWindows} windows, ${usage.openTabs} tabs`
  )

  await ctx.sessions.flushAll()
}

async function tabChecks(ctx: SmokeContext, check: Check, f: Fixtures, aId: string, bId: string): Promise<void> {
  const entry = ctx.windows.windowFor(aId)!
  const firstTab = entry.tabs.active!
  ctx.windows.navigate(entry, `${f.echoBase}/page?n=1`)
  const tab1 = entry.tabs.get(firstTab)!.view.webContents
  await waitFor(() => tab1.getTitle() === 'Smoke page 1')

  const secondTab = ctx.windows.newTab(entry, `${f.echoBase}/page?n=5`)
  const tab2 = entry.tabs.get(secondTab)!.view.webContents
  await waitFor(() => tab2.getTitle() === 'Smoke page 5')
  check('new tab opens and becomes active', entry.tabs.size === 2 && entry.tabs.active === secondTab)
  check(
    'all tabs use the profile session',
    tab1.session === tab2.session && tab2.session === ctx.sessions.sessionFor(entry.profile.partition)
  )

  // Cookies set in one tab are visible in another tab of the same profile, not in another profile.
  await tab1.executeJavaScript(`document.cookie = 'tabshare=yes; max-age=3600'`)
  const seenInTab2 = await tab2.executeJavaScript('document.cookie')
  const entryB = ctx.windows.windowFor(bId)!
  ctx.windows.navigate(entryB, `${f.echoBase}/page?n=9`)
  const tabB = ctx.windows.sessionContents(bId)!
  await waitFor(() => tabB.getTitle() === 'Smoke page 9')
  const seenInB = await tabB.executeJavaScript('document.cookie')
  check('tabs of one profile share cookies', String(seenInTab2).includes('tabshare=yes'), String(seenInTab2))
  check("other profile does not see the tab's cookie", !String(seenInB).includes('tabshare'), String(seenInB))

  const toolbar = entry.window.webContents
  const tabCount = (): Promise<number> =>
    toolbar.executeJavaScript(`document.querySelectorAll('.tabstrip .tab').length`)
  check('tab strip shows both tabs', await waitFor(async () => (await tabCount()) === 2))

  ctx.windows.activateTab(entry, firstTab)
  check('switching tabs changes the active tab', entry.tabs.active === firstTab && entry.shownTabId === firstTab)
  const activeMarked = await waitFor(async () =>
    toolbar.executeJavaScript(
      `document.querySelector('.tabstrip .tab.active')?.dataset.tabId === ${JSON.stringify(firstTab)}`
    )
  )
  check('toolbar marks the active tab', activeMarked)

  // target=_blank link (with a user gesture) opens a new tab in the same profile.
  await tab1.executeJavaScript(`document.getElementById('new-tab-link').click()`, true)
  check('target=_blank link opens a tab', await waitFor(() => entry.tabs.size === 3))
  const linkTabId = entry.tabs.ids()[1]
  check('link tab is placed next to its opener', linkTabId !== secondTab && linkTabId !== firstTab)

  // Crash recovery: a crashed tab is marked and recovers on reload.
  const linkTab = entry.tabs.get(linkTabId!)!
  ctx.windows.activateTab(entry, linkTab.id)
  await waitForLoad(linkTab.view.webContents).catch(() => {})
  linkTab.view.webContents.forcefullyCrashRenderer()
  const crashed = await waitFor(() => ctx.windows.state(entry).tabs.find((t) => t.id === linkTab.id)?.crashed === true)
  check('crashed tab is reported', crashed && ctx.windows.isOpen(aId))
  ctx.windows.reload(entry)
  const recovered = await waitFor(() => {
    const s = ctx.windows.state(entry).tabs.find((t) => t.id === linkTab.id)
    return s?.crashed === false && !linkTab.view.webContents.isLoading() && !linkTab.view.webContents.isCrashed()
  }, 15_000)
  check('crashed tab recovers on reload', recovered)

  ctx.windows.closeTab(entry, linkTab.id)
  ctx.windows.closeTab(entry, secondTab)
  check('closing tabs updates the strip', entry.tabs.size === 1 && (await waitFor(async () => (await tabCount()) === 1)))

  // Closing the last tab closes the window; the profile can then be reopened.
  const onlyTabB = ctx.windows.windowFor(bId)!.tabs.active!
  ctx.windows.closeTab(ctx.windows.windowFor(bId)!, onlyTabB)
  check('closing the last tab closes the window', await waitFor(() => !ctx.windows.isOpen(bId)))
  await ctx.windows.open(bId, { initialUrl: 'about:blank' })
  check('closed profile window can be reopened', ctx.windows.isOpen(bId))
}

async function proxyChecks(ctx: SmokeContext, check: Check, f: Fixtures): Promise<void> {
  const loop = '<-loopback>' // route 127.0.0.1 test traffic through the proxy too
  const make = (name: string, port: number, username = '', password = ''): string =>
    ctx.profiles.create({
      name,
      proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port, username, password, bypassRules: loop }
    }).id
  const ok = make('Proxy OK', f.authProxyPort, f.user, f.pass)
  const wrong = make('Proxy wrong password', f.authProxyPort, f.user, 'wrong-password')
  const missing = make('Proxy no credentials', f.authProxyPort)
  const closed = make('Proxy closed port', f.closedPort)
  const blackhole = make('Proxy blackhole', f.blackholePort)
  const challenge = make('Website asks for login', f.challengeProxyPort, f.user, f.pass)
  const direct = ctx.profiles.create({ name: 'Direct' }).id

  const saved = (id: string): Promise<ProxyTestResult> =>
    ctx.proxyTester.test(`saved-${id}`, ctx.profiles.resolveProxyTestTarget(id))
  const summary = (r: ProxyTestResult): string =>
    `${r.status}${r.ip ? ` ip=${r.ip}` : ''}${r.responseTimeMs !== null ? ` ${r.responseTimeMs}ms` : ''}`

  // Through the real IPC path used by the Test button.
  const dashboard = ctx.getDashboard()!
  const viaIpc = (await dashboard.webContents.executeJavaScript(
    `window.pob.testProxy(${JSON.stringify(ok)})`
  )) as { ok: boolean; data?: ProxyTestResult; error?: string }
  const r1 = viaIpc.data
  check(
    'proxy test succeeds through authenticated proxy (via IPC)',
    viaIpc.ok && r1?.ok === true && r1.status === 'success' && r1.ip === f.proxiedIp && typeof r1.responseTimeMs === 'number',
    r1 ? summary(r1) : viaIpc.error
  )

  const r2 = await saved(wrong)
  check('wrong proxy password reported as auth failure', !r2.ok && r2.status === 'auth-failed', summary(r2))
  const r3 = await saved(missing)
  check('missing proxy credentials reported', !r3.ok && r3.status === 'auth-required', summary(r3))
  const r4 = await saved(closed)
  check('unreachable proxy reported', !r4.ok && r4.status === 'proxy-unreachable', summary(r4))

  const started = Date.now()
  const r5 = await saved(blackhole)
  const elapsed = Date.now() - started
  check(
    'silent proxy times out (3 s limit)',
    !r5.ok && r5.status === 'timeout' && elapsed < 8000,
    `${summary(r5)} after ${elapsed} ms`
  )

  const statsBefore = await httpJson(`${f.echoBase}/stats`)
  const r6 = await saved(challenge)
  const statsAfter = await httpJson(`${f.echoBase}/stats`)
  check(
    'website login request is not answered with proxy credentials',
    !r6.ok && r6.status === 'http-error' && statsAfter.authorizationHeadersSeen === statsBefore.authorizationHeadersSeen,
    `${summary(r6)}, authorization headers seen: ${statsAfter.authorizationHeadersSeen}`
  )

  const r7 = await saved(direct)
  check('direct connection test reports local IP', r7.ok && r7.ip === '127.0.0.1' && r7.route.startsWith('Direct'), summary(r7))

  // Unsaved draft: same proxy and username reuses the saved password; a different username does not.
  const sameDraft = {
    enabled: true,
    protocol: 'http' as const,
    host: '127.0.0.1',
    port: f.authProxyPort,
    username: f.user,
    bypassRules: loop
  }
  const r8 = await ctx.proxyTester.test(`draft-${ok}`, ctx.profiles.resolveProxyTestTarget(ok, sameDraft))
  check('draft test reuses saved password for the same proxy', r8.ok, summary(r8))
  const r9 = await ctx.proxyTester.test(
    `draft-${ok}`,
    ctx.profiles.resolveProxyTestTarget(ok, { ...sameDraft, username: 'someone-else' })
  )
  check('saved password is not reused for a different username', !r9.ok && r9.status === 'auth-failed', summary(r9))

  check(
    'proxy credentials never reach the test website',
    (await httpJson(`${f.echoBase}/stats`)).proxyAuthorizationHeadersSeen === 0
  )

  const log = readFileSync(join(app.getPath('userData'), 'logs', 'app.log'), 'utf8')
  check('proxy credentials are not written to the log', !log.includes(f.pass) && !log.includes(f.user))

  for (const id of [ok, wrong, missing, closed, blackhole, challenge, direct]) ctx.profiles.delete(id)
}
