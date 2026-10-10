import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { session, type Session } from 'electron'
import { buildProxyRules, describeProxy } from '@shared/proxy'
import { isProfilePartition, partitionDirectoryName } from '@shared/partition'
import type { Profile } from '@shared/types'
import type { Logger } from '../services/logger'

/** Permissions web pages may use without asking. Everything else is denied in Phase 1. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])

/**
 * Owns the Electron sessions for profiles. Each profile maps to exactly one persistent
 * partition, so cookies, localStorage, IndexedDB, cache and service workers stay isolated.
 */
export class SessionManager {
  private readonly profileBySession = new WeakMap<Session, string>()
  private readonly configured = new Set<string>()
  private readonly known = new Map<string, Session>()

  constructor(
    private readonly userDataPath: string,
    private readonly logger: Logger
  ) {}

  sessionFor(partition: string): Session {
    if (!isProfilePartition(partition)) throw new Error('Refusing to use a non-profile partition')
    const ses = session.fromPartition(partition, { cache: true })
    this.known.set(partition, ses)
    return ses
  }

  /** Returns the profile's session with security policy and proxy applied. */
  async prepare(profile: Profile): Promise<Session> {
    const ses = this.sessionFor(profile.partition)
    this.profileBySession.set(ses, profile.id)
    if (!this.configured.has(profile.partition)) {
      this.applySecurityPolicy(ses)
      this.configured.add(profile.partition)
    }
    await this.applyProxy(ses, profile)
    return ses
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

  /** Wipes all browsing data of a (deleted) profile. Best effort — failures are logged. */
  async clearData(partition: string): Promise<void> {
    try {
      const ses = this.sessionFor(partition)
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
      await ses.cookies.flushStore()
    } catch (error) {
      this.logger.warn('Could not clear profile session data', error)
    }
    this.known.delete(partition)
    this.configured.delete(partition)
    const dir = join(this.userDataPath, 'Partitions', partitionDirectoryName(partition))
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Chromium may still hold files open; they are already empty and unreachable.
      this.logger.warn(`Partition folder will be left on disk: ${partitionDirectoryName(partition)}`)
    }
  }

  private applySecurityPolicy(ses: Session): void {
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  }
}
