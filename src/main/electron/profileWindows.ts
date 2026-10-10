import {
  BrowserWindow,
  Menu,
  clipboard,
  WebContentsView,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { Events } from '@shared/ipc'
import { describeProxy } from '@shared/proxy'
import type { NavigationState, Profile } from '@shared/types'
import { isNavigableUrl, normalizeAddressInput } from '@shared/url'
import { ValidationError } from '@shared/validation'
import type { Logger } from '../services/logger'
import type { ProfileService } from '../services/profileService'
import type { SettingsService } from '../services/settingsService'
import { loadPage, lockDownAppContents, preloadPath } from './pages'
import type { SessionManager } from './sessionManager'

/** Height of the toolbar page (address bar) at the top of a profile window, in DIPs. */
export const TOOLBAR_HEIGHT = 52

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

export interface ProfileWindow {
  profile: Profile
  window: BrowserWindow
  view: WebContentsView
  error: string | null
}

export interface ProfileWindowDeps {
  profiles: ProfileService
  settings: SettingsService
  sessions: SessionManager
  logger: Logger
  onOpenProfilesChanged: (ids: string[]) => void
}

export class ProfileWindowManager {
  private readonly windows = new Map<string, ProfileWindow>()

  constructor(private readonly deps: ProfileWindowDeps) {}

  openIds(): string[] {
    return [...this.windows.keys()]
  }

  isOpen(profileId: string): boolean {
    return this.windows.has(profileId)
  }

  sessionContents(profileId: string): WebContents | undefined {
    return this.windows.get(profileId)?.view.webContents
  }

  toolbarContents(profileId: string): WebContents | undefined {
    return this.windows.get(profileId)?.window.webContents
  }

  /** Finds the profile window whose toolbar sent an IPC message. */
  findByToolbar(sender: WebContents): ProfileWindow | undefined {
    for (const entry of this.windows.values()) {
      if (!entry.window.isDestroyed() && entry.window.webContents.id === sender.id) return entry
    }
    return undefined
  }

  async open(profileId: string, options: { initialUrl?: string } = {}): Promise<void> {
    const existing = this.windows.get(profileId)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      return
    }

    const { maxOpenProfiles } = this.deps.settings.get()
    if (this.windows.size >= maxOpenProfiles) {
      throw new ValidationError(
        `Only ${maxOpenProfiles} profile window(s) can be open at the same time. Close one, or raise the limit in Application Settings.`
      )
    }

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
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    lockDownAppContents(window.webContents)

    const view = new WebContentsView({
      webPreferences: {
        partition: profile.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    window.contentView.addChildView(view)

    const entry: ProfileWindow = { profile, window, view, error: null }
    this.windows.set(profileId, entry)
    this.deps.onOpenProfilesChanged(this.openIds())

    const layout = (): void => {
      if (window.isDestroyed()) return
      const [width = 0, height = 0] = window.getContentSize()
      view.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT,
        width,
        height: Math.max(0, height - TOOLBAR_HEIGHT)
      })
    }
    layout()
    window.on('resize', layout)
    window.on('maximize', layout)
    window.on('unmaximize', layout)
    window.on('enter-full-screen', layout)
    window.on('leave-full-screen', layout)
    window.once('ready-to-show', () => window.show())

    window.on('closed', () => {
      this.windows.delete(profileId)
      if (!view.webContents.isDestroyed()) view.webContents.close()
      void this.deps.sessions.flush(profile.partition)
      this.deps.onOpenProfilesChanged(this.openIds())
      this.deps.logger.info(`Closed profile window ${profileId}`)
    })

    this.attachContentHandlers(entry)
    this.attachShortcuts(entry, window.webContents)
    this.attachShortcuts(entry, view.webContents)

    try {
      await loadPage(window, 'browser')
    } catch (error) {
      this.deps.logger.error('Failed to load the browser toolbar', error)
    }

    const startUrl =
      options.initialUrl ?? profile.startUrl ?? this.deps.settings.get().homepage
    this.loadInView(entry, startUrl)
    this.deps.profiles.markOpened(profileId)
    this.deps.logger.info(`Opened profile window ${profileId}`)
  }

  close(profileId: string): void {
    const entry = this.windows.get(profileId)
    if (entry && !entry.window.isDestroyed()) entry.window.close()
  }

  closeAll(): void {
    for (const id of this.openIds()) this.close(id)
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

  navigate(entry: ProfileWindow, input: string): void {
    const url = normalizeAddressInput(input, this.deps.settings.get().searchEngine)
    if (!url) {
      entry.error = 'That address type is not allowed. Use an http:// or https:// address.'
      this.pushState(entry)
      return
    }
    this.loadInView(entry, url)
  }

  goHome(entry: ProfileWindow): void {
    this.loadInView(entry, entry.profile.startUrl ?? this.deps.settings.get().homepage)
  }

  state(entry: ProfileWindow): NavigationState {
    const contents = entry.view.webContents
    const destroyed = contents.isDestroyed()
    return {
      url: destroyed ? '' : contents.getURL(),
      title: destroyed ? '' : contents.getTitle(),
      isLoading: destroyed ? false : contents.isLoading(),
      canGoBack: destroyed ? false : contents.navigationHistory.canGoBack(),
      canGoForward: destroyed ? false : contents.navigationHistory.canGoForward(),
      error: entry.error,
      profileName: entry.profile.name,
      profileColor: entry.profile.color,
      proxyLabel: describeProxy(entry.profile.proxy)
    }
  }

  private loadInView(entry: ProfileWindow, url: string): void {
    if (!isNavigableUrl(url)) return
    entry.error = null
    entry.view.webContents.loadURL(url).catch(() => {
      /* failures are reported through did-fail-load */
    })
  }

  private pushState(entry: ProfileWindow): void {
    if (entry.window.isDestroyed()) return
    const state = this.state(entry)
    entry.window.webContents.send(Events.navigationState, state)
    const title = state.title && state.title !== state.url ? `${state.title} — ` : ''
    entry.window.setTitle(`${title}${entry.profile.name}`)
  }

  private attachContentHandlers(entry: ProfileWindow): void {
    const contents = entry.view.webContents
    const push = (): void => this.pushState(entry)

    contents.on('did-start-loading', () => {
      entry.error = null
      push()
    })
    contents.on('did-stop-loading', push)
    contents.on('did-navigate', push)
    contents.on('did-navigate-in-page', push)
    contents.on('page-title-updated', push)
    contents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3 = aborted (e.g. user stopped/navigated)
      entry.error = FRIENDLY_ERRORS[code] ?? `The page failed to load: ${description} (${code}).`
      push()
    })
    contents.on('render-process-gone', (_e, details) => {
      entry.error = `The page stopped unexpectedly (${details.reason}). Press Reload to try again.`
      this.deps.logger.warn(`Renderer gone in profile ${entry.profile.id}: ${details.reason}`)
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
    contents.setWindowOpenHandler(({ url }) => {
      if (!isNavigableUrl(url)) return { action: 'deny' }
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
      this.attachContextMenu(child.webContents)
    })
    this.attachContextMenu(contents)
  }

  private attachContextMenu(contents: WebContents): void {
    contents.on('context-menu', (_event, params) => {
      const template: MenuItemConstructorOptions[] = []
      if (params.linkURL && isNavigableUrl(params.linkURL)) {
        template.push({
          label: 'Copy link address',
          click: () => clipboard.writeText(params.linkURL)
        })
        template.push({ type: 'separator' })
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
        {
          label: 'Inspect element',
          click: () => contents.inspectElement(params.x, params.y)
        }
      )
      Menu.buildFromTemplate(template).popup()
    })
  }

  private attachShortcuts(entry: ProfileWindow, contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const page = entry.view.webContents
      const ctrl = input.control || input.meta
      const key = input.key.toLowerCase()
      if (key === 'f5' || (ctrl && key === 'r')) {
        page.reload()
      } else if (input.alt && key === 'arrowleft') {
        if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack()
      } else if (input.alt && key === 'arrowright') {
        if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward()
      } else if ((ctrl && key === 'l') || key === 'f6') {
        entry.window.webContents.focus()
        entry.window.webContents.send(Events.focusAddressBar)
      } else if (key === 'f12') {
        page.toggleDevTools()
      } else {
        return
      }
      event.preventDefault()
    })
  }
}
