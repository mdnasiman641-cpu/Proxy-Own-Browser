import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, MIGRATIONS, SCHEMA_VERSION } from '../src/main/services/database'
import { loadSqlJs } from '../src/main/services/sqlite'
import { createService, tempDir } from './helpers'

/** Writes a database file exactly as Phase 1/2 (schema v1) left it, with real rows. */
async function writeV1Database(file: string): Promise<void> {
  const SQL = await loadSqlJs()
  const db = new SQL.Database()
  db.exec(MIGRATIONS[0]!.sql)
  db.run('PRAGMA user_version = 1')
  const insert = `INSERT INTO profiles (id, name, name_key, notes, color, start_url, partition, proxy_protocol, proxy_host,
    proxy_port, proxy_username, proxy_password, proxy_bypass, created_at, updated_at, last_opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  const id1 = '11111111-1111-4111-8111-111111111111'
  const id2 = '22222222-2222-4222-8222-222222222222'
  db.run(insert, [id1, 'Shop Page', 'shop page', 'main', '#2563eb', 'https://example.com/', `persist:profile-${id1}`,
    'http', '10.0.0.1', 8080, 'bob', 'plain:v1:cHc=', '', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null])
  db.run(insert, [id2, 'Backup', 'backup', '', '#16a34a', null, `persist:profile-${id2}`,
    null, null, null, null, null, '', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'])
  db.run('INSERT INTO used_partitions (partition, created_at) VALUES (?, ?), (?, ?)', [
    `persist:profile-${id1}`, '2026-01-01', `persist:profile-${id2}`, '2026-01-03'])
  db.run(`INSERT INTO settings (key, value) VALUES ('maxOpenProfiles', '3')`)
  writeFileSync(file, db.export())
  db.close()
}

describe('database migrations', () => {
  let dir: ReturnType<typeof tempDir>
  beforeEach(() => {
    dir = tempDir()
  })
  afterEach(() => dir.cleanup())

  it('upgrades a v1 database to the current schema without losing profiles', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    await writeV1Database(file)

    const { db, migratedFrom, preMigrationBackup } = AppDatabase.open(await loadSqlJs(), file)
    expect(SCHEMA_VERSION).toBe(4)
    expect(db.schemaVersion).toBe(4)
    expect(migratedFrom).toBe(1)
    db.close()

    const { service, catalog } = await createService({ filePath: file })
    const profiles = service.list()
    expect(profiles.map((p) => p.name)).toEqual(['Backup', 'Shop Page'])
    const shop = profiles.find((p) => p.name === 'Shop Page')!
    expect(shop.partition).toBe('persist:profile-11111111-1111-4111-8111-111111111111')
    expect(shop.proxy).toMatchObject({ host: '10.0.0.1', port: 8080, username: 'bob', hasPassword: true })
    expect(service.getProxyCredentials(shop.id)?.password).toBe('pw')
    expect(shop.groupId).toBeNull()
    expect(shop.tags).toEqual([])
    // A profile with a proxy gets the automatic, proxy-based time zone; everything else is unchanged.
    expect(shop.browser).toMatchObject({ timezoneMode: 'auto', language: null, zoomPercent: 100, userAgent: 'default' })
    expect(profiles.find((p) => p.name === 'Backup')!.browser.timezoneMode).toBe('off')
    expect(profiles.find((p) => p.name === 'Backup')!.lastOpenedAt).toBe('2026-01-04T00:00:00.000Z')

    // New features work on the upgraded data.
    const group = catalog.createGroup({ name: 'Shops' })
    expect(service.update(shop.id, { groupId: group.id, tags: ['fb'] })).toMatchObject({ groupId: group.id, tags: ['fb'] })

    // A copy of the pre-upgrade file is kept and is still a valid v1 database.
    expect(preMigrationBackup).toMatch(/profiles\.sqlite\.pre-v4-\d+\.bak$/)
    const SQL = await loadSqlJs()
    const old = new SQL.Database(readFileSync(preMigrationBackup!))
    expect((old.exec('PRAGMA user_version')[0] as { values: unknown[][] }).values[0]![0]).toBe(1)
    old.close()
  })

  it('upgrades a v2 database (Phase 3) and keeps groups, tags and templates', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    await writeV1Database(file)
    const SQL = await loadSqlJs()
    // Bring it to v2 exactly as Phase 3 did, then add Phase 3 data.
    const raw = new SQL.Database(readFileSync(file))
    raw.exec(MIGRATIONS[1]!.sql)
    raw.run('PRAGMA user_version = 2')
    raw.run(`INSERT INTO groups (id, name, name_key, color, created_at, updated_at) VALUES ('g1', 'Shops', 'shops', '#000000', 'x', 'x')`)
    raw.run(`UPDATE profiles SET group_id = 'g1' WHERE name = 'Shop Page'`)
    raw.run(`INSERT INTO tags (id, name, name_key, created_at) VALUES ('t1', 'fb', 'fb', 'x')`)
    raw.run(`INSERT INTO profile_tags (profile_id, tag_id) VALUES ('11111111-1111-4111-8111-111111111111', 't1')`)
    writeFileSync(file, raw.export())
    raw.close()

    const { db, migratedFrom, preMigrationBackup } = AppDatabase.open(SQL, file)
    expect(migratedFrom).toBe(2)
    expect(db.schemaVersion).toBe(SCHEMA_VERSION)
    expect(existsSync(preMigrationBackup!)).toBe(true)
    db.close()

    const { service } = await createService({ filePath: file })
    const shop = service.list().find((p) => p.name === 'Shop Page')!
    expect(shop.groupId).toBe('g1')
    expect(shop.tags).toEqual(['fb'])
    expect(shop.partition).toBe('persist:profile-11111111-1111-4111-8111-111111111111')
    expect(service.update(shop.id, { browser: { timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka' } }).browser.timezoneManual).toBe('Asia/Dhaka')
  })

  it('upgrades a v3 database: proxied profiles switch to automatic time zone unless set manually', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    await writeV1Database(file)
    const SQL = await loadSqlJs()
    const raw = new SQL.Database(readFileSync(file))
    raw.exec(MIGRATIONS[1]!.sql)
    raw.exec(MIGRATIONS[2]!.sql)
    raw.run('PRAGMA user_version = 3')
    const id1 = '11111111-1111-4111-8111-111111111111'
    const id2 = '22222222-2222-4222-8222-222222222222'
    raw.run(`UPDATE profiles SET browser_config = ? WHERE id = ?`, [JSON.stringify({ timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka', zoomPercent: 125 }), id1])
    raw.run(
      `INSERT INTO profile_network_status (profile_id, route_key, checked_at, proxy_status, proxy_message, ip, geo_status, geo_json)
       VALUES (?, '10.0.0.1:8080|bob', '2026-10-01T00:00:00.000Z', 'success', 'ok', '203.0.113.7', 'success', ?)`,
      [id1, JSON.stringify({ ip: '203.0.113.7', country: 'X', countryCode: null, region: null, city: null, latitude: null, longitude: null, timezone: 'Asia/Dhaka', provider: 'ipwho.is' })]
    )
    // A third profile with a proxy and the default ("this PC") time zone.
    raw.run(`INSERT INTO profiles (id, name, name_key, notes, color, start_url, partition, proxy_protocol, proxy_host, proxy_port, proxy_bypass, created_at, updated_at, browser_config)
      VALUES ('33333333-3333-4333-8333-333333333333', 'Proxied', 'proxied', '', '#000000', NULL, 'persist:profile-33333333-3333-4333-8333-333333333333', 'http', '10.0.0.3', 3128, '', 'x', 'x', '{"timezoneMode":"off","language":"bn-BD"}')`)
    writeFileSync(file, raw.export())
    raw.close()

    const { db, migratedFrom } = AppDatabase.open(SQL, file)
    expect(migratedFrom).toBe(3)
    expect(db.get<{ geo_checked_at: string }>('SELECT geo_checked_at FROM profile_network_status')!.geo_checked_at).toBe('2026-10-01T00:00:00.000Z')
    db.close()
    const { service } = await createService({ filePath: file })
    expect(service.get(id1).browser).toMatchObject({ timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka', zoomPercent: 125 })
    expect(service.get('33333333-3333-4333-8333-333333333333').browser).toMatchObject({ timezoneMode: 'auto', language: 'bn-BD' })
    expect(service.get(id2).browser.timezoneMode).toBe('off') // no proxy: unchanged
  })

  it('does not upgrade when the safety copy cannot be verified', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    await writeV1Database(file)
    const before = readFileSync(file)
    // A directory where the copy should go makes the copy fail.
    const SQL = await loadSqlJs()
    const realNow = Date.now
    Date.now = () => 42
    try {
      mkdirSync(`${file}.pre-v${SCHEMA_VERSION}-42.bak`)
      expect(() => AppDatabase.open(SQL, file)).toThrow(/verified safety copy/)
    } finally {
      Date.now = realNow
    }
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('keeps used partitions reserved after the upgrade', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    await writeV1Database(file)
    const { service } = await createService({
      filePath: file,
      newId: () => '11111111-1111-4111-8111-111111111111'
    })
    service.delete('11111111-1111-4111-8111-111111111111')
    expect(() => service.create({ name: 'Reuse attempt' })).toThrow(/unique session partition/)
  })

  it('does not create a backup copy for a database that is already current', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    const first = AppDatabase.open(await loadSqlJs(), file)
    first.db.close()
    const second = AppDatabase.open(await loadSqlJs(), file)
    expect(second.preMigrationBackup).toBeUndefined()
    expect(readdirSync(dir.path)).toEqual(['profiles.sqlite'])
  })

  it('refuses a database written by a newer app version instead of changing it', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    const SQL = await loadSqlJs()
    const db = new SQL.Database()
    db.run('PRAGMA user_version = 99')
    writeFileSync(file, db.export())
    const before = readFileSync(file)
    expect(() => AppDatabase.open(SQL, file)).toThrow(/newer version/)
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(existsSync(file)).toBe(true)
  })
})
