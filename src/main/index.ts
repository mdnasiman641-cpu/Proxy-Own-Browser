import { join } from 'node:path'
import { app, BrowserWindow, dialog, type Session } from 'electron'
import { Events } from '@shared/ipc'
import { AppDatabase } from './services/database'
import { createFileLogger, type Logger } from './services/logger'
import { ProfileRepository } from './services/profileRepository'
import { ProfileService } from './services/profileService'
import { SettingsService } from './services/settingsService'
import { loadSqlJs } from './services/sqlite'
import { createDashboardWindow } from './electron/dashboardWindow'
import { ElectronSafeStorageCipher } from './electron/electronCipher'
import { registerIpcHandlers } from './electron/ipcHandlers'
import { ProfileWindowManager } from './electron/profileWindows'
import { SessionManager } from './electron/sessionManager'
import { runSmokeTest } from './smokeTest'

// Optional data-folder override (used by the automated smoke test and for portable setups).
if (process.env.POB_USER_DATA_DIR) {
  app.setPath('userData', process.env.POB_USER_DATA_DIR)
}

const smokeStage = process.env.POB_SMOKE_TEST
let dashboard: BrowserWindow | null = null
let logger: Logger = { info() {}, warn() {}, error() {} }

if (!smokeStage && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showDashboard())
  app.whenReady().then(start).catch((error: unknown) => {
    logger.error('Startup failed', error)
    dialog.showErrorBox(
      'Proxy Own Browser could not start',
      error instanceof Error ? error.message : String(error)
    )
    app.exit(1)
  })
}

function showDashboard(): void {
  if (dashboard && !dashboard.isDestroyed()) {
    if (dashboard.isMinimized()) dashboard.restore()
    dashboard.focus()
  } else {
    dashboard = createDashboardWindow(logger)
    dashboard.on('closed', () => (dashboard = null))
  }
}

async function start(): Promise<void> {
  const userData = app.getPath('userData')
  logger = createFileLogger(join(userData, 'logs'), !app.isPackaged)
  logger.info(`Starting Proxy Own Browser ${app.getVersion()} (Electron ${process.versions.electron})`)

  const SQL = await loadSqlJs()
  const { db, recoveredFrom } = AppDatabase.open(SQL, join(userData, 'data', 'profiles.sqlite'))
  if (recoveredFrom) {
    logger.warn(`Database was unreadable and has been moved to ${recoveredFrom}`)
  }

  const cipher = new ElectronSafeStorageCipher()
  const profiles = new ProfileService(new ProfileRepository(db), cipher)
  const settings = new SettingsService(db)
  const sessions = new SessionManager(userData, logger)

  const broadcast = (channel: string, payload?: unknown): void => {
    if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send(channel, payload)
  }
  const windows = new ProfileWindowManager({
    profiles,
    settings,
    sessions,
    logger,
    onOpenProfilesChanged: (ids) => broadcast(Events.openProfilesChanged, ids)
  })

  registerIpcHandlers({
    profiles,
    settings,
    sessions,
    windows,
    cipher,
    logger,
    getDashboard: () => dashboard,
    notifyProfilesChanged: () => broadcast(Events.profilesChanged)
  })

  // Answer proxy authentication challenges with the profile's own stored credentials.
  // Credentials are decrypted only here and are never logged.
  const authAttempts = new Map<string, number>()
  app.on('login', (event, webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy || !webContents) return
    const profileId = sessions.profileIdFor(webContents.session as Session)
    if (!profileId) return
    const key = `${profileId}|${authInfo.host}:${authInfo.port}`
    const attempts = authAttempts.get(key) ?? 0
    if (attempts >= 2) {
      logger.warn(`Proxy rejected the stored credentials for profile ${profileId}`)
      return // default behaviour cancels the request
    }
    let credentials
    try {
      credentials = profiles.getProxyCredentials(profileId)
    } catch {
      logger.warn(`Stored proxy password for profile ${profileId} could not be decrypted`)
      return
    }
    if (!credentials) return
    event.preventDefault()
    authAttempts.set(key, attempts + 1)
    setTimeout(() => authAttempts.delete(key), 60_000)
    callback(credentials.username, credentials.password)
  })

  // Write cookies and the database to disk before exiting.
  let shutdownDone = false
  app.on('before-quit', (event) => {
    if (shutdownDone) return
    event.preventDefault()
    shutdownDone = true
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
    void Promise.race([sessions.flushAll(), timeout]).finally(() => {
      try {
        db.close()
      } catch (error) {
        logger.error('Failed to close database', error)
      }
      logger.info('Shut down cleanly')
      app.quit()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('activate', () => showDashboard())

  showDashboard()

  if (smokeStage) {
    await runSmokeTest({
      stage: smokeStage,
      resultFile: process.env.POB_SMOKE_RESULT ?? join(userData, 'smoke-result.json'),
      profiles,
      sessions,
      windows,
      getDashboard: () => dashboard,
      logger
    })
  }
}
