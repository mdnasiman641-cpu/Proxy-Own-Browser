import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupCenter } from '../src/main/services/backupCenter'
import { managedPartitionDir, workPath } from '../src/main/services/managedPaths'
import { createApp, tempDir } from './helpers'

const PASSWORD = 'backup-password-1'

async function setup() {
  const dir = tempDir()
  const userData = join(dir.path, 'user-data')
  const folder = join(dir.path, 'backups')
  const app = await createApp()
  const loaded = new Set<string>()
  const open = new Set<string>()
  const center = new BackupCenter({
    userDataPath: userData,
    db: app.db,
    profiles: app.service,
    catalog: app.catalog,
    metadata: app.backups,
    settings: app.settings,
    // Tests use a cipher that reports itself as secure so scheduling can be exercised.
    cipher: {
      isSecure: true,
      encrypt: (v: string) => `test:${Buffer.from(v).toString('base64')}`,
      decrypt: (v: string) => Buffer.from(v.slice(5), 'base64').toString()
    },
    isLoadedThisRun: (partition) => loaded.has(partition),
    isOpen: (id) => open.has(id),
    appVersion: '0.4.0',
    logger: { info() {}, warn() {}, error() {} }
  })
  app.settings.update({ backupFolder: folder })
  const dataDir = (partition: string) => managedPartitionDir(userData, partition)
  /** Writes fake browser data for a profile. */
  const seed = (partition: string, cookie: string) => {
    const root = dataDir(partition)
    mkdirSync(join(root, 'Network'), { recursive: true })
    mkdirSync(join(root, 'Local Storage', 'leveldb'), { recursive: true })
    mkdirSync(join(root, 'Cache'), { recursive: true })
    writeFileSync(join(root, 'Network', 'Cookies'), cookie)
    writeFileSync(join(root, 'Local Storage', 'leveldb', '000003.log'), `ls-${cookie}`)
    writeFileSync(join(root, 'Cache', 'data_0'), 'cache')
  }
  const cookieOf = (partition: string) => readFileSync(join(dataDir(partition), 'Network', 'Cookies'), 'utf8')
  return { dir, userData, folder, app, center, loaded, open, seed, cookieOf, dataDir }
}

describe('local backup and restore', () => {
  let t: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    t = await setup()
  })
  afterEach(() => t.dir.cleanup())

  it('needs a backup folder before backing up', async () => {
    t.app.settings.update({ backupFolder: null })
    const p = t.app.service.create({ name: 'A' })
    await expect(t.center.backupMetadata([p.id])).rejects.toThrow(/Choose a backup folder/)
  })

  it('writes metadata backups with descriptive names, lists and verifies them', async () => {
    const a = t.app.service.create({ name: 'Shop / Main' })
    t.app.service.create({ name: 'Other' })
    const one = await t.center.backupMetadata([a.id])
    expect(one.fileName).toMatch(new RegExp(`^POB_metadata_Shop-Main_${a.id.slice(0, 8)}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.json$`))
    const all = await t.center.backupMetadata('all')
    expect(all.fileName).toMatch(/^POB_metadata_all-profiles_/)
    const list = await t.center.listBackups()
    expect(list.map((b) => b.kind)).toEqual(['metadata', 'metadata'])
    expect(list.find((b) => b.fileName === one.fileName)!.profiles).toEqual([{ id: a.id, name: 'Shop / Main' }])
    expect(await t.center.verify(one.path!)).toMatchObject({ ok: true })
    expect(t.center.history().map((h) => h.kind)).toEqual(['metadata', 'metadata'])
  })

  it('makes an encrypted full backup of a closed profile and restores it as a new profile', async () => {
    const a = t.app.service.create({ name: 'Alpha', tags: ['fb'], browser: { timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka' } })
    t.seed(a.partition, 'alpha-cookie')
    const [outcome] = await t.center.backupFull([a.id], PASSWORD)
    expect(outcome).toMatchObject({ status: 'success', name: 'Alpha' })
    expect(outcome!.fileName).toMatch(new RegExp(`^POB_full_Alpha_${a.id.slice(0, 8)}_.*\\.pobfull$`))
    expect(outcome!.excluded.join()).toMatch(/Cache/)
    const file = join(t.folder, outcome!.fileName!)
    expect(readFileSync(file).includes(Buffer.from('alpha-cookie'))).toBe(false)
    expect(await t.center.verify(file, PASSWORD)).toMatchObject({ ok: true })
    expect(await t.center.verify(file, 'wrong-password')).toMatchObject({ ok: false })

    const restored = await t.center.restore({ path: file, target: 'new', password: PASSWORD })
    expect(restored.status).toBe('success')
    const copy = t.app.service.get(restored.profileIds[0]!)
    expect(copy.id).not.toBe(a.id)
    expect(copy.partition).not.toBe(a.partition)
    expect(copy.name).toBe('Alpha (2)')
    expect(copy.tags).toEqual(['fb'])
    expect(copy.browser.timezoneManual).toBe('Asia/Dhaka')
    expect(t.cookieOf(copy.partition)).toBe('alpha-cookie')
    expect(existsSync(join(t.dataDir(copy.partition), 'Cache'))).toBe(false)
    // The original is untouched.
    expect(t.cookieOf(a.partition)).toBe('alpha-cookie')
  })

  it('restores into the original profile, keeping its previous data aside', async () => {
    const a = t.app.service.create({ name: 'Alpha', notes: 'old notes' })
    t.seed(a.partition, 'at-backup-time')
    const [outcome] = await t.center.backupFull([a.id], PASSWORD)
    t.seed(a.partition, 'changed-later')
    t.app.service.update(a.id, { notes: 'changed notes', name: 'Alpha renamed' })

    const result = await t.center.restore({ path: join(t.folder, outcome!.fileName!), target: 'original', password: PASSWORD })
    expect(result.status).toBe('success')
    expect(t.cookieOf(a.partition)).toBe('at-backup-time')
    const after = t.app.service.get(a.id)
    expect(after.notes).toBe('old notes')
    expect(after.name).toBe('Alpha renamed') // the name is kept
    const previous = readdirSync(join(t.userData, 'Partitions', '.pob-work', 'previous'))
    expect(previous).toHaveLength(1)
    expect(readFileSync(join(t.userData, 'Partitions', '.pob-work', 'previous', previous[0]!, 'Network', 'Cookies'), 'utf8')).toBe('changed-later')
    expect(result.details.join('\n')).toMatch(/previous browser data was kept/)
  })

  it('never restores over an open profile or one whose files are in use', async () => {
    const a = t.app.service.create({ name: 'Alpha' })
    t.seed(a.partition, 'v1')
    const [outcome] = await t.center.backupFull([a.id], PASSWORD)
    const file = join(t.folder, outcome!.fileName!)
    t.seed(a.partition, 'v2')

    t.open.add(a.id)
    await expect(t.center.restore({ path: file, target: 'original', password: PASSWORD })).rejects.toThrow(/Close "Alpha"/)
    t.open.delete(a.id)

    t.loaded.add(a.partition)
    const scheduled = await t.center.restore({ path: file, target: 'original', password: PASSWORD })
    expect(scheduled.status).toBe('scheduled')
    expect(t.cookieOf(a.partition)).toBe('v2') // unchanged until the next start
    expect(t.center.pendingJobs().map((j) => j.kind)).toEqual(['full-restore'])

    // Next start: nothing loaded yet.
    t.loaded.clear()
    const notes = await t.center.runPendingJobs()
    expect(notes.join()).toMatch(/restore of "Alpha" completed/)
    expect(t.cookieOf(a.partition)).toBe('v1')
    expect(t.center.pendingJobs()).toEqual([])
  })

  it('schedules a full backup of a profile in use and makes it at the next start', async () => {
    const a = t.app.service.create({ name: 'Busy' })
    t.seed(a.partition, 'busy-cookie')
    t.loaded.add(a.partition)
    const [outcome] = await t.center.backupFull([a.id], PASSWORD)
    expect(outcome!.status).toBe('scheduled')
    expect(existsSync(t.folder) ? readdirSync(t.folder) : []).toEqual([])

    t.loaded.clear()
    await t.center.runPendingJobs()
    const files = readdirSync(t.folder).filter((f) => f.endsWith('.pobfull'))
    expect(files).toHaveLength(1)
    expect(await t.center.verify(join(t.folder, files[0]!), PASSWORD)).toMatchObject({ ok: true })
    // The protected key is removed once the job ran.
    expect(t.app.db.get<{ payload: string }>('SELECT payload FROM jobs')!.payload).toBe('{}')
  })

  it('rejects a damaged backup without touching the destination profile', async () => {
    const a = t.app.service.create({ name: 'Alpha' })
    t.seed(a.partition, 'v1')
    const [outcome] = await t.center.backupFull([a.id], PASSWORD)
    const file = join(t.folder, outcome!.fileName!)
    const bytes = readFileSync(file)
    bytes[bytes.length - 40] ^= 1
    writeFileSync(file, bytes)
    t.seed(a.partition, 'current')
    const before = t.app.service.count()

    await expect(t.center.restore({ path: file, target: 'original', password: PASSWORD })).rejects.toThrow(/damaged or was modified/)
    await expect(t.center.restore({ path: file, target: 'new', password: PASSWORD })).rejects.toThrow(/damaged or was modified/)
    expect(t.cookieOf(a.partition)).toBe('current')
    expect(t.app.service.count()).toBe(before)
    expect(readdirSync(join(t.userData, 'Partitions', '.pob-work', 'staging'))).toEqual([])
  })

  it("only restores into the profile the backup belongs to", async () => {
    const a = t.app.service.create({ name: 'Alpha' })
    const b = t.app.service.create({ name: 'Beta' })
    t.seed(a.partition, 'alpha')
    t.seed(b.partition, 'beta')
    const [outcome] = await t.center.backupFull([a.id], PASSWORD)
    await t.center.restore({ path: join(t.folder, outcome!.fileName!), target: 'original', password: PASSWORD })
    expect(t.cookieOf(b.partition)).toBe('beta')

    t.app.service.delete(a.id)
    await expect(
      t.center.restore({ path: join(t.folder, outcome!.fileName!), target: 'original', password: PASSWORD })
    ).rejects.toThrow(/no longer exists/)
  })

  it('finishes or rolls back a restore interrupted half-way', async () => {
    const a = t.app.service.create({ name: 'Alpha' })
    t.seed(a.partition, 'old')
    const live = t.dataDir(a.partition)
    const { renameSync } = await import('node:fs')

    // Crash after the old data was moved aside, before the new data was moved in.
    const staged = workPath(t.userData, 'staging', 'restore-x')
    const previous = workPath(t.userData, 'previous', 'prev-x')
    mkdirSync(join(staged, 'Network'), { recursive: true })
    writeFileSync(join(staged, 'Network', 'Cookies'), 'new')
    mkdirSync(join(t.userData, 'Partitions', '.pob-work', 'previous'), { recursive: true })
    renameSync(live, previous)
    mkdirSync(join(t.userData, 'Partitions', '.pob-work', 'journal'), { recursive: true })
    writeFileSync(workPath(t.userData, 'journal', 'j1.json'), JSON.stringify({ live, staged, previous }))
    await t.center.recoverInterruptedSwaps()
    expect(t.cookieOf(a.partition)).toBe('new')

    // Crash where the staged data is gone: the previous data is put back.
    renameSync(live, staged + '-gone')
    writeFileSync(workPath(t.userData, 'journal', 'j2.json'), JSON.stringify({ live, staged, previous }))
    await t.center.recoverInterruptedSwaps()
    expect(t.cookieOf(a.partition)).toBe('old')
    expect(readdirSync(join(t.userData, 'Partitions', '.pob-work', 'journal'))).toEqual([])
  })

  it('ignores a journal that points outside the managed folder', async () => {
    const outside = join(t.dir.path, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'x')
    mkdirSync(join(t.userData, 'Partitions', '.pob-work', 'journal'), { recursive: true })
    writeFileSync(
      workPath(t.userData, 'journal', 'evil.json'),
      JSON.stringify({ live: join(t.dir.path, 'nothing'), staged: outside, previous: outside })
    )
    await t.center.recoverInterruptedSwaps()
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('x')
    expect(existsSync(join(t.dir.path, 'nothing'))).toBe(false)
  })

  it('duplicates settings only, or settings and data into a new separate partition', async () => {
    const a = t.app.service.create({ name: 'Alpha', tags: ['x'], browser: { zoomPercent: 150 } })
    t.seed(a.partition, 'alpha-cookie')

    const settingsOnly = await t.center.duplicate(a.id, { name: 'Alpha copy', mode: 'settings', copyProxy: true })
    expect(settingsOnly.data).toBe('not-requested')
    expect(settingsOnly.profile.partition).not.toBe(a.partition)
    expect(settingsOnly.profile.browser.zoomPercent).toBe(150)
    expect(settingsOnly.profile.tags).toEqual(['x'])
    expect(existsSync(t.dataDir(settingsOnly.profile.partition))).toBe(false)

    const withData = await t.center.duplicate(a.id, { name: 'Alpha data', mode: 'settings-and-data', copyProxy: false })
    expect(withData.data).toBe('copied')
    expect(t.cookieOf(withData.profile.partition)).toBe('alpha-cookie')
    expect(existsSync(join(t.dataDir(withData.profile.partition), 'Cache'))).toBe(false)
    // Separate storage: changing the copy does not change the original.
    t.seed(withData.profile.partition, 'copy-changed')
    expect(t.cookieOf(a.partition)).toBe('alpha-cookie')

    t.loaded.add(a.partition)
    const later = await t.center.duplicate(a.id, { name: 'Alpha later', mode: 'settings-and-data', copyProxy: false })
    expect(later.data).toBe('scheduled')
    expect(existsSync(t.dataDir(later.profile.partition))).toBe(false)
    t.loaded.clear()
    await t.center.runPendingJobs()
    expect(t.cookieOf(later.profile.partition)).toBe('alpha-cookie')
  })

  it('restores metadata into the original profile or as new profiles', async () => {
    const a = t.app.service.create({ name: 'Alpha', notes: 'v1', browser: { language: 'bn-BD' } })
    const entry = await t.center.backupMetadata([a.id])
    t.app.service.update(a.id, { notes: 'v2', browser: { language: 'en-GB' } })

    const original = await t.center.restore({ path: entry.path!, target: 'original' })
    expect(original.status).toBe('success')
    expect(t.app.service.get(a.id)).toMatchObject({ notes: 'v1', browser: { language: 'bn-BD' } })

    const asNew = await t.center.restore({ path: entry.path!, target: 'new' })
    const copy = t.app.service.get(asNew.profileIds[0]!)
    expect(copy.id).not.toBe(a.id)
    expect(copy.partition).not.toBe(a.partition)
    expect(copy.name).toBe('Alpha (2)')
  })
})
