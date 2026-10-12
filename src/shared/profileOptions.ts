import { z } from 'zod'

/**
 * Per-profile settings beyond the browser engine settings (browserConfig.ts): labels, startup,
 * window behaviour, downloads, Do Not Track and proxy notes. Stored as JSON in
 * `profiles.profile_options` with its own `configVersion`, read field by field so one damaged
 * value never resets the rest.
 */
export const PROFILE_OPTIONS_VERSION = 1

/**
 * - `start-page`: the profile's start page (or the app home page).
 * - `urls`: every URL in `startupUrls`, one tab each.
 * - `restore`: the tabs that were open when the profile window was last closed (falls back to
 *   the start page when nothing was saved).
 */
export const STARTUP_MODES = ['start-page', 'urls', 'restore'] as const
export type StartupMode = (typeof STARTUP_MODES)[number]

export const WINDOW_MODES = ['normal', 'maximized'] as const
export type WindowMode = (typeof WINDOW_MODES)[number]

/** `ask`: Chromium's save dialog (default). `folder`: save straight into `downloadFolder`. */
export const DOWNLOAD_MODES = ['ask', 'folder'] as const
export type DownloadMode = (typeof DOWNLOAD_MODES)[number]

export const OPTION_LIMITS = {
  startupUrlsMax: 10,
  purposeMax: 40,
  iconMax: 8,
  proxyLabelMax: 40,
  proxyNotesMax: 300,
  pathMax: 260,
  urlMax: 2048
} as const

export interface ProfileOptions {
  configVersion: number
  /** Free label such as "Shop", "Ads" or "Personal". */
  purpose: string | null
  /** Optional emoji or one or two characters shown instead of the initial. */
  icon: string | null
  startupMode: StartupMode
  startupUrls: string[]
  /** Ask in the dashboard before this profile is opened. */
  confirmBeforeOpen: boolean
  windowMode: WindowMode
  /** Show the profile name in the window title. */
  showNameInTitle: boolean
  downloadMode: DownloadMode
  downloadFolder: string | null
  /** Send the `DNT: 1` request header. */
  doNotTrack: boolean
  /** A name for this profile's proxy, e.g. the provider's plan. */
  proxyLabel: string | null
  proxyNotes: string
}

export const DEFAULT_PROFILE_OPTIONS: ProfileOptions = {
  configVersion: PROFILE_OPTIONS_VERSION,
  purpose: null,
  icon: null,
  startupMode: 'start-page',
  startupUrls: [],
  confirmBeforeOpen: false,
  windowMode: 'normal',
  showNameInTitle: true,
  downloadMode: 'ask',
  downloadFolder: null,
  doNotTrack: false,
  proxyLabel: null,
  proxyNotes: ''
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const label = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `${what} can be at most ${max} characters`)
    .refine((v) => !CONTROL_CHARS.test(v), `${what} contains invalid characters`)
    .transform((v) => (v === '' ? null : v))

export const startupUrlSchema = z
  .string()
  .trim()
  .min(1, 'Startup URLs cannot be empty')
  .max(OPTION_LIMITS.urlMax, 'A startup URL is too long')
  .refine((v) => isHttpUrl(v), 'Startup URLs must start with http:// or https://')

/** An absolute folder path on this PC (existence is checked when saving, in the main process). */
export const folderPathSchema = z
  .string()
  .trim()
  .min(1, 'Choose a folder')
  .max(OPTION_LIMITS.pathMax, 'The folder path is too long')
  .refine((v) => !CONTROL_CHARS.test(v), 'The folder path contains invalid characters')
  .refine((v) => /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\\\'), 'Use a full folder path, for example D:\\Downloads')

export const profileOptionsUpdateSchema = z
  .object({
    purpose: label(OPTION_LIMITS.purposeMax, 'Purpose').nullable().optional(),
    icon: z
      .string()
      .trim()
      .max(OPTION_LIMITS.iconMax, 'The icon can be one emoji or up to two characters')
      .refine((v) => !CONTROL_CHARS.test(v) && [...new Intl.Segmenter().segment(v)].length <= 2, 'The icon can be one emoji or up to two characters')
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    startupMode: z.enum(STARTUP_MODES).optional(),
    startupUrls: z
      .array(startupUrlSchema)
      .max(OPTION_LIMITS.startupUrlsMax, `At most ${OPTION_LIMITS.startupUrlsMax} startup URLs`)
      .transform((urls) => [...new Set(urls)])
      .optional(),
    confirmBeforeOpen: z.boolean().optional(),
    windowMode: z.enum(WINDOW_MODES).optional(),
    showNameInTitle: z.boolean().optional(),
    downloadMode: z.enum(DOWNLOAD_MODES).optional(),
    downloadFolder: folderPathSchema.nullable().optional(),
    doNotTrack: z.boolean().optional(),
    proxyLabel: label(OPTION_LIMITS.proxyLabelMax, 'Proxy label').nullable().optional(),
    proxyNotes: z
      .string()
      .max(OPTION_LIMITS.proxyNotesMax, `Proxy notes can be at most ${OPTION_LIMITS.proxyNotesMax} characters`)
      .optional()
  })
  .strict()

export type ProfileOptionsUpdate = z.input<typeof profileOptionsUpdateSchema>

/** Rules that span fields. Returns a message, or null when valid. */
export function profileOptionsProblem(options: ProfileOptions): string | null {
  if (options.startupMode === 'urls' && options.startupUrls.length === 0) return 'Add at least one startup URL, or choose another startup behaviour.'
  if (options.downloadMode === 'folder' && !options.downloadFolder) return 'Choose the download folder.'
  return null
}

export function mergeProfileOptions(base: ProfileOptions, update: z.infer<typeof profileOptionsUpdateSchema>): ProfileOptions {
  const next: ProfileOptions = { ...base, configVersion: PROFILE_OPTIONS_VERSION }
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value
  }
  return next
}

/** Reads stored options leniently; unknown or invalid fields fall back to their defaults. */
export function parseStoredProfileOptions(raw: unknown): ProfileOptions {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      value = {}
    }
  }
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const options: ProfileOptions = { ...DEFAULT_PROFILE_OPTIONS, startupUrls: [] }
  for (const key of Object.keys(DEFAULT_PROFILE_OPTIONS) as (keyof ProfileOptions)[]) {
    if (key === 'configVersion' || !(key in input)) continue
    if (key === 'startupUrls' && Array.isArray(input.startupUrls)) {
      // Keep the valid URLs even if one entry is damaged.
      options.startupUrls = input.startupUrls
        .filter((u): u is string => typeof u === 'string' && startupUrlSchema.safeParse(u).success)
        .slice(0, OPTION_LIMITS.startupUrlsMax)
      continue
    }
    const parsed = profileOptionsUpdateSchema.safeParse({ [key]: input[key] })
    if (parsed.success) (options as unknown as Record<string, unknown>)[key] = (parsed.data as Record<string, unknown>)[key]
  }
  if (options.startupMode === 'urls' && options.startupUrls.length === 0) options.startupMode = 'start-page'
  if (options.downloadMode === 'folder' && !options.downloadFolder) options.downloadMode = 'ask'
  return options
}
