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
}

/** Uniform response envelope for every IPC call. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
