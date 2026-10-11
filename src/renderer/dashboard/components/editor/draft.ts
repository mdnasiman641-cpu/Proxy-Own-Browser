import {
  acceptLanguageSchema,
  customUserAgentSchema,
  isValidLanguageTag,
  isValidTimeZone,
  type BrowserConfig
} from '@shared/browserConfig'
import { folderPathSchema, startupUrlSchema, type ProfileOptions } from '@shared/profileOptions'
import { proxyInputChanges } from '@shared/proxy'
import type { Profile, ProfileUpdate, ProxyInput, ProxyProtocol } from '@shared/types'
import { LIMITS, isHttpUrl, isValidProxyHost } from '@shared/validation'
import type { TKey } from '../../strings'

export interface ProxyDraft {
  enabled: boolean
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  password: string
  clearPassword: boolean
  bypass: string
}

/** Everything the editor changes before Save, as typed (strings for numeric inputs). */
export interface EditorDraft {
  name: string
  notes: string
  color: string
  startUrl: string
  groupId: string | null
  tags: string[]
  proxy: ProxyDraft
  browser: BrowserConfig
  options: ProfileOptions
  /** Text inputs kept as typed until saved. */
  language: string
  acceptLanguage: string
  timezoneManual: string
  customUserAgent: string
  geoLatitude: string
  geoLongitude: string
  startupUrls: string
}

export function draftFromProfile(profile: Profile): EditorDraft {
  const p = profile.proxy
  return {
    name: profile.name,
    notes: profile.notes,
    color: profile.color,
    startUrl: profile.startUrl ?? '',
    groupId: profile.groupId,
    tags: [...profile.tags],
    proxy: {
      enabled: Boolean(p),
      protocol: p?.protocol ?? 'http',
      host: p?.host ?? '',
      port: p ? String(p.port) : '',
      username: p?.username ?? '',
      password: '',
      clearPassword: false,
      bypass: p?.bypassRules ?? ''
    },
    browser: { ...profile.browser, permissions: { ...profile.browser.permissions } },
    options: { ...profile.options, startupUrls: [...profile.options.startupUrls] },
    language: profile.browser.language ?? '',
    acceptLanguage: profile.browser.acceptLanguage ?? '',
    timezoneManual: profile.browser.timezoneManual ?? '',
    customUserAgent: profile.browser.customUserAgent ?? '',
    geoLatitude: profile.browser.geoLatitude === null ? '' : String(profile.browser.geoLatitude),
    geoLongitude: profile.browser.geoLongitude === null ? '' : String(profile.browser.geoLongitude),
    startupUrls: profile.options.startupUrls.join('\n')
  }
}

export function buildProxyInput(draft: EditorDraft, profile: Profile): ProxyInput {
  const d = draft.proxy
  if (!d.enabled) return { enabled: false }
  const isSocks = d.protocol === 'socks4' || d.protocol === 'socks5'
  if (isSocks) {
    return { enabled: true, protocol: d.protocol, host: d.host.trim(), port: Number(d.port), username: '', password: '', bypassRules: d.bypass.trim() }
  }
  let password: string | undefined
  if (d.password) password = d.password
  else if (d.clearPassword || !profile.proxy?.hasPassword) password = ''
  return {
    enabled: true,
    protocol: d.protocol,
    host: d.host.trim(),
    port: Number(d.port),
    username: d.username.trim(),
    password,
    bypassRules: d.bypass.trim()
  }
}

const parseNumber = (text: string): number | null => {
  const value = text.trim().replace(',', '.')
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

export function startupUrlList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Field problems as translation keys, keyed by field name (empty when valid). */
export function validateDraft(draft: EditorDraft): Partial<Record<string, TKey>> {
  const errors: Partial<Record<string, TKey>> = {}
  if (!draft.name.trim()) errors.name = 'ed.err.name'
  if (draft.startUrl.trim() && !isHttpUrl(draft.startUrl.trim())) errors.startUrl = 'ed.err.url'
  const p = draft.proxy
  if (p.enabled) {
    if (!isValidProxyHost(p.host.trim())) errors.proxyHost = 'ed.err.host'
    const port = Number(p.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.proxyPort = 'ed.err.port'
    if (p.password && !p.username.trim() && p.protocol !== 'socks4' && p.protocol !== 'socks5') errors.proxyUser = 'ed.err.username'
  }
  const b = draft.browser
  if (b.timezoneMode === 'manual' && !isValidTimeZone(draft.timezoneManual.trim())) errors.timezone = 'ed.err.timezone'
  if (b.languageMode === 'manual' && !isValidLanguageTag(draft.language.trim())) errors.language = 'ed.err.language'
  if (draft.acceptLanguage.trim() && !acceptLanguageSchema.safeParse(draft.acceptLanguage).success) errors.acceptLanguage = 'ed.err.acceptLanguage'
  if (b.userAgent === 'custom' && !customUserAgentSchema.safeParse(draft.customUserAgent).success) errors.userAgent = 'ed.err.userAgent'
  if (b.geolocationMode === 'manual') {
    const lat = parseNumber(draft.geoLatitude)
    const lon = parseNumber(draft.geoLongitude)
    if (lat === null || Number.isNaN(lat) || lat < -90 || lat > 90) errors.latitude = 'ed.err.latitude'
    if (lon === null || Number.isNaN(lon) || lon < -180 || lon > 180) errors.longitude = 'ed.err.longitude'
  }
  const urls = startupUrlList(draft.startupUrls)
  if (urls.some((u) => !startupUrlSchema.safeParse(u).success)) errors.startupUrls = 'ed.err.startupUrls'
  if (urls.length > 10) errors.startupUrls = 'ed.err.startupUrlsMax'
  if (draft.options.startupMode === 'urls' && urls.length === 0) errors.startupUrls = 'ed.err.startupUrlsEmpty'
  if (draft.options.downloadMode === 'folder' && !folderPathSchema.safeParse(draft.options.downloadFolder ?? '').success) {
    errors.downloadFolder = 'ed.err.downloadFolder'
  }
  if (draft.notes.length > LIMITS.notesMax) errors.notes = 'ed.err.notes'
  return errors
}

/**
 * The update to save. The proxy is only included when it actually changes, so saving other
 * settings of an open profile never asks for the running-proxy confirmation.
 */
export function draftToUpdate(draft: EditorDraft, profile: Profile): ProfileUpdate {
  const proxy = buildProxyInput(draft, profile)
  const lat = parseNumber(draft.geoLatitude)
  const lon = parseNumber(draft.geoLongitude)
  const b = draft.browser
  const update: ProfileUpdate = {
    name: draft.name.trim(),
    notes: draft.notes,
    color: draft.color,
    startUrl: draft.startUrl.trim() || null,
    groupId: draft.groupId,
    tags: draft.tags,
    browser: {
      languageMode: b.languageMode,
      language: b.languageMode === 'manual' ? draft.language.trim() : draft.language.trim() && isValidLanguageTag(draft.language.trim()) ? draft.language.trim() : null,
      acceptLanguage: draft.acceptLanguage.trim() || null,
      timezoneMode: b.timezoneMode,
      timezoneManual:
        b.timezoneMode === 'manual' ? draft.timezoneManual.trim() : isValidTimeZone(draft.timezoneManual.trim()) ? draft.timezoneManual.trim() : null,
      windowWidth: b.windowWidth,
      windowHeight: b.windowHeight,
      zoomPercent: b.zoomPercent,
      userAgent: b.userAgent,
      customUserAgent: draft.customUserAgent.trim() ? draft.customUserAgent.trim() : null,
      webrtcPolicy: b.webrtcPolicy,
      geolocationMode: b.geolocationMode,
      geoLatitude: lat === null || Number.isNaN(lat) ? null : lat,
      geoLongitude: lon === null || Number.isNaN(lon) ? null : lon,
      permissions: { ...b.permissions }
    },
    options: {
      purpose: draft.options.purpose ?? '',
      icon: draft.options.icon ?? '',
      startupMode: draft.options.startupMode,
      startupUrls: startupUrlList(draft.startupUrls),
      confirmBeforeOpen: draft.options.confirmBeforeOpen,
      windowMode: draft.options.windowMode,
      showNameInTitle: draft.options.showNameInTitle,
      downloadMode: draft.options.downloadMode,
      downloadFolder: draft.options.downloadFolder,
      doNotTrack: draft.options.doNotTrack,
      proxyLabel: draft.options.proxyLabel ?? '',
      proxyNotes: draft.options.proxyNotes
    }
  }
  // A custom User-Agent that is not used is not kept if it would not validate.
  if (b.userAgent !== 'custom' && update.browser!.customUserAgent && !customUserAgentSchema.safeParse(update.browser!.customUserAgent).success) {
    update.browser!.customUserAgent = null
  }
  if (b.geolocationMode !== 'manual' && (update.browser!.geoLatitude === null || update.browser!.geoLongitude === null)) {
    update.browser!.geoLatitude = null
    update.browser!.geoLongitude = null
  }
  if (draft.options.downloadMode !== 'folder' && draft.options.downloadFolder === null) update.options!.downloadFolder = null
  if (proxyInputChanges(profile.proxy, proxy)) update.proxy = proxy
  return update
}

/** Stable form of the draft for "unsaved changes" detection. */
export function draftKey(draft: EditorDraft): string {
  return JSON.stringify(draft)
}

export { isHttpUrl }
