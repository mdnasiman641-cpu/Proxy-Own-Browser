import { describe, expect, it } from 'vitest'
import { BACKUP_FORMAT, createBackup, parseBackup } from '../src/main/services/backupService'
import { SettingsService } from '../src/main/services/settingsService'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { ValidationError } from '../src/shared/validation'
import { createService } from './helpers'

describe('SettingsService', () => {
  it('returns defaults, saves updates and validates them', async () => {
    const { db } = await createService()
    const settings = new SettingsService(db)
    expect(settings.get()).toEqual(DEFAULT_SETTINGS)
    expect(settings.get().maxOpenProfiles).toBe(2)

    const next = settings.update({ maxOpenProfiles: 5, searchEngine: 'bing' })
    expect(next.maxOpenProfiles).toBe(5)
    expect(next.searchEngine).toBe('bing')
    expect(new SettingsService(db).get().maxOpenProfiles).toBe(5)

    expect(() => settings.update({ homepage: 'javascript:alert(1)' })).toThrow(ValidationError)
  })

  it('ignores a corrupted stored value instead of failing', async () => {
    const { db } = await createService()
    db.run("INSERT INTO settings (key, value) VALUES ('maxOpenProfiles', '999')")
    db.run("INSERT INTO settings (key, value) VALUES ('homepage', 'not json')")
    expect(new SettingsService(db).get()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('backup and restore', () => {
  it('round-trips profiles without passwords, ids or partitions', async () => {
    const source = await createService()
    source.service.create({ name: 'Shop', notes: 'n', startUrl: 'https://example.com/' })
    source.service.create({
      name: 'Proxied',
      proxy: { enabled: true, protocol: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'topsecret' }
    })

    const backup = createBackup(
      source.service.list().map((p) => source.service.toPortable(p)),
      DEFAULT_SETTINGS,
      '0.1.0'
    )
    const text = JSON.stringify(backup)
    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(text).not.toContain('topsecret')
    expect(text).not.toContain('persist:profile-')

    const target = await createService()
    target.service.create({ name: 'Shop' })
    const parsed = parseBackup(text)
    const summary = target.service.importProfiles(parsed.profiles)

    expect(summary.imported).toBe(2)
    expect(summary.renamed).toEqual(['Shop → Shop (2)'])
    const restored = target.service.list().find((p) => p.name === 'Proxied')!
    expect(restored.proxy).toMatchObject({ host: '1.2.3.4', port: 8080, username: 'bob', hasPassword: false })
    const original = source.service.list().find((p) => p.name === 'Proxied')!
    expect(restored.partition).not.toBe(original.partition)
  })

  it('rejects files that are not backups', () => {
    expect(() => parseBackup('not json')).toThrow(/not valid JSON/)
    expect(() => parseBackup('{"format":"something-else"}')).toThrow(/not a Proxy Own Browser backup/)
    expect(() => parseBackup('x'.repeat(6 * 1024 * 1024))).toThrow(/too large/)
  })

  it('skips invalid entries instead of failing the whole import', async () => {
    const { service } = await createService()
    const parsed = parseBackup(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        profiles: [
          { name: 'Good' },
          { name: 'Bad URL', startUrl: 'javascript:alert(1)' }
        ]
      })
    )
    const summary = service.importProfiles(parsed.profiles)
    expect(summary).toEqual({ imported: 1, renamed: [], skipped: 1 })
  })
})
