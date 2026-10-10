import { contextBridge } from 'electron'
import { browserApi } from './browserApi'
import { dashboardApi } from './dashboardApi'

/**
 * Single preload for the app's own pages (bundled as one file, as sandboxed preloads
 * cannot load extra chunks). Each page only receives the API it needs, and the main
 * process independently verifies the sender of every IPC call.
 *
 * The page name comes from `additionalArguments` set by the main process (see pages.ts).
 * Website content never gets this preload — it runs in a separate WebContentsView.
 */
const page = process.argv.find((arg) => arg.startsWith('--pob-page='))?.slice('--pob-page='.length)

if (page === 'dashboard') {
  contextBridge.exposeInMainWorld('pob', dashboardApi)
} else if (page === 'browser') {
  contextBridge.exposeInMainWorld('pobBrowser', browserApi)
}
