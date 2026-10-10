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
}

export type ProfileUpdate = Partial<ProfileInput>

export const SEARCH_ENGINES = {
  google: { label: 'Google', template: 'https://www.google.com/search?q=%s' },
  duckduckgo: { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  bing: { label: 'Bing', template: 'https://www.bing.com/search?q=%s' }
} as const
export type SearchEngineId = keyof typeof SEARCH_ENGINES

export interface AppSettings {
  homepage: string
  searchEngine: SearchEngineId
  /** Maximum number of profile windows open at the same time. */
  maxOpenProfiles: number
  confirmBeforeDelete: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  homepage: 'https://www.google.com/',
  searchEngine: 'google',
  maxOpenProfiles: 2,
  confirmBeforeDelete: true
}

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

export interface ResourceUsage {
  /** Total memory used by all app processes, in MB. */
  totalMemoryMb: number
  processCount: number
  openWindows: number
  openTabs: number
  /** Configured limit on profile windows open at the same time. */
  maxOpenProfiles: number
}

/** Uniform response envelope for every IPC call. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
