import { freemem, totalmem } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, type Session } from 'electron'
import { Events } from '@shared/ipc'
import { BackupCenter } from './services/backupCenter'
import { BulkCreator } from './services/bulkCreate'
import { CatalogService } from './services/catalogService'
import { AppDatabase } from './services/database'
import { createFileLogger, type Logger } from './services/logger'
import { ProfileRepository } from './services/profileRepository'
import { ProfileService } from './services/profileService'
import { MetadataBackupService } from './services/metadataBackup'
import { NetworkService } from './services/networkService'
import { assessPressure } from './services/resourcePressure'
import { SettingsService } from './services/settingsService'
import { TemplateService } from './services/templateService'
import { loadSqlJs } from './services/sqlite'
import { createDashboardWindow } from './electron/dashboardWindow'
import { ElectronSafeStorageCipher } from './electron/electronCipher'
import { registerIpcHandlers } from './electron/ipcHandlers'
import { ProfileWindowManager } from './electron/profileWindows'
import { ProxyTester } from './electron/proxyTester'
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
  const { db, recoveredFrom, migratedFrom, preMigrationBackup } = AppDatabase.open(
    SQL,
    join(userData, 'data', 'profiles.sqlite')
  )
  if (recoveredFrom) {
    logger.warn(`Database was unreadable and has been moved to ${recoveredFrom}`)
  }
  if (migratedFrom !== undefined) {
    logger.info(`Upgraded database from schema ${migratedFrom} to ${db.schemaVersion}; copy kept at ${preMigrationBackup}`)
  }

  const cipher = new ElectronSafeStorageCipher()
  const catalog = new CatalogService(db)
  const settings = new SettingsService(db)
  const profiles = new ProfileService(new ProfileRepository(db), cipher, {
    catalog,
    requireUniqueProxy: () => settings.get().requireUniqueProxy
  })
  const templates = new TemplateService(db, catalog, profiles)
  const bulkCreator = new BulkCreator(profiles, catalog, templates)
  const backups = new MetadataBackupService(profiles, catalog, templates, settings)
  const sessions = new SessionManager(userData, logger)
  const proxyTester = new ProxyTester(logger, proxyTesterOptions())
  const network = new NetworkService({
    db,
    profiles,
    checker: proxyTester,
    geoEnabled: () => settings.get().ipGeolocation,
    logger
  })
  let windowsRef: { isOpen(id: string): boolean } | null = null
  const backupCenter = new BackupCenter({
    userDataPath: userData,
    db,
    profiles,
    catalog,
    metadata: backups,
    settings,
    cipher,
    isLoadedThisRun: (partition) => sessions.isLoadedThisRun(partition),
    isOpen: (id) => windowsRef?.isOpen(id) ?? false,
    appVersion: app.getVersion(),
    logger
  })
  // Scheduled full backups/restores run now, before any profile session is created, so no
  // Chromium process has those profiles' files open.
  let startupNotes: string[] = []
  try {
    startupNotes = await backupCenter.runPendingJobs()
    for (const note of startupNotes) logger.info(`Start-up task: ${note}`)
  } catch (error) {
    logger.error('Scheduled start-up tasks failed', error)
    startupNotes = ['Scheduled backup/restore tasks could not run. Details are in the log file.']
  }

  const broadcast = (channel: string, payload?: unknown): void => {
    if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send(channel, payload)
  }
  const windows: ProfileWindowManager = new ProfileWindowManager({
    profiles,
    settings,
    sessions,
    logger,
    onOpenProfilesChanged: (ids) => broadcast(Events.openProfilesChanged, ids),
    onStatusesChanged: (statuses) => broadcast(Events.profileStatusesChanged, statuses),
    planLaunch: async (profileId) => {
      const plan = await network.planLaunch(profileId)
      broadcast(Events.networkStatusChanged, profileId)
      return plan
    },
    pressure: (appMemoryMb) =>
      assessPressure({
        totalMemoryMb: totalmem() / 1048576,
        freeMemoryMb: freemem() / 1048576,
        appMemoryMb,
        openWindows: windows.openIds().length,
        maxOpenProfiles: settings.get().maxOpenProfiles
      })
  })
  windowsRef = windows

  registerIpcHandlers({
    profiles,
    settings,
    sessions,
    windows,
    cipher,
    proxyTester,
    catalog,
    templates,
    bulkCreator,
    backups,
    logger,
    getDashboard: () => dashboard,
    notifyProfilesChanged: () => broadcast(Events.profilesChanged),
    notifyCatalogChanged: () => broadcast(Events.catalogChanged),
    network,
    backupCenter,
    startupNotes,
    notifyNetworkStatus: (profileId) => broadcast(Events.networkStatusChanged, profileId),
    sendBackupProgress: (progress) => broadcast(Events.backupProgress, progress)
  })

  // Diagnostics for background process failures (type, reason and exit code only).
  app.on('child-process-gone', (_event, details) => {
    logger.warn(`Background process gone: ${details.type} ${details.reason} (exit code ${details.exitCode})`)
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
      proxyTester,
      catalog,
      templates,
      bulkCreator,
      backups,
      network,
      backupCenter,
      startupNotes,
      settings,
      getDashboard: () => dashboard,
      logger
    })
  }
}

/**
 * The automated smoke test points proxy checks at a local fixture server so it can verify
 * success, timeouts and auth failures without depending on the internet. These variables
 * are ignored unless the smoke test is running.
 */
function proxyTesterOptions(): ConstructorParameters<typeof ProxyTester>[1] {
  if (!smokeStage) return {}
  const url = process.env.POB_PROXY_TEST_URL
  const geoUrl = process.env.POB_GEO_TEST_URL
  const timeout = Number(process.env.POB_PROXY_TEST_TIMEOUT_MS)
  return {
    ...(url ? { endpoints: [{ url, format: 'json' as const }] } : {}),
    ...(geoUrl ? { geoEndpoints: [{ url: geoUrl, format: 'ipwhois' as const }], geoTimeoutMs: 3000 } : {}),
    ...(timeout > 0 ? { timeoutMs: timeout } : {})
  }
}
