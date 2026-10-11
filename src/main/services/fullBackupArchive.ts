import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type Hash
} from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Encrypted full browser-data backup of one profile (`.pobfull`).
 *
 * Layout:
 *   "POBFULL\0" | u32 header length | header JSON (plain, authenticated) |
 *   AES-256-GCM ciphertext | 16-byte GCM tag
 *
 * The plaintext is a sequence of file records followed by a manifest:
 *   'F' | u16 path length | path (UTF-8, '/'-separated) | u64 size | data | SHA-256 of data
 *   'M' | u32 manifest length | manifest JSON (every file with its size and SHA-256)
 *
 * The key is derived from the user's password with scrypt and a random salt; nothing is
 * hard-coded. The header (profile name/id, dates, versions) stays readable without the
 * password so backups can be listed; it is authenticated, so it can't be altered unnoticed.
 */

export const ARCHIVE_MAGIC = Buffer.from('POBFULL\0', 'latin1')
export const ARCHIVE_FORMAT = 'proxy-own-browser-full-backup'
export const ARCHIVE_VERSION = 1
export const ARCHIVE_EXTENSION = '.pobfull'

const MAX_HEADER_BYTES = 64 * 1024
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_PATH_BYTES = 1024
const MAX_FILES = 200_000
/** Largest backup accepted (plaintext). */
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
const TAG_BYTES = 16

const SCRYPT = { N: 1 << 16, r: 8, p: 1 } as const

/**
 * Folders that are not backed up: caches Chromium rebuilds by itself, temporary blob storage
 * and offline site caches (sites download them again). Matched by folder name at any depth.
 */
export const EXCLUDED_DIRS: Record<string, string> = {
  Cache: 'HTTP cache (rebuilt automatically)',
  'Code Cache': 'compiled script cache (rebuilt automatically)',
  GPUCache: 'graphics cache (rebuilt automatically)',
  DawnCache: 'graphics cache (rebuilt automatically)',
  DawnGraphiteCache: 'graphics cache (rebuilt automatically)',
  DawnWebGPUCache: 'graphics cache (rebuilt automatically)',
  GrShaderCache: 'graphics cache (rebuilt automatically)',
  ShaderCache: 'graphics cache (rebuilt automatically)',
  blob_storage: 'temporary blob storage',
  CacheStorage: 'offline site caches (sites download them again)',
  'Crashpad': 'crash reports'
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-a-backup'
      | 'unsupported-version'
      | 'damaged'
      | 'wrong-password'
      | 'unsafe-path'
      | 'source-changed'
      | 'too-large'
      | 'io'
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

export interface ArchiveFileEntry {
  path: string
  size: number
  sha256: string
}

export interface ArchiveHeader {
  format: typeof ARCHIVE_FORMAT
  version: number
  createdAt: string
  appVersion: string
  profile: { id: string; name: string }
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: { name: 'aes-256-gcm'; iv: string }
  /** HMAC of a fixed label with the key: lets a wrong password be reported before decrypting. */
  keyCheck: string
  fileCount: number
  dataBytes: number
}

export interface ArchiveManifest<Meta = unknown> {
  format: typeof ARCHIVE_FORMAT
  version: number
  createdAt: string
  /** Profile settings at backup time (validated by the caller when restoring). */
  profile: Meta
  files: ArchiveFileEntry[]
  excluded: string[]
}

export interface SourceFile {
  path: string
  absolute: string
  size: number
}

export interface CollectedFiles {
  files: SourceFile[]
  totalBytes: number
  /** Human-readable list of what was left out and why. */
  excluded: string[]
}

export interface DerivedKey {
  key: Buffer
  salt: Buffer
  params: { N: number; r: number; p: number }
}

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scryptCallback(password, salt, 32, { ...params, maxmem: 256 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolvePromise(key)
    )
  })
}

/** Derives a fresh key (new random salt) from a password. */
export async function deriveNewKey(password: string): Promise<DerivedKey> {
  const salt = randomBytes(16)
  return { key: await scrypt(password, salt, SCRYPT), salt, params: { ...SCRYPT } }
}

function keyCheck(key: Buffer): string {
  return createHmac('sha256', key).update('pob-full-backup-key-check').digest('base64')
}

/**
 * Validates a path from a backup and returns its segments. Rejects absolute paths, drive
 * letters, `..`, empty segments, backslashes, colons (Windows streams) and control characters.
 */
export function safeArchivePath(path: string): string[] {
  if (!path || Buffer.byteLength(path) > MAX_PATH_BYTES) throw new BackupError('Unsafe path in backup', 'unsafe-path')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\:*?"<>|]/.test(path) || path.startsWith('/')) {
    throw new BackupError(`Unsafe path in backup: ${JSON.stringify(path.slice(0, 80))}`, 'unsafe-path')
  }
  const segments = path.split('/')
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(segment)
    ) {
      throw new BackupError(`Unsafe path in backup: ${JSON.stringify(path.slice(0, 80))}`, 'unsafe-path')
    }
  }
  return segments
}

/** Joins a validated archive path under `root` and proves the result stays inside it. */
export function resolveInside(root: string, path: string): string {
  const base = resolve(root)
  const target = resolve(base, ...safeArchivePath(path))
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..') || resolve(base, rel) !== target) {
    throw new BackupError('Unsafe path in backup', 'unsafe-path')
  }
  return target
}

/**
 * Lists the files to back up from a profile's partition folder. Symbolic links are never
 * followed (reported as excluded); cache folders are excluded by name.
 */
export async function collectFiles(root: string): Promise<CollectedFiles> {
  const files: SourceFile[] = []
  const excluded = new Set<string>()
  let totalBytes = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        excluded.add(`${rel} (link — not followed)`)
        continue
      }
      if (entry.isDirectory()) {
        const reason = EXCLUDED_DIRS[entry.name]
        if (reason) {
          excluded.add(`${entry.name}: ${reason}`)
          continue
        }
        await walk(absolute, rel)
      } else if (entry.isFile()) {
        try {
          safeArchivePath(rel)
        } catch {
          excluded.add(`${rel} (name not supported)`)
          continue
        }
        const info = await stat(absolute)
        files.push({ path: rel, absolute, size: info.size })
        totalBytes += info.size
      }
    }
  }
  await walk(root, '')
  if (files.length > MAX_FILES) throw new BackupError('This profile has too many files to back up', 'too-large')
  if (totalBytes > MAX_ARCHIVE_BYTES) throw new BackupError('This profile is too large to back up', 'too-large')
  return { files, totalBytes, excluded: [...excluded].sort() }
}

function writeChunk(out: WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error)
    out.once('error', onError)
    const ok = out.write(chunk, (error) => {
      out.off('error', onError)
      if (error) reject(error)
      else if (ok) resolvePromise()
    })
    if (!ok) out.once('drain', () => resolvePromise())
  })
}

function u64(value: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(value))
  return b
}

export interface WriteArchiveOptions<Meta> {
  destination: string
  collected: CollectedFiles
  key: DerivedKey
  profile: { id: string; name: string }
  meta: Meta
  appVersion: string
  now?: () => Date
  onProgress?: (doneBytes: number, totalBytes: number) => void
}

export interface WrittenArchive {
  path: string
  sizeBytes: number
  /** SHA-256 of the whole backup file (also written to `<file>.sha256`). */
  sha256: string
  fileCount: number
  dataBytes: number
}

/**
 * Writes the backup to `<destination>.partial`, then renames it into place only after every
 * file was read completely and unchanged. A partial file is removed on failure, so an
 * incomplete backup never looks like a finished one.
 */
export async function writeArchive<Meta>(options: WriteArchiveOptions<Meta>): Promise<WrittenArchive> {
  const { destination, collected, key } = options
  const createdAt = (options.now?.() ?? new Date()).toISOString()
  const iv = randomBytes(12)
  const header: ArchiveHeader = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt,
    appVersion: options.appVersion,
    profile: options.profile,
    kdf: { name: 'scrypt', ...key.params, salt: key.salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') },
    keyCheck: keyCheck(key.key),
    fileCount: collected.files.length,
    dataBytes: collected.totalBytes
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const lengthBytes = Buffer.alloc(4)
  lengthBytes.writeUInt32BE(headerBytes.length)
  const prefix = Buffer.concat([ARCHIVE_MAGIC, lengthBytes, headerBytes])

  const partial = `${destination}.partial`
  await mkdir(dirname(destination), { recursive: true })
  const out = createWriteStream(partial, { flags: 'wx' })
  const fileHash = createHash('sha256')
  let written = 0
  const emit = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return
    fileHash.update(chunk)
    written += chunk.length
    await writeChunk(out, chunk)
  }
  const cipher = createCipheriv('aes-256-gcm', key.key, iv)
  cipher.setAAD(prefix)
  const plain = async (chunk: Buffer): Promise<void> => emit(cipher.update(chunk))

  try {
    await emit(prefix)
    const entries: ArchiveFileEntry[] = []
    let done = 0
    for (const file of collected.files) {
      const pathBytes = Buffer.from(file.path, 'utf8')
      const pathLength = Buffer.alloc(2)
      pathLength.writeUInt16BE(pathBytes.length)
      await plain(Buffer.concat([Buffer.from('F'), pathLength, pathBytes, u64(file.size)]))
      const hash = createHash('sha256')
      let size = 0
      for await (const chunk of createReadStream(file.absolute)) {
        const buf = chunk as Buffer
        size += buf.length
        if (size > file.size) break
        hash.update(buf)
        await plain(buf)
        done += buf.length
        options.onProgress?.(done, collected.totalBytes)
      }
      if (size !== file.size) {
        throw new BackupError(
          `"${file.path}" changed while it was being backed up. Close the profile and try again.`,
          'source-changed'
        )
      }
      const digest = hash.digest()
      await plain(digest)
      entries.push({ path: file.path, size: file.size, sha256: digest.toString('hex') })
    }
    const manifest: ArchiveManifest<Meta> = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      createdAt,
      profile: options.meta,
      files: entries,
      excluded: collected.excluded
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
    const manifestLength = Buffer.alloc(4)
    manifestLength.writeUInt32BE(manifestBytes.length)
    await plain(Buffer.concat([Buffer.from('M'), manifestLength, manifestBytes]))
    await emit(cipher.final())
    await emit(cipher.getAuthTag())
    await new Promise<void>((resolvePromise, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolvePromise())))
    await rename(partial, destination)
    const sha256 = fileHash.digest('hex')
    await writeFile(`${destination}.sha256`, `${sha256}  ${destination.split(/[\\/]/).pop()}\n`, 'utf8')
    return { path: destination, sizeBytes: written, sha256, fileCount: entries.length, dataBytes: collected.totalBytes }
  } catch (error) {
    out.destroy()
    await rm(partial, { force: true }).catch(() => {})
    if (error instanceof BackupError) throw error
    throw new BackupError(`The backup could not be written: ${(error as Error).message}`, 'io')
  }
}

/** Reads and validates the plain header (no password needed). */
export async function readArchiveHeader(path: string): Promise<{ header: ArchiveHeader; headerEnd: number; size: number }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const head = Buffer.alloc(12)
    const { bytesRead } = await handle.read(head, 0, 12, 0)
    if (bytesRead < 12 || !head.subarray(0, 8).equals(ARCHIVE_MAGIC)) {
      throw new BackupError('This file is not a Proxy Own Browser full backup.', 'not-a-backup')
    }
    const length = head.readUInt32BE(8)
    if (length === 0 || length > MAX_HEADER_BYTES || 12 + length + TAG_BYTES > size) {
      throw new BackupError('This backup file is damaged.', 'damaged')
    }
    const headerBytes = Buffer.alloc(length)
    await handle.read(headerBytes, 0, length, 12)
    let header: ArchiveHeader
    try {
      header = JSON.parse(headerBytes.toString('utf8')) as ArchiveHeader
    } catch {
      throw new BackupError('This backup file is damaged.', 'damaged')
    }
    if (header?.format !== ARCHIVE_FORMAT) throw new BackupError('This file is not a Proxy Own Browser full backup.', 'not-a-backup')
    if (typeof header.version !== 'number' || header.version > ARCHIVE_VERSION) {
      throw new BackupError(
        'This backup was made by a newer version of Proxy Own Browser. Update the app to restore it.',
        'unsupported-version'
      )
    }
    const kdf = header.kdf
    const valid =
      kdf?.name === 'scrypt' &&
      Number.isInteger(kdf.N) && kdf.N >= 1 << 14 && kdf.N <= 1 << 20 && (kdf.N & (kdf.N - 1)) === 0 &&
      Number.isInteger(kdf.r) && kdf.r >= 1 && kdf.r <= 16 &&
      Number.isInteger(kdf.p) && kdf.p >= 1 && kdf.p <= 4 &&
      typeof kdf.salt === 'string' && Buffer.from(kdf.salt, 'base64').length === 16 &&
      header.cipher?.name === 'aes-256-gcm' && Buffer.from(header.cipher.iv ?? '', 'base64').length === 12 &&
      typeof header.keyCheck === 'string' &&
      typeof header.profile?.id === 'string' && typeof header.profile?.name === 'string' &&
      Number.isInteger(header.fileCount) && header.fileCount >= 0 && header.fileCount <= MAX_FILES &&
      Number.isInteger(header.dataBytes) && header.dataBytes >= 0 && header.dataBytes <= MAX_ARCHIVE_BYTES
    if (!valid) throw new BackupError('This backup file is damaged.', 'damaged')
    return { header, headerEnd: 12 + length, size }
  } finally {
    await handle.close()
  }
}

/** Derives the key for an existing backup and rejects a wrong password before decrypting. */
export async function keyForArchive(header: ArchiveHeader, password: string): Promise<Buffer> {
  const key = await scrypt(password, Buffer.from(header.kdf.salt, 'base64'), header.kdf)
  const expected = Buffer.from(header.keyCheck, 'base64')
  const actual = Buffer.from(keyCheck(key), 'base64')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new BackupError('The password is not correct for this backup.', 'wrong-password')
  }
  return key
}

export interface ReadArchiveOptions {
  path: string
  key: Buffer
  /** Folder to extract into (must not exist yet). Omit to only verify. */
  extractTo?: string
  onProgress?: (doneBytes: number, totalBytes: number) => void
}

export interface ReadArchiveResult<Meta> {
  header: ArchiveHeader
  manifest: ArchiveManifest<Meta>
  bytes: number
}

/**
 * Decrypts and checks a backup completely: the GCM tag (detects any change to header or data),
 * every file's SHA-256 and size, that the manifest lists exactly the files present, and that
 * no path can escape the target folder. When extracting, files go to a new folder that is
 * removed again if anything fails — callers only move it into place after this resolves.
 */
export async function readArchive<Meta>(options: ReadArchiveOptions): Promise<ReadArchiveResult<Meta>> {
  const { header, headerEnd, size } = await readArchiveHeader(options.path)
  const handle = await open(options.path, 'r')
  const prefix = Buffer.alloc(headerEnd)
  const tag = Buffer.alloc(TAG_BYTES)
  try {
    await handle.read(prefix, 0, headerEnd, 0)
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES)
  } finally {
    await handle.close()
  }

  if (options.extractTo) {
    try {
      await lstat(options.extractTo)
      throw new BackupError('The restore folder already exists.', 'io')
    } catch (error) {
      if (error instanceof BackupError) throw error
    }
    await mkdir(options.extractTo, { recursive: true })
  }

  const decipher = createDecipheriv('aes-256-gcm', options.key, Buffer.from(header.cipher.iv, 'base64'))
  decipher.setAAD(prefix)
  decipher.setAuthTag(tag)
  const parser = new RecordParser(options.extractTo, header, options.onProgress)
  try {
    if (size - TAG_BYTES > headerEnd) {
      const stream = createReadStream(options.path, { start: headerEnd, end: size - TAG_BYTES - 1 })
      for await (const chunk of stream) {
        await parser.push(decipher.update(chunk as Buffer))
      }
    }
    let tail: Buffer
    try {
      tail = decipher.final()
    } catch {
      throw new BackupError('This backup file is damaged or was modified, so it was not used.', 'damaged')
    }
    await parser.push(tail)
    const manifest = parser.finish<Meta>()
    return { header, manifest, bytes: parser.dataBytes }
  } catch (error) {
    await parser.abort()
    if (options.extractTo) await rm(options.extractTo, { recursive: true, force: true }).catch(() => {})
    if (error instanceof BackupError) throw error
    throw new BackupError(`The backup could not be read: ${(error as Error).message}`, 'io')
  }
}

/** Streaming parser for the decrypted record sequence. */
class RecordParser {
  private buffer: Buffer = Buffer.alloc(0)
  private state: 'type' | 'data' | 'manifest' | 'done' = 'type'
  private current: { path: string; size: number; remaining: number; hash: Hash; out: WriteStream | null } | null = null
  private readonly seen = new Map<string, ArchiveFileEntry>()
  private manifestLength = 0
  private manifestBytes: Buffer | null = null
  dataBytes = 0

  constructor(
    private readonly root: string | undefined,
    private readonly header: ArchiveHeader,
    private readonly onProgress?: (done: number, total: number) => void
  ) {}

  async push(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      if (this.state === 'type') {
        if (this.buffer.length < 1) return
        const type = String.fromCharCode(this.buffer[0]!)
        if (type === 'F') {
          if (this.buffer.length < 3) return
          const pathLength = this.buffer.readUInt16BE(1)
          if (pathLength === 0 || pathLength > MAX_PATH_BYTES) throw damaged()
          if (this.buffer.length < 3 + pathLength + 8) return
          const path = this.buffer.subarray(3, 3 + pathLength).toString('utf8')
          const size = Number(this.buffer.readBigUInt64BE(3 + pathLength))
          this.buffer = this.buffer.subarray(3 + pathLength + 8)
          safeArchivePath(path)
          if (this.seen.has(path) || this.seen.size >= this.header.fileCount) throw damaged()
          if (!Number.isSafeInteger(size) || this.dataBytes + size > this.header.dataBytes) throw damaged()
          let out: WriteStream | null = null
          if (this.root) {
            const target = resolveInside(this.root, path)
            await mkdir(dirname(target), { recursive: true })
            out = createWriteStream(target, { flags: 'wx' })
          }
          this.current = { path, size, remaining: size, hash: createHash('sha256'), out }
          this.state = 'data'
        } else if (type === 'M') {
          if (this.buffer.length < 5) return
          this.manifestLength = this.buffer.readUInt32BE(1)
          if (this.manifestLength === 0 || this.manifestLength > MAX_MANIFEST_BYTES) throw damaged()
          this.buffer = this.buffer.subarray(5)
          this.state = 'manifest'
        } else {
          throw damaged()
        }
      } else if (this.state === 'data') {
        const current = this.current!
        if (current.remaining > 0) {
          if (this.buffer.length === 0) return
          const take = Math.min(current.remaining, this.buffer.length)
          const part = this.buffer.subarray(0, take)
          this.buffer = this.buffer.subarray(take)
          current.hash.update(part)
          if (current.out) await writeChunk(current.out, Buffer.from(part))
          current.remaining -= take
          this.dataBytes += take
          this.onProgress?.(this.dataBytes, this.header.dataBytes)
          continue
        }
        if (this.buffer.length < 32) return
        const recorded = this.buffer.subarray(0, 32)
        this.buffer = this.buffer.subarray(32)
        const actual = current.hash.digest()
        if (!actual.equals(recorded)) throw damaged()
        if (current.out) {
          const out = current.out
          await new Promise<void>((resolvePromise, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolvePromise())))
        }
        this.seen.set(current.path, { path: current.path, size: current.size, sha256: actual.toString('hex') })
        this.current = null
        this.state = 'type'
      } else if (this.state === 'manifest') {
        if (this.buffer.length < this.manifestLength) return
        this.manifestBytes = this.buffer.subarray(0, this.manifestLength)
        this.buffer = this.buffer.subarray(this.manifestLength)
        this.state = 'done'
      } else {
        if (this.buffer.length > 0) throw damaged()
        return
      }
    }
  }

  finish<Meta>(): ArchiveManifest<Meta> {
    if (this.state !== 'done' || !this.manifestBytes || this.buffer.length > 0) throw damaged()
    let manifest: ArchiveManifest<Meta>
    try {
      manifest = JSON.parse(this.manifestBytes.toString('utf8')) as ArchiveManifest<Meta>
    } catch {
      throw damaged()
    }
    if (manifest?.format !== ARCHIVE_FORMAT || !Array.isArray(manifest.files)) throw damaged()
    // The manifest must list exactly the files that were in the archive, with the same hashes.
    if (manifest.files.length !== this.seen.size || this.seen.size !== this.header.fileCount) {
      throw new BackupError('This backup is incomplete: some files are missing.', 'damaged')
    }
    for (const entry of manifest.files) {
      const seen = this.seen.get(entry?.path)
      if (!seen || seen.size !== entry.size || seen.sha256 !== entry.sha256) {
        throw new BackupError('This backup is incomplete: some files are missing or different.', 'damaged')
      }
    }
    if (!Array.isArray(manifest.excluded)) manifest.excluded = []
    return manifest
  }

  async abort(): Promise<void> {
    const out = this.current?.out
    if (out && !out.destroyed) out.destroy()
  }
}

function damaged(): BackupError {
  return new BackupError('This backup file is damaged or was modified, so it was not used.', 'damaged')
}

/** Confirms an extracted/moved folder holds exactly the manifest's files with the right sizes. */
export async function checkExtracted(root: string, files: ArchiveFileEntry[]): Promise<string | null> {
  for (const file of files) {
    try {
      const info = await lstat(resolveInside(root, file.path))
      if (!info.isFile() || info.size !== file.size) return `${file.path} has the wrong size`
    } catch {
      return `${file.path} is missing`
    }
  }
  return null
}
