import type { BrowserConfig, BrowserConfigUpdate } from './browserConfig'

/** Proxy protocols Chromium supports for per-session proxy rules. */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'] as const
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

/**
 * Proxy configuration as exposed outside the main process.
 * The password is never included — only whether one is stored.
 */
export interface ProxyConfig {
  protocol: ProxyProtocol
  host: string
  port: number
  username: string | null
  hasPassword: boolean
  bypassRules: string
}

export interface Profile {
  id: string
  name: string
  notes: string
  color: string
  startUrl: string | null
  /** Electron session partition, e.g. `persist:profile-<uuid>`. Unique and never reused. */
  partition: string
  proxy: ProxyConfig | null
  /** Group the profile belongs to, or null when ungrouped. */
  groupId: string | null
  /** Tag names, sorted alphabetically. */
  tags: string[]
  /** Language, time zone, window, zoom, User-Agent and permission settings. */
  browser: BrowserConfig
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
}

/** Proxy fields submitted from the UI. */
export interface ProxyInput {
  enabled: boolean
  protocol?: ProxyProtocol
  host?: string
  port?: number
  username?: string
  /**
   * New password. `undefined` keeps the stored password,
   * an empty string clears it.
   */
  password?: string
  bypassRules?: string
}

export interface ProfileInput {
  name: string
  notes?: string
  color?: string
  startUrl?: string | null
  proxy?: ProxyInput
  groupId?: string | null
  /** Replaces the profile's tags. Unknown tags are created. */
  tags?: string[]
  /** Changes to the profile's browser settings (fields left out keep their value). */
  browser?: BrowserConfigUpdate
}

export type ProfileUpdate = Partial<ProfileInput>

/** Options the user confirms explicitly in the UI. */
export interface SaveProfileOptions {
  /** Save even though another profile already uses the same proxy endpoint. */
  allowSharedProxy?: boolean
}

export const SEARCH_ENGINES = {
  google: { label: 'Google', template: 'https://www.google.com/search?q=%s' },
  duckduckgo: { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  bing: { label: 'Bing', template: 'https://www.bing.com/search?q=%s' }
} as const
export type SearchEngineId = keyof typeof SEARCH_ENGINES

export const UI_LANGUAGES = ['en', 'bn'] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]

export interface AppSettings {
  homepage: string
  searchEngine: SearchEngineId
  /** Maximum number of profile windows open at the same time. */
  maxOpenProfiles: number
  confirmBeforeDelete: boolean
  /** Dashboard language. English is the default. */
  language: UiLanguage
  /** Folder (on this PC) where backups are saved. null until the user chooses one. */
  backupFolder: string | null
  /** Refuse to give two profiles the same proxy endpoint unless the user confirms it. */
  requireUniqueProxy: boolean
  /** Look up country/city/time zone of the proxy's public IP after a proxy check. */
  ipGeolocation: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  homepage: 'https://www.google.com/',
  searchEngine: 'google',
  maxOpenProfiles: 2,
  confirmBeforeDelete: true,
  language: 'en',
  backupFolder: null,
  requireUniqueProxy: false,
  ipGeolocation: true
}

export interface ProfileGroup {
  id: string
  name: string
  color: string
  profileCount: number
  createdAt: string
}

export interface ProfileTag {
  id: string
  name: string
  profileCount: number
}

/** How a template sets a new profile's proxy. Passwords are never stored in a template. */
export type TemplateProxy =
  | { mode: 'none' }
  /** Copy the proxy (including its saved password) from an existing profile at creation time. */
  | { mode: 'copy-from-profile'; profileId: string }

export interface ProfileTemplate {
  id: string
  name: string
  notes: string
  /** Null means "pick the next color automatically". */
  color: string | null
  startUrl: string | null
  groupId: string | null
  tags: string[]
  proxy: TemplateProxy
  createdAt: string
  updatedAt: string
}

export interface TemplateInput {
  name: string
  notes?: string
  color?: string | null
  startUrl?: string | null
  groupId?: string | null
  tags?: string[]
  proxy?: TemplateProxy
}

/** Bulk profile creation request. Explicit fields override the template's values. */
export interface BulkCreateSpec {
  /** e.g. `Shop-{number}`. Must contain `{number}` when creating more than one profile. */
  nameTemplate: string
  count: number
  startNumber?: number
  /** Minimum digits for {number}, e.g. 3 → 001. 0 means no padding. */
  padding?: number
  templateId?: string | null
  groupId?: string | null
  /** Added to the template's tags. */
  tags?: string[]
  startUrl?: string | null
  /** Copy the proxy settings (and saved password) of this existing profile. */
  proxySourceProfileId?: string | null
  /**
   * Confirmed by the user: the created profiles may share the copied proxy even when
   * "Require unique proxy assignment" is on.
   */
  allowSharedProxy?: boolean
}

export type BulkPlanIssue = 'exists' | 'duplicate-in-batch' | 'invalid-name' | null

export interface BulkPlanItem {
  name: string
  issue: BulkPlanIssue
  message: string | null
}

export interface BulkCreatePlan {
  items: BulkPlanItem[]
  /** Problems with the settings as a whole (group, template, proxy source, limits). */
  errors: string[]
  /** True when every item can be created. */
  ready: boolean
  /** Human-readable summary of what each profile will get. */
  resolved: {
    groupName: string | null
    tags: string[]
    startUrl: string | null
    proxyLabel: string | null
    templateName: string | null
  }
}

export interface BulkItemResult {
  /** Profile id for actions on existing profiles; empty for creation failures. */
  id: string
  name: string
  ok: boolean
  /** e.g. 'opened', 'focused', 'closed', 'created', 'deleted', 'not-open'. */
  outcome: string | null
  error: string | null
}

export interface BulkSummary {
  action: string
  succeeded: number
  failed: number
  results: BulkItemResult[]
}

export type ProfileRuntimeStatus = 'closed' | 'starting' | 'running' | 'crashed'


export interface DeleteProfileOptions {
  /** Also wipe cookies, cache and storage of the profile's session. */
  clearData: boolean
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  platform: string
  userDataPath: string
  /** Whether OS-level encryption is available for stored proxy passwords. */
  secureStorageAvailable: boolean
}

export interface BackupExportResult {
  saved: boolean
  filePath?: string
  profileCount: number
}

export interface BackupImportResult {
  imported: number
  renamed: string[]
  skipped: number
  cancelled: boolean
  /** Format version of the restored file (1 = Phase 1/2 backups, 2 = with groups/tags/templates). */
  version?: number
  groupsCreated?: number
  groupsMerged?: number
  templatesImported?: number
  warnings?: string[]
}

export interface DeleteDataScope {
  /** Also delete the profile's local browser data (cookies, logins, cache, storage). */
  clearData: boolean
}

export interface NavigationState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  profileName: string
  profileColor: string
  proxyLabel: string | null
  /** Time zone applied to this window's pages, e.g. "Asia/Dhaka (automatic)"; null = this PC's. */
  timezoneLabel: string | null
  /** A warning about this window's settings (e.g. time zone could not be refreshed). */
  notice: string | null
  /** Tabs of this profile window, in display order. */
  tabs: TabState[]
  activeTabId: string | null
}

export const PROXY_TEST_STATUSES = [
  'success',
  'timeout',
  'proxy-unreachable',
  'proxy-error',
  'auth-required',
  'auth-failed',
  'dns-failed',
  'tls-error',
  'http-error',
  'invalid-response',
  'network-error',
  'invalid-config'
] as const
export type ProxyTestStatus = (typeof PROXY_TEST_STATUSES)[number]

/** Outcome of a real request made through a profile's proxy. `ok` is true only on success. */
export interface ProxyTestResult {
  ok: boolean
  status: ProxyTestStatus
  /** User-facing explanation. Never contains credentials. */
  message: string
  /** Public IP address reported by the endpoint, when the request succeeded. */
  ip: string | null
  /** Time for the successful request, in milliseconds. */
  responseTimeMs: number | null
  /** Host name of the IP-check service that was used (or last tried). */
  endpoint: string | null
  /** The route that was tested, e.g. "HTTP 1.2.3.4:8080 (auth)" or "Direct connection". */
  route: string
  testedAt: string
}

export interface TabState {
  id: string
  title: string
  url: string
  isLoading: boolean
  crashed: boolean
}

export interface ProfileResourceUsage {
  profileId: string
  name: string
  status: ProfileRuntimeStatus
  tabs: number
  /** Memory of the page processes used only by this profile, in MB. */
  memoryMb: number
  processCount: number
}

export interface ResourceUsage {
  /** Total memory used by all app processes, in MB. */
  totalMemoryMb: number
  processCount: number
  openWindows: number
  openTabs: number
  /** Configured limit on profile windows open at the same time. */
  maxOpenProfiles: number
  /**
   * Memory of processes that are not attributable to a single profile (browser, GPU, network,
   * utility, dashboard, and any process used by more than one profile), in MB.
   */
  sharedMemoryMb: number
  /** Per-profile breakdown for open profiles (page processes only). */
  profiles: ProfileResourceUsage[]
  measuredAt: string
  /** Memory warnings based on this PC's free memory and the app's own use. */
  pressure: ResourcePressure
}

/** Uniform response envelope for every IPC call. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ---------------------------------------------------------------------------------------------
// Phase 4: proxy/IP status, geolocation, backups and deferred jobs

/** Approximate location of a public IP address, as reported by the geolocation service. */
export interface IpGeolocation {
  ip: string
  country: string | null
  countryCode: string | null
  region: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  /** IANA time zone, e.g. Asia/Dhaka. */
  timezone: string | null
  /** Internet provider of the IP, when the service reports it. */
  isp: string | null
  /** Organization the IP is registered to, when reported. */
  org: string | null
  /** Autonomous system, e.g. "AS13335", when reported. */
  asn: string | null
  /** Host name of the service that answered. */
  provider: string
}

export type GeoStatus = 'success' | 'failed' | 'skipped'

/** Result of one check of a profile's network route, stored per profile. */
export interface ProfileNetworkStatus {
  profileId: string
  /** Proxy endpoint the check was made for (no credentials). */
  routeKey: string
  /** False when the profile's proxy changed after this check — the result is out of date. */
  current: boolean
  checkedAt: string
  proxy: {
    ok: boolean
    status: ProxyTestStatus
    message: string
    responseTimeMs: number | null
  }
  /** Public IP seen through the proxy, or null when it could not be determined. */
  ip: string | null
  geo: {
    status: GeoStatus
    message: string
    data: IpGeolocation | null
  }
  /** Last time zone detected successfully (kept when a later check fails). */
  lastValidTimezone: string | null
  lastValidTimezoneAt: string | null
  /** Whether lastValidTimezone was detected for the profile's current proxy. */
  lastValidTimezoneCurrent: boolean
  /** Other profiles whose latest check saw the same public IP. */
  sameExitIpAs: { id: string; name: string }[]
  /** When the location was last looked up (it is reused while the exit IP stays the same). */
  geoCheckedAt: string | null
  /** True when this check reused the stored location because the exit IP had not changed. */
  geoReused: boolean
  /** The exit IP seen before the current one, and when the change was noticed (rotating proxies). */
  previousIp: string | null
  ipChangedAt: string | null
}

/** Time zone that JavaScript in an open profile window actually reported. */
export interface BrowserTimezoneReport {
  profileId: string
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone` read from the active page. */
  reported: string
  /** What the profile is set to apply (null = this PC's time zone). */
  expected: string | null
  matches: boolean
  checkedAt: string
}

/** A profile whose proxy endpoint matches another profile's. */
export interface ProxyConflict {
  id: string
  name: string
}

export type DuplicateMode = 'settings' | 'settings-and-data'

export interface DuplicateRequest {
  name: string
  mode: DuplicateMode
  copyProxy: boolean
}

export interface DuplicateResult {
  profile: Profile
  /** For settings-and-data: whether the data was copied now or after the next restart. */
  data: 'not-requested' | 'copied' | 'scheduled'
  details: string[]
}

export type BackupKind = 'metadata' | 'full'
export type BackupScope = 'profile' | 'selected' | 'all'

/** Information shown for a backup file without decrypting it. */
export interface BackupFileInfo {
  fileName: string
  path: string
  kind: BackupKind
  sizeBytes: number
  createdAt: string | null
  appVersion: string | null
  profiles: { id: string | null; name: string }[]
  /** Result of reading the file header (full backups are verified completely with the password). */
  readable: boolean
  problem: string | null
  encrypted: boolean
}

export interface BackupVerifyResult {
  ok: boolean
  message: string
  files: number
  bytes: number
}

export interface BackupHistoryEntry {
  id: string
  profileId: string | null
  profileName: string
  kind: BackupKind | 'restore' | 'duplicate'
  status: 'success' | 'failed' | 'scheduled' | 'partial'
  fileName: string | null
  path: string | null
  sizeBytes: number | null
  sha256: string | null
  details: string
  createdAt: string
}

export interface FullBackupRequest {
  profileIds: string[]
  password: string
}

export interface FullBackupOutcome {
  profileId: string
  name: string
  status: 'success' | 'failed' | 'scheduled'
  fileName: string | null
  sizeBytes: number | null
  message: string
  included: string[]
  excluded: string[]
}

export type RestoreTarget = 'original' | 'new'

export interface RestoreRequest {
  path: string
  target: RestoreTarget
  /** Required for full (encrypted) backups. */
  password?: string
  /** For metadata backups with several profiles: which profile ids to restore (all when absent). */
  profileIds?: string[]
  /** Name for a profile restored as new (defaults to the backed-up name, renamed on clashes). */
  newName?: string
}

export interface RestoreOutcome {
  status: 'success' | 'failed' | 'scheduled'
  message: string
  profileIds: string[]
  details: string[]
}

export interface PendingJob {
  id: string
  kind: 'full-backup' | 'full-restore' | 'copy-data'
  profileId: string
  profileName: string
  createdAt: string
}

/** Real, unmodified facts about the installed runtime and this PC. */
export interface RuntimeInfo {
  electron: string
  chrome: string
  node: string
  v8: string
  defaultUserAgent: string
  chromeUserAgent: string
  host: {
    platform: string
    osRelease: string
    arch: string
    cpuModel: string
    cpuCores: number
    totalMemoryMb: number
    freeMemoryMb: number
  }
}

export interface ResourcePressure {
  level: 'ok' | 'warning' | 'high'
  messages: string[]
}
