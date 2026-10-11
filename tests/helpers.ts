import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/services/database'
import { BulkCreator } from '../src/main/services/bulkCreate'
import { CatalogService } from '../src/main/services/catalogService'
import { MetadataBackupService } from '../src/main/services/metadataBackup'
import { ProfileRepository } from '../src/main/services/profileRepository'
import { SettingsService } from '../src/main/services/settingsService'
import { TemplateService } from '../src/main/services/templateService'
import { ProfileService } from '../src/main/services/profileService'
import { EncodingOnlyCipher, type SecretCipher } from '../src/main/services/secretCipher'
import { loadSqlJs } from '../src/main/services/sqlite'

export async function openDb(filePath: string | null = null): Promise<AppDatabase> {
  return AppDatabase.open(await loadSqlJs(), filePath).db
}

export async function createService(
  options: {
    filePath?: string | null
    cipher?: SecretCipher
    newId?: () => string
    maxProfiles?: number
    requireUniqueProxy?: () => boolean
  } = {}
): Promise<{ db: AppDatabase; service: ProfileService; repo: ProfileRepository; catalog: CatalogService }> {
  const db = await openDb(options.filePath ?? null)
  const repo = new ProfileRepository(db)
  const catalog = new CatalogService(db)
  const service = new ProfileService(repo, options.cipher ?? new EncodingOnlyCipher(), {
    newId: options.newId,
    maxProfiles: options.maxProfiles,
    catalog,
    requireUniqueProxy: options.requireUniqueProxy
  })
  return { db, service, repo, catalog }
}

/** Every Phase 3 service wired together on one in-memory (or file) database. */
export async function createApp(options: { filePath?: string | null; maxProfiles?: number } = {}) {
  const base = await createService(options)
  const settings = new SettingsService(base.db)
  const templates = new TemplateService(base.db, base.catalog, base.service)
  const bulk = new BulkCreator(base.service, base.catalog, templates)
  const backups = new MetadataBackupService(base.service, base.catalog, templates, settings)
  return { ...base, settings, templates, bulk, backups }
}

export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'pob-test-'))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
