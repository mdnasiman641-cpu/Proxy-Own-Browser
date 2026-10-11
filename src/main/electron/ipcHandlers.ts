import { cpus, freemem, release, totalmem } from 'node:os'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  app,
  dialog,
  ipcMain,
  screen,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { BrowserChannels, DashboardChannels, type BackupProgress } from '@shared/ipc'
import type {
  AppInfo,
  AppSettings,
  BackupExportResult,
  BackupImportResult,
  IpcResult,
  BulkCreateSpec,
  ProfileInput,
  ProfileUpdate,
  ProxyInput,
  ProxyTestResult,
  RuntimeInfo,
  ProfileEffectiveConfig,
  TemplateInput
} from '@shared/types'
import { DEFAULT_STUN_SERVER } from '@shared/diagnostics'
import { RUNNING_PROXY_CHANGE_MESSAGE, proxyInputChanges } from '@shared/proxy'
import { z } from 'zod'
import {
  ValidationError,
  addressInputSchema,
  bulkTagsChangeSchema,
  deleteOptionsSchema,
  groupIdSchema,
  groupInputSchema,
  nullableProfileIdSchema,
  optionalAddressSchema,
  parseOrThrow,
  profileIdSchema,
  profileIdsSchema,
  tabIdSchema,
  tagIdSchema,
  tagNameSchema,
  templateIdSchema,
  backupPathSchema,
  duplicateRequestSchema,
  fullBackupRequestSchema,
  restoreRequestSchema,
  saveProfileOptionsSchema,
  profileUpdateSchema
} from '@shared/validation'
import type { BackupCenter } from '../services/backupCenter'
import type { ExtensionStore } from '../services/extensionStore'
import type { ExtensionLoader } from './extensionLoader'
import type { ProfileDataService } from './profileData'
import { userAgentConflict } from '@shared/browserConfig'
import { buildDiagnostics } from '../services/diagnostics'
import { BACKUP_FORMAT, MAX_BACKUP_BYTES, parseBackup } from '../services/backupService'
import { BackupError } from '../services/fullBackupArchive'
import type { NetworkService } from '../services/networkService'
import { routeLabel } from '../services/proxyTest'
import type { BulkCreator } from '../services/bulkCreate'
import { runBulk, type BulkTarget } from '../services/bulkRunner'
import type { CatalogService } from '../services/catalogService'
import type { Logger } from '../services/logger'
import type { MetadataBackupService } from '../services/metadataBackup'
import { NotFoundError, type ProfileService } from '../services/profileService'
import type { TemplateService } from '../services/templateService'
import type { SecretCipher } from '../services/secretCipher'
import type { SettingsService } from '../services/settingsService'
import { isAppFrame } from './pages'
import type { ProfileWindow, ProfileWindowManager } from './profileWindows'
import type { ProxyTester } from './proxyTester'
import { defaultUserAgent, plainChromeUserAgent, userAgentFor, type SessionManager } from './sessionManager'

export interface IpcDeps {
  profiles: ProfileService
  settings: SettingsService
  sessions: SessionManager
  windows: ProfileWindowManager
  cipher: SecretCipher
  proxyTester: ProxyTester
  catalog: CatalogService
  templates: TemplateService
  bulkCreator: BulkCreator
  backups: MetadataBackupService
  logger: Logger
  getDashboard: () => BrowserWindow | null
  notifyProfilesChanged: () => void
  /** Groups, tags or templates changed. */
  notifyCatalogChanged: () => void
  network: NetworkService
  backupCenter: BackupCenter
  /** Results of scheduled tasks that ran at start-up. */
  startupNotes: string[]
  notifyNetworkStatus: (profileId: string) => void
  sendBackupProgress: (progress: BackupProgress) => void
  extensions: ExtensionStore
  extensionLoader: ExtensionLoader
  profileData: ProfileDataService
}

const proxyEndpointSchema = z
  .object({
    host: z.string().trim().min(1).max(253),
    port: z.coerce.number().int().min(1).max(65535),
    username: z.string().max(256).nullable().optional()
  })
  .strip()

const groupUpdateSchema = z.object({
  name: z.string().optional(),
  color: z.string().optional()
})

class UntrustedSenderError extends Error {}

const USER_FACING = [ValidationError, NotFoundError, BackupError]

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
  const { profiles, settings, windows, logger, catalog, templates } = deps

  /** Resolves validated ids to names for bulk result reporting. */
  const targets = (ids: unknown): BulkTarget[] =>
    parseOrThrow(profileIdsSchema, ids).map((id) => ({
      id,
      name: profiles.exists(id) ? profiles.get(id).name : '(deleted profile)'
    }))
  const logUnexpected = (action: string) => (item: BulkTarget, error: unknown) =>
    logger.error(`Bulk ${action} failed for profile ${item.id}`, error)

  const saveJson = async (title: string, defaultName: string, content: unknown) => {
    const parent = deps.getDashboard()
    const options = { title, defaultPath: defaultName, filters: [{ name: 'Backup file', extensions: ['json'] }] }
    const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return null
    await writeFile(choice.filePath, JSON.stringify(content, null, 2), 'utf8')
    return choice.filePath
  }

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

  dashboard(DashboardChannels.createProfile, (input, options) => {
    const { allowSharedProxy } = parseOrThrow(saveProfileOptionsSchema, options ?? undefined) ?? {}
    const profile = profiles.create(input as ProfileInput, { allowSharedProxy })
    logger.info(`Created profile ${profile.id}`)
    if (profile.proxy && profile.browser.timezoneMode === 'auto' && settings.get().ipGeolocation) {
      // Detect the new proxy's exit IP, location and time zone right away (in the background).
      void deps.network
        .check(profile.id)
        .then(() => deps.notifyNetworkStatus(profile.id))
        .catch((error) => logger.warn(`Background network check for profile ${profile.id} failed`, error))
    }
    deps.notifyProfilesChanged()
    return profile
  })

  dashboard(DashboardChannels.updateProfile, async (id, update, options) => {
    const profileId = parseOrThrow(profileIdSchema, id)
    const saveOptions = parseOrThrow(saveProfileOptionsSchema, options ?? undefined) ?? {}
    const before = profiles.get(profileId)
    const typedUpdate = update as ProfileUpdate
    if (
      windows.isOpen(profileId) &&
      !saveOptions.confirmRunningProxyChange &&
      proxyInputChanges(before.proxy, parseOrThrow(profileUpdateSchema, update).proxy as ProxyInput | undefined)
    ) {
      // Never switch an open profile's route without the user's explicit confirmation.
      throw new ValidationError(RUNNING_PROXY_CHANGE_MESSAGE)
    }
    const profile = profiles.update(profileId, typedUpdate, saveOptions)
    logger.info(`Updated profile ${profile.id}`)
    // Only this profile's session and windows are updated.
    deps.sessions.refreshBrowserSettings(profile)
    const proxyChanged = JSON.stringify(before.proxy) !== JSON.stringify(profile.proxy)
    if (proxyChanged && profile.browser.timezoneMode === 'auto' && settings.get().ipGeolocation && !windows.isOpen(profile.id)) {
      // Refresh the proxy-based time zone in the background; an open window re-checks itself.
      void deps.network
        .check(profile.id)
        .then(() => deps.notifyNetworkStatus(profile.id))
        .catch((error) => logger.warn(`Background network check for profile ${profile.id} failed`, error))
    }
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
    // The profile's own extension copies are removed with it.
    await deps.extensions.removeAll(removed.id).catch((error) => logger.warn('Could not remove the extensions of a deleted profile', error))
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
    // The backup folder can only be chosen with the folder dialog (chooseBackupFolder).
    if (update && typeof update === 'object' && 'backupFolder' in update) {
      throw new ValidationError('Choose the backup folder with the "Choose folder" button.')
    }
    const result = settings.update(update as Partial<AppSettings>)
    logger.info('Updated application settings')
    return result
  })

  dashboard(DashboardChannels.exportBackup, async (): Promise<BackupExportResult> => {
    const backup = deps.backups.buildBackup(app.getVersion())
    const date = new Date().toISOString().slice(0, 10)
    const filePath = await saveJson('Export metadata backup', `proxy-own-browser-backup-${date}.json`, backup)
    if (!filePath) return { saved: false, profileCount: backup.profiles.length }
    logger.info(`Exported metadata backup with ${backup.profiles.length} profile(s)`)
    return { saved: true, filePath, profileCount: backup.profiles.length }
  })

  dashboard(DashboardChannels.importBackup, async (): Promise<BackupImportResult> => {
    const parent = deps.getDashboard()
    const options = {
      title: 'Restore from metadata backup',
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
    // Parsing verifies structure and integrity before anything is changed.
    const parsed = parseBackup(await readFile(filePath, 'utf8'))
    const summary = deps.backups.restore(parsed)
    logger.info(
      `Restored v${parsed.version} backup: ${summary.imported} imported, ${summary.skipped} skipped, ${summary.templatesImported ?? 0} templates`
    )
    deps.notifyProfilesChanged()
    deps.notifyCatalogChanged()
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

  dashboard(DashboardChannels.testProxy, async (id, draft) => {
    const profileId = parseOrThrow(nullableProfileIdSchema, id ?? null)
    if (profileId && draft === undefined) {
      // Testing a saved proxy also stores its exit IP, location and time zone for this profile.
      const status = await deps.network.check(profileId, { force: true })
      deps.notifyNetworkStatus(profileId)
      const result: ProxyTestResult = {
        ok: status.proxy.ok,
        status: status.proxy.status,
        message: status.proxy.message,
        ip: status.ip,
        responseTimeMs: status.proxy.responseTimeMs,
        endpoint: null,
        route: routeLabel(profiles.get(profileId).proxy),
        testedAt: status.checkedAt
      }
      return result
    }
    const target = profiles.resolveProxyTestTarget(profileId, draft as ProxyInput | undefined)
    const key = `${draft ? 'draft' : 'saved'}-${profileId ?? 'new'}`
    return deps.proxyTester.test(key, target)
  })

  dashboard(DashboardChannels.resourceUsage, () => windows.resourceUsage())

  dashboard(DashboardChannels.profileStatuses, () => windows.statuses())

  // ---------- groups & tags ----------
  dashboard(DashboardChannels.listGroups, () => catalog.listGroups())
  dashboard(DashboardChannels.createGroup, (input) => {
    const group = catalog.createGroup(parseOrThrow(groupInputSchema, input))
    deps.notifyCatalogChanged()
    return group
  })
  dashboard(DashboardChannels.updateGroup, (id, input) => {
    const group = catalog.updateGroup(parseOrThrow(groupIdSchema, id), parseOrThrow(groupUpdateSchema, input))
    deps.notifyCatalogChanged()
    return group
  })
  dashboard(DashboardChannels.deleteGroup, (id) => {
    const ungrouped = catalog.deleteGroup(parseOrThrow(groupIdSchema, id))
    logger.info(`Deleted a group; ${ungrouped} profile(s) became ungrouped`)
    deps.notifyCatalogChanged()
    deps.notifyProfilesChanged()
    return ungrouped
  })
  dashboard(DashboardChannels.listTags, () => catalog.listTags())
  dashboard(DashboardChannels.createTag, (name) => {
    const tag = catalog.createTag(parseOrThrow(tagNameSchema, name))
    deps.notifyCatalogChanged()
    return tag
  })
  dashboard(DashboardChannels.renameTag, (id, name) => {
    const tag = catalog.renameTag(parseOrThrow(tagIdSchema, id), parseOrThrow(tagNameSchema, name))
    deps.notifyCatalogChanged()
    deps.notifyProfilesChanged()
    return tag
  })
  dashboard(DashboardChannels.deleteTag, (id) => {
    const removed = catalog.deleteTag(parseOrThrow(tagIdSchema, id))
    deps.notifyCatalogChanged()
    deps.notifyProfilesChanged()
    return removed
  })

  // ---------- templates ----------
  dashboard(DashboardChannels.listTemplates, () =>
    templates.list().map((t) => ({ ...t, problems: templates.problems(t) }))
  )
  dashboard(DashboardChannels.createTemplate, (input) => {
    const template = templates.create(input as TemplateInput)
    deps.notifyCatalogChanged()
    return template
  })
  dashboard(DashboardChannels.updateTemplate, (id, input) => {
    const template = templates.update(parseOrThrow(templateIdSchema, id), input as TemplateInput)
    deps.notifyCatalogChanged()
    return template
  })
  dashboard(DashboardChannels.duplicateTemplate, (id) => {
    const template = templates.duplicate(parseOrThrow(templateIdSchema, id))
    deps.notifyCatalogChanged()
    return template
  })
  dashboard(DashboardChannels.deleteTemplate, (id) => {
    templates.delete(parseOrThrow(templateIdSchema, id))
    deps.notifyCatalogChanged()
  })

  // ---------- bulk creation (never opens the new profiles) ----------
  dashboard(DashboardChannels.planBulkCreate, (spec) => deps.bulkCreator.plan(spec as BulkCreateSpec))
  dashboard(DashboardChannels.bulkCreate, (spec, names) => {
    const results = deps.bulkCreator.create(spec as BulkCreateSpec, names as string[])
    const created = results.filter((r) => r.ok).length
    logger.info(`Bulk create: ${created} created, ${results.length - created} failed`)
    if (created) {
      deps.notifyProfilesChanged()
      deps.notifyCatalogChanged()
    }
    return results
  })

  // ---------- bulk actions on selected profiles ----------
  dashboard(DashboardChannels.bulkOpen, async (ids) => {
    // Every open goes through the window coordinator, so the configured limit always applies.
    const summary = await runBulk('open', targets(ids), (item) => windows.open(item.id), logUnexpected('open'))
    logger.info(`Bulk open: ${summary.succeeded} ok, ${summary.failed} failed`)
    deps.notifyProfilesChanged()
    return summary
  })
  dashboard(DashboardChannels.bulkClose, async (ids) =>
    runBulk(
      'close',
      targets(ids),
      (item) => {
        if (!windows.isOpen(item.id)) return 'not-open'
        windows.close(item.id)
        return 'closed'
      },
      logUnexpected('close')
    )
  )
  dashboard(DashboardChannels.bulkAssignGroup, async (ids, groupId) => {
    const group = groupId === null ? null : parseOrThrow(groupIdSchema, groupId)
    catalog.assertGroupReference(group)
    const summary = await runBulk(
      'assign-group',
      targets(ids),
      async (item) => {
        await windows.profileUpdated(profiles.update(item.id, { groupId: group }))
        return group ? 'moved' : 'ungrouped'
      },
      logUnexpected('assign-group')
    )
    deps.notifyProfilesChanged()
    deps.notifyCatalogChanged()
    return summary
  })
  dashboard(DashboardChannels.bulkChangeTags, async (ids, change) => {
    const { add, remove } = parseOrThrow(bulkTagsChangeSchema, change)
    if (!add.length && !remove.length) throw new ValidationError('Choose tags to add or remove')
    const summary = await runBulk(
      'change-tags',
      targets(ids),
      (item) => {
        profiles.changeTags(item.id, add, remove)
        return 'updated'
      },
      logUnexpected('change-tags')
    )
    deps.notifyProfilesChanged()
    deps.notifyCatalogChanged()
    return summary
  })
  dashboard(DashboardChannels.bulkExport, async (ids) => {
    const selected = targets(ids).map((t) => t.id).filter((id) => profiles.exists(id))
    if (!selected.length) throw new ValidationError('The selected profiles no longer exist')
    const backup = deps.backups.buildBackup(app.getVersion(), selected)
    const date = new Date().toISOString().slice(0, 10)
    const filePath = await saveJson(
      'Export selected profiles',
      `proxy-own-browser-profiles-${date}.json`,
      backup
    )
    if (!filePath) return { saved: false, profileCount: selected.length }
    logger.info(`Exported metadata for ${selected.length} selected profile(s)`)
    return { saved: true, filePath, profileCount: selected.length }
  })
  dashboard(DashboardChannels.bulkDelete, async (ids, scope) => {
    const { clearData } = parseOrThrow(deleteOptionsSchema, scope)
    const summary = await runBulk(
      'delete',
      targets(ids),
      async (item) => {
        if (!profiles.exists(item.id)) throw new NotFoundError('Profile not found')
        if (windows.isOpen(item.id)) throw new ValidationError('Close this profile window first')
        const removed = profiles.delete(item.id)
        if (!clearData) return 'deleted'
        // Only this profile's own partition folder is touched.
        const complete = await deps.sessions.clearData(removed.partition)
        return complete ? 'deleted-with-data' : 'deleted-data-partially-removed'
      },
      logUnexpected('delete')
    )
    logger.info(
      `Bulk delete (browser data ${clearData ? 'removed' : 'kept'}): ${summary.succeeded} ok, ${summary.failed} failed`
    )
    deps.notifyProfilesChanged()
    deps.notifyCatalogChanged()
    return summary
  })

  // ---------- proxy uniqueness, duplicate, network status, runtime info ----------
  dashboard(DashboardChannels.proxyConflicts, (id, proxy) => {
    const profileId = parseOrThrow(nullableProfileIdSchema, id ?? null)
    const endpoint = parseOrThrow(proxyEndpointSchema, proxy)
    return profiles.findProxyConflicts({ host: endpoint.host, port: endpoint.port, username: endpoint.username ?? null }, profileId)
  })

  dashboard(DashboardChannels.duplicateProfile, async (id, request, options) => {
    const result = await deps.backupCenter.duplicate(
      parseOrThrow(profileIdSchema, id),
      parseOrThrow(duplicateRequestSchema, request),
      parseOrThrow(saveProfileOptionsSchema, options ?? undefined) ?? {}
    )
    logger.info(`Duplicated a profile into ${result.profile.id} (${result.data})`)
    deps.notifyProfilesChanged()
    deps.notifyCatalogChanged()
    return result
  })

  dashboard(DashboardChannels.checkNetwork, async (id, options) => {
    const profileId = parseOrThrow(profileIdSchema, id)
    const { force } = parseOrThrow(z.object({ force: z.boolean().optional() }).strict(), options ?? {})
    // "Refresh IP & location" (default) always asks the location service again; "Refresh IP"
    // (force: false) reuses the location while the exit IP is unchanged.
    const status = await deps.network.check(profileId, { force: force ?? true })
    deps.notifyNetworkStatus(profileId)
    return status
  })

  dashboard(DashboardChannels.reportedTimezones, () => windows.reportedTimezones())

  dashboard(DashboardChannels.runDiagnostics, async (id, options) => {
    const profileId = parseOrThrow(profileIdSchema, id)
    const { stun } = parseOrThrow(z.object({ stun: z.boolean() }).strict(), options ?? { stun: false })
    const profile = deps.profiles.get(profileId)
    const stunServer = stun ? DEFAULT_STUN_SERVER : null
    const pageResult = await windows.diagnosePage(profileId, stunServer)
    const report = buildDiagnostics({
      profile,
      network: deps.network.status(profileId),
      page: pageResult?.page ?? null,
      pagePartition: pageResult?.pagePartition ?? null,
      resolvedProxy: pageResult?.resolvedProxy ?? null,
      expected: pageResult?.expected ?? null,
      pageProblem: pageResult?.problem ?? null,
      systemTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      stunServer,
      now: new Date()
    })
    // Verdicts only: no addresses, cookies or page content are written to the log.
    logger.info(
      `Diagnostics for profile ${profileId}${stun ? ' (with STUN test)' : ''}: proxy ${report.proxyConnection.verdict}, route ${report.proxyRoute.verdict}, time zone ${report.timezone.verdict}, WebRTC ${report.webrtcLocal.verdict}${report.webrtcStun ? `/${report.webrtcStun.verdict}` : ''}`
    )
    return report
  })

  dashboard(DashboardChannels.networkStatuses, () => deps.network.statuses())

  dashboard(DashboardChannels.runtimeInfo, (): RuntimeInfo => {
    const cpu = cpus()
    return {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      v8: process.versions.v8,
      defaultUserAgent: defaultUserAgent(),
      chromeUserAgent: plainChromeUserAgent(),
      host: {
        platform: process.platform,
        osRelease: release(),
        arch: process.arch,
        cpuModel: cpu[0]?.model?.trim() ?? 'unknown',
        cpuCores: cpu.length,
        totalMemoryMb: Math.round(totalmem() / 1048576),
        freeMemoryMb: Math.round(freemem() / 1048576),
        screen: (() => {
          const primary = screen.getPrimaryDisplay()
          return {
            width: primary.size.width,
            height: primary.size.height,
            scaleFactor: primary.scaleFactor,
            displays: screen.getAllDisplays().length
          }
        })()
      }
    }
  })

  // ---------- advanced profile settings ----------
  dashboard(DashboardChannels.effectiveConfig, (id): ProfileEffectiveConfig => {
    const profileId = parseOrThrow(profileIdSchema, id)
    const profile = profiles.get(profileId)
    const open = windows.isOpen(profileId)
    const applied = open ? windows.emulationFor(profileId) : null
    const preview = deps.network.previewPlan(profileId)
    const userAgent = userAgentFor(profile)
    const report = windows.launchReport(profileId)
    const timezone = applied
      ? { value: applied.timezone, source: applied.timezone ? preview.timezoneSource : ('off' as const), note: null }
      : { value: preview.timezone, source: preview.timezoneSource, note: preview.timezoneNote }
    const geolocation = applied ? applied.geolocation : preview.geolocation
    return {
      profileId,
      open,
      userAgent,
      userAgentConflict: profile.browser.userAgent === 'custom' ? userAgentConflict(userAgent, defaultUserAgent()) : null,
      timezone,
      language: applied
        ? { locale: applied.locale, acceptLanguage: applied.acceptLanguage, source: preview.languageSource }
        : { locale: preview.locale, acceptLanguage: preview.acceptLanguage, source: preview.languageSource },
      geolocation: geolocation
        ? { ...geolocation, source: profile.browser.geolocationMode === 'manual' ? 'manual' : 'auto' }
        : null,
      warnings: preview.warnings,
      launchReport: report
    }
  })

  dashboard(DashboardChannels.launchReport, (id) => windows.launchReport(parseOrThrow(profileIdSchema, id)))

  dashboard(DashboardChannels.reopenProfile, async (id) => {
    const profileId = parseOrThrow(profileIdSchema, id)
    if (!windows.isOpen(profileId)) throw new ValidationError('This profile is not open.')
    await windows.reopen(profileId)
    logger.info(`Reopened profile window ${profileId} to apply start-up settings`)
  })

  dashboard(DashboardChannels.exportProfileConfig, async (id) => {
    const profileId = parseOrThrow(profileIdSchema, id)
    const profile = profiles.get(profileId)
    const backup = deps.backups.buildBackup(app.getVersion(), [profileId])
    const date = new Date().toISOString().slice(0, 10)
    const safeName = profile.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'profile'
    const filePath = await saveJson('Export profile configuration', `POB_config_${safeName}_${date}.json`, backup)
    if (!filePath) return { saved: false }
    logger.info(`Exported the configuration of profile ${profileId}`)
    return { saved: true, filePath }
  })

  dashboard(DashboardChannels.chooseDownloadFolder, async () => {
    const options = { title: 'Choose the download folder for this profile', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const parent = deps.getDashboard()
    const choice = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const folder = choice.filePaths[0]
    return choice.canceled || !folder ? null : folder
  })

  dashboard(DashboardChannels.listExtensions, (id) => deps.extensions.list(profiles.get(parseOrThrow(profileIdSchema, id)).id))

  dashboard(DashboardChannels.addExtension, async (id) => {
    const profileId = profiles.get(parseOrThrow(profileIdSchema, id)).id
    const options = { title: 'Choose an unpacked extension folder (with manifest.json)', properties: ['openDirectory' as const] }
    const parent = deps.getDashboard()
    const choice = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const folder = choice.filePaths[0]
    if (choice.canceled || !folder) return null
    return addExtensionFrom(profileId, folder)
  })

  /** Copies the extension into the profile and, if the profile is open, loads it right away. */
  async function addExtensionFrom(profileId: string, folder: string) {
    const { extension, warnings } = await deps.extensions.add(profileId, folder)
    let loadError: string | null = null
    if (windows.isOpen(profileId)) {
      loadError = await deps.extensionLoader.loadOne(deps.sessions.sessionFor(profiles.get(profileId).partition), extension)
    }
    logger.info(`Installed an extension into profile ${profileId}${loadError ? ' (load failed)' : ''}`)
    return { extension: deps.extensions.get(profileId, extension.id), warnings, loadError }
  }

  dashboard(DashboardChannels.setExtensionEnabled, async (id, extensionId, enabled) => {
    const profile = profiles.get(parseOrThrow(profileIdSchema, id))
    const extId = parseOrThrow(z.uuid(), extensionId)
    const on = parseOrThrow(z.boolean(), enabled)
    let extension = deps.extensions.setEnabled(profile.id, extId, on)
    if (windows.isOpen(profile.id)) {
      const ses = deps.sessions.sessionFor(profile.partition)
      if (on) await deps.extensionLoader.loadOne(ses, extension)
      else deps.extensionLoader.unloadOne(ses, extension)
      extension = deps.extensions.get(profile.id, extId)
    }
    return extension
  })

  dashboard(DashboardChannels.removeExtension, async (id, extensionId) => {
    const profile = profiles.get(parseOrThrow(profileIdSchema, id))
    const extId = parseOrThrow(z.uuid(), extensionId)
    const extension = deps.extensions.get(profile.id, extId)
    if (windows.isOpen(profile.id)) deps.extensionLoader.unloadOne(deps.sessions.sessionFor(profile.partition), extension)
    await deps.extensions.remove(profile.id, extId)
    logger.info(`Removed an extension from profile ${profile.id}`)
  })

  dashboard(DashboardChannels.storageInfo, (id) => deps.profileData.storageInfo(parseOrThrow(profileIdSchema, id)))

  dashboard(DashboardChannels.listCookies, (id) => deps.profileData.cookies(parseOrThrow(profileIdSchema, id)))

  dashboard(DashboardChannels.clearProfileData, (id, kind, origin) =>
    deps.profileData.clear(
      parseOrThrow(profileIdSchema, id),
      parseOrThrow(z.enum(['cookies', 'cache', 'site', 'all']), kind),
      parseOrThrow(z.string().max(2048).nullable(), origin ?? null)
    )
  )

  // ---------- local backups ----------
  /**
   * Backup files the renderer may refer to: only paths this process listed or the user picked
   * in a file dialog. A page can never make the app read an arbitrary path.
   */
  const knownBackupPaths = new Set<string>()
  const remember = <T extends { path: string }>(items: T[]): T[] => {
    for (const item of items) knownBackupPaths.add(item.path)
    return items
  }
  const knownPath = (value: unknown): string => {
    const path = parseOrThrow(backupPathSchema, value)
    if (!isAbsolute(path) || !knownBackupPaths.has(path)) {
      throw new ValidationError('Choose the backup file again from the list or with "Choose file".')
    }
    return path
  }
  const dialogParent = (): BrowserWindow | undefined => deps.getDashboard() ?? undefined

  dashboard(DashboardChannels.chooseBackupFolder, async () => {
    const options = { title: 'Choose a folder for backups', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const parent = dialogParent()
    const choice = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const folder = choice.filePaths[0]
    if (choice.canceled || !folder) return null
    const updated = settings.update({ backupFolder: folder })
    logger.info('Backup folder changed')
    return updated
  })

  dashboard(DashboardChannels.openBackupFolder, async () => {
    const folder = deps.backupCenter.backupFolder()
    const error = await shell.openPath(folder)
    if (error) throw new ValidationError(`Could not open the backup folder: ${error}`)
  })

  dashboard(DashboardChannels.backupMetadata, async (ids) => {
    const selection = ids === 'all' ? 'all' : parseOrThrow(profileIdsSchema, ids)
    const entry = await deps.backupCenter.backupMetadata(selection)
    if (entry.path) knownBackupPaths.add(entry.path)
    return entry
  })

  dashboard(DashboardChannels.backupFull, async (request) => {
    const { profileIds, password } = parseOrThrow(fullBackupRequestSchema, request)
    let last = 0
    const outcomes = await deps.backupCenter.backupFull(profileIds, password, (profileId, doneBytes, totalBytes) => {
      const now = Date.now()
      if (now - last < 150 && doneBytes < totalBytes) return
      last = now
      deps.sendBackupProgress({ profileId, doneBytes, totalBytes })
    })
    logger.info(`Full backup: ${outcomes.map((o) => o.status).join(', ')}`)
    return outcomes
  })

  dashboard(DashboardChannels.listBackups, async () => remember(await deps.backupCenter.listBackups()))

  dashboard(DashboardChannels.chooseBackupFile, async () => {
    const options = {
      title: 'Choose a backup file',
      properties: ['openFile' as const],
      filters: [{ name: 'Proxy Own Browser backups', extensions: ['json', 'pobfull'] }]
    }
    const parent = dialogParent()
    const choice = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const file = choice.filePaths[0]
    if (choice.canceled || !file) return null
    const info = await deps.backupCenter.describeFile(file)
    if (!info) throw new ValidationError(`This file is not a Proxy Own Browser backup (${BACKUP_FORMAT} or .pobfull).`)
    return remember([info])[0]!
  })

  dashboard(DashboardChannels.verifyBackup, (path, password) =>
    deps.backupCenter.verify(knownPath(path), typeof password === 'string' ? password : undefined)
  )

  dashboard(DashboardChannels.restoreBackup, async (request) => {
    const parsed = parseOrThrow(restoreRequestSchema, request)
    const path = knownPath(parsed.path)
    if (parsed.target === 'original') {
      // In-place restores require the target profile to be closed (checked again inside).
      for (const id of parsed.profileIds ?? []) {
        if (windows.isOpen(id)) throw new ValidationError('Close the profile window before restoring it.')
      }
    }
    const outcome = await deps.backupCenter.restore({ ...parsed, path })
    for (const id of outcome.profileIds) {
      if (profiles.exists(id)) await windows.profileUpdated(profiles.get(id))
    }
    logger.info(`Restore (${parsed.target}): ${outcome.status}`)
    deps.notifyProfilesChanged()
    deps.notifyCatalogChanged()
    return outcome
  })

  dashboard(DashboardChannels.backupHistory, (profileId) =>
    deps.backupCenter.history(profileId === undefined || profileId === null ? undefined : parseOrThrow(profileIdSchema, profileId))
  )
  dashboard(DashboardChannels.backupStatus, () => deps.backupCenter.backupStatus())
  dashboard(DashboardChannels.pendingJobs, () => deps.backupCenter.pendingJobs())
  dashboard(DashboardChannels.cancelJob, (id) => deps.backupCenter.cancelJob(parseOrThrow(z.uuid(), id)))
  dashboard(DashboardChannels.startupNotes, () => deps.startupNotes)
  dashboard(DashboardChannels.restartApp, () => {
    logger.info('Restarting at the user’s request to finish scheduled tasks')
    app.relaunch()
    app.quit()
  })

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
