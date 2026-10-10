import { z } from 'zod'
import { PROXY_PROTOCOLS, type AppSettings } from '@shared/types'
import { LIMITS, ValidationError, settingsUpdateSchema } from '@shared/validation'
import type { PortableProfile } from './profileService'

export const BACKUP_FORMAT = 'proxy-own-browser-backup'
export const BACKUP_VERSION = 1
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024

/**
 * Backups contain profile metadata and settings only. They never contain proxy passwords,
 * cookies or other session data, so they are safe to keep as an ordinary file.
 */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: string
  appVersion: string
  settings: AppSettings
  profiles: PortableProfile[]
}

const portableProfileSchema = z.object({
  name: z.string().min(1).max(LIMITS.nameMax),
  notes: z.string().max(LIMITS.notesMax).default(''),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#2563eb'),
  startUrl: z.string().max(LIMITS.urlMax).nullable().default(null),
  proxy: z
    .object({
      protocol: z.enum(PROXY_PROTOCOLS),
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      username: z.string().max(LIMITS.credentialMax).nullable().default(null),
      bypassRules: z.string().max(LIMITS.bypassMax).default('')
    })
    .nullable()
    .default(null)
})

const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string(),
  appVersion: z.string().default('unknown'),
  settings: z.record(z.string(), z.unknown()).default({}),
  profiles: z.array(portableProfileSchema).max(LIMITS.maxProfiles)
})

export function createBackup(
  profiles: PortableProfile[],
  settings: AppSettings,
  appVersion: string,
  now: Date = new Date()
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    appVersion,
    settings,
    profiles
  }
}

export interface ParsedBackup {
  profiles: PortableProfile[]
  settings: Partial<AppSettings>
}

export function parseBackup(text: string): ParsedBackup {
  if (Buffer.byteLength(text, 'utf8') > MAX_BACKUP_BYTES) {
    throw new ValidationError('Backup file is too large')
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ValidationError('Backup file is not valid JSON')
  }
  const result = backupSchema.safeParse(json)
  if (!result.success) {
    throw new ValidationError('This file is not a Proxy Own Browser backup (or it is damaged)')
  }
  // Only restore settings that are still valid.
  const settings = settingsUpdateSchema.safeParse(result.data.settings)
  return {
    profiles: result.data.profiles,
    settings: settings.success ? (settings.data as Partial<AppSettings>) : {}
  }
}
