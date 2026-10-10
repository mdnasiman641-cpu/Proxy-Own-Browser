import { contextBridge } from 'electron'
import { browserApi } from './browserApi'
import { dashboardApi } from './dashboardApi'

/**
 * Single preload for the app's own pages (bundled as one file, as sandboxed preloads
 * cannot load extra chunks). Each page only receives the API it needs, and the main
 * process independently verifies the sender of every IPC call.
 *
 * Website content never gets this preload — it runs in a separate WebContentsView.
 */
const page = window.location.pathname.split('/').pop()

if (page === 'dashboard.html') {
  contextBridge.exposeInMainWorld('pob', dashboardApi)
} else if (page === 'browser.html') {
  contextBridge.exposeInMainWorld('pobBrowser', browserApi)
}
