import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  safeArchivePath,
  writeArchive,
  type CollectedFiles
} from '../src/main/services/fullBackupArchive'
import { tempDir } from './helpers'

const PROFILE = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Shop' }
const PASSWORD = 'correct horse battery'

/** A small fake Chromium partition folder. */
function makePartition(root: string): void {
  mkdirSync(join(root, 'Local Storage', 'leveldb'), { recursive: true })
  mkdirSync(join(root, 'IndexedDB', 'https_example.com_0.indexeddb.leveldb'), { recursive: true })
  mkdirSync(join(root, 'Cache', 'Cache_Data'), { recursive: true })
  mkdirSync(join(root, 'Service Worker', 'CacheStorage'), { recursive: true })
  mkdirSync(join(root, 'Network'), { recursive: true })
  writeFileSync(join(root, 'Network', 'Cookies'), 'cookie-db-bytes')
  writeFileSync(join(root, 'Local Storage', 'leveldb', '000003.log'), Buffer.alloc(200_000, 7))
  writeFileSync(join(root, 'IndexedDB', 'https_example.com_0.indexeddb.leveldb', 'CURRENT'), 'MANIFEST-000001\n')
  writeFileSync(join(root, 'Cache', 'Cache_Data', 'data_0'), 'cached')
  writeFileSync(join(root, 'Service Worker', 'CacheStorage', 'x'), 'offline cache')
  writeFileSync(join(root, 'Preferences'), '{}')
  writeFileSync(join(root, 'empty'), '')
}

async function backup(dir: string, collected?: CollectedFiles, password = PASSWORD): Promise<string> {
  const source = join(dir, 'profile')
  const files = collected ?? (await collectFiles(source))
  const destination = join(dir, 'out', `test${ARCHIVE_EXTENSION}`)
  await writeArchive({
    destination,
    collected: files,
    key: await deriveNewKey(password),
    profile: PROFILE,
    meta: { name: 'Shop', notes: 'n' },
    appVersion: '9.9.9'
  })
  return destination
}

describe('full browser-data backup archive', () => {
  let dir: ReturnType<typeof tempDir>
  beforeEach(() => {
    dir = tempDir()
    makePartition(join(dir.path, 'profile'))
  })
  afterEach(() => dir.cleanup())

  it('backs up profile data, leaves caches out, and restores it byte for byte', async () => {
    const collected = await collectFiles(join(dir.path, 'profile'))
    const paths = collected.files.map((f) => f.path)
    expect(paths).toContain('Network/Cookies')
    expect(paths).toContain('Local Storage/leveldb/000003.log')
    expect(paths).toContain('IndexedDB/https_example.com_0.indexeddb.leveldb/CURRENT')
    expect(paths.some((p) => p.startsWith('Cache/'))).toBe(false)
    expect(paths.some((p) => p.includes('CacheStorage'))).toBe(false)
    expect(collected.excluded.join('\n')).toMatch(/Cache: HTTP cache/)

    const file = await backup(dir.path, collected)
    expect(existsSync(`${file}.sha256`)).toBe(true)
    expect(existsSync(`${file}.partial`)).toBe(false)
    // Nothing readable inside without the password.
    expect(readFileSync(file).includes(Buffer.from('cookie-db-bytes'))).toBe(false)

    const { header } = await readArchiveHeader(file)
    expect(header.profile).toEqual(PROFILE)
    expect(header.appVersion).toBe('9.9.9')

    const target = join(dir.path, 'restored')
    const result = await readArchive<{ notes: string }>({
      path: file,
      key: await keyForArchive(header, PASSWORD),
      extractTo: target
    })
    expect(result.manifest.profile.notes).toBe('n')
    expect(result.manifest.files).toHaveLength(collected.files.length)
    expect(readFileSync(join(target, 'Network', 'Cookies'), 'utf8')).toBe('cookie-db-bytes')
    expect(readFileSync(join(target, 'Local Storage', 'leveldb', '000003.log')).equals(Buffer.alloc(200_000, 7))).toBe(true)
    expect(readFileSync(join(target, 'empty'), 'utf8')).toBe('')
    expect(await checkExtracted(target, result.manifest.files)).toBeNull()
  })

  it('verifies without writing anything when no target folder is given', async () => {
    const file = await backup(dir.path)
    const { header } = await readArchiveHeader(file)
    const before = readdirSync(dir.path).sort()
    const result = await readArchive({ path: file, key: await keyForArchive(header, PASSWORD) })
    expect(result.bytes).toBeGreaterThan(200_000)
    expect(readdirSync(dir.path).sort()).toEqual(before)
  })

  it('rejects a wrong password before decrypting', async () => {
    const file = await backup(dir.path)
    const { header } = await readArchiveHeader(file)
    await expect(keyForArchive(header, 'not the password')).rejects.toThrow(/password is not correct/)
  })

  it('rejects a modified byte anywhere in the encrypted data and removes the partial restore', async () => {
    const file = await backup(dir.path)
    const bytes = readFileSync(file)
    bytes[bytes.length - 5000] ^= 0xff
    writeFileSync(file, bytes)
    const { header } = await readArchiveHeader(file)
    const target = join(dir.path, 'restored')
    await expect(
      readArchive({ path: file, key: await keyForArchive(header, PASSWORD), extractTo: target })
    ).rejects.toThrow(/damaged or was modified/)
    expect(existsSync(target)).toBe(false)
  })

  it('rejects a changed header (e.g. another profile id) even with the right password', async () => {
    const file = await backup(dir.path)
    const text = readFileSync(file).toString('latin1').replace(PROFILE.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    writeFileSync(file, Buffer.from(text, 'latin1'))
    const { header } = await readArchiveHeader(file)
    expect(header.profile.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    await expect(readArchive({ path: file, key: await keyForArchive(header, PASSWORD) })).rejects.toThrow(/damaged or was modified/)
  })

  it('rejects truncated files, other files and backups from a newer version', async () => {
    const file = await backup(dir.path)
    const bytes = readFileSync(file)
    writeFileSync(file, bytes.subarray(0, bytes.length - 100))
    const { header } = await readArchiveHeader(file)
    await expect(readArchive({ path: file, key: await keyForArchive(header, PASSWORD) })).rejects.toThrow(BackupError)

    const other = join(dir.path, 'other.pobfull')
    writeFileSync(other, 'PK\u0003\u0004 not a backup')
    await expect(readArchiveHeader(other)).rejects.toThrow(/not a Proxy Own Browser full backup/)

    const newer = readFileSync(join(dir.path, 'out', `test${ARCHIVE_EXTENSION}`)).toString('latin1').replace('"version":1', '"version":9')
    const newerFile = join(dir.path, 'newer.pobfull')
    writeFileSync(newerFile, Buffer.from(newer, 'latin1'))
    await expect(readArchiveHeader(newerFile)).rejects.toThrow(/newer version/)
  })

  it('refuses archive paths that would escape the restore folder', async () => {
    for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b', 'a//b', 'NUL', 'x/con.txt', 'a/./b', 'x:stream']) {
      expect(() => safeArchivePath(bad)).toThrow(/Unsafe path/)
    }
    expect(safeArchivePath('Local Storage/leveldb/000003.log')).toEqual(['Local Storage', 'leveldb', '000003.log'])
    expect(() => resolveInside(dir.path, '../outside')).toThrow(/Unsafe path/)

    // A crafted backup containing a traversal path is rejected and nothing is written outside.
    const evilSource = join(dir.path, 'profile', 'Preferences')
    const collected: CollectedFiles = {
      files: [{ path: '../escaped', absolute: evilSource, size: 2 }],
      totalBytes: 2,
      excluded: []
    }
    const file = await backup(dir.path, collected)
    const { header } = await readArchiveHeader(file)
    const target = join(dir.path, 'restored')
    await expect(
      readArchive({ path: file, key: await keyForArchive(header, PASSWORD), extractTo: target })
    ).rejects.toThrow(/Unsafe path/)
    expect(existsSync(join(dir.path, 'escaped'))).toBe(false)
    expect(existsSync(target)).toBe(false)
  })

  it('fails (and leaves no backup file) when a file changes while being backed up', async () => {
    const collected = await collectFiles(join(dir.path, 'profile'))
    const cookies = collected.files.find((f) => f.path === 'Network/Cookies')!
    cookies.size -= 3 // the file is now "larger" than when it was listed
    await expect(backup(dir.path, collected)).rejects.toThrow(/changed while it was being backed up/)
    expect(existsSync(join(dir.path, 'out'))).toBe(true)
    expect(readdirSync(join(dir.path, 'out'))).toEqual([])
  })

  it('never follows links inside the profile folder', async () => {
    const outside = join(dir.path, 'outside-secret')
    writeFileSync(outside, 'secret')
    try {
      symlinkSync(outside, join(dir.path, 'profile', 'link'))
    } catch {
      return // symlinks need extra rights on some Windows setups
    }
    const collected = await collectFiles(join(dir.path, 'profile'))
    expect(collected.files.some((f) => f.path === 'link')).toBe(false)
    expect(collected.excluded.join('\n')).toMatch(/link \(link — not followed\)/)
  })

  it('reports files missing after extraction', async () => {
    const target = join(dir.path, 'restored')
    mkdirSync(target)
    expect(await checkExtracted(target, [{ path: 'Network/Cookies', size: 3, sha256: 'x' }])).toMatch(/missing/)
  })

  it('refuses to extract into a folder that already exists', async () => {
    const file = await backup(dir.path)
    const { header } = await readArchiveHeader(file)
    const target = join(dir.path, 'restored')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'mine')
    await expect(
      readArchive({ path: file, key: await keyForArchive(header, PASSWORD), extractTo: target })
    ).rejects.toThrow(/already exists/)
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('mine')
  })
})
