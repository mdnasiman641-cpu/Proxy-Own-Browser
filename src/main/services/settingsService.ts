import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { parseOrThrow, settingsUpdateSchema } from '@shared/validation'
import type { AppDatabase } from './database'

export class SettingsService {
  constructor(private readonly db: AppDatabase) {}

  get(): AppSettings {
    const stored: Record<string, unknown> = {}
    for (const row of this.db.all<{ key: string; value: string }>(
      'SELECT key, value FROM settings'
    )) {
      try {
        stored[row.key] = JSON.parse(row.value)
      } catch {
        /* ignore malformed value, default applies */
      }
    }
    // Validate each stored value on its own so one bad value can't reset everything.
    const settings: AppSettings = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      if (!(key in stored)) continue
      const parsed = settingsUpdateSchema.safeParse({ [key]: stored[key] })
      if (parsed.success && parsed.data[key] !== undefined) {
        ;(settings as unknown as Record<string, unknown>)[key] = parsed.data[key]
      }
    }
    return settings
  }

  update(update: Partial<AppSettings>): AppSettings {
    const data = parseOrThrow(settingsUpdateSchema, update)
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [key, JSON.stringify(value)]
        )
      }
    })
    return this.get()
  }
}
