import { z } from 'zod'

/**
 * Per-profile browser settings. Only settings the installed Electron/Chromium runtime can
 * genuinely apply are offered; nothing here changes the real PC (CPU, RAM, GPU, OS clock) and
 * nothing is designed to hide the browser from website security checks.
 */

/** Site permissions a profile can allow. Everything else stays blocked. */
export const CONFIGURABLE_PERMISSIONS = ['notifications', 'media', 'geolocation', 'clipboard-read'] as const
export type ConfigurablePermission = (typeof CONFIGURABLE_PERMISSIONS)[number]
export type PermissionSetting = 'block' | 'allow'

/** Permissions every profile gets without asking (harmless and needed by normal sites). */
export const ALWAYS_ALLOWED_PERMISSIONS = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'] as const

/**
 * - `off`: no override; pages see this PC's time zone (behaviour of earlier versions).
 * - `auto`: the IANA time zone of the public IP seen through the profile's proxy.
 * - `manual`: a time zone the user picked.
 */
export const TIMEZONE_MODES = ['off', 'auto', 'manual'] as const
export type TimezoneMode = (typeof TIMEZONE_MODES)[number]

/**
 * - `default`: Electron's own User-Agent (contains "Electron/<version>" and the app name).
 * - `chrome`: the same real Chromium version, without the Electron and app tokens — what a
 *   regular Chrome of this exact version sends. No other versions are ever offered.
 */
export const USER_AGENT_MODES = ['default', 'chrome'] as const
export type UserAgentMode = (typeof USER_AGENT_MODES)[number]

export interface BrowserConfig {
  /** BCP 47 language tag such as `en-US` or `bn-BD`; null keeps the app default. */
  language: string | null
  timezoneMode: TimezoneMode
  /** IANA time zone used in `manual` mode. */
  timezoneManual: string | null
  windowWidth: number
  windowHeight: number
  zoomPercent: number
  userAgent: UserAgentMode
  permissions: Record<ConfigurablePermission, PermissionSetting>
}

export const BROWSER_LIMITS = {
  windowMinWidth: 640,
  windowMaxWidth: 3840,
  windowMinHeight: 480,
  windowMaxHeight: 2160,
  zoomMin: 25,
  zoomMax: 300
} as const

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  language: null,
  timezoneMode: 'off',
  timezoneManual: null,
  windowWidth: 1280,
  windowHeight: 860,
  zoomPercent: 100,
  userAgent: 'default',
  permissions: { notifications: 'block', media: 'block', geolocation: 'block', 'clipboard-read': 'block' }
}

/** Common browser languages offered in the UI (any valid BCP 47 tag is accepted). */
export const COMMON_LANGUAGES = [
  'en-US', 'en-GB', 'bn-BD', 'bn-IN', 'hi-IN', 'ur-PK', 'ar-SA', 'ar-AE', 'de-DE', 'fr-FR', 'es-ES',
  'es-MX', 'it-IT', 'nl-NL', 'pt-BR', 'pt-PT', 'ru-RU', 'tr-TR', 'pl-PL', 'uk-UA', 'id-ID', 'ms-MY',
  'th-TH', 'vi-VN', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW'
] as const

/** True when `tz` is an IANA time zone this runtime knows (aliases such as Asia/Calcutta included). */
export function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** True for well-formed BCP 47 language tags (checked by Intl). */
export function isValidLanguageTag(tag: string): boolean {
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(tag)) return false
  try {
    return Intl.getCanonicalLocales(tag).length === 1
  } catch {
    return false
  }
}

/** Full list of IANA time zones for pickers (falls back to a short list on old runtimes). */
export function supportedTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  const zones = intl.supportedValuesOf?.('timeZone') ?? ['UTC', 'Asia/Dhaka', 'Europe/London', 'America/New_York']
  return zones.includes('UTC') ? zones : ['UTC', ...zones]
}

export const timeZoneSchema = z
  .string()
  .trim()
  .refine(isValidTimeZone, 'Unknown time zone. Choose one from the list (for example Asia/Dhaka).')

export const languageTagSchema = z
  .string()
  .trim()
  .refine(isValidLanguageTag, 'Unknown language code. Use a code such as en-US or bn-BD.')
  .transform((tag) => Intl.getCanonicalLocales(tag)[0]!)

const permissionSchema = z.enum(['block', 'allow'])

export const browserConfigUpdateSchema = z
  .object({
    language: languageTagSchema.nullable().optional(),
    timezoneMode: z.enum(TIMEZONE_MODES).optional(),
    timezoneManual: timeZoneSchema.nullable().optional(),
    windowWidth: z.coerce
      .number()
      .int()
      .min(BROWSER_LIMITS.windowMinWidth, `Width must be at least ${BROWSER_LIMITS.windowMinWidth}`)
      .max(BROWSER_LIMITS.windowMaxWidth, `Width can be at most ${BROWSER_LIMITS.windowMaxWidth}`)
      .optional(),
    windowHeight: z.coerce
      .number()
      .int()
      .min(BROWSER_LIMITS.windowMinHeight, `Height must be at least ${BROWSER_LIMITS.windowMinHeight}`)
      .max(BROWSER_LIMITS.windowMaxHeight, `Height can be at most ${BROWSER_LIMITS.windowMaxHeight}`)
      .optional(),
    zoomPercent: z.coerce
      .number()
      .int()
      .min(BROWSER_LIMITS.zoomMin, `Zoom must be at least ${BROWSER_LIMITS.zoomMin}%`)
      .max(BROWSER_LIMITS.zoomMax, `Zoom can be at most ${BROWSER_LIMITS.zoomMax}%`)
      .optional(),
    userAgent: z.enum(USER_AGENT_MODES).optional(),
    permissions: z
      .object({
        notifications: permissionSchema.optional(),
        media: permissionSchema.optional(),
        geolocation: permissionSchema.optional(),
        'clipboard-read': permissionSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict()

export type BrowserConfigUpdate = z.input<typeof browserConfigUpdateSchema>

/** Applies an already-validated update. Manual mode requires a chosen time zone. */
export function mergeBrowserConfig(
  base: BrowserConfig,
  update: z.infer<typeof browserConfigUpdateSchema>
): BrowserConfig {
  const next: BrowserConfig = {
    ...base,
    ...Object.fromEntries(Object.entries(update).filter(([k, v]) => v !== undefined && k !== 'permissions')),
    permissions: { ...base.permissions }
  } as BrowserConfig
  for (const [key, value] of Object.entries(update.permissions ?? {})) {
    if (value) next.permissions[key as ConfigurablePermission] = value
  }
  return next
}

/**
 * Reads a stored config leniently: each field is validated on its own, so one bad or missing
 * value falls back to its default instead of discarding the whole configuration.
 */
export function parseStoredBrowserConfig(raw: unknown): BrowserConfig {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      value = {}
    }
  }
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const config: BrowserConfig = {
    ...DEFAULT_BROWSER_CONFIG,
    permissions: { ...DEFAULT_BROWSER_CONFIG.permissions }
  }
  for (const key of Object.keys(DEFAULT_BROWSER_CONFIG) as (keyof BrowserConfig)[]) {
    if (key === 'permissions' || !(key in input)) continue
    const parsed = browserConfigUpdateSchema.safeParse({ [key]: input[key] })
    if (parsed.success) {
      ;(config as unknown as Record<string, unknown>)[key] = (parsed.data as Record<string, unknown>)[key]
    }
  }
  const perms = input.permissions
  if (perms && typeof perms === 'object') {
    for (const key of CONFIGURABLE_PERMISSIONS) {
      const v = (perms as Record<string, unknown>)[key]
      if (v === 'allow' || v === 'block') config.permissions[key] = v
    }
  }
  if (config.timezoneMode === 'manual' && !config.timezoneManual) config.timezoneMode = 'off'
  return config
}

/** Checks rules that span several fields. Returns a message, or null when valid. */
export function browserConfigProblem(config: BrowserConfig): string | null {
  if (config.timezoneMode === 'manual' && !config.timezoneManual) {
    return 'Choose a time zone for Manual mode.'
  }
  return null
}

/**
 * Builds the "chrome" User-Agent from Electron's real one by removing only the Electron and app
 * name tokens. The Chromium version and platform stay exactly as installed.
 */
export function chromeUserAgent(electronUserAgent: string, appName: string): string {
  const appToken = appName.replace(/\s+/g, '')
  return electronUserAgent
    .split(' ')
    .filter((token) => !/^Electron\//.test(token) && !(appToken && token.startsWith(`${appToken}/`)))
    .filter((token) => !/^proxy-own-browser\//i.test(token))
    .join(' ')
}

/**
 * Ordered language list for a language tag, e.g. `bn-BD,bn,en`. Chromium adds the q-values to
 * the Accept-Language header itself and uses the same list for navigator.languages.
 */
export function acceptLanguageFor(tag: string): string {
  const base = tag.split('-')[0]!
  const parts = [tag]
  if (base !== tag) parts.push(base)
  if (base !== 'en') parts.push('en')
  return parts.join(',')
}
