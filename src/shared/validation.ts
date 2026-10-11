import { z } from 'zod'
import { browserConfigUpdateSchema } from './browserConfig'
import { PROXY_PROTOCOLS, SEARCH_ENGINES, UI_LANGUAGES, type SearchEngineId } from './types'

export const LIMITS = {
  nameMax: 60,
  notesMax: 500,
  urlMax: 2048,
  credentialMax: 256,
  bypassMax: 1000,
  searchMax: 200,
  maxProfiles: 500,
  maxOpenProfilesCeiling: 10,
  groupNameMax: 40,
  tagMax: 32,
  tagsPerProfile: 20,
  maxGroups: 200,
  maxTags: 500,
  maxTemplates: 100,
  bulkCreateMax: 100,
  bulkIdsMax: 500,
  startNumberMax: 999_999,
  paddingMax: 6
} as const

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export const PROFILE_COLORS = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#475569',
  '#ca8a04'
] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_RE = /^[0-9a-f:.]+$/i
const BYPASS_RE = /^[a-z0-9.*:\-<>[\]/,; ]*$/i

export function isValidProxyHost(host: string): boolean {
  if (IPV4_RE.test(host)) return true
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare.includes(':')) return IPV6_RE.test(bare) && bare.split(':').length >= 3
  return HOSTNAME_RE.test(host)
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export const profileIdSchema = z.string().regex(UUID_RE, 'Invalid profile id')
export const groupIdSchema = z.string().regex(UUID_RE, 'Invalid group id')
export const tagIdSchema = z.string().regex(UUID_RE, 'Invalid tag id')
export const templateIdSchema = z.string().regex(UUID_RE, 'Invalid template id')

/** A list of distinct profile ids for a bulk action. */
export const profileIdsSchema = z
  .array(profileIdSchema)
  .min(1, 'Select at least one profile')
  .max(LIMITS.bulkIdsMax, `At most ${LIMITS.bulkIdsMax} profiles at a time`)
  .refine((ids) => new Set(ids).size === ids.length, 'The selection contains duplicates')

export const tagNameSchema = z
  .string()
  .trim()
  .min(1, 'Tag names cannot be empty')
  .max(LIMITS.tagMax, `Tags can be at most ${LIMITS.tagMax} characters`)
  .refine((v) => !CONTROL_CHARS.test(v) && !v.includes(','), 'Tags cannot contain commas or control characters')

/** Tag list, de-duplicated case-insensitively (first spelling wins). */
export const tagListSchema = z
  .array(tagNameSchema)
  .max(LIMITS.tagsPerProfile, `At most ${LIMITS.tagsPerProfile} tags`)
  .transform((tags) => {
    const seen = new Set<string>()
    return tags.filter((t) => {
      const key = t.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })

export const groupInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Group name is required')
    .max(LIMITS.groupNameMax, `Group names can be at most ${LIMITS.groupNameMax} characters`)
    .refine((v) => !CONTROL_CHARS.test(v), 'Group name contains invalid characters'),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'Color must be a hex value like #2563eb').optional()
})

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Profile name is required')
  .max(LIMITS.nameMax, `Profile name must be at most ${LIMITS.nameMax} characters`)
  .refine((v) => !CONTROL_CHARS.test(v), 'Profile name contains invalid characters')

const notesSchema = z
  .string()
  .max(LIMITS.notesMax, `Notes must be at most ${LIMITS.notesMax} characters`)

const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'Color must be a hex value like #2563eb')

const startUrlSchema = z
  .string()
  .trim()
  .max(LIMITS.urlMax, 'Start page URL is too long')
  .refine((v) => v === '' || isHttpUrl(v), 'Start page must be an http:// or https:// URL')
  .transform((v) => (v === '' ? null : v))

const credentialSchema = z
  .string()
  .max(LIMITS.credentialMax, 'Proxy credential is too long')
  .refine((v) => !CONTROL_CHARS.test(v), 'Proxy credential contains invalid characters')

export const proxyInputSchema = z
  .object({
    enabled: z.boolean(),
    protocol: z.enum(PROXY_PROTOCOLS).optional(),
    host: z.string().trim().optional(),
    port: z.coerce.number().optional(),
    username: credentialSchema.optional(),
    password: credentialSchema.optional(),
    bypassRules: z
      .string()
      .trim()
      .max(LIMITS.bypassMax, 'Bypass list is too long')
      .refine((v) => BYPASS_RE.test(v), 'Bypass list contains invalid characters')
      .optional()
  })
  .superRefine((proxy, ctx) => {
    if (!proxy.enabled) return
    if (!proxy.protocol) {
      ctx.addIssue({ code: 'custom', path: ['protocol'], message: 'Proxy protocol is required' })
    }
    if (!proxy.host || !isValidProxyHost(proxy.host)) {
      ctx.addIssue({
        code: 'custom',
        path: ['host'],
        message: 'Proxy host must be a valid hostname or IP address'
      })
    }
    if (
      proxy.port === undefined ||
      !Number.isInteger(proxy.port) ||
      proxy.port < 1 ||
      proxy.port > 65535
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['port'],
        message: 'Proxy port must be a whole number between 1 and 65535'
      })
    }
    const hasCredentials = Boolean(proxy.username) || Boolean(proxy.password)
    if (hasCredentials && (proxy.protocol === 'socks4' || proxy.protocol === 'socks5')) {
      ctx.addIssue({
        code: 'custom',
        path: ['username'],
        message:
          'Chromium does not support username/password authentication for SOCKS proxies. Use an HTTP/HTTPS proxy for authenticated connections.'
      })
    }
    if (proxy.password && !proxy.username) {
      ctx.addIssue({
        code: 'custom',
        path: ['username'],
        message: 'A proxy username is required when a password is set'
      })
    }
  })

export const profileInputSchema = z.object({
  name: nameSchema,
  notes: notesSchema.optional().default(''),
  color: colorSchema.optional(),
  startUrl: startUrlSchema.nullable().optional(),
  proxy: proxyInputSchema.optional(),
  groupId: groupIdSchema.nullable().optional(),
  tags: tagListSchema.optional(),
  browser: browserConfigUpdateSchema.optional()
})

export const profileUpdateSchema = z.object({
  name: nameSchema.optional(),
  notes: notesSchema.optional(),
  color: colorSchema.optional(),
  startUrl: startUrlSchema.nullable().optional(),
  proxy: proxyInputSchema.optional(),
  groupId: groupIdSchema.nullable().optional(),
  tags: tagListSchema.optional(),
  browser: browserConfigUpdateSchema.optional()
})

export const saveProfileOptionsSchema = z
  .object({ allowSharedProxy: z.boolean().optional() })
  .strict()
  .optional()

export const duplicateRequestSchema = z
  .object({
    name: nameSchema,
    mode: z.enum(['settings', 'settings-and-data']),
    copyProxy: z.boolean()
  })
  .strict()

/** Backup passwords protect copies of cookies and logins, so a minimum length is enforced. */
export const backupPasswordSchema = z
  .string()
  .min(8, 'The backup password must be at least 8 characters')
  .max(256, 'The backup password is too long')

export const fullBackupRequestSchema = z
  .object({ profileIds: z.array(profileIdSchema).min(1).max(100), password: backupPasswordSchema })
  .strict()

export const restoreRequestSchema = z
  .object({
    path: z.string().min(1).max(1024),
    target: z.enum(['original', 'new']),
    password: z.string().max(256).optional(),
    profileIds: z.array(profileIdSchema).max(5000).optional(),
    newName: z.string().optional()
  })
  .strict()

export const backupPathSchema = z.string().min(1).max(1024)

export const templateProxySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('copy-from-profile'), profileId: profileIdSchema })
])

export const templateInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Template name is required')
    .max(LIMITS.nameMax, `Template names can be at most ${LIMITS.nameMax} characters`)
    .refine((v) => !CONTROL_CHARS.test(v), 'Template name contains invalid characters'),
  notes: notesSchema.optional().default(''),
  color: colorSchema.nullable().optional().default(null),
  startUrl: startUrlSchema.nullable().optional().default(null),
  groupId: groupIdSchema.nullable().optional().default(null),
  tags: tagListSchema.optional().default([]),
  proxy: templateProxySchema.optional().default({ mode: 'none' })
})

export const bulkCreateSpecSchema = z.object({
  nameTemplate: z
    .string()
    .trim()
    .min(1, 'Enter a name template, for example Profile-{number}')
    .max(LIMITS.nameMax, `The name template can be at most ${LIMITS.nameMax} characters`),
  count: z.coerce
    .number()
    .int('Count must be a whole number')
    .min(1, 'Create at least 1 profile')
    .max(LIMITS.bulkCreateMax, `At most ${LIMITS.bulkCreateMax} profiles per batch`),
  startNumber: z.coerce
    .number()
    .int('Start number must be a whole number')
    .min(0, 'Start number cannot be negative')
    .max(LIMITS.startNumberMax)
    .optional()
    .default(1),
  padding: z.coerce
    .number()
    .int()
    .min(0)
    .max(LIMITS.paddingMax, `Zero-padding can be at most ${LIMITS.paddingMax} digits`)
    .optional()
    .default(0),
  templateId: templateIdSchema.nullable().optional().default(null),
  groupId: groupIdSchema.nullable().optional(),
  tags: tagListSchema.optional().default([]),
  startUrl: startUrlSchema.nullable().optional(),
  proxySourceProfileId: profileIdSchema.nullable().optional()
})

/** Names chosen in the bulk wizard (all, or only the failed ones when retrying). */
export const bulkNamesSchema = z
  .array(nameSchema)
  .min(1, 'Nothing to create')
  .max(LIMITS.bulkCreateMax, `At most ${LIMITS.bulkCreateMax} profiles per batch`)

export const bulkTagsChangeSchema = z.object({
  add: tagListSchema.optional().default([]),
  remove: tagListSchema.optional().default([])
})

export const searchQuerySchema = z.string().max(LIMITS.searchMax).optional()

export const deleteOptionsSchema = z.object({ clearData: z.boolean() })

const searchEngineIds = Object.keys(SEARCH_ENGINES) as [SearchEngineId, ...SearchEngineId[]]

export const settingsUpdateSchema = z.object({
  homepage: z
    .string()
    .trim()
    .max(LIMITS.urlMax)
    .refine(isHttpUrl, 'Homepage must be an http:// or https:// URL')
    .optional(),
  searchEngine: z.enum(searchEngineIds).optional(),
  maxOpenProfiles: z.coerce
    .number()
    .int('Must be a whole number')
    .min(1, 'At least 1 profile window must be allowed')
    .max(LIMITS.maxOpenProfilesCeiling, `At most ${LIMITS.maxOpenProfilesCeiling} windows`)
    .optional(),
  confirmBeforeDelete: z.boolean().optional(),
  language: z.enum(UI_LANGUAGES).optional(),
  backupFolder: z
    .string()
    .max(1024)
    .refine((v) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(v), 'Backup folder must be an absolute path')
    .nullable()
    .optional(),
  requireUniqueProxy: z.boolean().optional(),
  ipGeolocation: z.boolean().optional()
})

export const addressInputSchema = z.string().max(LIMITS.urlMax)

export const optionalAddressSchema = addressInputSchema.optional()

export const tabIdSchema = z.string().regex(/^tab-\d{1,9}$/, 'Invalid tab id')

/** Profile id for a proxy test, or null when testing a profile that has not been saved yet. */
export const nullableProfileIdSchema = profileIdSchema.nullable()

export type ParsedProfileInput = z.infer<typeof profileInputSchema>
export type ParsedProfileUpdate = z.infer<typeof profileUpdateSchema>
export type ParsedProxyInput = z.infer<typeof proxyInputSchema>
export type ParsedSettingsUpdate = z.infer<typeof settingsUpdateSchema>
export type ParsedTemplateInput = z.infer<typeof templateInputSchema>
export type ParsedBulkCreateSpec = z.infer<typeof bulkCreateSpecSchema>

/** Turns a zod error into a single readable sentence for the UI. */
export function formatValidationError(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ')
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** Parses with a schema and throws a ValidationError with a readable message. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new ValidationError(formatValidationError(result.error))
  return result.data
}
