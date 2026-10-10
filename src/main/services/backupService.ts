import { createHash } from 'node:crypto'
import { z } from 'zod'
import { PROXY_PROTOCOLS, type AppSettings, type ProfileTemplate } from '@shared/types'
import {
  LIMITS,
  ValidationError,
  settingsUpdateSchema,
  templateProxySchema
} from '@shared/validation'
import type { PortableProfile } from './profileService'

export const BACKUP_FORMAT = 'proxy-own-browser-backup'
/** Version written by this app. Version 1 files (Phase 1/2) can still be restored. */
export const BACKUP_VERSION = 2
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024

export interface PortableGroup {
  id: string
  name: string
  color: string
}

export type PortableTemplate = Omit<ProfileTemplate, 'createdAt' | 'updatedAt'>

/**
 * Metadata backup. It never contains proxy passwords, cookies, saved logins or any other
 * browser data, so it is safe to keep as an ordinary file.
 */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  kind: 'metadata'
  exportedAt: string
  appVersion: string
  settings: AppSettings
  groups: PortableGroup[]
  tags: string[]
  profiles: PortableProfile[]
  templates: PortableTemplate[]
  /** SHA-256 over the rest of the file, to detect truncation or accidental damage. */
  integrity: { algorithm: 'sha256'; digest: string }
}

export interface BackupExtras {
  groups?: PortableGroup[]
  tags?: string[]
  templates?: PortableTemplate[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COLOR = /^#[0-9a-f]{6}$/i

const portableProxySchema = z
  .object({
    protocol: z.enum(PROXY_PROTOCOLS),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(LIMITS.credentialMax).nullable().default(null),
    bypassRules: z.string().max(LIMITS.bypassMax).default('')
  })
  .strip()

const v1ProfileSchema = z.object({
  name: z.string().min(1).max(LIMITS.nameMax),
  notes: z.string().max(LIMITS.notesMax).default(''),
  color: z.string().regex(COLOR).default('#2563eb'),
  startUrl: z.string().max(LIMITS.urlMax).nullable().default(null),
  proxy: portableProxySchema.nullable().default(null)
})

const v1Schema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  appVersion: z.string().default('unknown'),
  settings: z.record(z.string(), z.unknown()).default({}),
  profiles: z.array(v1ProfileSchema).max(LIMITS.maxProfiles)
})

const v2ProfileSchema = v1ProfileSchema.extend({
  id: z.string().regex(UUID),
  groupId: z.string().regex(UUID).nullable().default(null),
  tags: z.array(z.string().min(1).max(LIMITS.tagMax)).max(LIMITS.tagsPerProfile).default([])
})

const v2TemplateSchema = z.object({
  id: z.string().regex(UUID),
  name: z.string().min(1).max(LIMITS.nameMax),
  notes: z.string().max(LIMITS.notesMax).default(''),
  color: z.string().regex(COLOR).nullable().default(null),
  startUrl: z.string().max(LIMITS.urlMax).nullable().default(null),
  groupId: z.string().regex(UUID).nullable().default(null),
  tags: z.array(z.string().min(1).max(LIMITS.tagMax)).max(LIMITS.tagsPerProfile).default([]),
  proxy: templateProxySchema.default({ mode: 'none' })
})

const v2Schema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(2),
  kind: z.literal('metadata'),
  exportedAt: z.string(),
  appVersion: z.string().default('unknown'),
  settings: z.record(z.string(), z.unknown()).default({}),
  groups: z
    .array(z.object({ id: z.string().regex(UUID), name: z.string().min(1).max(LIMITS.groupNameMax), color: z.string().regex(COLOR) }))
    .max(LIMITS.maxGroups),
  tags: z.array(z.string().min(1).max(LIMITS.tagMax)).max(LIMITS.maxTags),
  profiles: z.array(v2ProfileSchema).max(LIMITS.maxProfiles),
  templates: z.array(v2TemplateSchema).max(LIMITS.maxTemplates),
  integrity: z.object({ algorithm: z.literal('sha256'), digest: z.string().regex(/^[0-9a-f]{64}$/) })
})

/** Digest over everything except the `integrity` field itself. Independent of whitespace. */
export function backupDigest(body: Record<string, unknown>): string {
  const rest = { ...body }
  delete rest.integrity
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

export function createBackup(
  profiles: PortableProfile[],
  settings: AppSettings,
  appVersion: string,
  now: Date = new Date(),
  extras: BackupExtras = {}
): BackupFile {
  const body = {
    format: BACKUP_FORMAT as typeof BACKUP_FORMAT,
    version: BACKUP_VERSION as typeof BACKUP_VERSION,
    kind: 'metadata' as const,
    exportedAt: now.toISOString(),
    appVersion,
    settings,
    groups: extras.groups ?? [],
    tags: extras.tags ?? [],
    profiles,
    templates: extras.templates ?? []
  }
  return { ...body, integrity: { algorithm: 'sha256', digest: backupDigest(body) } }
}

export interface ParsedBackup {
  version: 1 | 2
  profiles: PortableProfile[]
  groups: PortableGroup[]
  tags: string[]
  templates: PortableTemplate[]
  settings: Partial<AppSettings>
}

const DAMAGED = 'This backup file is damaged or was modified, so it was not restored'

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
  const head = z.object({ format: z.literal(BACKUP_FORMAT), version: z.number() }).safeParse(json)
  if (!head.success) {
    throw new ValidationError('This file is not a Proxy Own Browser backup (or it is damaged)')
  }
  if (head.data.version > BACKUP_VERSION) {
    throw new ValidationError('This backup was made by a newer version of Proxy Own Browser. Please update the app.')
  }

  if (head.data.version === 1) {
    const v1 = v1Schema.safeParse(json)
    if (!v1.success) throw new ValidationError('This file is not a Proxy Own Browser backup (or it is damaged)')
    return {
      version: 1,
      profiles: v1.data.profiles,
      groups: [],
      tags: [],
      templates: [],
      settings: validSettings(v1.data.settings)
    }
  }

  const v2 = v2Schema.safeParse(json)
  if (!v2.success) throw new ValidationError(DAMAGED)
  if (backupDigest(json as Record<string, unknown>) !== v2.data.integrity.digest) {
    throw new ValidationError(DAMAGED)
  }
  const unique = <T>(items: T[], idOf: (t: T) => string): boolean => new Set(items.map(idOf)).size === items.length
  if (
    !unique(v2.data.profiles, (p) => p.id) ||
    !unique(v2.data.groups, (g) => g.id) ||
    !unique(v2.data.templates, (t) => t.id)
  ) {
    throw new ValidationError(DAMAGED)
  }
  return {
    version: 2,
    profiles: v2.data.profiles,
    groups: v2.data.groups,
    tags: v2.data.tags,
    templates: v2.data.templates,
    settings: validSettings(v2.data.settings)
  }
}

/** Only settings that are still valid are restored. */
function validSettings(raw: Record<string, unknown>): Partial<AppSettings> {
  const settings = settingsUpdateSchema.safeParse(raw)
  return settings.success ? (settings.data as Partial<AppSettings>) : {}
}
