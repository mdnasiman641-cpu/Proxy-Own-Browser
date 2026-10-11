import { describe, expect, it } from 'vitest'
import { BACKUP_FORMAT, backupDigest, parseBackup } from '../src/main/services/backupService'
import { SCHEMA_VERSION } from '../src/main/services/database'
import { createApp } from './helpers'

async function populated() {
  const app = await createApp()
  const shops = app.catalog.createGroup({ name: 'Shops', color: '#16a34a' })
  app.catalog.createGroup({ name: 'Unused' })
  const src = app.service.create({
    name: 'Main shop',
    groupId: shops.id,
    tags: ['fb', 'bd'],
    startUrl: 'https://example.com/',
    proxy: { enabled: true, protocol: 'http', host: '10.1.1.1', port: 8080, username: 'bob', password: 'very-secret-pw' }
  })
  const plain = app.service.create({ name: 'Plain' })
  app.templates.create({ name: 'Shop template', groupId: shops.id, tags: ['fb'], proxy: { mode: 'copy-from-profile', profileId: src.id } })
  app.settings.update({ maxOpenProfiles: 4, language: 'bn' })
  return { ...app, shops, src, plain }
}

describe('metadata backup v2', () => {
  it('exports profiles, ids, groups, tags, templates and settings — never passwords or partitions', async () => {
    const app = await populated()
    const backup = app.backups.buildBackup('0.3.0')
    const text = JSON.stringify(backup)
    expect(backup).toMatchObject({ format: BACKUP_FORMAT, version: 3, kind: 'metadata' })
    expect(backup.profiles.map((p) => p.id)).toEqual([app.src.id, app.plain.id])
    expect(backup.groups.map((g) => g.name)).toEqual(['Shops', 'Unused'])
    expect(backup.tags).toEqual(['bd', 'fb'])
    expect(backup.templates).toHaveLength(1)
    expect(backup.settings.language).toBe('bn')
    expect(text).not.toContain('very-secret-pw')
    expect(text).not.toContain('plain:v1:')
    expect(text).not.toContain('persist:profile-')
    expect(backup.integrity.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exports only the selected profiles and the groups/tags they use', async () => {
    const app = await populated()
    const backup = app.backups.buildBackup('0.3.0', [app.src.id])
    expect(backup.profiles.map((p) => p.name)).toEqual(['Main shop'])
    expect(backup.groups.map((g) => g.name)).toEqual(['Shops'])
    expect(backup.tags).toEqual(['bd', 'fb'])
    expect(backup.templates).toEqual([])
  })

  it('restores into an empty install with the same ids, groups, tags and template links', async () => {
    const source = await populated()
    const text = JSON.stringify(source.backups.buildBackup('0.3.0'), null, 2)
    const target = await createApp()
    const summary = target.backups.restore(parseBackup(text))
    expect(summary).toMatchObject({ version: 3, imported: 2, skipped: 0, groupsCreated: 2, groupsMerged: 0, templatesImported: 1 })

    const restored = target.service.get(source.src.id)
    expect(restored).toMatchObject({ name: 'Main shop', groupId: source.shops.id, tags: ['bd', 'fb'] })
    expect(restored.partition).toBe(source.src.partition)
    expect(restored.proxy).toMatchObject({ host: '10.1.1.1', username: 'bob', hasPassword: false })
    const template = target.templates.list()[0]!
    expect(template.proxy).toEqual({ mode: 'copy-from-profile', profileId: source.src.id })
    expect(target.settings.get()).toMatchObject({ maxOpenProfiles: 4, language: 'bn' })
  })

  it('restoring next to existing data merges groups, renames clashes and gives taken ids new partitions', async () => {
    const app = await populated()
    const text = JSON.stringify(app.backups.buildBackup('0.3.0'))
    const summary = app.backups.restore(parseBackup(text))
    expect(summary.imported).toBe(2)
    expect(summary.renamed).toEqual(['Main shop → Main shop (2)', 'Plain → Plain (2)'])
    expect(summary.groupsMerged).toBe(2)
    expect(summary.groupsCreated).toBe(0)
    const copy = app.service.list().find((p) => p.name === 'Main shop (2)')!
    expect(copy.id).not.toBe(app.src.id)
    expect(copy.partition).not.toBe(app.src.partition)
    expect(copy.groupId).toBe(app.shops.id)
    // The restored template points at the restored copy, not the original.
    const templateCopy = app.templates.list().find((t) => t.name === 'Shop template (2)')!
    expect(templateCopy.proxy).toEqual({ mode: 'copy-from-profile', profileId: copy.id })
  })

  it('still restores Phase 1/2 (v1) backups', async () => {
    const app = await createApp()
    const v1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-10T00:00:00.000Z',
      appVersion: '0.2.0',
      settings: { maxOpenProfiles: 3 },
      profiles: [{ name: 'Old', notes: '', color: '#2563eb', startUrl: null, proxy: null }]
    }
    const summary = app.backups.restore(parseBackup(JSON.stringify(v1)))
    expect(summary).toMatchObject({ version: 1, imported: 1 })
    expect(app.service.list()[0]).toMatchObject({ name: 'Old', groupId: null, tags: [] })
    expect(app.settings.get().maxOpenProfiles).toBe(3)
  })

  it('rejects damaged, modified or unsupported backups', async () => {
    const app = await populated()
    const good = app.backups.buildBackup('0.3.0')
    const text = JSON.stringify(good)

    expect(() => parseBackup(text.slice(0, text.length - 40))).toThrow(/not valid JSON/)
    const tampered = JSON.parse(text)
    tampered.profiles[0].startUrl = 'https://evil.example/'
    expect(() => parseBackup(JSON.stringify(tampered))).toThrow(/damaged or was modified/)
    const wrongType = JSON.parse(text)
    wrongType.profiles[0].tags = 'not-a-list'
    expect(() => parseBackup(JSON.stringify(wrongType))).toThrow(/damaged/)
    const duplicateIds = JSON.parse(text)
    duplicateIds.profiles[1].id = duplicateIds.profiles[0].id
    expect(() => parseBackup(JSON.stringify(duplicateIds))).toThrow(/damaged/)
    expect(() => parseBackup(JSON.stringify({ ...good, version: 4 }))).toThrow(/newer version/)
    expect(() => parseBackup(JSON.stringify({ format: 'zip', version: 2 }))).toThrow(/not a Proxy Own Browser backup/)
    expect(() => parseBackup(JSON.stringify({ ...good, integrity: { algorithm: 'md5', digest: 'x' } }))).toThrow(/damaged/)
  })

  it('still restores Phase 3 (v2) backups, which have no browser settings', async () => {
    const source = await populated()
    const v3 = source.backups.buildBackup('0.3.0') as unknown as Record<string, unknown>
    // Rebuild the same content exactly as a v2 file was written (no schemaVersion/browser/createdAt).
    const { integrity: _i, schemaVersion: _s, ...rest } = v3
    const body = {
      ...rest,
      version: 2,
      profiles: (rest.profiles as Record<string, unknown>[]).map(({ browser: _b, createdAt: _c, ...p }) => p)
    }
    const v2 = { ...body, integrity: { algorithm: 'sha256', digest: backupDigest(body) } }
    const target = await createApp()
    const summary = target.backups.restore(parseBackup(JSON.stringify(v2)))
    expect(summary).toMatchObject({ version: 2, imported: 2, skipped: 0 })
    // No browser settings in v2: a restored profile with a proxy gets the automatic time zone,
    // one without a proxy keeps this PC's time zone.
    expect(target.service.get(source.src.id).browser.timezoneMode).toBe('auto')
    expect(target.service.get(source.plain.id).browser.timezoneMode).toBe('off')
  })

  it('v3 carries browser settings and creation dates, but not the backup folder', async () => {
    const app = await populated()
    app.service.update(app.src.id, { browser: { timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka', language: 'bn-BD', zoomPercent: 125 } })
    app.settings.update({ backupFolder: 'C:\\Users\\me\\Backups' })
    const backup = app.backups.buildBackup('0.4.0')
    expect(backup.schemaVersion).toBe(SCHEMA_VERSION)
    expect(JSON.stringify(backup.settings)).not.toContain('Backups')
    expect(backup.profiles[0]).toMatchObject({ createdAt: app.src.createdAt, browser: { timezoneManual: 'Asia/Dhaka', zoomPercent: 125 } })

    const target = await createApp()
    target.backups.restore(parseBackup(JSON.stringify(backup)))
    expect(target.service.get(app.src.id).browser).toMatchObject({ timezoneMode: 'manual', timezoneManual: 'Asia/Dhaka', language: 'bn-BD', zoomPercent: 125 })
    expect(target.settings.get().backupFolder).toBeNull()
  })

  it('accepts a backup re-formatted with different whitespace', async () => {
    const app = await populated()
    const pretty = JSON.stringify(app.backups.buildBackup('0.3.0'), null, 4)
    expect(parseBackup(pretty).profiles).toHaveLength(2)
  })
})
