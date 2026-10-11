import { app, session, type Session } from 'electron'
import {
  ALWAYS_ALLOWED_PERMISSIONS,
  CONFIGURABLE_PERMISSIONS,
  acceptLanguageFor,
  chromeUserAgent,
  type BrowserConfig,
  type ConfigurablePermission
} from '@shared/browserConfig'
import { buildProxyRules, describeProxy } from '@shared/proxy'
import { isProfilePartition, partitionDirectoryName } from '@shared/partition'
import type { Profile } from '@shared/types'
import type { Logger } from '../services/logger'
import { removeManagedPartitionDir } from '../services/managedPaths'

/** Permissions web pages may use without asking. Others depend on the profile's settings. */
const ALWAYS_ALLOWED = new Set<string>(ALWAYS_ALLOWED_PERMISSIONS)
const CONFIGURABLE = new Set<string>(CONFIGURABLE_PERMISSIONS)

/** Electron's own default User-Agent (real Electron/Chromium versions of this build). */
export function defaultUserAgent(): string {
  return app.userAgentFallback
}

/** The same real Chromium version without the Electron and app-name tokens. */
export function plainChromeUserAgent(): string {
  return chromeUserAgent(app.userAgentFallback, app.getName())
}

/** The User-Agent a profile's pages use (always the installed runtime's real version). */
export function userAgentFor(profile: Pick<Profile, 'browser'>): string {
  return profile.browser.userAgent === 'chrome' ? plainChromeUserAgent() : defaultUserAgent()
}

/** Accept-Language list for a profile with a language set, or null to keep the default. */
export function acceptLanguageForProfile(profile: Pick<Profile, 'browser'>): string | null {
  return profile.browser.language ? acceptLanguageFor(profile.browser.language) : null
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
  /** Browser settings per partition, read by the permission handlers at request time. */
  private readonly configs = new Map<string, BrowserConfig>()

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
    this.configs.set(profile.partition, profile.browser)
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
    const language = profile.browser.language ?? app.getLocale()
    ses.setUserAgent(userAgentFor(profile), acceptLanguageFor(language))
  }

  /** Applies changed browser settings to a session that is already in use. */
  refreshBrowserSettings(profile: Profile): void {
    const ses = this.known.get(profile.partition)
    this.configs.set(profile.partition, profile.browser)
    if (ses) this.applyBrowserSettings(ses, profile)
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
    try {
      await removeManagedPartitionDir(this.userDataPath, partition)
    } catch (error) {
      // Chromium may still hold files open; they are already emptied above.
      complete = false
      this.logger.warn(`Partition folder will be left on disk: ${partitionDirectoryName(partition)}`, error)
    }
    return complete
  }

  /** Allowed: the harmless defaults plus what this profile's settings allow. Everything else is denied. */
  private isAllowed(partition: string, permission: string): boolean {
    if (ALWAYS_ALLOWED.has(permission)) return true
    if (!CONFIGURABLE.has(permission)) return false
    return this.configs.get(partition)?.permissions[permission as ConfigurablePermission] === 'allow'
  }

  private applySecurityPolicy(ses: Session, partition: string): void {
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(this.isAllowed(partition, permission))
    })
    ses.setPermissionCheckHandler((_wc, permission) => this.isAllowed(partition, permission))
  }
}
