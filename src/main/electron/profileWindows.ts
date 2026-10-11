import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  clipboard,
  WebContentsView,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import type { WebRtcPolicy } from '@shared/browserConfig'
import type { PageProbeResult } from '@shared/diagnostics'
import { Events } from '@shared/ipc'
import { describeProxy } from '@shared/proxy'
import type {
  NavigationState,
  Profile,
  ProfileResourceUsage,
  ProfileRuntimeStatus,
  BrowserTimezoneReport,
  LaunchReport,
  LaunchReportItem,
  ResourceUsage,
  TabState
} from '@shared/types'
import { isNavigableUrl, normalizeAddressInput } from '@shared/url'
import { ValidationError } from '@shared/validation'
import type { Logger } from '../services/logger'
import { OpenCoordinator, type OpenOutcome } from '../services/openCoordinator'
import type { ProfileService } from '../services/profileService'
import { attributeMemory } from '../services/resourceAttribution'
import { deriveStatuses, statusOf } from '../services/runtimeStatus'
import type { SettingsService } from '../services/settingsService'
import { TabList, type AddTabOptions } from '../services/tabList'
import type { LaunchPlan } from '../services/networkService'
import type { LastTabsStore } from '../services/lastTabs'
import { startupPages, windowTitle } from '../services/windowPolicy'
import type { ExtensionLoader } from './extensionLoader'
import type { ConfigurablePermission } from '@shared/browserConfig'
import { parseProbeResult, probeScript } from '../services/diagnostics'
import { applyPageEmulation, isEmpty, type PageEmulation } from './pageEmulation'
import { appWebPreferences, loadPage, lockDownAppContents } from './pages'
import { acceptLanguageForProfile, userAgentFor, type SessionManager } from './sessionManager'

/** Height of the toolbar page (tab strip + address bar) at the top of a profile window, in DIPs. */
export const TOOLBAR_HEIGHT = 88
/** How often a crashed toolbar page is reloaded before giving up on that window. */
const MAX_TOOLBAR_RELOADS = 3

const FRIENDLY_ERRORS: Record<number, string> = {
  [-105]: 'The site address could not be found (DNS lookup failed).',
  [-106]: 'You appear to be offline.',
  [-109]: 'The address is unreachable.',
  [-111]: "Could not connect through this profile's proxy (tunnel failed).",
  [-118]: 'The connection timed out.',
  [-130]: "Could not connect to this profile's proxy server. Check the proxy settings.",
  [-127]: 'The proxy requires authentication. Check the proxy username and password.',
  [-200]: 'The site certificate is invalid.'
}

interface Tab {
  id: string
  view: WebContentsView
  error: string | null
  crashed: boolean
  /** False until the profile's time zone/language are applied; loads wait for it. */
  ready: boolean
  /** Latest address requested before the tab was ready. */
  pendingUrl: string | null
}

export interface ProfileWindow {
  profile: Profile
  window: BrowserWindow
  tabs: TabList<Tab>
  /** Id of the tab whose view is currently attached to the window. */
  shownTabId: string | null
  toolbarReloads: number
  /** Time zone and locale applied to every tab and pop-up of this window. */
  emulation: PageEmulation
  /** e.g. "Asia/Dhaka (automatic)" for the toolbar. */
  timezoneLabel: string | null
  /** Non-blocking warning shown in the toolbar (e.g. time zone could not be refreshed). */
  notice: string | null
  /** Time zone the window's pages actually reported (checked after each page load). */
  reportedTimezone: BrowserTimezoneReport | null
  /** What was applied when the window opened (and what could not be). */
  launchReport: LaunchReport
}

export interface ProfileWindowDeps {
  profiles: ProfileService
  settings: SettingsService
  sessions: SessionManager
  logger: Logger
  onOpenProfilesChanged: (ids: string[]) => void
  /** Called (coalesced) whenever any profile's runtime status may have changed. */
  onStatusesChanged?: (statuses: Record<string, ProfileRuntimeStatus>) => void
  /**
   * Decides the time zone and locale before a window opens. Throws (with the reason shown to
   * the user) when a required time zone can't be determined. Without it nothing is overridden.
   */
  planLaunch?: (profileId: string) => Promise<LaunchPlan>
  /** Resource-pressure check for the resource panel. */
  pressure?: (appMemoryMb: number) => ResourceUsage['pressure']
  /** Called when a window's pages reported their time zone (see reportedTimezones). */
  onTimezoneReport?: (profileId: string) => void
  /** Loads the profile's extensions into its session when the window opens. */
  extensions?: ExtensionLoader
  /** Tabs saved at close for "restore previous tabs". */
  lastTabs?: LastTabsStore
  /** Called when a launch report changed (window opened or settings re-applied). */
  onLaunchReport?: (profileId: string) => void
}

const PERMISSION_LABELS: Record<ConfigurablePermission, string> = {
  notifications: 'show notifications',
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  'clipboard-read': 'read your clipboard',
  midi: 'use MIDI devices',
  'idle-detection': 'know when you are idle',
  'window-management': 'manage windows on your screens'
}

/** Canonical IANA name, so aliases (Asia/Calcutta vs Asia/Kolkata) compare equal. */
function canonicalZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return zone
  }
}

/** Read in an isolated world, so page scripts cannot change what is reported. */
const REPORTED_TZ_WORLD = 1001
/** Diagnostics run in their own isolated world; the page cannot see or alter the results. */
const DIAGNOSTICS_WORLD = 1002

export interface PageDiagnostics {
  page: PageProbeResult | null
  pagePartition: string | null
  resolvedProxy: string | null
  expected: { timezone: string | null; locale: string | null; userAgent: string; geolocation: { latitude: number; longitude: number; accuracy: number } | null }
  problem: string | null
}

function emulationOf(profile: Profile, plan: Pick<LaunchPlan, 'timezone' | 'locale' | 'acceptLanguage' | 'geolocation'>): PageEmulation {
  return {
    timezone: plan.timezone,
    locale: plan.locale,
    userAgent: userAgentFor(profile),
    acceptLanguage: plan.acceptLanguage ?? acceptLanguageForProfile(profile),
    geolocation: plan.geolocation
  }
}

const EMPTY_PLAN: LaunchPlan = {
  timezone: null,
  timezoneSource: 'off',
  locale: null,
  languageSource: 'default',
  acceptLanguage: null,
  geolocation: null,
  geolocationSource: 'off',
  warnings: []
}

function timezoneLabel(plan: LaunchPlan): string | null {
  if (!plan.timezone) return null
  return `${plan.timezone} (${plan.timezoneSource === 'auto' ? 'automatic' : 'manual'})`
}

let tabSequence = 0
const nextTabId = (): string => `tab-${++tabSequence}`

export class ProfileWindowManager {
  private readonly windows = new Map<string, ProfileWindow>()
  private readonly coordinator: OpenCoordinator
  private statusTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: ProfileWindowDeps) {
    this.coordinator = new OpenCoordinator({
      limit: () => this.deps.settings.get().maxOpenProfiles,
      openCount: () => this.windows.size,
      isOpen: (id) => this.isOpen(id),
      focus: (id) => this.focus(id)
    })
    // "Ask" permissions are answered in the window of the profile that asked.
    this.deps.sessions.askPermission = (profileId, origin, keys) => this.askPermission(profileId, origin, keys)
  }

  private async askPermission(profileId: string, origin: string, keys: ConfigurablePermission[]): Promise<boolean> {
    const entry = this.windows.get(profileId)
    if (!entry || entry.window.isDestroyed()) return false
    const what = keys.map((k) => PERMISSION_LABELS[k]).join(' and ')
    const { response } = await dialog.showMessageBox(entry.window, {
      type: 'question',
      buttons: ['Block', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: entry.profile.name,
      message: `${origin || 'This site'} wants to ${what}.`,
      detail: `Profile: ${entry.profile.name}. Your answer applies to this site until the window is closed. Change the default in the profile's settings.`
    })
    return response === 1
  }

  /** What was applied when the profile's window opened, or null when it is not open. */
  launchReport(profileId: string): LaunchReport | null {
    return this.windows.get(profileId)?.launchReport ?? null
  }

  /**
   * Closes the profile window and opens it again, so settings that only apply at start
   * (window size, startup pages, extensions) take effect. Unsaved page state is lost; the
   * dashboard says so before calling this.
   */
  async reopen(profileId: string): Promise<OpenOutcome> {
    const entry = this.windows.get(profileId)
    if (entry && !entry.window.isDestroyed()) {
      const closed = new Promise<void>((resolve) => entry.window.once('closed', () => resolve()))
      entry.window.close()
      await closed
    }
    return this.open(profileId)
  }

  openIds(): string[] {
    return [...this.windows.keys()]
  }

  isOpen(profileId: string): boolean {
    const entry = this.windows.get(profileId)
    return Boolean(entry && !entry.window.isDestroyed())
  }

  /** Web contents of the profile window's active tab. */
  sessionContents(profileId: string): WebContents | undefined {
    const entry = this.windows.get(profileId)
    return entry ? this.activeTab(entry)?.view.webContents : undefined
  }

  toolbarContents(profileId: string): WebContents | undefined {
    return this.windows.get(profileId)?.window.webContents
  }

  windowFor(profileId: string): ProfileWindow | undefined {
    return this.windows.get(profileId)
  }

  /** Finds the profile window whose toolbar sent an IPC message. */
  findByToolbar(sender: WebContents): ProfileWindow | undefined {
    for (const entry of this.windows.values()) {
      if (!entry.window.isDestroyed() && entry.window.webContents.id === sender.id) return entry
    }
    return undefined
  }

  /**
   * Opens (or focuses) a profile window. Duplicate requests while a window is starting are
   * merged, and windows still starting count toward the concurrency limit.
   */
  open(profileId: string, options: { initialUrl?: string } = {}): Promise<OpenOutcome> {
    return this.coordinator
      .open(profileId, () => {
        this.notifyStatuses()
        return this.create(profileId, options)
      })
      .finally(() => this.notifyStatuses())
  }

  /** Live status of every profile that is not closed. */
  statuses(): Record<string, ProfileRuntimeStatus> {
    return deriveStatuses(
      this.coordinator.pendingIds(),
      [...this.windows.entries()]
        .filter(([, entry]) => !entry.window.isDestroyed())
        .map(([profileId, entry]) => ({
          profileId,
          crashedTabs: entry.tabs.values().filter((t) => t.crashed).length
        }))
    )
  }

  /** Coalesces status notifications from bursts of events into one push. */
  private notifyStatuses(): void {
    if (!this.deps.onStatusesChanged || this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.deps.onStatusesChanged?.(this.statuses())
    }, 50)
  }

  close(profileId: string): void {
    const entry = this.windows.get(profileId)
    if (entry && !entry.window.isDestroyed()) entry.window.close()
  }

  closeAll(): void {
    for (const id of this.openIds()) this.close(id)
  }

  /**
   * Memory and window counts, to judge whether raising the window limit is safe.
   * Per-profile numbers cover the page processes of that profile's tabs, matched by process id;
   * browser, GPU, network, toolbar and dashboard processes are reported as shared.
   * Measured only when asked for (no background polling).
   */
  resourceUsage(): ResourceUsage {
    const metrics = app.getAppMetrics()
    const owners = [...this.windows.entries()].map(([profileId, entry]) => ({
      profileId,
      pids: entry.tabs
        .values()
        .filter((t) => !t.view.webContents.isDestroyed())
        .map((t) => t.view.webContents.getOSProcessId())
    }))
    const attribution = attributeMemory(
      metrics.map((m) => ({ pid: m.pid, memoryKb: m.memory?.workingSetSize ?? 0 })),
      owners
    )
    const statuses = this.statuses()
    let openTabs = 0
    const profiles: ProfileResourceUsage[] = []
    for (const [profileId, entry] of this.windows) {
      openTabs += entry.tabs.size
      const usage = attribution.perProfile.get(profileId) ?? { memoryMb: 0, processCount: 0 }
      profiles.push({
        profileId,
        name: entry.profile.name,
        status: statusOf(statuses, profileId),
        tabs: entry.tabs.size,
        memoryMb: usage.memoryMb,
        processCount: usage.processCount
      })
    }
    return {
      totalMemoryMb: attribution.totalMb,
      processCount: metrics.length,
      openWindows: this.windows.size,
      openTabs,
      maxOpenProfiles: this.deps.settings.get().maxOpenProfiles,
      sharedMemoryMb: attribution.sharedMb,
      profiles: profiles.sort((a, b) => b.memoryMb - a.memoryMb),
      measuredAt: new Date().toISOString(),
      pressure: this.deps.pressure?.(attribution.totalMb) ?? { level: 'ok', messages: [] }
    }
  }

  /**
   * Called after a profile is edited, so its open window picks up name, proxy and browser
   * setting changes. Only this profile's session and tabs are touched.
   */
  async profileUpdated(profile: Profile): Promise<void> {
    const entry = this.windows.get(profile.id)
    if (!entry) return
    const proxyChanged = JSON.stringify(entry.profile.proxy) !== JSON.stringify(profile.proxy)
    const before = entry.profile.browser
    const browserChanged = JSON.stringify(before) !== JSON.stringify(profile.browser)
    entry.profile = profile
    if (proxyChanged) await this.deps.sessions.refreshProxy(profile)
    if (browserChanged) {
      this.deps.sessions.refreshBrowserSettings(profile)
      if (before.webrtcPolicy !== profile.browser.webrtcPolicy) {
        // New WebRTC connections use the new setting; pages already open keep existing ones.
        for (const tab of entry.tabs.values()) applyWebRtcPolicy(tab.view.webContents, profile.browser.webrtcPolicy)
      }
      if (before.zoomPercent !== profile.browser.zoomPercent) {
        for (const tab of entry.tabs.values()) {
          if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setZoomFactor(profile.browser.zoomPercent / 100)
        }
      }
    }
    const timeChanged =
      proxyChanged ||
      before.timezoneMode !== profile.browser.timezoneMode ||
      before.timezoneManual !== profile.browser.timezoneManual ||
      before.language !== profile.browser.language ||
      before.languageMode !== profile.browser.languageMode ||
      before.acceptLanguage !== profile.browser.acceptLanguage ||
      before.geolocationMode !== profile.browser.geolocationMode ||
      before.geoLatitude !== profile.browser.geoLatitude ||
      before.geoLongitude !== profile.browser.geoLongitude
    if (timeChanged && this.deps.planLaunch) {
      try {
        const plan = await this.deps.planLaunch(profile.id)
        entry.timezoneLabel = timezoneLabel(plan)
        entry.notice = plan.warnings[0] ?? null
        this.deps.sessions.setLanguagePlan(profile.partition, plan.acceptLanguage)
        await this.setEmulation(entry, emulationOf(profile, plan))
        // Settings applied while open replace the matching lines of the launch report.
        const fresh = launchItems(profile, plan)
        const names = new Set(fresh.map((i) => i.setting))
        entry.launchReport = {
          ...entry.launchReport,
          items: [...fresh, ...entry.launchReport.items.filter((i) => !names.has(i.setting))]
        }
        this.deps.onLaunchReport?.(profile.id)
      } catch (error) {
        // Keep the previous time zone in the open window and say why it was not changed.
        entry.notice = `Time zone not updated: ${error instanceof Error ? error.message : String(error)}`
        await this.setEmulation(entry, emulationOf(profile, entry.emulation))
      }
    } else if (browserChanged) {
      await this.setEmulation(entry, emulationOf(profile, entry.emulation))
    }
    this.pushState(entry)
  }

  /** Applies time zone, locale and User-Agent to every tab of an open window. */
  private async setEmulation(entry: ProfileWindow, emulation: PageEmulation): Promise<void> {
    entry.emulation = emulation
    await Promise.all(
      entry.tabs.values().map((tab) => applyPageEmulation(tab.view.webContents, emulation, this.deps.logger))
    )
  }

  /** What the pages of each open window reported as their time zone. */
  reportedTimezones(): Record<string, BrowserTimezoneReport> {
    const result: Record<string, BrowserTimezoneReport> = {}
    for (const [id, entry] of this.windows) {
      if (entry.reportedTimezone && !entry.window.isDestroyed()) result[id] = entry.reportedTimezone
    }
    return result
  }

  /**
   * Reads `Intl.DateTimeFormat().resolvedOptions().timeZone` from a loaded page and compares it
   * with the time zone the profile should have. A mismatch is logged and shown in the toolbar.
   */
  private async verifyTimezone(entry: ProfileWindow, tab: Tab): Promise<void> {
    const contents = tab.view.webContents
    if (contents.isDestroyed() || !/^https?:/i.test(contents.getURL())) return
    let reported: unknown
    try {
      reported = await contents.executeJavaScriptInIsolatedWorld(REPORTED_TZ_WORLD, [
        { code: 'Intl.DateTimeFormat().resolvedOptions().timeZone' }
      ])
    } catch {
      return
    }
    if (typeof reported !== 'string' || entry.window.isDestroyed()) return
    const expected = entry.emulation.timezone
    const target = expected ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const matches = canonicalZone(reported) === canonicalZone(target)
    const previous = entry.reportedTimezone
    entry.reportedTimezone = { profileId: entry.profile.id, reported, expected, matches, checkedAt: new Date().toISOString() }
    if (!matches) {
      this.deps.logger.warn(`Profile ${entry.profile.id}: pages report time zone ${reported}, expected ${target}`)
      entry.notice = `Pages report the time zone ${reported}, not ${target}. Reload the page; if it stays wrong, close and reopen the profile.`
      this.pushState(entry)
    } else if (entry.notice?.startsWith('Pages report the time zone')) {
      entry.notice = null
      this.pushState(entry)
    }
    if (previous?.reported !== reported || previous?.matches !== matches) this.deps.onTimezoneReport?.(entry.profile.id)
  }

  /**
   * Runs the page part of the diagnostics in the active tab of an open profile window: what the
   * page reports (time zone, language, User-Agent, WebRTC candidates), which session it runs
   * in, and the proxy Chromium resolves for that session. Returns null when the profile is not
   * open. The STUN test contacts `stunServer` and only runs when one is given.
   */
  async diagnosePage(profileId: string, stunServer: string | null): Promise<PageDiagnostics | null> {
    const entry = this.windows.get(profileId)
    if (!entry || entry.window.isDestroyed()) return null
    const activeId = entry.tabs.active
    const tab = activeId ? entry.tabs.get(activeId) : undefined
    const contents = tab && tab.ready && !tab.crashed ? tab.view.webContents : undefined
    const expected = { timezone: entry.emulation.timezone, locale: entry.emulation.locale, userAgent: entry.emulation.userAgent, geolocation: entry.emulation.geolocation }
    if (!contents || contents.isDestroyed()) {
      return { page: null, pagePartition: null, resolvedProxy: null, expected, problem: 'No ready tab to test. Open a page in the profile and try again.' }
    }
    let resolvedProxy: string | null = null
    try {
      resolvedProxy = await contents.session.resolveProxy('https://www.example.com/')
    } catch {
      resolvedProxy = null
    }
    let page: PageProbeResult | null = null
    let problem: string | null = null
    try {
      page = parseProbeResult(await contents.executeJavaScriptInIsolatedWorld(DIAGNOSTICS_WORLD, [{ code: probeScript(stunServer) }]))
      if (!page) problem = 'The page did not return a test result.'
    } catch (error) {
      problem = `The page test could not run: ${error instanceof Error ? error.message : String(error)}`
    }
    return { page, pagePartition: this.deps.sessions.partitionFor(contents.session) ?? 'another session', resolvedProxy, expected, problem }
  }

  /** Current emulation of an open window (for tests and the details panel). */
  emulationFor(profileId: string): PageEmulation | null {
    return this.windows.get(profileId)?.emulation ?? null
  }

  // ---- tab actions (called from the toolbar via IPC and from shortcuts) ----

  newTab(entry: ProfileWindow, input?: string): string {
    let url = 'about:blank'
    if (input?.trim()) {
      const normalized = normalizeAddressInput(input, this.deps.settings.get().searchEngine)
      if (!normalized) throw new ValidationError('That address type is not allowed.')
      url = normalized
    }
    const id = this.createTab(entry, url, { activate: true, position: 'end' })
    if (url === 'about:blank') this.focusAddressBar(entry)
    return id
  }

  closeTab(entry: ProfileWindow, tabId: string): void {
    const tab = entry.tabs.get(tabId)
    if (!tab) throw new ValidationError('That tab no longer exists.')
    if (entry.tabs.size === 1) {
      // Closing the last tab closes the window, as in other browsers.
      entry.window.close()
      return
    }
    const { activeId } = entry.tabs.remove(tabId)
    if (tab.crashed) this.notifyStatuses()
    if (entry.shownTabId === tabId) {
      if (!entry.window.isDestroyed()) entry.window.contentView.removeChildView(tab.view)
      entry.shownTabId = null
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (activeId) this.showTab(entry, activeId)
    this.pushState(entry)
  }

  activateTab(entry: ProfileWindow, tabId: string): void {
    if (!entry.tabs.activate(tabId)) throw new ValidationError('That tab no longer exists.')
    this.showTab(entry, tabId)
    this.pushState(entry)
  }

  navigate(entry: ProfileWindow, input: string): void {
    const tab = this.activeTab(entry)
    if (!tab) return
    const url = normalizeAddressInput(input, this.deps.settings.get().searchEngine)
    if (!url) {
      tab.error = 'That address type is not allowed. Use an http:// or https:// address.'
      this.pushState(entry)
      return
    }
    this.loadInTab(tab, url)
  }

  goHome(entry: ProfileWindow): void {
    const tab = this.activeTab(entry)
    if (tab) this.loadInTab(tab, entry.profile.startUrl ?? this.deps.settings.get().homepage)
  }

  back(entry: ProfileWindow): void {
    const history = this.activeTab(entry)?.view.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward(entry: ProfileWindow): void {
    const history = this.activeTab(entry)?.view.webContents.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload(entry: ProfileWindow): void {
    const tab = this.activeTab(entry)
    if (!tab) return
    tab.error = null
    tab.crashed = false
    tab.view.webContents.reload()
  }

  stop(entry: ProfileWindow): void {
    this.activeTab(entry)?.view.webContents.stop()
  }

  state(entry: ProfileWindow): NavigationState {
    const active = this.activeTab(entry)
    const contents = active?.view.webContents
    const alive = contents && !contents.isDestroyed()
    return {
      url: alive ? contents.getURL() : '',
      title: alive ? contents.getTitle() : '',
      isLoading: alive ? contents.isLoading() : false,
      canGoBack: alive ? contents.navigationHistory.canGoBack() : false,
      canGoForward: alive ? contents.navigationHistory.canGoForward() : false,
      error: active?.error ?? null,
      profileName: entry.profile.name,
      profileColor: entry.profile.color,
      proxyLabel: describeProxy(entry.profile.proxy),
      timezoneLabel: entry.timezoneLabel,
      notice: entry.notice,
      tabs: entry.tabs.values().map((tab) => this.tabState(tab)),
      activeTabId: entry.tabs.active
    }
  }

  // ---- internals ----

  private async create(profileId: string, options: { initialUrl?: string }): Promise<void> {
    const profile = this.deps.profiles.get(profileId)
    // Decided before anything opens: if a required time zone can't be determined, the window
    // is not opened at all rather than showing pages with this PC's time zone.
    const plan: LaunchPlan = this.deps.planLaunch ? await this.deps.planLaunch(profileId) : EMPTY_PLAN
    this.deps.sessions.setLanguagePlan(profile.partition, plan.acceptLanguage)
    const ses = await this.deps.sessions.prepare(profile)
    const report: LaunchReportItem[] = launchItems(profile, plan)
    if (this.deps.extensions) {
      try {
        report.push(...(await this.deps.extensions.loadForProfile(ses, profile.id)))
      } catch (error) {
        report.push({ setting: 'Extensions', status: 'failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }

    const window = new BrowserWindow({
      width: profile.browser.windowWidth,
      height: profile.browser.windowHeight,
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: windowTitle('', '', profile.name, profile.options.showNameInTitle),
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: appWebPreferences('browser')
    })
    lockDownAppContents(window.webContents)

    const entry: ProfileWindow = {
      profile,
      window,
      tabs: new TabList<Tab>(),
      shownTabId: null,
      toolbarReloads: 0,
      emulation: emulationOf(profile, plan),
      timezoneLabel: timezoneLabel(plan),
      notice: plan.warnings[0] ?? null,
      reportedTimezone: null,
      launchReport: { profileId, openedAt: new Date().toISOString(), items: report }
    }
    this.windows.set(profileId, entry)
    this.deps.onOpenProfilesChanged(this.openIds())
    this.notifyStatuses()

    const layout = (): void => this.layout(entry)
    window.on('resize', layout)
    window.on('maximize', layout)
    window.on('unmaximize', layout)
    window.on('enter-full-screen', layout)
    window.on('leave-full-screen', layout)
    window.once('ready-to-show', () => {
      if (entry.profile.options.windowMode === 'maximized') window.maximize()
      window.show()
    })
    window.on('unresponsive', () => this.deps.logger.warn(`Profile window ${profileId} is not responding`))

    // Remember the open tabs for "restore previous tabs" (web addresses only).
    window.on('close', () => {
      if (entry.profile.options.startupMode !== 'restore' || !this.deps.lastTabs) return
      const urls = entry.tabs
        .values()
        .map((t) => (t.view.webContents.isDestroyed() ? (t.pendingUrl ?? '') : t.view.webContents.getURL() || (t.pendingUrl ?? '')))
      try {
        this.deps.lastTabs.save(profileId, urls)
      } catch (error) {
        this.deps.logger.warn(`Could not save the open tabs of profile ${profileId}`, error)
      }
    })

    window.on('closed', () => {
      this.windows.delete(profileId)
      for (const tab of entry.tabs.values()) {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      }
      this.deps.sessions.forgetPermissionDecisions(profile.partition)
      void this.deps.sessions.flush(profile.partition)
      this.deps.onOpenProfilesChanged(this.openIds())
      this.notifyStatuses()
      this.deps.logger.info(`Closed profile window ${profileId}`)
    })

    this.attachToolbarHandlers(entry)
    this.attachShortcuts(entry, window.webContents)

    try {
      await loadPage(window, 'browser')
    } catch (error) {
      this.deps.logger.error('Failed to load the browser toolbar', error)
    }

    const pages = startupPages(
      profile.options,
      profile.startUrl,
      this.deps.settings.get().homepage,
      this.deps.lastTabs?.load(profileId) ?? [],
      options.initialUrl
    )
    pages.urls.forEach((url, index) => {
      if (entry.tabs.canAdd()) this.createTab(entry, url, { activate: index === 0, position: 'end' })
    })
    report.push({
      setting: 'Startup pages',
      status: pages.source === 'restore-empty' ? 'warning' : 'applied',
      detail:
        pages.source === 'restore-empty'
          ? 'No saved tabs to restore; the start page was opened.'
          : `${pages.urls.length} tab(s) opened (${pages.source}).`
    })
    this.deps.onLaunchReport?.(profileId)
    this.deps.profiles.markOpened(profileId)
    this.deps.logger.info(`Opened profile window ${profileId}`)
  }

  private focus(profileId: string): void {
    const entry = this.windows.get(profileId)
    if (!entry || entry.window.isDestroyed()) return
    if (entry.window.isMinimized()) entry.window.restore()
    entry.window.show()
    entry.window.focus()
  }

  private activeTab(entry: ProfileWindow): Tab | undefined {
    return entry.tabs.activeItem()
  }

  private tabState(tab: Tab): TabState {
    const contents = tab.view.webContents
    const alive = !contents.isDestroyed()
    const url = alive ? contents.getURL() : ''
    return {
      id: tab.id,
      title: (alive && contents.getTitle()) || (url && url !== 'about:blank' ? url : 'New tab'),
      url,
      isLoading: alive ? contents.isLoading() : false,
      crashed: tab.crashed
    }
  }

  /** Creates a tab in the profile's own session and returns its id. */
  private createTab(entry: ProfileWindow, url: string, options: AddTabOptions): string {
    if (!entry.tabs.canAdd()) {
      throw new ValidationError('This window has reached its tab limit. Close a tab first.')
    }
    const view = new WebContentsView({
      webPreferences: {
        // Every tab uses the profile's partition — tabs share its cookies and logins.
        partition: entry.profile.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        zoomFactor: entry.profile.browser.zoomPercent / 100
      }
    })
    // Before any page loads, so the profile's WebRTC setting covers the first connection.
    applyWebRtcPolicy(view.webContents, entry.profile.browser.webrtcPolicy)
    const tab: Tab = { id: nextTabId(), view, error: null, crashed: false, ready: isEmpty(entry.emulation), pendingUrl: null }
    entry.tabs.add(tab.id, tab, options)
    this.attachTabHandlers(entry, tab)
    this.attachShortcuts(entry, view.webContents)
    if (entry.tabs.active === tab.id) this.showTab(entry, tab.id)
    if (isEmpty(entry.emulation)) {
      view.webContents.setUserAgent(entry.emulation.userAgent)
      this.loadInTab(tab, url)
    } else {
      // The time zone must be in place before the first page script runs.
      tab.pendingUrl = url
      // DevTools-protocol commands reach the page through its renderer, so an empty page is
      // loaded first; no website content runs before the overrides are in place.
      view.webContents.loadURL('about:blank').catch(() => {})
      void applyPageEmulation(view.webContents, entry.emulation, this.deps.logger).then((ok) => {
        if (ok) {
          tab.ready = true
          // Load the newest address requested meanwhile (e.g. the user already navigated).
          const next = tab.pendingUrl ?? url
          tab.pendingUrl = null
          this.loadInTab(tab, next)
        } else {
          tab.error =
            "This profile's time zone/language could not be applied, so the page was not loaded (it would have shown this PC's settings). Close the tab and try again."
          this.pushState(entry)
        }
      })
    }
    this.pushState(entry)
    return tab.id
  }

  /** Attaches only the active tab's view to the window. */
  private showTab(entry: ProfileWindow, tabId: string): void {
    if (entry.window.isDestroyed()) return
    const next = entry.tabs.get(tabId)
    if (!next) return
    if (entry.shownTabId && entry.shownTabId !== tabId) {
      const previous = entry.tabs.get(entry.shownTabId)
      if (previous) entry.window.contentView.removeChildView(previous.view)
    }
    if (entry.shownTabId !== tabId) entry.window.contentView.addChildView(next.view)
    entry.shownTabId = tabId
    this.layout(entry)
    if (!next.view.webContents.isDestroyed()) next.view.webContents.focus()
  }

  private layout(entry: ProfileWindow): void {
    if (entry.window.isDestroyed() || !entry.shownTabId) return
    const tab = entry.tabs.get(entry.shownTabId)
    if (!tab) return
    const [width = 0, height = 0] = entry.window.getContentSize()
    tab.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT)
    })
  }

  private loadInTab(tab: Tab, url: string): void {
    if (!isNavigableUrl(url) || tab.view.webContents.isDestroyed()) return
    if (!tab.ready) {
      // Never load a page before the profile's time zone/language are in place.
      tab.pendingUrl = url
      return
    }
    tab.error = null
    tab.view.webContents.loadURL(url).catch(() => {
      /* failures are reported through did-fail-load */
    })
  }

  private focusAddressBar(entry: ProfileWindow): void {
    if (entry.window.isDestroyed()) return
    entry.window.webContents.focus()
    entry.window.webContents.send(Events.focusAddressBar)
  }

  private pushState(entry: ProfileWindow): void {
    if (entry.window.isDestroyed() || entry.window.webContents.isDestroyed()) return
    const state = this.state(entry)
    entry.window.webContents.send(Events.navigationState, state)
    entry.window.setTitle(windowTitle(state.title, state.url, entry.profile.name, entry.profile.options.showNameInTitle))
  }

  /** Keeps the toolbar alive: re-sends state after loads and reloads it if it crashes. */
  private attachToolbarHandlers(entry: ProfileWindow): void {
    const toolbar = entry.window.webContents
    toolbar.on('did-finish-load', () => this.pushState(entry))
    toolbar.on('render-process-gone', (_e, details) => {
      this.deps.logger.warn(`Toolbar renderer gone in profile ${entry.profile.id}: ${details.reason}`)
      if (entry.window.isDestroyed() || details.reason === 'clean-exit') return
      if (entry.toolbarReloads >= MAX_TOOLBAR_RELOADS) {
        this.deps.logger.error(`Toolbar keeps crashing in profile ${entry.profile.id}; closing window`)
        entry.window.close()
        return
      }
      entry.toolbarReloads++
      setTimeout(() => {
        if (!entry.window.isDestroyed()) {
          loadPage(entry.window, 'browser').catch((error) =>
            this.deps.logger.error('Failed to reload the browser toolbar', error)
          )
        }
      }, 500)
    })
  }

  private attachTabHandlers(entry: ProfileWindow, tab: Tab): void {
    const contents = tab.view.webContents
    const push = (): void => this.pushState(entry)

    contents.on('did-start-loading', () => {
      tab.error = null
      if (tab.crashed) {
        tab.crashed = false
        this.notifyStatuses()
      }
      push()
    })
    contents.on('did-stop-loading', push)
    contents.on('did-finish-load', () => void this.verifyTimezone(entry, tab))
    contents.on('did-navigate', push)
    contents.on('did-navigate-in-page', push)
    contents.on('page-title-updated', push)
    contents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3 = aborted (e.g. user stopped/navigated)
      tab.error = FRIENDLY_ERRORS[code] ?? `The page failed to load: ${description} (${code}).`
      push()
    })
    contents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      tab.crashed = true
      tab.error = `This tab stopped unexpectedly (${details.reason}). Press Reload to try again.`
      // Reason and exit code only — never the URL, which can contain tokens.
      this.deps.logger.warn(
        `Tab renderer gone in profile ${entry.profile.id}: ${details.reason} (exit code ${details.exitCode})`
      )
      this.notifyStatuses()
      push()
    })
    contents.on('unresponsive', () => {
      tab.error = 'This page is not responding. Wait, or close the tab.'
      push()
    })
    contents.on('responsive', () => {
      if (tab.error?.startsWith('This page is not responding')) tab.error = null
      push()
    })

    this.guardWebContents(contents, entry)
  }

  /** Navigation/popup policy for website content (applied to popups recursively). */
  private guardWebContents(contents: WebContents, entry: ProfileWindow): void {
    contents.on('will-navigate', (event, url) => {
      if (!isNavigableUrl(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!isNavigableUrl(url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (!isNavigableUrl(url)) return { action: 'deny' }
      // Links opened "in a new tab" (target=_blank, middle-click, Ctrl+click) become tabs.
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        if (entry.tabs.canAdd() && !entry.window.isDestroyed()) {
          this.createTab(entry, url, {
            activate: disposition === 'foreground-tab',
            position: 'after-active'
          })
        }
        return { action: 'deny' }
      }
      // Scripted pop-ups (sign-in windows etc.) keep their window and opener.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1024,
          height: 760,
          autoHideMenuBar: true,
          title: entry.profile.name,
          webPreferences: {
            partition: entry.profile.partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
          }
        }
      }
    })
    contents.on('did-create-window', (child) => {
      applyWebRtcPolicy(child.webContents, entry.profile.browser.webrtcPolicy)
      void applyPageEmulation(child.webContents, entry.emulation, this.deps.logger)
      this.guardWebContents(child.webContents, entry)
    })
    this.attachContextMenu(contents, entry)
  }

  private attachContextMenu(contents: WebContents, entry: ProfileWindow): void {
    contents.on('context-menu', (_event, params) => {
      const template: MenuItemConstructorOptions[] = []
      if (params.linkURL && isNavigableUrl(params.linkURL)) {
        template.push(
          {
            label: 'Open link in new tab',
            enabled: entry.tabs.canAdd(),
            click: () => {
              if (!entry.window.isDestroyed() && entry.tabs.canAdd()) {
                this.createTab(entry, params.linkURL, { activate: false, position: 'after-active' })
              }
            }
          },
          { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' }
        )
      }
      if (params.isEditable) {
        template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
      } else if (params.selectionText) {
        template.push({ role: 'copy' })
      }
      if (template.length) template.push({ type: 'separator' })
      template.push(
        {
          label: 'Back',
          enabled: contents.navigationHistory.canGoBack(),
          click: () => contents.navigationHistory.goBack()
        },
        {
          label: 'Forward',
          enabled: contents.navigationHistory.canGoForward(),
          click: () => contents.navigationHistory.goForward()
        },
        { label: 'Reload', click: () => contents.reload() },
        { type: 'separator' },
        { label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) }
      )
      Menu.buildFromTemplate(template).popup()
    })
  }

  private attachShortcuts(entry: ProfileWindow, contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const ctrl = input.control || input.meta
      const key = input.key.toLowerCase()
      const tab = this.activeTab(entry)
      try {
        if (key === 'f5' || (ctrl && key === 'r')) {
          this.reload(entry)
        } else if (input.alt && key === 'arrowleft') {
          this.back(entry)
        } else if (input.alt && key === 'arrowright') {
          this.forward(entry)
        } else if ((ctrl && key === 'l') || key === 'f6') {
          this.focusAddressBar(entry)
        } else if (ctrl && key === 't') {
          this.newTab(entry)
        } else if (ctrl && (key === 'w' || key === 'f4')) {
          if (tab) this.closeTab(entry, tab.id)
        } else if ((ctrl && key === 'tab') || (ctrl && (key === 'pagedown' || key === 'pageup'))) {
          const direction = input.shift || key === 'pageup' ? -1 : 1
          const id = entry.tabs.cycle(direction)
          if (id) this.activateTab(entry, id)
        } else if (ctrl && /^[1-9]$/.test(key)) {
          const id = entry.tabs.activateIndex(key === '9' ? -1 : Number(key) - 1)
          if (id) this.activateTab(entry, id)
        } else if (key === 'f12') {
          tab?.view.webContents.toggleDevTools()
        } else {
          return
        }
      } catch (error) {
        // e.g. tab limit reached — show it on the active tab instead of failing silently.
        if (tab && error instanceof ValidationError) {
          tab.error = error.message
          this.pushState(entry)
        }
      }
      event.preventDefault()
    })
  }
}

/** Applies the profile's WebRTC IP handling setting to one page (tab or pop-up). */
function applyWebRtcPolicy(contents: WebContents, policy: WebRtcPolicy): void {
  if (contents.isDestroyed()) return
  contents.setWebRTCIPHandlingPolicy(policy)
}

/** Launch-report lines for the settings decided before a window opens. */
function launchItems(profile: Profile, plan: LaunchPlan): LaunchReportItem[] {
  const items: LaunchReportItem[] = []
  items.push({
    setting: 'Proxy',
    status: profile.proxy ? 'applied' : 'not-set',
    detail: profile.proxy ? `${describeProxy(profile.proxy)} for every tab; no direct fallback.` : 'Direct connection (no proxy).'
  })
  items.push(
    plan.timezone
      ? { setting: 'Time zone', status: 'applied', detail: `${plan.timezone} (${plan.timezoneSource}).` }
      : { setting: 'Time zone', status: 'not-set', detail: 'Pages use this PC’s time zone.' }
  )
  items.push(
    plan.locale || plan.acceptLanguage
      ? { setting: 'Language', status: 'applied', detail: `${plan.locale ?? 'app language'} (${plan.languageSource}); Accept-Language ${plan.acceptLanguage ?? 'default'}.` }
      : { setting: 'Language', status: profile.browser.languageMode === 'auto' ? 'warning' : 'not-set', detail: 'The app’s language is used.' }
  )
  items.push(
    plan.geolocation
      ? {
          setting: 'Geolocation',
          status: 'applied',
          detail: `${plan.geolocation.latitude.toFixed(4)}, ${plan.geolocation.longitude.toFixed(4)} (±${plan.geolocation.accuracy} m, ${plan.geolocationSource}); sites still need the location permission.`
        }
      : {
          setting: 'Geolocation',
          status: profile.browser.geolocationMode === 'off' ? 'not-set' : 'warning',
          detail: 'No location is provided to pages.'
        }
  )
  items.push({ setting: 'User-Agent', status: 'applied', detail: profile.browser.userAgent === 'custom' ? 'Custom User-Agent.' : `${profile.browser.userAgent === 'chrome' ? 'Chrome' : 'Default'} User-Agent of the installed engine.` })
  items.push({ setting: 'WebRTC', status: 'applied', detail: `IP handling policy: ${profile.browser.webrtcPolicy}.` })
  items.push({ setting: 'Window', status: 'applied', detail: `${profile.browser.windowWidth} × ${profile.browser.windowHeight}, ${profile.options.windowMode}, zoom ${profile.browser.zoomPercent}%.` })
  items.push({
    setting: 'Downloads',
    status: profile.options.downloadMode === 'folder' ? 'applied' : 'not-set',
    detail: profile.options.downloadMode === 'folder' ? 'Saved to the profile’s download folder.' : 'Ask where to save.'
  })
  const granted = Object.entries(profile.browser.permissions).filter(([, v]) => v !== 'block')
  items.push({
    setting: 'Permissions',
    status: 'applied',
    detail: granted.length ? granted.map(([k, v]) => `${k}: ${v}`).join(', ') + '; everything else is blocked.' : 'All configurable permissions are blocked.'
  })
  items.push({ setting: 'Do Not Track', status: profile.options.doNotTrack ? 'applied' : 'not-set', detail: profile.options.doNotTrack ? 'Sends DNT: 1.' : 'Not sent.' })
  for (const warning of plan.warnings) items.push({ setting: 'Notice', status: 'warning', detail: warning })
  return items
}
