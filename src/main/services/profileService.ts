import { randomUUID } from 'node:crypto'
import {
  DEFAULT_BROWSER_CONFIG,
  browserConfigProblem,
  mergeBrowserConfig,
  parseStoredBrowserConfig,
  type BrowserConfig
} from '@shared/browserConfig'
import { partitionForProfile } from '@shared/partition'
import { describeProxy, proxyEndpointKey } from '@shared/proxy'
import type {
  DuplicateRequest,
  Profile,
  ProfileInput,
  ProfileUpdate,
  ProxyConflict,
  ProxyConfig,
  ProxyInput,
  SaveProfileOptions
} from '@shared/types'
import {
  LIMITS,
  PROFILE_COLORS,
  ValidationError,
  parseOrThrow,
  profileIdSchema,
  profileInputSchema,
  profileUpdateSchema,
  proxyInputSchema,
  duplicateRequestSchema,
  searchQuerySchema,
  type ParsedProfileUpdate,
  type ParsedProxyInput
} from '@shared/validation'
import type { CatalogService } from './catalogService'
import type { ProfileRecord, ProfileRepository } from './profileRepository'
import { canReuseStoredPassword } from './proxyTest'
import { NotFoundError } from './errors'
import type { SecretCipher } from './secretCipher'

export { NotFoundError }

export interface ProxyCredentials {
  username: string
  password: string
}

/** Profile fields carried in a backup file (never the partition, password or session data). */
export interface PortableProfile {
  /** Present in v2 backups; absent in v1 backups. */
  id?: string
  name: string
  notes: string
  color: string
  startUrl: string | null
  proxy: Omit<ProxyConfig, 'hasPassword'> | null
  groupId?: string | null
  tags?: string[]
  /** Browser settings (v3 backups). */
  browser?: BrowserConfig
}

/** Options available only to main-process code (never accepted from IPC directly). */
export interface CreateOptions {
  /** Keep this id when restoring a backup, if it is free and its partition was never used. */
  preferredId?: string
  /** Copy the proxy settings, including the encrypted password, from this profile. */
  proxySourceProfileId?: string | null
  /** The user confirmed that this profile may share a proxy endpoint with another profile. */
  allowSharedProxy?: boolean
  /** Start from these browser settings (duplicates and restores) before applying input.browser. */
  baseBrowserConfig?: BrowserConfig
}

/** What a proxy test should connect through. Credentials stay in the main process. */
export interface ProxyTestTarget {
  proxy: ProxyConfig | null
  credentials: ProxyCredentials | null
}

export interface ImportSummary {
  imported: number
  renamed: string[]
  skipped: number
}

interface ProfileServiceOptions {
  now?: () => Date
  newId?: () => string
  maxProfiles?: number
  /** Groups and tags. Required for group/tag fields; tests may omit it. */
  catalog?: CatalogService
  /** Whether the "Require unique proxy assignment" setting is on. */
  requireUniqueProxy?: () => boolean
}

export class ProfileService {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly maxProfiles: number
  private readonly catalog: CatalogService | undefined
  private readonly requireUniqueProxy: () => boolean

  constructor(
    private readonly repo: ProfileRepository,
    private readonly cipher: SecretCipher,
    options: ProfileServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
    this.maxProfiles = options.maxProfiles ?? LIMITS.maxProfiles
    this.catalog = options.catalog
    this.requireUniqueProxy = options.requireUniqueProxy ?? (() => false)
  }

  list(query?: string): Profile[] {
    const q = parseOrThrow(searchQuerySchema, query)?.trim()
    const records = q ? this.repo.search(q) : this.repo.findAll()
    const tags = this.catalog?.tagsByProfile() ?? new Map<string, string[]>()
    return records.map((r) => toProfile(r, tags.get(r.id) ?? []))
  }

  exists(id: string): boolean {
    return this.repo.findById(id) !== undefined
  }

  isNameTaken(name: string): boolean {
    return this.repo.isNameTaken(name)
  }

  get maxProfileCount(): number {
    return this.maxProfiles
  }

  count(): number {
    return this.repo.count()
  }

  get(id: string): Profile {
    const record = this.getRecord(id)
    return toProfile(record, this.catalog?.tagsForProfile(record.id) ?? [])
  }

  create(input: ProfileInput, options: CreateOptions = {}): Profile {
    const data = parseOrThrow(profileInputSchema, input)
    if (this.repo.count() >= this.maxProfiles) {
      throw new ValidationError(`You can save at most ${this.maxProfiles} profiles`)
    }
    if (this.repo.isNameTaken(data.name)) {
      throw new ValidationError(`A profile named "${data.name}" already exists`)
    }
    this.assertCatalogFields(data.groupId, data.tags)
    const proxySource = options.proxySourceProfileId
      ? this.proxySourceRecord(options.proxySourceProfileId)
      : null

    const id = this.uniqueId(options.preferredId)
    const timestamp = this.now().toISOString()
    const record: ProfileRecord = {
      id,
      name: data.name,
      notes: data.notes ?? '',
      color: data.color ?? PROFILE_COLORS[this.repo.count() % PROFILE_COLORS.length]!,
      startUrl: data.startUrl ?? null,
      partition: partitionForProfile(id),
      proxyProtocol: null,
      proxyHost: null,
      proxyPort: null,
      proxyUsername: null,
      proxyPassword: null,
      proxyBypass: '',
      groupId: data.groupId ?? null,
      browserConfig: '{}',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: null
    }
    if (data.proxy) this.applyProxy(record, data.proxy)
    else if (proxySource) copyProxy(proxySource, record)
    record.browserConfig = JSON.stringify(
      this.resolveBrowserConfig(options.baseBrowserConfig ?? DEFAULT_BROWSER_CONFIG, data.browser)
    )
    this.assertProxyAllowed(record, options.allowSharedProxy)
    // Profile row and its tags are written together, or not at all.
    this.repo.transaction(() => {
      this.repo.insert(record)
      if (data.tags?.length) this.catalog!.setProfileTags(record.id, data.tags)
    })
    return this.get(record.id)
  }

  update(id: string, update: ProfileUpdate, options: SaveProfileOptions = {}): Profile {
    const record = this.getRecord(id)
    const data = parseOrThrow(profileUpdateSchema, update)
    const endpointBefore = proxyEndpointKey(toProfile(record).proxy)

    if (data.name !== undefined) {
      if (this.repo.isNameTaken(data.name, record.id)) {
        throw new ValidationError(`A profile named "${data.name}" already exists`)
      }
      record.name = data.name
    }
    if (data.notes !== undefined) record.notes = data.notes
    if (data.color !== undefined) record.color = data.color
    if (data.startUrl !== undefined) record.startUrl = data.startUrl
    if (data.proxy) this.applyProxy(record, data.proxy)
    this.assertCatalogFields(data.groupId, data.tags)
    if (data.groupId !== undefined) record.groupId = data.groupId
    if (data.browser !== undefined) {
      record.browserConfig = JSON.stringify(
        this.resolveBrowserConfig(parseStoredBrowserConfig(record.browserConfig), data.browser)
      )
    }
    // Only a change of endpoint is checked, so editing other fields never fails because of an
    // overlap the user already accepted.
    if (proxyEndpointKey(toProfile(record).proxy) !== endpointBefore) {
      this.assertProxyAllowed(record, options.allowSharedProxy)
    }

    record.updatedAt = this.now().toISOString()
    this.repo.transaction(() => {
      this.repo.update(record)
      if (data.tags !== undefined) this.catalog!.setProfileTags(record.id, data.tags)
    })
    return this.get(record.id)
  }

  /** Adds/removes tags on a profile without touching its other fields. */
  changeTags(id: string, add: string[], remove: string[]): Profile {
    const record = this.getRecord(id)
    if (!this.catalog) throw new Error('Tags are not available')
    this.repo.transaction(() => {
      this.catalog!.changeProfileTags(record.id, add, remove)
      record.updatedAt = this.now().toISOString()
      this.repo.update(record)
    })
    return this.get(record.id)
  }

  /** Copies another profile's proxy settings (including the encrypted password) onto this one. */
  copyProxyFrom(id: string, sourceId: string, options: SaveProfileOptions = {}): Profile {
    const record = this.getRecord(id)
    copyProxy(this.proxySourceRecord(sourceId), record)
    this.assertProxyAllowed(record, options.allowSharedProxy)
    record.updatedAt = this.now().toISOString()
    this.repo.update(record)
    return this.get(record.id)
  }

  /**
   * Creates a copy of a profile's settings with a new id and its own new, empty session
   * partition. Browser data is never shared; copying it is a separate, explicit step.
   */
  duplicate(sourceId: string, request: DuplicateRequest, options: SaveProfileOptions = {}): Profile {
    const source = this.getRecord(sourceId)
    const data = parseOrThrow(duplicateRequestSchema, request)
    const profile = toProfile(source, this.catalog?.tagsForProfile(source.id) ?? [])
    return this.create(
      {
        name: data.name,
        notes: profile.notes,
        color: profile.color,
        startUrl: profile.startUrl,
        groupId: profile.groupId,
        tags: profile.tags
      },
      {
        proxySourceProfileId: data.copyProxy && profile.proxy ? source.id : null,
        baseBrowserConfig: profile.browser,
        allowSharedProxy: options.allowSharedProxy
      }
    )
  }

  /** Profiles (other than `excludeId`) whose proxy endpoint equals `proxy`'s. */
  findProxyConflicts(
    proxy: Pick<ProxyConfig, 'host' | 'port' | 'username'> | null,
    excludeId?: string | null
  ): ProxyConflict[] {
    if (!proxy) return []
    const key = proxyEndpointKey(proxy)
    return this.repo
      .findAll()
      .filter((r) => r.id !== excludeId)
      .filter((r) => {
        const p = toProfile(r).proxy
        return p !== null && proxyEndpointKey(p) === key
      })
      .map((r) => ({ id: r.id, name: r.name }))
  }

  /** Stores browser settings coming from a backup (already validated by the backup parser). */
  replaceBrowserConfig(id: string, config: BrowserConfig): Profile {
    const record = this.getRecord(id)
    record.browserConfig = JSON.stringify(parseStoredBrowserConfig(config))
    record.updatedAt = this.now().toISOString()
    this.repo.update(record)
    return this.get(id)
  }

  /** Deletes a profile and returns it so the caller can clean up its session data. */
  delete(id: string): Profile {
    const profile = this.get(id)
    this.repo.delete(profile.id)
    return profile
  }

  markOpened(id: string): void {
    this.repo.setLastOpened(parseOrThrow(profileIdSchema, id), this.now().toISOString())
  }

  /**
   * Decrypted proxy credentials, for answering a proxy auth challenge in the main process only.
   * Never send the result over IPC or write it to a log.
   */
  getProxyCredentials(id: string): ProxyCredentials | null {
    const record = this.repo.findById(id)
    if (!record?.proxyUsername) return null
    let password = ''
    if (record.proxyPassword) password = this.cipher.decrypt(record.proxyPassword)
    return { username: record.proxyUsername, password }
  }

  /**
   * Resolves the proxy (and credentials) for a connection test.
   * - No draft: the profile's saved proxy.
   * - Draft (unsaved form values): those values. A saved password is reused only when the
   *   draft points at the same proxy server and username; otherwise only a typed password is used.
   */
  resolveProxyTestTarget(profileId: string | null, draft?: ProxyInput): ProxyTestTarget {
    const saved = profileId ? this.get(profileId) : null
    if (!draft) {
      if (!saved) throw new ValidationError('Choose a profile to test')
      return { proxy: saved.proxy, credentials: this.getProxyCredentials(saved.id) }
    }

    const data = parseOrThrow(proxyInputSchema, draft)
    if (!data.enabled) return { proxy: null, credentials: null }

    const isSocks = data.protocol === 'socks4' || data.protocol === 'socks5'
    const username = isSocks ? '' : (data.username?.trim() ?? '')
    let password = ''
    if (username) {
      if (data.password) password = data.password
      else if (data.password === undefined && saved && canReuseStoredPassword(saved.proxy, data)) {
        password = this.getProxyCredentials(saved.id)?.password ?? ''
      }
    }
    return {
      proxy: {
        protocol: data.protocol!,
        host: data.host!,
        port: data.port!,
        username: username || null,
        hasPassword: Boolean(password),
        bypassRules: data.bypassRules ?? ''
      },
      credentials: username ? { username, password } : null
    }
  }

  toPortable(profile: Profile): PortableProfile {
    return {
      id: profile.id,
      groupId: profile.groupId,
      tags: profile.tags,
      browser: profile.browser,
      name: profile.name,
      notes: profile.notes,
      color: profile.color,
      startUrl: profile.startUrl,
      proxy: profile.proxy
        ? {
            protocol: profile.proxy.protocol,
            host: profile.proxy.host,
            port: profile.proxy.port,
            username: profile.proxy.username,
            bypassRules: profile.proxy.bypassRules
          }
        : null
    }
  }

  /** Recreates profiles from a backup. Each gets a fresh id and session partition. */
  importProfiles(entries: PortableProfile[]): ImportSummary {
    const summary: ImportSummary = { imported: 0, renamed: [], skipped: 0 }
    for (const entry of entries) {
      try {
        const name = this.availableName(entry.name)
        if (name !== entry.name) summary.renamed.push(`${entry.name} → ${name}`)
        this.create({
          name,
          notes: entry.notes,
          color: entry.color,
          startUrl: entry.startUrl,
          proxy: entry.proxy
            ? {
                enabled: true,
                protocol: entry.proxy.protocol,
                host: entry.proxy.host,
                port: entry.proxy.port,
                username: entry.proxy.username ?? '',
                bypassRules: entry.proxy.bypassRules
              }
            : undefined
        })
        summary.imported++
      } catch {
        summary.skipped++
      }
    }
    return summary
  }

  private availableName(name: string): string {
    if (!this.repo.isNameTaken(name)) return name
    for (let n = 2; n < 1000; n++) {
      const suffix = ` (${n})`
      const candidate = `${name.slice(0, LIMITS.nameMax - suffix.length)}${suffix}`
      if (!this.repo.isNameTaken(candidate)) return candidate
    }
    throw new ValidationError('Could not find a free profile name')
  }

  private resolveBrowserConfig(base: BrowserConfig, update: ParsedProfileUpdate['browser']): BrowserConfig {
    const next = update ? mergeBrowserConfig(base, update) : base
    const problem = browserConfigProblem(next)
    if (problem) throw new ValidationError(problem)
    return next
  }

  private assertProxyAllowed(record: ProfileRecord, allowShared: boolean | undefined): void {
    if (allowShared || !this.requireUniqueProxy()) return
    const proxy = toProfile(record).proxy
    const conflicts = this.findProxyConflicts(proxy, record.id)
    if (conflicts.length === 0) return
    const names = conflicts.slice(0, 3).map((c) => `"${c.name}"`).join(', ')
    const more = conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : ''
    throw new ValidationError(
      `${describeProxy(proxy)} is already assigned to ${names}${more}. ` +
        'Unique proxy assignment is on — choose another proxy or confirm that these profiles may share it.'
    )
  }

  private getRecord(id: string): ProfileRecord {
    const record = this.repo.findById(parseOrThrow(profileIdSchema, id))
    if (!record) throw new NotFoundError()
    return record
  }

  private assertCatalogFields(groupId: string | null | undefined, tags: string[] | undefined): void {
    if ((groupId || tags?.length) && !this.catalog) throw new Error('Groups and tags are not available')
    this.catalog?.assertGroupReference(groupId)
  }

  private proxySourceRecord(sourceId: string): ProfileRecord {
    const source = this.repo.findById(parseOrThrow(profileIdSchema, sourceId))
    if (!source) throw new ValidationError('The profile chosen for proxy settings no longer exists')
    if (!source.proxyProtocol) throw new ValidationError(`"${source.name}" has no proxy to copy`)
    return source
  }

  private uniqueId(preferred?: string): string {
    if (
      preferred &&
      profileIdSchema.safeParse(preferred).success &&
      !this.repo.findById(preferred) &&
      !this.repo.isPartitionUsed(partitionForProfile(preferred))
    ) {
      return preferred
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = this.newId()
      if (!this.repo.findById(id) && !this.repo.isPartitionUsed(partitionForProfile(id))) {
        return id
      }
    }
    throw new Error('Could not allocate a unique session partition')
  }

  private applyProxy(record: ProfileRecord, proxy: ParsedProxyInput): void {
    if (!proxy.enabled) {
      record.proxyProtocol = null
      record.proxyHost = null
      record.proxyPort = null
      record.proxyUsername = null
      record.proxyPassword = null
      record.proxyBypass = ''
      return
    }
    const username = proxy.username?.trim() || null
    const isSocks = proxy.protocol === 'socks4' || proxy.protocol === 'socks5'

    record.proxyProtocol = proxy.protocol!
    record.proxyHost = proxy.host!
    record.proxyPort = proxy.port!
    record.proxyBypass = proxy.bypassRules ?? ''

    if (!username) {
      record.proxyUsername = null
      record.proxyPassword = null
    } else {
      if (isSocks) {
        throw new ValidationError(
          'Chromium does not support username/password authentication for SOCKS proxies'
        )
      }
      record.proxyUsername = username
      if (proxy.password !== undefined) {
        record.proxyPassword = proxy.password === '' ? null : this.cipher.encrypt(proxy.password)
      }
    }
  }
}

/** Copies proxy fields between records. The password stays encrypted; it is never decrypted here. */
function copyProxy(from: ProfileRecord, to: ProfileRecord): void {
  to.proxyProtocol = from.proxyProtocol
  to.proxyHost = from.proxyHost
  to.proxyPort = from.proxyPort
  to.proxyUsername = from.proxyUsername
  to.proxyPassword = from.proxyPassword
  to.proxyBypass = from.proxyBypass
}

export function toProfile(record: ProfileRecord, tags: string[] = []): Profile {
  const proxy: ProxyConfig | null =
    record.proxyProtocol && record.proxyHost && record.proxyPort
      ? {
          protocol: record.proxyProtocol,
          host: record.proxyHost,
          port: record.proxyPort,
          username: record.proxyUsername,
          hasPassword: Boolean(record.proxyPassword),
          bypassRules: record.proxyBypass
        }
      : null
  return {
    id: record.id,
    name: record.name,
    notes: record.notes,
    color: record.color,
    startUrl: record.startUrl,
    partition: record.partition,
    proxy,
    groupId: record.groupId,
    tags,
    browser: parseStoredBrowserConfig(record.browserConfig),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: record.lastOpenedAt
  }
}
