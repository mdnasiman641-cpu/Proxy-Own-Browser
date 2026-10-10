import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, SCHEMA_VERSION } from '../src/main/services/database'
import { loadSqlJs } from '../src/main/services/sqlite'
import { createService, tempDir } from './helpers'

describe('SQLite storage', () => {
  let dir: ReturnType<typeof tempDir>
  beforeEach(() => {
    dir = tempDir()
  })
  afterEach(() => dir.cleanup())

  it('creates the schema on first open', async () => {
    const file = join(dir.path, 'data', 'profiles.sqlite')
    const { db } = AppDatabase.open(await loadSqlJs(), file)
    expect(db.schemaVersion).toBe(SCHEMA_VERSION)
    expect(existsSync(file)).toBe(true)
  })

  it('persists profiles across restarts', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    const first = await createService({ filePath: file })
    const created = []
    for (let i = 1; i <= 20; i++) created.push(first.service.create({ name: `Account ${i}` }))
    first.service.update(created[0]!.id, { notes: 'edited' })
    first.service.delete(created[19]!.id)
    first.db.close()

    const second = await createService({ filePath: file })
    const all = second.service.list()
    expect(all).toHaveLength(19)
    expect(second.service.get(created[0]!.id).notes).toBe('edited')
    expect(second.service.get(created[5]!.id).partition).toBe(created[5]!.partition)
  })

  it('writes atomically (no temp file left behind)', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    const { service } = await createService({ filePath: file })
    service.create({ name: 'A' })
    expect(readdirSync(dir.path)).toEqual(['profiles.sqlite'])
  })

  it('rolls back a failed transaction', async () => {
    const { db } = await createService()
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('a', '1')")
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.all('SELECT * FROM settings')).toEqual([])
  })

  it('moves an unreadable database aside and starts fresh', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    writeFileSync(file, 'this is not a database'.repeat(100))
    const { db, recoveredFrom } = AppDatabase.open(await loadSqlJs(), file)
    expect(recoveredFrom).toMatch(/profiles\.sqlite\.corrupt-\d+$/)
    expect(existsSync(recoveredFrom!)).toBe(true)
    expect(db.schemaVersion).toBe(SCHEMA_VERSION)
  })
})
