import type {
  AppInfo,
  AppSettings,
  BackupExportResult,
  BackupImportResult,
  DeleteProfileOptions,
  IpcResult,
  NavigationState,
  Profile,
  ProfileInput,
  ProfileUpdate,
  ProxyInput,
  ProxyTestResult,
  ResourceUsage,
  BulkCreatePlan,
  BulkCreateSpec,
  BulkItemResult,
  BulkSummary,
  DeleteDataScope,
  ProfileGroup,
  ProfileRuntimeStatus,
  ProfileTag,
  ProfileTemplate,
  TemplateInput,
  BackupFileInfo,
  BackupHistoryEntry,
  ProfileBackupStatus,
  BrowserTimezoneReport,
  BackupVerifyResult,
  DuplicateRequest,
  DuplicateResult,
  FullBackupOutcome,
  FullBackupRequest,
  PendingJob,
  ProfileNetworkStatus,
  ProxyConflict,
  RestoreOutcome,
  RestoreRequest,
  RuntimeInfo,
  SaveProfileOptions,
  ClearDataKind,
  ClearDataResult,
  CookieSummary,
  LaunchReport,
  ProfileEffectiveConfig,
  ProfileExtension,
  ProfileStorageInfo
} from './types'
import type { ProfileDiagnostics } from './diagnostics'

/** Invoke channels callable from the dashboard window. */
export const DashboardChannels = {
  listProfiles: 'profiles:list',
  createProfile: 'profiles:create',
  updateProfile: 'profiles:update',
  deleteProfile: 'profiles:delete',
  openProfile: 'profiles:open',
  closeProfile: 'profiles:close',
  openProfileIds: 'profiles:open-ids',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  exportBackup: 'backup:export',
  importBackup: 'backup:import',
  appInfo: 'app:info',
  openDataFolder: 'app:open-data-folder',
  testProxy: 'proxy:test',
  resourceUsage: 'app:resource-usage',
  profileStatuses: 'profiles:statuses',
  listGroups: 'groups:list',
  createGroup: 'groups:create',
  updateGroup: 'groups:update',
  deleteGroup: 'groups:delete',
  listTags: 'tags:list',
  createTag: 'tags:create',
  renameTag: 'tags:rename',
  deleteTag: 'tags:delete',
  listTemplates: 'templates:list',
  createTemplate: 'templates:create',
  updateTemplate: 'templates:update',
  duplicateTemplate: 'templates:duplicate',
  deleteTemplate: 'templates:delete',
  planBulkCreate: 'bulk:plan-create',
  bulkCreate: 'bulk:create',
  bulkOpen: 'bulk:open',
  bulkClose: 'bulk:close',
  bulkAssignGroup: 'bulk:assign-group',
  bulkChangeTags: 'bulk:change-tags',
  bulkExport: 'bulk:export',
  bulkDelete: 'bulk:delete',
  proxyConflicts: 'proxy:conflicts',
  duplicateProfile: 'profiles:duplicate',
  checkNetwork: 'network:check',
  runDiagnostics: 'network:diagnostics',
  networkStatuses: 'network:statuses',
  runtimeInfo: 'app:runtime-info',
  reportedTimezones: 'network:reported-timezones',
  chooseBackupFolder: 'backups:choose-folder',
  openBackupFolder: 'backups:open-folder',
  backupMetadata: 'backups:metadata',
  backupFull: 'backups:full',
  listBackups: 'backups:list',
  chooseBackupFile: 'backups:choose-file',
  verifyBackup: 'backups:verify',
  restoreBackup: 'backups:restore',
  backupHistory: 'backups:history',
  backupStatus: 'backups:status',
  pendingJobs: 'jobs:pending',
  cancelJob: 'jobs:cancel',
  startupNotes: 'jobs:startup-notes',
  restartApp: 'app:restart',
  effectiveConfig: 'profiles:effective-config',
  launchReport: 'profiles:launch-report',
  reopenProfile: 'profiles:reopen',
  exportProfileConfig: 'profiles:export-config',
  chooseDownloadFolder: 'profiles:choose-download-folder',
  listExtensions: 'extensions:list',
  addExtension: 'extensions:add',
  setExtensionEnabled: 'extensions:set-enabled',
  removeExtension: 'extensions:remove',
  storageInfo: 'data:storage-info',
  listCookies: 'data:cookies',
  clearProfileData: 'data:clear'
} as const

/** Invoke channels callable from a profile window toolbar. */
export const BrowserChannels = {
  getState: 'nav:get-state',
  navigate: 'nav:navigate',
  back: 'nav:back',
  forward: 'nav:forward',
  reload: 'nav:reload',
  stop: 'nav:stop',
  home: 'nav:home',
  newTab: 'tabs:new',
  closeTab: 'tabs:close',
  activateTab: 'tabs:activate'
} as const

/** Events pushed from the main process to renderers. */
export const Events = {
  profilesChanged: 'event:profiles-changed',
  openProfilesChanged: 'event:open-profiles-changed',
  navigationState: 'event:navigation-state',
  focusAddressBar: 'event:focus-address-bar',
  profileStatusesChanged: 'event:profile-statuses-changed',
  catalogChanged: 'event:catalog-changed',
  networkStatusChanged: 'event:network-status-changed',
  backupProgress: 'event:backup-progress',
  launchReportChanged: 'event:launch-report-changed'
} as const

export interface BackupProgress {
  profileId: string
  doneBytes: number
  totalBytes: number
}

export interface DashboardApi {
  listProfiles(query?: string): Promise<IpcResult<Profile[]>>
  createProfile(input: ProfileInput, options?: SaveProfileOptions): Promise<IpcResult<Profile>>
  updateProfile(id: string, update: ProfileUpdate, options?: SaveProfileOptions): Promise<IpcResult<Profile>>
  deleteProfile(id: string, options: DeleteProfileOptions): Promise<IpcResult<void>>
  openProfile(id: string): Promise<IpcResult<void>>
  closeProfile(id: string): Promise<IpcResult<void>>
  openProfileIds(): Promise<IpcResult<string[]>>
  getSettings(): Promise<IpcResult<AppSettings>>
  updateSettings(update: Partial<AppSettings>): Promise<IpcResult<AppSettings>>
  exportBackup(): Promise<IpcResult<BackupExportResult>>
  importBackup(): Promise<IpcResult<BackupImportResult>>
  appInfo(): Promise<IpcResult<AppInfo>>
  openDataFolder(): Promise<IpcResult<void>>
  /**
   * Makes a real request through a proxy. Pass only `profileId` to test the saved proxy,
   * or a `draft` to test unsaved form values (profileId may be null for a new profile).
   */
  testProxy(profileId: string | null, draft?: ProxyInput): Promise<IpcResult<ProxyTestResult>>
  resourceUsage(): Promise<IpcResult<ResourceUsage>>
  profileStatuses(): Promise<IpcResult<Record<string, ProfileRuntimeStatus>>>

  listGroups(): Promise<IpcResult<ProfileGroup[]>>
  createGroup(input: { name: string; color?: string }): Promise<IpcResult<ProfileGroup>>
  updateGroup(id: string, input: { name?: string; color?: string }): Promise<IpcResult<ProfileGroup>>
  /** Deletes the group only; its profiles become ungrouped. Returns how many were ungrouped. */
  deleteGroup(id: string): Promise<IpcResult<number>>
  listTags(): Promise<IpcResult<ProfileTag[]>>
  createTag(name: string): Promise<IpcResult<ProfileTag>>
  renameTag(id: string, name: string): Promise<IpcResult<ProfileTag>>
  deleteTag(id: string): Promise<IpcResult<number>>

  listTemplates(): Promise<IpcResult<(ProfileTemplate & { problems: string[] })[]>>
  createTemplate(input: TemplateInput): Promise<IpcResult<ProfileTemplate>>
  updateTemplate(id: string, input: TemplateInput): Promise<IpcResult<ProfileTemplate>>
  duplicateTemplate(id: string): Promise<IpcResult<ProfileTemplate>>
  deleteTemplate(id: string): Promise<IpcResult<void>>

  planBulkCreate(spec: BulkCreateSpec): Promise<IpcResult<BulkCreatePlan>>
  /** Creates the given names from the plan (call in chunks to show progress). Never opens them. */
  bulkCreate(spec: BulkCreateSpec, names: string[]): Promise<IpcResult<BulkItemResult[]>>
  bulkOpen(ids: string[]): Promise<IpcResult<BulkSummary>>
  bulkClose(ids: string[]): Promise<IpcResult<BulkSummary>>
  bulkAssignGroup(ids: string[], groupId: string | null): Promise<IpcResult<BulkSummary>>
  bulkChangeTags(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<IpcResult<BulkSummary>>
  /** Saves the selected profiles' metadata to a file chosen by the user. */
  bulkExport(ids: string[]): Promise<IpcResult<{ saved: boolean; filePath?: string; profileCount: number }>>
  bulkDelete(ids: string[], scope: DeleteDataScope): Promise<IpcResult<BulkSummary>>

  /** Other profiles using the same proxy endpoint (host, port and username). */
  proxyConflicts(
    profileId: string | null,
    proxy: { host: string; port: number; username?: string | null }
  ): Promise<IpcResult<ProxyConflict[]>>
  duplicateProfile(id: string, request: DuplicateRequest, options?: SaveProfileOptions): Promise<IpcResult<DuplicateResult>>
  /**
   * Proxy check + public IP + IP location through the profile's saved proxy (stored). Without
   * `force` the location is reused when the exit IP is unchanged ("Refresh IP"); with it the
   * location is always looked up again ("Refresh location").
   */
  checkNetwork(id: string, options?: { force?: boolean }): Promise<IpcResult<ProfileNetworkStatus>>
  networkStatuses(): Promise<IpcResult<Record<string, ProfileNetworkStatus>>>
  /**
   * Proxy, DNS, page-reported values and WebRTC tests for one profile. The STUN test contacts a
   * public STUN server and only runs when `stun` is true (the user asked for it).
   */
  runDiagnostics(id: string, options: { stun: boolean }): Promise<IpcResult<ProfileDiagnostics>>
  runtimeInfo(): Promise<IpcResult<RuntimeInfo>>
  /** Time zones reported by the pages of open profile windows (read inside each window). */
  reportedTimezones(): Promise<IpcResult<Record<string, BrowserTimezoneReport>>>

  chooseBackupFolder(): Promise<IpcResult<AppSettings | null>>
  openBackupFolder(): Promise<IpcResult<void>>
  backupMetadata(ids: string[] | 'all'): Promise<IpcResult<BackupHistoryEntry>>
  backupFull(request: FullBackupRequest): Promise<IpcResult<FullBackupOutcome[]>>
  listBackups(): Promise<IpcResult<BackupFileInfo[]>>
  /** Lets the user pick a backup file anywhere on this PC. */
  chooseBackupFile(): Promise<IpcResult<BackupFileInfo | null>>
  verifyBackup(path: string, password?: string): Promise<IpcResult<BackupVerifyResult>>
  restoreBackup(request: RestoreRequest): Promise<IpcResult<RestoreOutcome>>
  backupHistory(profileId?: string): Promise<IpcResult<BackupHistoryEntry[]>>
  backupStatus(): Promise<IpcResult<Record<string, ProfileBackupStatus>>>
  pendingJobs(): Promise<IpcResult<PendingJob[]>>
  cancelJob(id: string): Promise<IpcResult<void>>
  /** Results of tasks that ran when the app started (scheduled backups/restores). */
  startupNotes(): Promise<IpcResult<string[]>>
  restartApp(): Promise<IpcResult<void>>

  /** Saved, stored and (when open) applied configuration of a profile. */
  effectiveConfig(id: string): Promise<IpcResult<ProfileEffectiveConfig>>
  launchReport(id: string): Promise<IpcResult<LaunchReport | null>>
  /** Closes and reopens an open profile so start-only settings apply. */
  reopenProfile(id: string): Promise<IpcResult<void>>
  /** Saves this profile's configuration (no password, no browser data) to a JSON file. */
  exportProfileConfig(id: string): Promise<IpcResult<{ saved: boolean; filePath?: string }>>
  /** Folder picker for the profile's download folder; returns the chosen path or null. */
  chooseDownloadFolder(): Promise<IpcResult<string | null>>
  listExtensions(id: string): Promise<IpcResult<ProfileExtension[]>>
  /** Opens a folder picker and installs the chosen unpacked extension into this profile. */
  addExtension(id: string): Promise<IpcResult<{ extension: ProfileExtension; warnings: string[]; loadError: string | null } | null>>
  setExtensionEnabled(id: string, extensionId: string, enabled: boolean): Promise<IpcResult<ProfileExtension>>
  removeExtension(id: string, extensionId: string): Promise<IpcResult<void>>
  storageInfo(id: string): Promise<IpcResult<ProfileStorageInfo>>
  /** Cookies of this profile only (names and domains; values are never sent). */
  listCookies(id: string): Promise<IpcResult<CookieSummary[]>>
  clearProfileData(id: string, kind: ClearDataKind, origin?: string | null): Promise<IpcResult<ClearDataResult>>
  onLaunchReportChanged(listener: (profileId: string) => void): () => void

  onNetworkStatusChanged(listener: (profileId: string) => void): () => void
  onBackupProgress(listener: (progress: BackupProgress) => void): () => void
  onProfileStatusesChanged(listener: (statuses: Record<string, ProfileRuntimeStatus>) => void): () => void
  onCatalogChanged(listener: () => void): () => void
  onProfilesChanged(listener: () => void): () => void
  onOpenProfilesChanged(listener: (ids: string[]) => void): () => void
}

export interface BrowserApi {
  getState(): Promise<IpcResult<NavigationState>>
  navigate(input: string): Promise<IpcResult<void>>
  back(): Promise<IpcResult<void>>
  forward(): Promise<IpcResult<void>>
  reload(): Promise<IpcResult<void>>
  stop(): Promise<IpcResult<void>>
  home(): Promise<IpcResult<void>>
  newTab(input?: string): Promise<IpcResult<void>>
  closeTab(tabId: string): Promise<IpcResult<void>>
  activateTab(tabId: string): Promise<IpcResult<void>>
  onState(listener: (state: NavigationState) => void): () => void
  onFocusAddressBar(listener: () => void): () => void
}
