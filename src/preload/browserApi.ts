import { ipcRenderer } from 'electron'
import { BrowserChannels as C, Events, type BrowserApi } from '@shared/ipc'
import { subscribe } from './subscribe'
import type { NavigationState } from '@shared/types'

// Exposed only to the toolbar page of a profile window. Website content runs in a
// separate WebContentsView with no preload and cannot reach these functions.
export const browserApi: BrowserApi = {
  getState: () => ipcRenderer.invoke(C.getState),
  navigate: (input) => ipcRenderer.invoke(C.navigate, input),
  back: () => ipcRenderer.invoke(C.back),
  forward: () => ipcRenderer.invoke(C.forward),
  reload: () => ipcRenderer.invoke(C.reload),
  stop: () => ipcRenderer.invoke(C.stop),
  home: () => ipcRenderer.invoke(C.home),
  newTab: (input) => ipcRenderer.invoke(C.newTab, input),
  closeTab: (tabId) => ipcRenderer.invoke(C.closeTab, tabId),
  activateTab: (tabId) => ipcRenderer.invoke(C.activateTab, tabId),
  onState: (listener) => subscribe<NavigationState>(Events.navigationState, listener),
  onFocusAddressBar: (listener) => subscribe(Events.focusAddressBar, () => listener())
}
