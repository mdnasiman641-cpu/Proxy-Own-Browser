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
  ProfileUpdate
} from './types'

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
  openDataFolder: 'app:open-data-folder'
} as const

/** Invoke channels callable from a profile window toolbar. */
export const BrowserChannels = {
  getState: 'nav:get-state',
  navigate: 'nav:navigate',
  back: 'nav:back',
  forward: 'nav:forward',
  reload: 'nav:reload',
  stop: 'nav:stop',
  home: 'nav:home'
} as const

/** Events pushed from the main process to renderers. */
export const Events = {
  profilesChanged: 'event:profiles-changed',
  openProfilesChanged: 'event:open-profiles-changed',
  navigationState: 'event:navigation-state',
  focusAddressBar: 'event:focus-address-bar'
} as const

export interface DashboardApi {
  listProfiles(query?: string): Promise<IpcResult<Profile[]>>
  createProfile(input: ProfileInput): Promise<IpcResult<Profile>>
  updateProfile(id: string, update: ProfileUpdate): Promise<IpcResult<Profile>>
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
  onState(listener: (state: NavigationState) => void): () => void
  onFocusAddressBar(listener: () => void): () => void
}
