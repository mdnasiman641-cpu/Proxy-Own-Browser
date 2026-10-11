import { statSync } from 'node:fs'
import { app, session, type Session } from 'electron'
import {
  ALWAYS_ALLOWED_PERMISSIONS,
  acceptLanguageFor,
  chromeUserAgent,
  effectiveUserAgent,
  type ConfigurablePermission
} from '@shared/browserConfig'
import { buildProxyRules, describeProxy } from '@shared/proxy'
import { isProfilePartition, partitionDirectoryName } from '@shared/partition'
import type { Profile } from '@shared/types'
import type { Logger } from '../services/logger'
import { removeManagedPartitionDir } from '../services/managedPaths'
import { permissionKeys, uniqueDownloadPath } from '../services/sessionPolicy'

/** Permissions web pages may use without asking. Others depend on the profile's settings. */
const ALWAYS_ALLOWED = new Set<string>(ALWAYS_ALLOWED_PERMISSIONS)

/** Asks the user (in the profile's window) whether a site may use the listed permissions. */
export type AskPermission = (profileId: string, origin: string, keys: ConfigurablePermission[]) => Promise<boolean>

/** Electron's own default User-Agent (real Electron/Chromium versions of this build). */
export function defaultUserAgent(): string {
  return app.userAgentFallback
}

/** The same real Chromium version without the Electron and app-name tokens. */
export function plainChromeUserAgent(): string {
  return chromeUserAgent(app.userAgentFallback, app.getName())
}

/**
 * The User-Agent a profile's pages use: the installed runtime's real one, the same without the
 * Electron tokens, or the user's custom string (flagged in the UI when it does not match).
 */
export function userAgentFor(profile: Pick<Profile, 'browser'>): string {
  return effectiveUserAgent(profile.browser, { defaultUserAgent: defaultUserAgent(), chromeUserAgent: plainChromeUserAgent() })
}

/** Accept-Language list from the saved settings alone (manual language or custom list), or null. */
export function acceptLanguageForProfile(profile: Pick<Profile, 'browser'>): string | null {
  if (profile.browser.acceptLanguage) return profile.browser.acceptLanguage
  return profile.browser.languageMode === 'manual' && profile.browser.language ? acceptLanguageFor(profile.browser.language) : null
}

/**
 * Owns the Electron sessions for profiles. Each profile maps to exactly one persistent
 * partition, so cookies, localStorage, IndexedDB, cache and service workers stay isolated.
 */
export class SessionManager {
  private readonly profileBySession = new WeakMap<Session, string>()
  private readonly configured = new Set<string>()
  private readonly known = new Map<string, Session>()
  /** Partitions whose session was created in this run (Chromium then keeps their files open). */
  private readonly loadedThisRun = new Set<string>()
  /** Profile settings per partition, read by the request handlers at request time. */
  private readonly configs = new Map<string, Profile>()
  /** Accept-Language decided at launch (e.g. automatic language), per partition. */
  private readonly languagePlans = new Map<string, string | null>()
  /** Answers to "ask" permissions, per partition → "origin|permission" (kept while the window is open). */
  private readonly decisions = new Map<string, Map<string, boolean>>()
  /** Set by the window manager so "ask" permissions can show a question in the right window. */
  askPermission: AskPermission | null = null

  constructor(
    private readonly userDataPath: string,
    private readonly logger: Logger
  ) {}

  sessionFor(partition: string): Session {
    if (!isProfilePartition(partition)) throw new Error('Refusing to use a non-profile partition')
    const ses = session.fromPartition(partition, { cache: true })
    this.known.set(partition, ses)
    this.loadedThisRun.add(partition)
    return ses
  }

  /**
   * Whether Chromium has opened this profile's storage in the current run. Its database files
   * then stay open until the app exits, so they must not be copied or replaced until a restart.
   */
  isLoadedThisRun(partition: string): boolean {
    return this.loadedThisRun.has(partition)
  }

  /** Returns the profile's session with security policy and proxy applied. */
  async prepare(profile: Profile): Promise<Session> {
    const ses = this.sessionFor(profile.partition)
    this.profileBySession.set(ses, profile.id)
    this.configs.set(profile.partition, profile)
    if (!this.configured.has(profile.partition)) {
      this.applySecurityPolicy(ses, profile.partition)
      this.configured.add(profile.partition)
    }
    this.applyBrowserSettings(ses, profile)
    await this.applyProxy(ses, profile)
    return ses
  }

  /** User-Agent and Accept-Language for the whole profile session (all tabs and requests). */
  private applyBrowserSettings(ses: Session, profile: Profile): void {
    const planned = this.languagePlans.get(profile.partition)
    const list = planned ?? acceptLanguageForProfile(profile) ?? acceptLanguageFor(app.getLocale())
    ses.setUserAgent(userAgentFor(profile), list)
  }

  /** The Accept-Language list a launch decided (automatic language), or null for the saved one. */
  setLanguagePlan(partition: string, acceptLanguage: string | null): void {
    this.languagePlans.set(partition, acceptLanguage)
    const ses = this.known.get(partition)
    const profile = this.configs.get(partition)
    if (ses && profile) this.applyBrowserSettings(ses, profile)
  }

  /** Applies changed browser settings to a session that is already in use. */
  refreshBrowserSettings(profile: Profile): void {
    const ses = this.known.get(profile.partition)
    this.configs.set(profile.partition, profile)
    if (ses) this.applyBrowserSettings(ses, profile)
  }

  /** Forgets "ask" answers when the profile's window closes. */
  forgetPermissionDecisions(partition: string): void {
    this.decisions.delete(partition)
  }

  /** Partition name of a session this manager created (diagnostics), or null. */
  partitionFor(ses: Session): string | null {
    for (const [partition, known] of this.known) if (known === ses) return partition
    return null
  }

  profileIdFor(ses: Session): string | undefined {
    return this.profileBySession.get(ses)
  }

  async applyProxy(ses: Session, profile: Profile): Promise<void> {
    if (profile.proxy) {
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: buildProxyRules(profile.proxy),
        proxyBypassRules: profile.proxy.bypassRules || undefined
      })
    } else {
      await ses.setProxy({ mode: 'direct' })
    }
    // Drop pooled connections so the new route is used immediately.
    await ses.closeAllConnections()
    // describeProxy never includes the username or password.
    this.logger.info(
      `Applied network route for profile ${profile.id}: ${describeProxy(profile.proxy) ?? 'direct'}`
    )
  }

  /** Re-applies the proxy if the profile's session is currently in use. */
  async refreshProxy(profile: Profile): Promise<void> {
    const ses = this.known.get(profile.partition)
    if (ses) {
      await ses.clearAuthCache()
      await this.applyProxy(ses, profile)
    }
  }

  async flush(partition: string): Promise<void> {
    const ses = this.known.get(partition)
    if (!ses) return
    try {
      await ses.cookies.flushStore()
    } catch (error) {
      this.logger.warn('Could not flush cookie store', error)
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.known.keys()].map((p) => this.flush(p)))
  }

  /**
   * Wipes the browsing data of a (deleted) profile: first through Chromium (cookies, storage,
   * cache), then by removing that profile's own partition folder. Only
   * `<userData>/Partitions/profile-<uuid>` of this profile is ever deleted (see managedPaths.ts).
   * Returns false if some data could not be removed (it is logged).
   */
  async clearData(partition: string): Promise<boolean> {
    let complete = true
    try {
      const ses = this.sessionFor(partition)
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
      await ses.cookies.flushStore()
    } catch (error) {
      complete = false
      this.logger.warn('Could not clear profile session data', error)
    }
    this.known.delete(partition)
    this.configured.delete(partition)
    this.configs.delete(partition)
    this.decisions.delete(partition)
    this.languagePlans.delete(partition)
    try {
      await removeManagedPartitionDir(this.userDataPath, partition)
    } catch (error) {
      // Chromium may still hold files open; they are already emptied above.
      complete = false
      this.logger.warn(`Partition folder will be left on disk: ${partitionDirectoryName(partition)}`, error)
    }
    return complete
  }

  /**
   * Synchronous answer: the harmless defaults, what the profile allows, and "ask" permissions the
   * user already allowed for this site while the window is open. Everything else is denied.
   */
  private isAllowed(partition: string, permission: string, origin: string, mediaTypes: readonly string[] = []): boolean {
    if (ALWAYS_ALLOWED.has(permission)) return true
    const keys = permissionKeys(permission, mediaTypes)
    const profile = this.configs.get(partition)
    if (!keys || !profile) return false
    return keys.every((key) => {
      const setting = profile.browser.permissions[key]
      if (setting === 'allow') return true
      if (setting === 'ask') return this.decisions.get(partition)?.get(`${origin}|${key}`) === true
      return false
    })
  }

  private async requestPermission(partition: string, permission: string, origin: string, mediaTypes: readonly string[]): Promise<boolean> {
    if (ALWAYS_ALLOWED.has(permission)) return true
    const keys = permissionKeys(permission, mediaTypes)
    const profile = this.configs.get(partition)
    if (!keys || !profile) return false
    const settings = keys.map((key) => profile.browser.permissions[key])
    if (settings.some((s) => s === 'block')) return false
    const pending = keys.filter((key, i) => settings[i] === 'ask' && this.decisions.get(partition)?.get(`${origin}|${key}`) === undefined)
    if (pending.length > 0) {
      let allowed = false
      try {
        allowed = this.askPermission ? await this.askPermission(profile.id, origin, pending) : false
      } catch (error) {
        this.logger.warn('Could not ask for a site permission', error)
      }
      const map = this.decisions.get(partition) ?? new Map<string, boolean>()
      for (const key of pending) map.set(`${origin}|${key}`, allowed)
      this.decisions.set(partition, map)
    }
    return this.isAllowed(partition, permission, origin, mediaTypes)
  }

  private applySecurityPolicy(ses: Session, partition: string): void {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const origin = originOf((details as { requestingUrl?: string }).requestingUrl)
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      this.requestPermission(partition, permission, origin, mediaTypes)
        .then(callback)
        .catch(() => callback(false))
    })
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      const mediaType = (details as { mediaType?: string }).mediaType
      return this.isAllowed(partition, permission, originOf(requestingOrigin), mediaType ? [mediaType] : [])
    })
    // Do Not Track: the profile's choice, sent with every request of this profile only.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const profile = this.configs.get(partition)
      if (profile?.options.doNotTrack) {
        callback({ requestHeaders: { ...details.requestHeaders, DNT: '1' } })
      } else {
        callback({})
      }
    })
    // Downloads: Chromium's save dialog, or straight into the profile's download folder.
    ses.on('will-download', (_event, item) => {
      const profile = this.configs.get(partition)
      const folder = profile?.options.downloadMode === 'folder' ? profile.options.downloadFolder : null
      if (!folder) return
      if (!isDirectory(folder)) {
        this.logger.warn(`Download folder of profile ${profile!.id} is missing; asking where to save instead`)
        return
      }
      item.setSavePath(uniqueDownloadPath(folder, item.getFilename()))
    })
  }
}

function originOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

