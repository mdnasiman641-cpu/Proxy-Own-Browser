import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { DashboardChannels as C, Events, type DashboardApi } from '@shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// Only these narrow functions are exposed to the page — never ipcRenderer itself.
const api: DashboardApi = {
  listProfiles: (query) => ipcRenderer.invoke(C.listProfiles, query),
  createProfile: (input) => ipcRenderer.invoke(C.createProfile, input),
  updateProfile: (id, update) => ipcRenderer.invoke(C.updateProfile, id, update),
  deleteProfile: (id, options) => ipcRenderer.invoke(C.deleteProfile, id, options),
  openProfile: (id) => ipcRenderer.invoke(C.openProfile, id),
  closeProfile: (id) => ipcRenderer.invoke(C.closeProfile, id),
  openProfileIds: () => ipcRenderer.invoke(C.openProfileIds),
  getSettings: () => ipcRenderer.invoke(C.getSettings),
  updateSettings: (update) => ipcRenderer.invoke(C.updateSettings, update),
  exportBackup: () => ipcRenderer.invoke(C.exportBackup),
  importBackup: () => ipcRenderer.invoke(C.importBackup),
  appInfo: () => ipcRenderer.invoke(C.appInfo),
  openDataFolder: () => ipcRenderer.invoke(C.openDataFolder),
  onProfilesChanged: (listener) => subscribe(Events.profilesChanged, () => listener()),
  onOpenProfilesChanged: (listener) => subscribe<string[]>(Events.openProfilesChanged, listener)
}

contextBridge.exposeInMainWorld('pob', api)
