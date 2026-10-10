import { readFile, stat, writeFile } from 'node:fs/promises'
import {
  app,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { BrowserChannels, DashboardChannels } from '@shared/ipc'
import type {
  AppInfo,
  AppSettings,
  BackupExportResult,
  BackupImportResult,
  IpcResult,
  ProfileInput,
  ProfileUpdate,
  ProxyInput
} from '@shared/types'
import {
  ValidationError,
  addressInputSchema,
  deleteOptionsSchema,
  nullableProfileIdSchema,
  optionalAddressSchema,
  parseOrThrow,
  profileIdSchema,
  tabIdSchema
} from '@shared/validation'
import { MAX_BACKUP_BYTES, createBackup, parseBackup } from '../services/backupService'
import type { Logger } from '../services/logger'
import { NotFoundError, type ProfileService } from '../services/profileService'
import type { SecretCipher } from '../services/secretCipher'
import type { SettingsService } from '../services/settingsService'
import { isAppFrame } from './pages'
import type { ProfileWindow, ProfileWindowManager } from './profileWindows'
import type { ProxyTester } from './proxyTester'
import type { SessionManager } from './sessionManager'

export interface IpcDeps {
  profiles: ProfileService
  settings: SettingsService
  sessions: SessionManager
  windows: ProfileWindowManager
  cipher: SecretCipher
  proxyTester: ProxyTester
  logger: Logger
  getDashboard: () => BrowserWindow | null
  notifyProfilesChanged: () => void
}

class UntrustedSenderError extends Error {}

const USER_FACING = [ValidationError, NotFoundError]

function respond<T>(channel: string, logger: Logger, run: () => Promise<T> | T): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(run)
    .then((data) => ({ ok: true as const, data }))
    .catch((error: unknown) => {
      if (USER_FACING.some((type) => error instanceof type)) {
        return { ok: false as const, error: (error as Error).message }
      }
      if (error instanceof UntrustedSenderError) {
        logger.warn(`Rejected IPC call on ${channel} from an untrusted sender`)
        return { ok: false as const, error: 'Not allowed' }
      }
      logger.error(`IPC ${channel} failed`, error)
      return { ok: false as const, error: 'Something went wrong. Details were written to the log file.' }
    })
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { profiles, settings, windows, logger } = deps

  /** Dashboard channels: only the dashboard window's own page may call them. */
  const dashboard = <T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
      respond(channel, logger, () => {
        const main = deps.getDashboard()
        if (!main || event.sender.id !== main.webContents.id || !isAppFrame(event.senderFrame)) {
          throw new UntrustedSenderError()
        }
        return fn(...args)
      })
    )
  }

  /** Toolbar channels: only the toolbar page of an open profile window may call them. */
  const toolbar = <T>(channel: string, fn: (entry: ProfileWindow, ...args: unknown[]) => T): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
      respond(channel, logger, () => {
        const entry = windows.findByToolbar(event.sender)
        if (!entry || !isAppFrame(event.senderFrame)) throw new UntrustedSenderError()
        return fn(entry, ...args)
      })
    )
  }

  dashboard(DashboardChannels.listProfiles, (query) => profiles.list(query as string | undefined))

  dashboard(DashboardChannels.createProfile, (input) => {
    const profile = profiles.create(input as ProfileInput)
    logger.info(`Created profile ${profile.id}`)
    deps.notifyProfilesChanged()
    return profile
  })

  dashboard(DashboardChannels.updateProfile, async (id, update) => {
    const profile = profiles.update(parseOrThrow(profileIdSchema, id), update as ProfileUpdate)
    logger.info(`Updated profile ${profile.id}`)
    await windows.profileUpdated(profile)
    deps.notifyProfilesChanged()
    return profile
  })

  dashboard(DashboardChannels.deleteProfile, async (id, options) => {
    const profileId = parseOrThrow(profileIdSchema, id)
    const { clearData } = parseOrThrow(deleteOptionsSchema, options)
    if (windows.isOpen(profileId)) {
      throw new ValidationError('Close this profile window before deleting the profile.')
    }
    const removed = profiles.delete(profileId)
    if (clearData) await deps.sessions.clearData(removed.partition)
    logger.info(`Deleted profile ${removed.id} (session data ${clearData ? 'cleared' : 'kept'})`)
    deps.notifyProfilesChanged()
  })

  dashboard(DashboardChannels.openProfile, async (id) => {
    const outcome = await windows.open(parseOrThrow(profileIdSchema, id))
    if (outcome === 'opened') deps.notifyProfilesChanged()
  })

  dashboard(DashboardChannels.closeProfile, (id) => {
    windows.close(parseOrThrow(profileIdSchema, id))
  })

  dashboard(DashboardChannels.openProfileIds, () => windows.openIds())

  dashboard(DashboardChannels.getSettings, () => settings.get())

  dashboard(DashboardChannels.updateSettings, (update) => {
    const result = settings.update(update as Partial<AppSettings>)
    logger.info('Updated application settings')
    return result
  })

  dashboard(DashboardChannels.exportBackup, async (): Promise<BackupExportResult> => {
    const all = profiles.list()
    const date = new Date().toISOString().slice(0, 10)
    const parent = deps.getDashboard()
    const options = {
      title: 'Export profile backup',
      defaultPath: `proxy-own-browser-backup-${date}.json`,
      filters: [{ name: 'Backup file', extensions: ['json'] }]
    }
    const choice = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return { saved: false, profileCount: all.length }
    const backup = createBackup(
      all.map((p) => profiles.toPortable(p)),
      settings.get(),
      app.getVersion()
    )
    await writeFile(choice.filePath, JSON.stringify(backup, null, 2), 'utf8')
    logger.info(`Exported backup with ${all.length} profile(s)`)
    return { saved: true, filePath: choice.filePath, profileCount: all.length }
  })

  dashboard(DashboardChannels.importBackup, async (): Promise<BackupImportResult> => {
    const parent = deps.getDashboard()
    const options = {
      title: 'Restore profiles from backup',
      properties: ['openFile' as const],
      filters: [{ name: 'Backup file', extensions: ['json'] }]
    }
    const choice = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const filePath = choice.filePaths[0]
    if (choice.canceled || !filePath) {
      return { imported: 0, renamed: [], skipped: 0, cancelled: true }
    }
    if ((await stat(filePath)).size > MAX_BACKUP_BYTES) {
      throw new ValidationError('Backup file is too large')
    }
    const parsed = parseBackup(await readFile(filePath, 'utf8'))
    const summary = profiles.importProfiles(parsed.profiles)
    if (Object.keys(parsed.settings).length) settings.update(parsed.settings)
    logger.info(`Restored backup: ${summary.imported} imported, ${summary.skipped} skipped`)
    deps.notifyProfilesChanged()
    return { ...summary, cancelled: false }
  })

  dashboard(DashboardChannels.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    platform: `${process.platform} ${process.arch}`,
    userDataPath: app.getPath('userData'),
    secureStorageAvailable: deps.cipher.isSecure
  }))

  dashboard(DashboardChannels.openDataFolder, async () => {
    const error = await shell.openPath(app.getPath('userData'))
    if (error) throw new ValidationError(`Could not open the data folder: ${error}`)
  })

  dashboard(DashboardChannels.testProxy, (id, draft) => {
    const profileId = parseOrThrow(nullableProfileIdSchema, id ?? null)
    const target = profiles.resolveProxyTestTarget(profileId, draft as ProxyInput | undefined)
    const key = `${draft ? 'draft' : 'saved'}-${profileId ?? 'new'}`
    return deps.proxyTester.test(key, target)
  })

  dashboard(DashboardChannels.resourceUsage, () => windows.resourceUsage())

  toolbar(BrowserChannels.getState, (entry) => windows.state(entry))
  toolbar(BrowserChannels.navigate, (entry, input) => {
    windows.navigate(entry, parseOrThrow(addressInputSchema, input))
  })
  toolbar(BrowserChannels.back, (entry) => windows.back(entry))
  toolbar(BrowserChannels.forward, (entry) => windows.forward(entry))
  toolbar(BrowserChannels.reload, (entry) => windows.reload(entry))
  toolbar(BrowserChannels.stop, (entry) => windows.stop(entry))
  toolbar(BrowserChannels.home, (entry) => windows.goHome(entry))
  toolbar(BrowserChannels.newTab, (entry, input) => {
    windows.newTab(entry, parseOrThrow(optionalAddressSchema, input ?? undefined))
  })
  toolbar(BrowserChannels.closeTab, (entry, tabId) => {
    windows.closeTab(entry, parseOrThrow(tabIdSchema, tabId))
  })
  toolbar(BrowserChannels.activateTab, (entry, tabId) => {
    windows.activateTab(entry, parseOrThrow(tabIdSchema, tabId))
  })
}
