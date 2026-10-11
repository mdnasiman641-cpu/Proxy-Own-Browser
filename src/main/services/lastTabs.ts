import type { AppDatabase } from './database'
import { tabsToSave } from './windowPolicy'

/**
 * The web addresses that were open when a profile window closed, kept only for profiles that
 * use "restore previous tabs". Stored locally in the app database; never logged.
 */
export class LastTabsStore {
  constructor(private readonly db: AppDatabase, private readonly now: () => Date = () => new Date()) {}

  save(profileId: string, urls: readonly string[]): void {
    const kept = tabsToSave(urls)
    this.db.run(
      `INSERT INTO profile_last_tabs (profile_id, urls, saved_at) VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET urls = excluded.urls, saved_at = excluded.saved_at`,
      [profileId, JSON.stringify(kept), this.now().toISOString()]
    )
  }

  load(profileId: string): string[] {
    const row = this.db.get<{ urls: string }>('SELECT urls FROM profile_last_tabs WHERE profile_id = ?', [profileId])
    if (!row) return []
    try {
      const parsed = JSON.parse(row.urls) as unknown
      return Array.isArray(parsed) ? tabsToSave(parsed.filter((u): u is string => typeof u === 'string')) : []
    } catch {
      return []
    }
  }

  clear(profileId: string): void {
    this.db.run('DELETE FROM profile_last_tabs WHERE profile_id = ?', [profileId])
  }
}
