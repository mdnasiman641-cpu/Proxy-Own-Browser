import type { ExtensionStore } from './services/extensionStore'
import type { ExtensionLoader } from './electron/extensionLoader'
import type { ProfileDataService } from './electron/profileData'
import type { LastTabsStore } from './services/lastTabs'
import { get } from 'node:http'
import type { BrowserWindow, WebContents } from 'electron'
import type { BackupCenter } from './services/backupCenter'
import type { BulkCreator } from './services/bulkCreate'
import type { CatalogService } from './services/catalogService'
import type { Logger } from './services/logger'
import type { MetadataBackupService } from './services/metadataBackup'
import type { NetworkService } from './services/networkService'
import type { ProfileService } from './services/profileService'
import type { SettingsService } from './services/settingsService'
import type { TemplateService } from './services/templateService'
import type { ProfileWindowManager } from './electron/profileWindows'
import type { ProxyTester } from './electron/proxyTester'
import type { SessionManager } from './electron/sessionManager'

/** Shared helpers for the end-to-end smoke test (inert unless POB_SMOKE_TEST is set). */

export interface SmokeContext {
  stage: string
  resultFile: string
  profiles: ProfileService
  sessions: SessionManager
  windows: ProfileWindowManager
  proxyTester: ProxyTester
  catalog: CatalogService
  templates: TemplateService
  bulkCreator: BulkCreator
  backups: MetadataBackupService
  network: NetworkService
  backupCenter: BackupCenter
  settings: SettingsService
  startupNotes: string[]
  getDashboard: () => BrowserWindow | null
  logger: Logger
  extensions: ExtensionStore
  extensionLoader: ExtensionLoader
  profileData: ProfileDataService
  lastTabs: LastTabsStore
  userDataPath: string
}

export interface Fixtures {
  echoBase: string
  authProxyPort: number
  openProxyPort: number
  sameExitProxyPort: number
  labProxyPort: number
  challengeProxyPort: number
  blackholePort: number
  closedPort: number
  proxiedIp: string
  /** Exit identities of the fixture proxies: ny (auth/same-exit), chi (open), lab-a/lab-b (lab). */
  exits: Record<string, { ip: string; city: string | null; timezone: string; isp: string }>
  user: string
  pass: string
}

export const COOKIE_URL = 'https://smoke-test.invalid/'
export const COOKIE_NAME = 'pob_smoke'
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function waitForLoad(contents: WebContents, timeoutMs = 20_000): Promise<void> {
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
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return true
    await sleep(150)
  }
  return Boolean(await predicate())
}

export async function pageHas(contents: WebContents, selector: string): Promise<boolean> {
  return waitFor(
    () => contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}) !== null`),
    10_000
  )
}

export async function readCookie(ctx: SmokeContext, partition: string): Promise<string[]> {
  const cookies = await ctx.sessions.sessionFor(partition).cookies.get({ name: COOKIE_NAME })
  return cookies.map((c) => c.value).sort()
}

export function httpJson<T = Record<string, number>>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve(JSON.parse(body) as T))
    }).on('error', reject)
  })
}

export type Check = (name: string, passed: boolean, detail?: string, optional?: boolean) => void

export function shellLanguage(contents: WebContents): Promise<string> {
  return contents
    .executeJavaScript(`document.querySelector('[data-testid="app-shell"]')?.getAttribute('lang') ?? ''`)
    .catch(() => '')
}

export type IpcReply<T> = { ok: true; data: T } | { ok: false; error: string }

/** Calls the dashboard preload API exactly as the UI does (real IPC, sender checks, validation). */
export async function viaDashboard<T>(ctx: SmokeContext, expression: string): Promise<T> {
  const reply = (await ctx.getDashboard()!.webContents.executeJavaScript(expression)) as IpcReply<T>
  if (!reply.ok) throw new Error(`IPC failed: ${reply.error}`)
  return reply.data
}

