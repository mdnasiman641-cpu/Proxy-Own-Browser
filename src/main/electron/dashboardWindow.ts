import { BrowserWindow } from 'electron'
import type { Logger } from '../services/logger'
import { appWebPreferences, loadPage, lockDownAppContents } from './pages'

export function createDashboardWindow(logger: Logger): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Proxy Own Browser',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: appWebPreferences('dashboard')
  })
  lockDownAppContents(window.webContents)
  window.once('ready-to-show', () => window.show())
  window.webContents.on('render-process-gone', (_e, details) => {
    logger.error(`Dashboard renderer gone: ${details.reason}`)
  })
  loadPage(window, 'dashboard').catch((error) => logger.error('Failed to load dashboard', error))
  return window
}
