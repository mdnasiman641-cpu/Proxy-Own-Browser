import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  WebContentsView,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { Events } from '@shared/ipc'
import { describeProxy } from '@shared/proxy'
import type { NavigationState, Profile, ResourceUsage, TabState } from '@shared/types'
import { isNavigableUrl, normalizeAddressInput } from '@shared/url'
import { ValidationError } from '@shared/validation'
import type { Logger } from '../services/logger'
import { OpenCoordinator, type OpenOutcome } from '../services/openCoordinator'
import type { ProfileService } from '../services/profileService'
import type { SettingsService } from '../services/settingsService'
import { TabList, type AddTabOptions } from '../services/tabList'
import { appWebPreferences, loadPage, lockDownAppContents } from './pages'
import type { SessionManager } from './sessionManager'

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
}

export interface ProfileWindow {
  profile: Profile
  window: BrowserWindow
  tabs: TabList<Tab>
  /** Id of the tab whose view is currently attached to the window. */
  shownTabId: string | null
  toolbarReloads: number
}

export interface ProfileWindowDeps {
  profiles: ProfileService
  settings: SettingsService
  sessions: SessionManager
  logger: Logger
  onOpenProfilesChanged: (ids: string[]) => void
}

let tabSequence = 0
const nextTabId = (): string => `tab-${++tabSequence}`

export class ProfileWindowManager {
  private readonly windows = new Map<string, ProfileWindow>()
  private readonly coordinator: OpenCoordinator

  constructor(private readonly deps: ProfileWindowDeps) {
    this.coordinator = new OpenCoordinator({
      limit: () => this.deps.settings.get().maxOpenProfiles,
      openCount: () => this.windows.size,
      isOpen: (id) => this.isOpen(id),
      focus: (id) => this.focus(id)
    })
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
    return this.coordinator.open(profileId, () => this.create(profileId, options))
  }

  close(profileId: string): void {
    const entry = this.windows.get(profileId)
    if (entry && !entry.window.isDestroyed()) entry.window.close()
  }

  closeAll(): void {
    for (const id of this.openIds()) this.close(id)
  }

  /** Memory and window counts, to judge whether raising the window limit is safe. */
  resourceUsage(): ResourceUsage {
    const metrics = app.getAppMetrics()
    const totalKb = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0)
    let openTabs = 0
    for (const entry of this.windows.values()) openTabs += entry.tabs.size
    return {
      totalMemoryMb: Math.round(totalKb / 1024),
      processCount: metrics.length,
      openWindows: this.windows.size,
      openTabs,
      maxOpenProfiles: this.deps.settings.get().maxOpenProfiles
    }
  }

  /** Called after a profile is edited, so open windows pick up name/proxy changes. */
  async profileUpdated(profile: Profile): Promise<void> {
    const entry = this.windows.get(profile.id)
    if (!entry) return
    const proxyChanged = JSON.stringify(entry.profile.proxy) !== JSON.stringify(profile.proxy)
    entry.profile = profile
    if (proxyChanged) await this.deps.sessions.refreshProxy(profile)
    this.pushState(entry)
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
      tabs: entry.tabs.values().map((tab) => this.tabState(tab)),
      activeTabId: entry.tabs.active
    }
  }

  // ---- internals ----

  private async create(profileId: string, options: { initialUrl?: string }): Promise<void> {
    const profile = this.deps.profiles.get(profileId)
    await this.deps.sessions.prepare(profile)

    const window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: `${profile.name} — Proxy Own Browser`,
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
      toolbarReloads: 0
    }
    this.windows.set(profileId, entry)
    this.deps.onOpenProfilesChanged(this.openIds())

    const layout = (): void => this.layout(entry)
    window.on('resize', layout)
    window.on('maximize', layout)
    window.on('unmaximize', layout)
    window.on('enter-full-screen', layout)
    window.on('leave-full-screen', layout)
    window.once('ready-to-show', () => window.show())
    window.on('unresponsive', () => this.deps.logger.warn(`Profile window ${profileId} is not responding`))

    window.on('closed', () => {
      this.windows.delete(profileId)
      for (const tab of entry.tabs.values()) {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      }
      void this.deps.sessions.flush(profile.partition)
      this.deps.onOpenProfilesChanged(this.openIds())
      this.deps.logger.info(`Closed profile window ${profileId}`)
    })

    this.attachToolbarHandlers(entry)
    this.attachShortcuts(entry, window.webContents)

    try {
      await loadPage(window, 'browser')
    } catch (error) {
      this.deps.logger.error('Failed to load the browser toolbar', error)
    }

    const startUrl = options.initialUrl ?? profile.startUrl ?? this.deps.settings.get().homepage
    this.createTab(entry, startUrl, { activate: true })
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
        allowRunningInsecureContent: false
      }
    })
    const tab: Tab = { id: nextTabId(), view, error: null, crashed: false }
    entry.tabs.add(tab.id, tab, options)
    this.attachTabHandlers(entry, tab)
    this.attachShortcuts(entry, view.webContents)
    if (entry.tabs.active === tab.id) this.showTab(entry, tab.id)
    this.loadInTab(tab, url)
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
    const title = state.title && state.title !== state.url ? `${state.title} — ` : ''
    entry.window.setTitle(`${title}${entry.profile.name}`)
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
      tab.crashed = false
      push()
    })
    contents.on('did-stop-loading', push)
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
      this.deps.logger.warn(`Tab renderer gone in profile ${entry.profile.id}: ${details.reason}`)
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
