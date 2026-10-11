import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { BrowserConfig } from '@shared/browserConfig'
import { describeProxy } from '@shared/proxy'
import type {
  BackupFileInfo,
  BackupHistoryEntry,
  BackupKind,
  BackupVerifyResult,
  DuplicateRequest,
  DuplicateResult,
  FullBackupOutcome,
  PendingJob,
  Profile,
  RestoreOutcome,
  RestoreRequest,
  SaveProfileOptions
} from '@shared/types'
import { ValidationError } from '@shared/validation'
import { BACKUP_FORMAT, MAX_BACKUP_BYTES, parseBackup, parsePortableProfile, type BackupFile } from './backupService'
import type { CatalogService } from './catalogService'
import type { AppDatabase } from './database'
import {
  ARCHIVE_EXTENSION,
  BackupError,
  checkExtracted,
  collectFiles,
  deriveNewKey,
  keyForArchive,
  readArchive,
  readArchiveHeader,
  resolveInside,
  writeArchive,
  type DerivedKey
} from './fullBackupArchive'
import type { Logger } from './logger'
import { managedPartitionDir, workDir, workPath } from './managedPaths'
import type { MetadataBackupService } from './metadataBackup'
import type { PortableProfile, ProfileService } from './profileService'
import type { SecretCipher } from './secretCipher'
import type { SettingsService } from './settingsService'

export interface BackupCenterDeps {
  userDataPath: string
  db: AppDatabase
  profiles: ProfileService
  catalog: CatalogService
  metadata: MetadataBackupService
  settings: SettingsService
  /** Protects a scheduled backup's key until the job runs (Windows DPAPI in the app). */
  cipher: SecretCipher
  /** Whether Chromium has opened the partition's files in this run (then they are in use). */
  isLoadedThisRun: (partition: string) => boolean
  isOpen: (profileId: string) => boolean
  appVersion: string
  logger: Logger
  now?: () => Date
}

/** Profile settings stored inside a full backup. */
type FullBackupMeta = PortableProfile & { groupName?: string | null }

type JobKind = PendingJob['kind']

interface JobRow {
  id: string
  kind: JobKind
  profile_id: string
  payload: string
  status: string
  created_at: string
}

interface SwapJournal {
  live: string
  staged: string
  previous: string
}

const META_EXTENSION = '.json'

/** Characters Windows does not allow in file names, plus control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-').replace('T', '_')
}

function slug(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME, ' ').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  return cleaned || 'profile'
}

function toUserError(error: unknown): Error {
  if (error instanceof BackupError) return new ValidationError(error.message)
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Local backups and restores. Everything stays on this PC: backups are written only to the
 * folder the user picked, nothing is uploaded.
 *
 * Full browser-data backups/restores never touch files Chromium has open: a profile whose
 * session was used since the app started is handled at the next start, before any profile
 * session is loaded.
 */
export class BackupCenter {
  constructor(private readonly deps: BackupCenterDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  // ------------------------------------------------------------------ folder and file names

  backupFolder(): string {
    const folder = this.deps.settings.get().backupFolder
    if (!folder) throw new ValidationError('Choose a backup folder first (Backup & Restore → Backup folder).')
    if (!isAbsolute(folder)) throw new ValidationError('The backup folder must be a full path.')
    return folder
  }

  /** Descriptive file name: app, backup type, profile name and id, date and time. */
  fileName(kind: BackupKind, profiles: Pick<Profile, 'id' | 'name'>[], scope: 'profile' | 'selected' | 'all'): string {
    const when = stamp(this.now())
    const ext = kind === 'full' ? ARCHIVE_EXTENSION : META_EXTENSION
    if (scope === 'all') return `POB_${kind}_all-profiles_${when}${ext}`
    if (profiles.length === 1) {
      const p = profiles[0]!
      return `POB_${kind}_${slug(p.name)}_${p.id.slice(0, 8)}_${when}${ext}`
    }
    return `POB_${kind}_${profiles.length}-profiles_${when}${ext}`
  }

  private async uniqueTarget(folder: string, name: string): Promise<string> {
    await mkdir(folder, { recursive: true })
    let candidate = join(folder, name)
    const ext = extname(name)
    for (let n = 2; existsSync(candidate) || existsSync(`${candidate}.partial`); n++) {
      candidate = join(folder, `${name.slice(0, -ext.length)}_${n}${ext}`)
    }
    return candidate
  }

  // ------------------------------------------------------------------ metadata backups

  /** Writes a metadata backup (no passwords, no browser data) to the backup folder. */
  async backupMetadata(profileIds: string[] | 'all'): Promise<BackupHistoryEntry> {
    const folder = this.backupFolder()
    const all = profileIds === 'all'
    const ids = all ? undefined : profileIds
    const profiles = all ? this.deps.profiles.list() : ids!.map((id) => this.deps.profiles.get(id))
    if (profiles.length === 0) throw new ValidationError('There are no profiles to back up.')
    const backup: BackupFile = this.deps.metadata.buildBackup(this.deps.appVersion, ids)
    const scope = all ? 'all' : profiles.length === 1 ? 'profile' : 'selected'
    const target = await this.uniqueTarget(folder, this.fileName('metadata', profiles, scope))
    const text = JSON.stringify(backup, null, 2)
    await writeFile(`${target}.partial`, text, { encoding: 'utf8', flag: 'wx' })
    await rename(`${target}.partial`, target)
    const sha256 = createHash('sha256').update(text).digest('hex')
    const entry = this.addHistory({
      profileId: profiles.length === 1 ? profiles[0]!.id : null,
      profileName: profiles.length === 1 ? profiles[0]!.name : `${profiles.length} profiles`,
      kind: 'metadata',
      status: 'success',
      fileName: basename(target),
      path: target,
      sizeBytes: Buffer.byteLength(text),
      sha256,
      details: `${profiles.length} profile(s); proxy passwords and browser data are not included.`
    })
    this.deps.logger.info(`Metadata backup written (${profiles.length} profiles)`)
    return entry
  }

  // ------------------------------------------------------------------ full backups

  /**
   * Full browser-data backup of each profile, encrypted with the password. Profiles whose
   * files are in use are scheduled for the next app start instead of being copied while
   * Chromium may write to them.
   */
  async backupFull(
    profileIds: string[],
    password: string,
    onProgress?: (profileId: string, done: number, total: number) => void
  ): Promise<FullBackupOutcome[]> {
    const folder = this.backupFolder()
    const key = await deriveNewKey(password)
    const outcomes: FullBackupOutcome[] = []
    for (const id of profileIds) {
      const profile = this.deps.profiles.get(id)
      try {
        if (this.inUse(profile)) {
          outcomes.push(this.scheduleFullBackup(profile, folder, key))
        } else {
          outcomes.push(await this.writeFullBackup(profile, folder, key, (d, t) => onProgress?.(id, d, t)))
        }
      } catch (error) {
        const message = toUserError(error).message
        this.addHistory({
          profileId: id,
          profileName: profile.name,
          kind: 'full',
          status: 'failed',
          fileName: null,
          path: null,
          sizeBytes: null,
          sha256: null,
          details: message
        })
        if (!(error instanceof ValidationError || error instanceof BackupError)) {
          this.deps.logger.error(`Full backup of profile ${id} failed`, error)
        }
        outcomes.push({ profileId: id, name: profile.name, status: 'failed', fileName: null, sizeBytes: null, message, included: [], excluded: [] })
      }
    }
    return outcomes
  }

  private inUse(profile: Profile): boolean {
    return this.deps.isOpen(profile.id) || this.deps.isLoadedThisRun(profile.partition)
  }

  private scheduleFullBackup(profile: Profile, folder: string, key: DerivedKey): FullBackupOutcome {
    if (!this.deps.cipher.isSecure) {
      throw new ValidationError(
        'This profile was used since the app started, so its files are in use. Windows data protection is not available to keep the backup password safe until the next start — restart the app and back up this profile before opening it.'
      )
    }
    this.addJob('full-backup', profile.id, {
      folder,
      key: this.deps.cipher.encrypt(key.key.toString('base64')),
      salt: key.salt.toString('base64'),
      params: key.params
    })
    const message =
      'This profile was used since the app started, so Chromium still has its files open. The backup will be made automatically the next time the app starts, before the profile is opened.'
    this.addHistory({
      profileId: profile.id,
      profileName: profile.name,
      kind: 'full',
      status: 'scheduled',
      fileName: null,
      path: null,
      sizeBytes: null,
      sha256: null,
      details: message
    })
    return { profileId: profile.id, name: profile.name, status: 'scheduled', fileName: null, sizeBytes: null, message, included: [], excluded: [] }
  }

  private async writeFullBackup(
    profile: Profile,
    folder: string,
    key: DerivedKey,
    onProgress?: (done: number, total: number) => void
  ): Promise<FullBackupOutcome> {
    const source = managedPartitionDir(this.deps.userDataPath, profile.partition)
    if (!existsSync(source)) {
      throw new ValidationError('This profile has no browser data yet (it has never been opened), so there is nothing to back up.')
    }
    const collected = await collectFiles(source)
    const meta: FullBackupMeta = {
      ...this.deps.profiles.toPortable(profile),
      groupName: profile.groupId ? this.deps.catalog.getGroup(profile.groupId).name : null
    }
    const destination = await this.uniqueTarget(folder, this.fileName('full', [profile], 'profile'))
    const written = await writeArchive({
      destination,
      collected,
      key,
      profile: { id: profile.id, name: profile.name },
      meta,
      appVersion: this.deps.appVersion,
      now: () => this.now(),
      onProgress
    })
    // Read it back completely before reporting success.
    await readArchive({ path: written.path, key: key.key })
    const included = [
      `${written.fileCount} files, ${written.dataBytes} bytes of browser data (cookies, site storage, IndexedDB and settings)`
    ]
    const message = `Backed up and verified (${written.fileCount} files).`
    this.addHistory({
      profileId: profile.id,
      profileName: profile.name,
      kind: 'full',
      status: 'success',
      fileName: basename(written.path),
      path: written.path,
      sizeBytes: written.sizeBytes,
      sha256: written.sha256,
      details: [message, ...collected.excluded.map((e) => `Not included: ${e}`)].join('\n')
    })
    this.deps.logger.info(`Full backup of profile ${profile.id} written (${written.fileCount} files)`)
    return {
      profileId: profile.id,
      name: profile.name,
      status: 'success',
      fileName: basename(written.path),
      sizeBytes: written.sizeBytes,
      message,
      included,
      excluded: collected.excluded
    }
  }

  // ------------------------------------------------------------------ browsing and verifying

  /** Backups in the backup folder (headers only; nothing is decrypted). */
  async listBackups(): Promise<BackupFileInfo[]> {
    const folder = this.deps.settings.get().backupFolder
    if (!folder || !existsSync(folder)) return []
    const names = (await readdir(folder)).filter((n) => n.endsWith(META_EXTENSION) || n.endsWith(ARCHIVE_EXTENSION))
    const infos: BackupFileInfo[] = []
    for (const name of names.slice(0, 1000)) {
      const info = await this.describeFile(join(folder, name)).catch(() => null)
      if (info) infos.push(info)
    }
    return infos.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  }

  /** Reads what can be read without a password. Files that are not backups return null. */
  async describeFile(path: string): Promise<BackupFileInfo | null> {
    const info = await lstat(path)
    if (!info.isFile()) return null
    const base = { fileName: basename(path), path, sizeBytes: info.size }
    if (path.endsWith(ARCHIVE_EXTENSION)) {
      try {
        const { header } = await readArchiveHeader(path)
        return {
          ...base,
          kind: 'full',
          createdAt: header.createdAt,
          appVersion: header.appVersion,
          profiles: [{ id: header.profile.id, name: header.profile.name }],
          readable: true,
          problem: null,
          encrypted: true
        }
      } catch (error) {
        if (error instanceof BackupError && error.code === 'not-a-backup') return null
        return { ...base, kind: 'full', createdAt: null, appVersion: null, profiles: [], readable: false, problem: toUserError(error).message, encrypted: true }
      }
    }
    if (info.size > MAX_BACKUP_BYTES) return null
    const text = await readFile(path, 'utf8')
    let head: { format?: unknown } | null = null
    try {
      head = JSON.parse(text) as { format?: unknown }
    } catch {
      return null
    }
    if (head?.format !== BACKUP_FORMAT) return null
    try {
      const parsed = parseBackup(text)
      return {
        ...base,
        kind: 'metadata',
        createdAt: parsed.exportedAt ?? null,
        appVersion: parsed.appVersion ?? null,
        profiles: parsed.profiles.map((p) => ({ id: p.id ?? null, name: p.name })),
        readable: true,
        problem: null,
        encrypted: false
      }
    } catch (error) {
      return { ...base, kind: 'metadata', createdAt: null, appVersion: null, profiles: [], readable: false, problem: toUserError(error).message, encrypted: false }
    }
  }

  /** Checks a backup completely (full backups: decrypts and checks every file). */
  async verify(path: string, password?: string): Promise<BackupVerifyResult> {
    try {
      if (path.endsWith(ARCHIVE_EXTENSION)) {
        if (!password) throw new ValidationError('Enter the backup password to verify this backup.')
        const { header } = await readArchiveHeader(path)
        const key = await keyForArchive(header, password)
        const result = await readArchive({ path, key })
        return {
          ok: true,
          message: `Verified: ${result.manifest.files.length} files, all checksums match.`,
          files: result.manifest.files.length,
          bytes: result.bytes
        }
      }
      const parsed = parseBackup(await readFile(path, 'utf8'))
      return { ok: true, message: `Verified: ${parsed.profiles.length} profile(s), integrity check passed.`, files: 1, bytes: 0 }
    } catch (error) {
      const message = toUserError(error).message
      return { ok: false, message, files: 0, bytes: 0 }
    }
  }

  // ------------------------------------------------------------------ restore

  async restore(request: RestoreRequest): Promise<RestoreOutcome> {
    try {
      if (request.path.endsWith(ARCHIVE_EXTENSION)) return await this.restoreFull(request)
      return await this.restoreMetadata(request)
    } catch (error) {
      throw toUserError(error)
    }
  }

  private async restoreMetadata(request: RestoreRequest): Promise<RestoreOutcome> {
    const parsed = parseBackup(await readFile(request.path, 'utf8'))
    const wanted = request.profileIds ? new Set(request.profileIds) : null
    const entries = parsed.profiles.filter((p) => !wanted || (p.id && wanted.has(p.id)))
    if (entries.length === 0) throw new ValidationError('No profiles were selected from this backup.')
    const groupNames = new Map(parsed.groups.map((g) => [g.id, g.name]))
    const details: string[] = []
    const ids: string[] = []

    for (const entry of entries) {
      const meta: FullBackupMeta = { ...entry, groupName: entry.groupId ? (groupNames.get(entry.groupId) ?? null) : null }
      try {
        if (request.target === 'original') {
          if (!entry.id || !this.deps.profiles.exists(entry.id)) {
            details.push(`"${entry.name}": no longer exists here — use "Restore as a new profile".`)
            continue
          }
          const own: string[] = []
          this.applyToExisting(entry.id, meta, own)
          ids.push(entry.id)
          details.push(`"${entry.name}": settings restored (name, proxy and browser data unchanged).`, ...own.slice(1))
        } else {
          const profile = this.createFromMeta(meta, request.newName && entries.length === 1 ? request.newName : undefined, details)
          ids.push(profile.id)
        }
      } catch (error) {
        details.push(`"${entry.name}": ${toUserError(error).message}`)
      }
    }
    const status = ids.length > 0 ? 'success' : 'failed'
    this.addHistory({
      profileId: ids.length === 1 ? ids[0]! : null,
      profileName: entries.length === 1 ? entries[0]!.name : `${entries.length} profiles`,
      kind: 'restore',
      status: ids.length === entries.length ? 'success' : ids.length ? 'partial' : 'failed',
      fileName: basename(request.path),
      path: request.path,
      sizeBytes: null,
      sha256: null,
      details: details.join('\n')
    })
    return {
      status,
      message: `${ids.length} of ${entries.length} profile(s) restored from the metadata backup.`,
      profileIds: ids,
      details
    }
  }

  private async restoreFull(request: RestoreRequest): Promise<RestoreOutcome> {
    if (!request.password) throw new ValidationError('Enter the backup password.')
    const { header } = await readArchiveHeader(request.path)
    const key = await keyForArchive(header, request.password)

    if (request.target === 'original') {
      const id = header.profile.id
      if (!this.deps.profiles.exists(id)) {
        throw new ValidationError(
          `The profile this backup belongs to ("${header.profile.name}") no longer exists. Use "Restore as a new profile".`
        )
      }
      const profile = this.deps.profiles.get(id)
      if (this.deps.isOpen(id)) throw new ValidationError(`Close "${profile.name}" before restoring its browser data.`)
      // Extract and verify everything first; the live data is untouched until this succeeds.
      const staged = workPath(this.deps.userDataPath, 'staging', `restore-${randomUUID()}`)
      await mkdir(dirname(staged), { recursive: true })
      const result = await readArchive<unknown>({ path: request.path, key, extractTo: staged })
      const meta = parsePortableProfile(result.manifest.profile)

      if (this.deps.isLoadedThisRun(profile.partition)) {
        this.addJob('full-restore', id, { staged, meta, files: result.manifest.files, file: basename(request.path) })
        const message =
          'The backup was verified and prepared. Chromium still has this profile’s files open, so the restore will be completed automatically the next time the app starts.'
        this.addHistory({ profileId: id, profileName: profile.name, kind: 'restore', status: 'scheduled', fileName: basename(request.path), path: request.path, sizeBytes: null, sha256: null, details: message })
        return { status: 'scheduled', message, profileIds: [id], details: [] }
      }
      const details = await this.swapIn(profile, staged, result.manifest.files)
      this.applyToExisting(id, meta, details)
      this.addHistory({ profileId: id, profileName: profile.name, kind: 'restore', status: 'success', fileName: basename(request.path), path: request.path, sizeBytes: null, sha256: null, details: details.join('\n') })
      return { status: 'success', message: `Browser data and settings of "${profile.name}" restored and verified.`, profileIds: [id], details }
    }

    // Restore as a new profile: new id, new partition, nothing existing is touched.
    const staged = workPath(this.deps.userDataPath, 'staging', `restore-${randomUUID()}`)
    await mkdir(dirname(staged), { recursive: true })
    const result = await readArchive<unknown>({ path: request.path, key, extractTo: staged })
    let created: Profile | null = null
    try {
      const meta = parsePortableProfile(result.manifest.profile)
      const details: string[] = []
      created = this.createFromMeta(meta, request.newName, details)
      const live = managedPartitionDir(this.deps.userDataPath, created.partition)
      if (existsSync(live)) throw new ValidationError('The new profile’s data folder already exists; nothing was restored.')
      await mkdir(dirname(live), { recursive: true })
      await rename(staged, live)
      const problem = await checkExtracted(live, result.manifest.files)
      if (problem) throw new ValidationError(`The restored data could not be validated (${problem}).`)
      details.unshift(`${result.manifest.files.length} files restored and verified into a new profile with its own new session.`)
      this.addHistory({ profileId: created.id, profileName: created.name, kind: 'restore', status: 'success', fileName: basename(request.path), path: request.path, sizeBytes: null, sha256: null, details: details.join('\n') })
      return { status: 'success', message: `Restored as new profile "${created.name}".`, profileIds: [created.id], details }
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => {})
      if (created) {
        this.deps.profiles.delete(created.id)
        await rm(managedPartitionDir(this.deps.userDataPath, created.partition), { recursive: true, force: true }).catch(() => {})
      }
      throw error
    }
  }

  /** Creates a new profile from backed-up settings. Proxy passwords are never in backups. */
  private createFromMeta(meta: FullBackupMeta, newName: string | undefined, details: string[]): Profile {
    const name = this.availableName(newName?.trim() || meta.name)
    if (name !== (newName?.trim() || meta.name)) details.push(`Renamed to "${name}" because the name is taken.`)
    let groupId: string | null = null
    if (meta.groupName) {
      groupId = (this.deps.catalog.findGroupByName(meta.groupName) ?? this.deps.catalog.createGroup({ name: meta.groupName })).id
    }
    let proxy = meta.proxy
    if (proxy && this.deps.settings.get().requireUniqueProxy) {
      const conflicts = this.deps.profiles.findProxyConflicts(proxy)
      if (conflicts.length) {
        details.push(
          `Proxy ${describeProxy({ ...proxy, hasPassword: false })} was not restored because unique proxy assignment is on and "${conflicts[0]!.name}" uses it.`
        )
        proxy = null
      }
    }
    if (proxy?.username) details.push('Re-enter the proxy password (passwords are never stored in backups).')
    return this.deps.profiles.create(
      {
        name,
        notes: meta.notes,
        color: meta.color,
        startUrl: meta.startUrl,
        groupId,
        tags: meta.tags ?? [],
        proxy: proxy
          ? { enabled: true, protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username ?? '', bypassRules: proxy.bypassRules }
          : undefined
      },
      { baseBrowserConfig: meta.browser, allowSharedProxy: true }
    )
  }

  /**
   * Restores settings onto an existing profile with the same id. The name and the stored proxy
   * (with its password) are kept. The previous settings are saved in the backup history first.
   */
  private applyToExisting(id: string, meta: FullBackupMeta, details: string[] = []): void {
    const before = this.deps.profiles.get(id)
    let groupId: string | null = null
    if (meta.groupName) {
      groupId = (this.deps.catalog.findGroupByName(meta.groupName) ?? this.deps.catalog.createGroup({ name: meta.groupName })).id
    }
    this.deps.profiles.update(id, {
      notes: meta.notes,
      color: meta.color,
      startUrl: meta.startUrl,
      groupId,
      tags: meta.tags ?? []
    })
    if (meta.browser) this.deps.profiles.replaceBrowserConfig(id, meta.browser as BrowserConfig)
    details.push('Profile settings restored; its name and current proxy settings were kept.')
    details.push(`Settings before the restore (for reference): ${JSON.stringify(this.deps.profiles.toPortable(before))}`)
  }

  private availableName(name: string): string {
    if (!this.deps.profiles.isNameTaken(name)) return name
    for (let n = 2; n < 1000; n++) {
      const candidate = `${name.slice(0, 60 - ` (${n})`.length)} (${n})`
      if (!this.deps.profiles.isNameTaken(candidate)) return candidate
    }
    throw new ValidationError('Could not find a free profile name')
  }

  /**
   * Moves verified data into a profile's partition folder. The previous folder is kept under
   * `.pob-work/previous/` (never deleted automatically). A journal makes the two renames
   * recoverable if the app stops half-way (see recoverInterruptedSwaps).
   */
  private async swapIn(profile: Profile, staged: string, files: { path: string; size: number; sha256: string }[]): Promise<string[]> {
    const live = managedPartitionDir(this.deps.userDataPath, profile.partition)
    const previous = workPath(
      this.deps.userDataPath,
      'previous',
      `${basename(live)}-${stamp(this.now())}-${randomUUID().slice(0, 8)}`
    )
    const journal = workPath(this.deps.userDataPath, 'journal', `${randomUUID()}.json`)
    await mkdir(dirname(previous), { recursive: true })
    await mkdir(dirname(journal), { recursive: true })
    const entry: SwapJournal = { live, staged, previous }
    await writeFile(journal, JSON.stringify(entry), 'utf8')
    const hadData = existsSync(live)
    try {
      if (hadData) await rename(live, previous)
      await rename(staged, live)
    } catch (error) {
      // Put the original back if the new data could not be moved in.
      if (hadData && !existsSync(live) && existsSync(previous)) await rename(previous, live).catch(() => {})
      await rm(journal, { force: true })
      throw new ValidationError(`The restore could not be completed; the profile's previous data was kept. (${(error as Error).message})`)
    }
    await rm(journal, { force: true })
    const problem = await checkExtracted(live, files)
    if (problem) {
      // Roll back to the previous data.
      await rm(live, { recursive: true, force: true })
      if (hadData) await rename(previous, live)
      throw new ValidationError(`The restored data could not be validated (${problem}); the previous data was put back.`)
    }
    return [
      `${files.length} files restored and verified.`,
      hadData
        ? `The profile's previous browser data was kept in ${previous} — delete it yourself once you no longer need it.`
        : 'The profile had no browser data before.'
    ]
  }

  /** Finishes or rolls back folder swaps interrupted by a crash or power loss. Run at start-up. */
  async recoverInterruptedSwaps(): Promise<string[]> {
    const dir = workDir(this.deps.userDataPath, 'journal')
    if (!existsSync(dir)) return []
    const notes: string[] = []
    for (const name of await readdir(dir)) {
      const file = join(dir, name)
      try {
        const journal = JSON.parse(await readFile(file, 'utf8')) as SwapJournal
        // Only folders inside the managed area are ever moved.
        const root = resolve(this.deps.userDataPath, 'Partitions') + sep
        for (const p of [journal.live, journal.staged, journal.previous]) {
          if (typeof p !== 'string' || !resolve(p).startsWith(root)) throw new Error('invalid journal')
        }
        if (!existsSync(journal.live)) {
          if (existsSync(journal.staged)) {
            await rename(journal.staged, journal.live)
            notes.push(`Completed an interrupted restore of ${basename(journal.live)}.`)
          } else if (existsSync(journal.previous)) {
            await rename(journal.previous, journal.live)
            notes.push(`Rolled back an interrupted restore of ${basename(journal.live)}; its previous data is in place.`)
          }
        }
        await rm(file, { force: true })
      } catch (error) {
        this.deps.logger.warn(`Could not recover restore journal ${name}`, error)
      }
    }
    return notes
  }

  // ------------------------------------------------------------------ duplicate

  /**
   * Duplicates a profile. Browser data is copied only when asked for, into the new profile's
   * own new partition — the two profiles never share storage.
   */
  async duplicate(sourceId: string, request: DuplicateRequest, options: SaveProfileOptions = {}): Promise<DuplicateResult> {
    const source = this.deps.profiles.get(sourceId)
    const profile = this.deps.profiles.duplicate(sourceId, request, options)
    if (request.mode === 'settings') {
      return { profile, data: 'not-requested', details: ['Settings copied. The new profile starts with empty browser data (logged out).'] }
    }
    const from = managedPartitionDir(this.deps.userDataPath, source.partition)
    if (!existsSync(from)) {
      return { profile, data: 'copied', details: ['The original profile has no browser data yet, so there was nothing to copy.'] }
    }
    if (this.inUse(source)) {
      this.addJob('copy-data', profile.id, { sourceId: source.id })
      const message = `"${source.name}" was used since the app started, so its files are in use. Its browser data will be copied to "${profile.name}" the next time the app starts.`
      this.addHistory({ profileId: profile.id, profileName: profile.name, kind: 'duplicate', status: 'scheduled', fileName: null, path: null, sizeBytes: null, sha256: null, details: message })
      return { profile, data: 'scheduled', details: [message] }
    }
    const details = await this.copyData(source, profile)
    return { profile, data: 'copied', details }
  }

  private async copyData(source: Profile, target: Profile): Promise<string[]> {
    const from = managedPartitionDir(this.deps.userDataPath, source.partition)
    const to = managedPartitionDir(this.deps.userDataPath, target.partition)
    if (existsSync(to)) throw new ValidationError('The new profile already has browser data; nothing was copied.')
    const collected = await collectFiles(from)
    const staged = workPath(this.deps.userDataPath, 'staging', `copy-${randomUUID()}`)
    try {
      for (const file of collected.files) {
        const dest = resolveInside(staged, file.path)
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(file.absolute, dest)
        if ((await stat(dest)).size !== file.size) throw new ValidationError(`"${file.path}" changed while it was being copied.`)
      }
      await mkdir(dirname(to), { recursive: true })
      await rename(staged, to)
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    const details = [
      `${collected.files.length} files of browser data copied into the new profile's own session.`,
      'Websites may treat both profiles as the same signed-in device and may sign one of them out.',
      ...collected.excluded.map((e) => `Not copied: ${e}`)
    ]
    this.addHistory({ profileId: target.id, profileName: target.name, kind: 'duplicate', status: 'success', fileName: null, path: null, sizeBytes: null, sha256: null, details: details.join('\n') })
    return details
  }

  // ------------------------------------------------------------------ jobs run at start-up

  private addJob(kind: JobKind, profileId: string, payload: unknown): void {
    this.deps.db.run(
      `INSERT INTO jobs (id, kind, profile_id, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      [randomUUID(), kind, profileId, JSON.stringify(payload), this.now().toISOString()]
    )
  }

  pendingJobs(): PendingJob[] {
    const names = new Map(this.deps.profiles.list().map((p) => [p.id, p.name]))
    return this.deps.db
      .all<JobRow>(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at`)
      .map((j) => ({ id: j.id, kind: j.kind, profileId: j.profile_id, profileName: names.get(j.profile_id) ?? '(deleted profile)', createdAt: j.created_at }))
  }

  async cancelJob(id: string): Promise<void> {
    const job = this.deps.db.get<JobRow>(`SELECT * FROM jobs WHERE id = ? AND status = 'pending'`, [id])
    if (!job) throw new ValidationError('That task already ran or was cancelled.')
    await this.discardJobFiles(job)
    this.finishJob(job.id, 'cancelled', 'Cancelled by the user.')
  }

  private async discardJobFiles(job: JobRow): Promise<void> {
    if (job.kind !== 'full-restore') return
    try {
      const { staged } = JSON.parse(job.payload) as { staged?: string }
      const root = resolve(workDir(this.deps.userDataPath, 'staging')) + sep
      if (staged && resolve(staged).startsWith(root)) await rm(staged, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  private finishJob(id: string, status: 'done' | 'failed' | 'cancelled', result: string): void {
    // The payload (which may hold the protected key) is cleared once the job has run.
    this.deps.db.run(`UPDATE jobs SET status = ?, result = ?, payload = '{}', finished_at = ? WHERE id = ?`, [
      status,
      result,
      this.now().toISOString(),
      id
    ])
  }

  /**
   * Runs scheduled backups/restores/copies. Must be called at start-up before any profile
   * session is created, so no Chromium process has these files open.
   */
  async runPendingJobs(): Promise<string[]> {
    const notes = await this.recoverInterruptedSwaps()
    for (const job of this.deps.db.all<JobRow>(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at`)) {
      if (!this.deps.profiles.exists(job.profile_id)) {
        await this.discardJobFiles(job)
        this.finishJob(job.id, 'cancelled', 'The profile was deleted.')
        continue
      }
      const profile = this.deps.profiles.get(job.profile_id)
      try {
        const payload = JSON.parse(job.payload) as Record<string, unknown>
        if (this.deps.isLoadedThisRun(profile.partition)) throw new Error('profile already in use')
        if (job.kind === 'full-backup') {
          const key: DerivedKey = {
            key: Buffer.from(this.deps.cipher.decrypt(String(payload.key)), 'base64'),
            salt: Buffer.from(String(payload.salt), 'base64'),
            params: payload.params as DerivedKey['params']
          }
          const outcome = await this.writeFullBackup(profile, String(payload.folder), key)
          notes.push(`Scheduled full backup of "${profile.name}" completed: ${outcome.fileName}`)
          this.finishJob(job.id, 'done', outcome.message)
        } else if (job.kind === 'full-restore') {
          const staged = String(payload.staged)
          if (!resolve(staged).startsWith(resolve(workDir(this.deps.userDataPath, 'staging')) + sep)) {
            throw new Error('invalid staging folder')
          }
          const files = payload.files as { path: string; size: number; sha256: string }[]
          const problem = await checkExtracted(staged, files)
          if (problem) throw new ValidationError(`The prepared restore is incomplete (${problem}).`)
          const details = await this.swapIn(profile, staged, files)
          this.applyToExisting(profile.id, parsePortableProfile(payload.meta), details)
          this.addHistory({ profileId: profile.id, profileName: profile.name, kind: 'restore', status: 'success', fileName: String(payload.file ?? ''), path: null, sizeBytes: null, sha256: null, details: details.join('\n') })
          notes.push(`Scheduled restore of "${profile.name}" completed.`)
          this.finishJob(job.id, 'done', details.join('\n'))
        } else if (job.kind === 'copy-data') {
          const source = this.deps.profiles.get(String(payload.sourceId))
          const details = await this.copyData(source, profile)
          notes.push(`Browser data copied into "${profile.name}".`)
          this.finishJob(job.id, 'done', details.join('\n'))
        }
      } catch (error) {
        const message = toUserError(error).message
        this.deps.logger.error(`Scheduled ${job.kind} for profile ${job.profile_id} failed`, error)
        await this.discardJobFiles(job)
        this.addHistory({ profileId: profile.id, profileName: profile.name, kind: job.kind === 'full-backup' ? 'full' : job.kind === 'copy-data' ? 'duplicate' : 'restore', status: 'failed', fileName: null, path: null, sizeBytes: null, sha256: null, details: `Scheduled task failed: ${message}. The profile's existing data was not changed.` })
        notes.push(`Scheduled ${job.kind} of "${profile.name}" failed: ${message}`)
        this.finishJob(job.id, 'failed', message)
      }
    }
    return notes
  }

  // ------------------------------------------------------------------ history

  history(profileId?: string): BackupHistoryEntry[] {
    const rows = this.deps.db.all<Record<string, unknown>>(
      profileId
        ? 'SELECT * FROM backup_history WHERE profile_id = ? ORDER BY created_at DESC LIMIT 200'
        : 'SELECT * FROM backup_history ORDER BY created_at DESC LIMIT 500',
      profileId ? [profileId] : []
    )
    return rows.map((r) => ({
      id: String(r.id),
      profileId: (r.profile_id as string | null) ?? null,
      profileName: String(r.profile_name),
      kind: r.kind as BackupHistoryEntry['kind'],
      status: r.status as BackupHistoryEntry['status'],
      fileName: (r.file_name as string | null) ?? null,
      path: (r.file_path as string | null) ?? null,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      sha256: (r.sha256 as string | null) ?? null,
      details: String(r.details ?? ''),
      createdAt: String(r.created_at)
    }))
  }

  private addHistory(entry: Omit<BackupHistoryEntry, 'id' | 'createdAt'>): BackupHistoryEntry {
    const full: BackupHistoryEntry = { ...entry, id: randomUUID(), createdAt: this.now().toISOString() }
    this.deps.db.run(
      `INSERT INTO backup_history (id, profile_id, profile_name, kind, status, file_name, file_path, size_bytes, sha256, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [full.id, full.profileId, full.profileName, full.kind, full.status, full.fileName, full.path, full.sizeBytes, full.sha256, full.details, full.createdAt]
    )
    return full
  }
}
