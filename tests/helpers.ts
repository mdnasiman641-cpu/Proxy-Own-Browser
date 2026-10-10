import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/services/database'
import { ProfileRepository } from '../src/main/services/profileRepository'
import { ProfileService } from '../src/main/services/profileService'
import { EncodingOnlyCipher, type SecretCipher } from '../src/main/services/secretCipher'
import { loadSqlJs } from '../src/main/services/sqlite'

export async function openDb(filePath: string | null = null): Promise<AppDatabase> {
  return AppDatabase.open(await loadSqlJs(), filePath).db
}

export async function createService(
  options: { filePath?: string | null; cipher?: SecretCipher; newId?: () => string; maxProfiles?: number } = {}
): Promise<{ db: AppDatabase; service: ProfileService; repo: ProfileRepository }> {
  const db = await openDb(options.filePath ?? null)
  const repo = new ProfileRepository(db)
  const service = new ProfileService(repo, options.cipher ?? new EncodingOnlyCipher(), {
    newId: options.newId,
    maxProfiles: options.maxProfiles
  })
  return { db, service, repo }
}

export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'pob-test-'))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
