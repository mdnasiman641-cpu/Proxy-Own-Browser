import { writeFileSync } from 'node:fs'
import { app, type BrowserWindow, type WebContents } from 'electron'
import type { Logger } from './services/logger'
import type { ProfileService } from './services/profileService'
import type { ProfileWindowManager } from './electron/profileWindows'
import type { SessionManager } from './electron/sessionManager'

/**
 * Automated end-to-end check run by `npm run smoke` (scripts/smoke-test.mjs) against an
 * isolated temporary data folder. It is inert unless POB_SMOKE_TEST is set.
 *
 *   stage "setup":  create two profiles, open both windows, set a different cookie in each
 *   stage "verify": after a full app restart, check each profile restored only its own cookie
 */
interface SmokeContext {
  stage: string
  resultFile: string
  profiles: ProfileService
  sessions: SessionManager
  windows: ProfileWindowManager
  getDashboard: () => BrowserWindow | null
  logger: Logger
}

const COOKIE_URL = 'https://smoke-test.invalid/'
const COOKIE_NAME = 'pob_smoke'

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

async function pageHas(contents: WebContents, selector: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const found = await contents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}) !== null`
    )
    if (found) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function readCookie(ctx: SmokeContext, partition: string): Promise<string[]> {
  const cookies = await ctx.sessions.sessionFor(partition).cookies.get({ name: COOKIE_NAME })
  return cookies.map((c) => c.value).sort()
}

export async function runSmokeTest(ctx: SmokeContext): Promise<void> {
  const checks: { name: string; passed: boolean; detail?: string }[] = []
  const check = (name: string, passed: boolean, detail?: string): void => {
    checks.push({ name, passed, ...(detail ? { detail } : {}) })
  }

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
      check('starts with no profiles', ctx.profiles.count() === 0)
      const a = ctx.profiles.create({ name: 'Smoke A' })
      const b = ctx.profiles.create({
        name: 'Smoke B',
        proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 9, bypassRules: '<-loopback>' }
      })
      check('partitions are unique', a.partition !== b.partition)

      await ctx.windows.open(a.id, { initialUrl: 'about:blank' })
      await ctx.windows.open(b.id, { initialUrl: 'about:blank' })
      check('two profile windows open', ctx.windows.openIds().length === 2)

      const c = ctx.profiles.create({ name: 'Smoke C' })
      let limited = false
      try {
        await ctx.windows.open(c.id, { initialUrl: 'about:blank' })
      } catch {
        limited = true
      }
      check('concurrent window limit enforced (default 2)', limited)
      ctx.profiles.delete(c.id)

      const toolbarA = ctx.windows.toolbarContents(a.id)
      let toolbarName = ''
      if (toolbarA) {
        await waitForLoad(toolbarA)
        for (let i = 0; i < 50 && toolbarName !== 'Smoke A'; i++) {
          toolbarName = await toolbarA.executeJavaScript(
            `document.querySelector('.profile-info .name')?.textContent ?? ''`
          )
          if (toolbarName !== 'Smoke A') await new Promise((r) => setTimeout(r, 200))
        }
      }
      check('toolbar receives profile state over IPC', toolbarName === 'Smoke A', toolbarName)

      const viewA = ctx.windows.sessionContents(a.id)
      check('profile A web view uses its own session', viewA?.session === ctx.sessions.sessionFor(a.partition))

      const expirationDate = Math.floor(Date.now() / 1000) + 86_400
      await ctx.sessions
        .sessionFor(a.partition)
        .cookies.set({ url: COOKIE_URL, name: COOKIE_NAME, value: 'alpha', expirationDate })
      await ctx.sessions
        .sessionFor(b.partition)
        .cookies.set({ url: COOKIE_URL, name: COOKIE_NAME, value: 'beta', expirationDate })

      check('profile A sees only its cookie', (await readCookie(ctx, a.partition)).join() === 'alpha')
      check('profile B sees only its cookie', (await readCookie(ctx, b.partition)).join() === 'beta')
      await ctx.sessions.flushAll()
    } else if (ctx.stage === 'verify') {
      const all = ctx.profiles.list()
      const a = all.find((p) => p.name === 'Smoke A')
      const b = all.find((p) => p.name === 'Smoke B')
      check('profiles restored from SQLite', all.length === 2 && Boolean(a && b))
      check('proxy settings restored', b?.proxy?.host === '127.0.0.1' && b.proxy.port === 9)
      if (a && b) {
        check(
          'profile A cookie restored after restart',
          (await readCookie(ctx, a.partition)).join() === 'alpha'
        )
        check(
          'profile B cookie restored after restart',
          (await readCookie(ctx, b.partition)).join() === 'beta'
        )
        await ctx.windows.open(a.id, { initialUrl: 'about:blank' })
        const toolbarOk = ctx.windows.isOpen(a.id)
        check('profile window reopens', toolbarOk)
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
