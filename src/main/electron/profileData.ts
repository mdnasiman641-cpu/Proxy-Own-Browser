import { existsSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ClearDataKind, ClearDataResult, CookieSummary, ProfileStorageInfo } from '@shared/types'
import { ValidationError } from '@shared/validation'
import { EXTENSIONS_DIR } from '../services/extensionStore'
import type { Logger } from '../services/logger'
import { managedPartitionDir } from '../services/managedPaths'
import type { ProfileService } from '../services/profileService'
import type { SessionManager } from './sessionManager'

/** Storage types removed for "this site's data" and "all website data" (cookies separately). */
const SITE_STORAGES = ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'] as const

/** A website origin typed by the user, e.g. https://example.com. */
export function normalizeOrigin(input: string): string {
  const value = input.trim()
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    throw new ValidationError('Enter a website address such as https://example.com')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ValidationError('Only http and https websites have site data.')
  return url.origin
}

/** Cookie domain matches a host: same host or a parent domain cookie (".example.com"). */
export function cookieMatchesHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase()
  const h = host.toLowerCase()
  return h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`)
}

async function folderSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 12 || files > 200_000) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile()) {
        try {
          bytes += (await lstat(path)).size
          files++
        } catch {
          // file vanished while measuring
        }
      }
    }
  }
  await walk(dir, 0)
  return { bytes, files }
}

/**
 * Cookies and website data of one profile. Every operation goes through that profile's own
 * session (its partition) — never another profile's — and destructive ones are only called
 * after the user confirmed them in the dashboard. Cookie values are never returned.
 */
export class ProfileDataService {
  constructor(
    private readonly deps: {
      profiles: ProfileService
      sessions: SessionManager
      userDataPath: string
      isOpen: (profileId: string) => boolean
      logger: Logger
    }
  ) {}

  async storageInfo(profileId: string): Promise<ProfileStorageInfo> {
    const profile = this.deps.profiles.get(profileId)
    const folder = managedPartitionDir(this.deps.userDataPath, profile.partition)
    const exists = existsSync(folder)
    const size = exists ? await folderSize(folder) : { bytes: 0, files: 0 }
    return {
      partition: profile.partition,
      folder,
      exists,
      bytes: exists ? size.bytes : 0,
      files: size.files,
      inUseThisRun: this.deps.sessions.isLoadedThisRun(profile.partition),
      open: this.deps.isOpen(profile.id),
      extensionsFolder: resolve(this.deps.userDataPath, EXTENSIONS_DIR, profile.id)
    }
  }

  private session(profileId: string) {
    const profile = this.deps.profiles.get(profileId)
    return { profile, ses: this.deps.sessions.sessionFor(profile.partition) }
  }

  async cookies(profileId: string): Promise<CookieSummary[]> {
    const { ses } = this.session(profileId)
    const cookies = await ses.cookies.get({})
    return cookies
      .map((c) => ({
        domain: c.domain ?? '',
        name: c.name,
        path: c.path ?? '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : null
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
      .slice(0, 5000)
  }

  async clear(profileId: string, kind: ClearDataKind, originInput: string | null): Promise<ClearDataResult> {
    const { profile, ses } = this.session(profileId)
    let removedCookies: number | null = null
    let origin: string | null = null
    let message: string
    switch (kind) {
      case 'cookies': {
        removedCookies = (await ses.cookies.get({})).length
        await ses.clearStorageData({ storages: ['cookies'] })
        message = `Removed ${removedCookies} cookies. Sites in this profile are signed out.`
        break
      }
      case 'cache': {
        await ses.clearCache()
        await ses.clearCodeCaches({})
        message = 'Cached files were removed. Logins and site data were kept.'
        break
      }
      case 'site': {
        if (!originInput) throw new ValidationError('Enter the website whose data should be removed.')
        origin = normalizeOrigin(originInput)
        const host = new URL(origin).hostname
        const matching = (await ses.cookies.get({})).filter((c) => c.domain && cookieMatchesHost(c.domain, host))
        for (const cookie of matching) {
          const scheme = cookie.secure ? 'https' : 'http'
          await ses.cookies.remove(`${scheme}://${cookie.domain!.replace(/^\./, '')}${cookie.path ?? '/'}`, cookie.name)
        }
        removedCookies = matching.length
        await ses.clearStorageData({ origin, storages: [...SITE_STORAGES] })
        message = `Removed ${matching.length} cookies and the stored data of ${origin}. Other sites were not changed.`
        break
      }
      case 'all': {
        removedCookies = (await ses.cookies.get({})).length
        await ses.clearStorageData()
        await ses.clearCache()
        message = 'All website data of this profile was removed (cookies, storage, cache). Its settings, proxy and extensions were kept.'
        break
      }
    }
    await ses.cookies.flushStore().catch(() => {})
    // Kind only — never the site, cookie names or values.
    this.deps.logger.info(`Cleared ${kind} data of profile ${profile.id}`)
    return { kind, origin, removedCookies, message }
  }
}
