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
}

export type ProfileUpdate = Partial<ProfileInput>

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
}

export const DEFAULT_SETTINGS: AppSettings = {
  homepage: 'https://www.google.com/',
  searchEngine: 'google',
  maxOpenProfiles: 2,
  confirmBeforeDelete: true,
  language: 'en'
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
}

/** Uniform response envelope for every IPC call. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
