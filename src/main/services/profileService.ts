import { randomUUID } from 'node:crypto'
import { partitionForProfile } from '@shared/partition'
import type { Profile, ProfileInput, ProfileUpdate, ProxyConfig } from '@shared/types'
import {
  LIMITS,
  PROFILE_COLORS,
  ValidationError,
  parseOrThrow,
  profileIdSchema,
  profileInputSchema,
  profileUpdateSchema,
  searchQuerySchema,
  type ParsedProxyInput
} from '@shared/validation'
import type { ProfileRecord, ProfileRepository } from './profileRepository'
import type { SecretCipher } from './secretCipher'

export class NotFoundError extends Error {
  constructor(message = 'Profile not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export interface ProxyCredentials {
  username: string
  password: string
}

/** Profile fields carried in a backup file (no id, partition or password). */
export interface PortableProfile {
  name: string
  notes: string
  color: string
  startUrl: string | null
  proxy: Omit<ProxyConfig, 'hasPassword'> | null
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
}

export class ProfileService {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly maxProfiles: number

  constructor(
    private readonly repo: ProfileRepository,
    private readonly cipher: SecretCipher,
    options: ProfileServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
    this.maxProfiles = options.maxProfiles ?? LIMITS.maxProfiles
  }

  list(query?: string): Profile[] {
    const q = parseOrThrow(searchQuerySchema, query)?.trim()
    const records = q ? this.repo.search(q) : this.repo.findAll()
    return records.map(toProfile)
  }

  count(): number {
    return this.repo.count()
  }

  get(id: string): Profile {
    return toProfile(this.getRecord(id))
  }

  create(input: ProfileInput): Profile {
    const data = parseOrThrow(profileInputSchema, input)
    if (this.repo.count() >= this.maxProfiles) {
      throw new ValidationError(`You can save at most ${this.maxProfiles} profiles`)
    }
    if (this.repo.isNameTaken(data.name)) {
      throw new ValidationError(`A profile named "${data.name}" already exists`)
    }

    const id = this.uniqueId()
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
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: null
    }
    if (data.proxy) this.applyProxy(record, data.proxy)
    this.repo.insert(record)
    return toProfile(record)
  }

  update(id: string, update: ProfileUpdate): Profile {
    const record = this.getRecord(id)
    const data = parseOrThrow(profileUpdateSchema, update)

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

    record.updatedAt = this.now().toISOString()
    this.repo.update(record)
    return toProfile(record)
  }

  /** Deletes a profile and returns it so the caller can clean up its session data. */
  delete(id: string): Profile {
    const record = this.getRecord(id)
    this.repo.delete(record.id)
    return toProfile(record)
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

  toPortable(profile: Profile): PortableProfile {
    return {
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

  private getRecord(id: string): ProfileRecord {
    const record = this.repo.findById(parseOrThrow(profileIdSchema, id))
    if (!record) throw new NotFoundError()
    return record
  }

  private uniqueId(): string {
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

export function toProfile(record: ProfileRecord): Profile {
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
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: record.lastOpenedAt
  }
}
