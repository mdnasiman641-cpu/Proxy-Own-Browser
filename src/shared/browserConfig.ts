import { z } from 'zod'

/**
 * Per-profile browser settings. Only settings the installed Electron/Chromium runtime can
 * genuinely apply are offered; nothing here changes the real PC (CPU, RAM, GPU, OS clock) and
 * nothing is designed to hide the browser from website security checks.
 */

/**
 * Site permissions a profile can set. Each maps to a permission Electron reports to the
 * session's permission handlers (camera and microphone are the two halves of `media`).
 * Everything else stays blocked.
 */
export const CONFIGURABLE_PERMISSIONS = [
  'notifications',
  'camera',
  'microphone',
  'geolocation',
  'clipboard-read',
  'midi',
  'idle-detection',
  'window-management'
] as const
export type ConfigurablePermission = (typeof CONFIGURABLE_PERMISSIONS)[number]
/** `ask`: the profile window asks once per site while it is open. */
export const PERMISSION_SETTINGS = ['block', 'ask', 'allow'] as const
export type PermissionSetting = (typeof PERMISSION_SETTINGS)[number]

/**
 * - `default`: the app's language (this PC's language).
 * - `manual`: the language tag chosen for the profile.
 * - `auto`: derived from the country of the proxy's verified public IP (see countryLanguage.ts);
 *   when the country is unknown or has no mapping, the app's language is used and the launch
 *   report says so.
 */
export const LANGUAGE_MODES = ['default', 'manual', 'auto'] as const
export type LanguageMode = (typeof LANGUAGE_MODES)[number]

/**
 * Geolocation the profile's pages receive (through `Emulation.setGeolocationOverride`), only
 * when the site is also allowed to use the location:
 * - `off`: no override — this Electron build has no location provider, so pages get no location.
 * - `auto`: the approximate coordinates of the proxy's verified public IP.
 * - `manual`: coordinates the user entered.
 */
export const GEOLOCATION_MODES = ['off', 'auto', 'manual'] as const
export type GeolocationMode = (typeof GEOLOCATION_MODES)[number]

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
 *   regular Chrome of this exact version sends.
 * - `custom`: a User-Agent string the user typed. It only changes the header and
 *   navigator.userAgent, never the engine; a version that differs from the installed one is
 *   flagged as a conflict everywhere it is shown. The app never suggests other versions.
 */
export const USER_AGENT_MODES = ['default', 'chrome', 'custom'] as const
export type UserAgentMode = (typeof USER_AGENT_MODES)[number]

/**
 * Which network interfaces WebRTC may use, applied with Chromium's own WebRTC IP handling
 * policy (the same setting Chrome exposes to extensions):
 * - `default`: Chromium's normal behaviour (local addresses are hidden behind mDNS names).
 * - `default_public_interface_only`: only the default public interface; no private addresses.
 * - `disable_non_proxied_udp`: WebRTC only through the proxy (TCP), no direct UDP. Real-time
 *   calls may stop working on sites and proxies that need UDP.
 * Changing it is always the user's choice; the app never changes it on its own.
 */
export const WEBRTC_POLICIES = ['default', 'default_public_interface_only', 'disable_non_proxied_udp'] as const
export type WebRtcPolicy = (typeof WEBRTC_POLICIES)[number]

export interface BrowserConfig {
  /** BCP 47 language tag such as `en-US` or `bn-BD`, used in `manual` language mode. */
  language: string | null
  languageMode: LanguageMode
  /**
   * Optional Accept-Language list (comma-separated language tags, most preferred first).
   * Null derives it from the language, e.g. `bn-BD,bn,en`.
   */
  acceptLanguage: string | null
  timezoneMode: TimezoneMode
  /** IANA time zone used in `manual` mode. */
  timezoneManual: string | null
  windowWidth: number
  windowHeight: number
  zoomPercent: number
  userAgent: UserAgentMode
  /** Used in `custom` User-Agent mode. */
  customUserAgent: string | null
  webrtcPolicy: WebRtcPolicy
  geolocationMode: GeolocationMode
  /** Manual coordinates (decimal degrees). */
  geoLatitude: number | null
  geoLongitude: number | null
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
  languageMode: 'default',
  acceptLanguage: null,
  userAgent: 'default',
  customUserAgent: null,
  webrtcPolicy: 'default',
  geolocationMode: 'off',
  geoLatitude: null,
  geoLongitude: null,
  permissions: {
    notifications: 'block',
    camera: 'block',
    microphone: 'block',
    geolocation: 'block',
    'clipboard-read': 'block',
    midi: 'block',
    'idle-detection': 'block',
    'window-management': 'block'
  }
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

/** Canonical form of a language tag; an invalid tag is returned unchanged (validation reports it). */
function canonicalTag(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? tag
  } catch {
    return tag
  }
}

export const languageTagSchema = z
  .string()
  .trim()
  .refine(isValidLanguageTag, { message: 'Unknown language code. Use a code such as en-US or bn-BD.', abort: true })
  .transform((tag) => canonicalTag(tag))

const permissionSchema = z.enum(PERMISSION_SETTINGS)

/** Comma-separated list of valid language tags (at most 10), normalized. */
export const acceptLanguageSchema = z
  .string()
  .trim()
  .max(200, 'Accept-Language can be at most 200 characters')
  .refine(
    (v) => {
      const parts = v.split(',').map((x) => x.trim())
      return parts.length >= 1 && parts.length <= 10 && parts.every((x) => isValidLanguageTag(x))
    },
    { message: 'Use language tags separated by commas, for example bn-BD,bn,en', abort: true }
  )
  .transform((v) => [...new Set(v.split(',').map((x) => canonicalTag(x.trim())))].join(','))

/** Printable ASCII only (what an HTTP header can carry), 20–400 characters. */
export const customUserAgentSchema = z
  .string()
  .trim()
  .min(20, 'The User-Agent is too short')
  .max(400, 'The User-Agent can be at most 400 characters')
  .regex(/^[\x20-\x7e]+$/, 'The User-Agent can only contain printable ASCII characters')

const latitudeSchema = z.number().finite().min(-90, 'Latitude must be between -90 and 90').max(90, 'Latitude must be between -90 and 90')
const longitudeSchema = z.number().finite().min(-180, 'Longitude must be between -180 and 180').max(180, 'Longitude must be between -180 and 180')

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
    languageMode: z.enum(LANGUAGE_MODES).optional(),
    acceptLanguage: acceptLanguageSchema.nullable().optional(),
    userAgent: z.enum(USER_AGENT_MODES).optional(),
    customUserAgent: customUserAgentSchema.nullable().optional(),
    webrtcPolicy: z.enum(WEBRTC_POLICIES).optional(),
    geolocationMode: z.enum(GEOLOCATION_MODES).optional(),
    geoLatitude: latitudeSchema.nullable().optional(),
    geoLongitude: longitudeSchema.nullable().optional(),
    permissions: z
      .object({
        notifications: permissionSchema.optional(),
        camera: permissionSchema.optional(),
        microphone: permissionSchema.optional(),
        /** Earlier versions: camera and microphone together. */
        media: permissionSchema.optional(),
        geolocation: permissionSchema.optional(),
        'clipboard-read': permissionSchema.optional(),
        midi: permissionSchema.optional(),
        'idle-detection': permissionSchema.optional(),
        'window-management': permissionSchema.optional()
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
  // Callers that only set a language (earlier versions, templates) mean manual mode.
  if (update.languageMode === undefined && update.language !== undefined) {
    next.languageMode = update.language ? 'manual' : next.languageMode === 'manual' ? 'default' : next.languageMode
  }
  for (const [key, value] of Object.entries(update.permissions ?? {})) {
    if (!value) continue
    if (key === 'media') {
      next.permissions.camera = value
      next.permissions.microphone = value
    } else {
      next.permissions[key as ConfigurablePermission] = value
    }
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
  const isSetting = (v: unknown): v is PermissionSetting => (PERMISSION_SETTINGS as readonly unknown[]).includes(v)
  if (perms && typeof perms === 'object') {
    // Earlier versions stored camera and microphone together as `media`.
    const legacyMedia = (perms as Record<string, unknown>).media
    if (isSetting(legacyMedia)) {
      config.permissions.camera = legacyMedia
      config.permissions.microphone = legacyMedia
    }
    for (const key of CONFIGURABLE_PERMISSIONS) {
      const v = (perms as Record<string, unknown>)[key]
      if (isSetting(v)) config.permissions[key] = v
    }
  }
  // Saved before language modes existed: a set language means manual mode.
  if (!('languageMode' in input) || !LANGUAGE_MODES.includes(input.languageMode as LanguageMode)) {
    config.languageMode = config.language ? 'manual' : 'default'
  }
  if (config.timezoneMode === 'manual' && !config.timezoneManual) config.timezoneMode = 'off'
  if (config.languageMode === 'manual' && !config.language) config.languageMode = 'default'
  if (config.userAgent === 'custom' && !config.customUserAgent) config.userAgent = 'default'
  if (config.geolocationMode === 'manual' && (config.geoLatitude === null || config.geoLongitude === null)) {
    config.geolocationMode = 'off'
  }
  return config
}

/** Checks rules that span several fields. Returns a message, or null when valid. */
export function browserConfigProblem(config: BrowserConfig): string | null {
  if (config.timezoneMode === 'manual' && !config.timezoneManual) {
    return 'Choose a time zone for Manual mode.'
  }
  if (config.languageMode === 'manual' && !config.language) return 'Choose a language for Manual language mode.'
  if (config.userAgent === 'custom' && !config.customUserAgent) return 'Enter the custom User-Agent.'
  if (config.geolocationMode === 'manual' && (config.geoLatitude === null || config.geoLongitude === null)) {
    return 'Enter latitude and longitude for manual geolocation.'
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

/** Major Chromium version in a User-Agent (`Chrome/152.0…` → 152), or null. */
export function chromeMajor(userAgent: string): number | null {
  const m = /\bChrome\/(\d+)\./.exec(userAgent)
  return m ? Number(m[1]) : null
}

/**
 * Why a custom User-Agent does not describe the installed runtime, or null when it does. The
 * User-Agent never changes the engine, so a mismatch makes sites see a version that is not real.
 */
export function userAgentConflict(custom: string, runtimeUserAgent: string): string | null {
  const real = chromeMajor(runtimeUserAgent)
  const claimed = chromeMajor(custom)
  if (claimed === null) return 'It does not name a Chrome version, but the engine is Chromium ' + (real ?? '?') + '.'
  if (real !== null && claimed !== real) {
    return `It claims Chrome ${claimed}, but the engine is Chromium ${real}. Changing the User-Agent does not change the engine.`
  }
  const realWindows = /Windows NT/.test(runtimeUserAgent)
  if (realWindows !== /Windows NT/.test(custom)) return 'It names a different operating system than the one this browser runs on.'
  return null
}

/** The User-Agent a profile's pages use, given the runtime's own default and plain-Chrome ones. */
export function effectiveUserAgent(browser: Pick<BrowserConfig, 'userAgent' | 'customUserAgent'>, runtime: { defaultUserAgent: string; chromeUserAgent: string }): string {
  if (browser.userAgent === 'custom' && browser.customUserAgent) return browser.customUserAgent
  return browser.userAgent === 'chrome' ? runtime.chromeUserAgent : runtime.defaultUserAgent
}
