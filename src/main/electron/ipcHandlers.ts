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
  BulkCreateSpec,
  ProfileInput,
  ProfileUpdate,
  ProxyInput,
  TemplateInput
} from '@shared/types'
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
  templateIdSchema
} from '@shared/validation'
import { MAX_BACKUP_BYTES, parseBackup } from '../services/backupService'
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
import type { SessionManager } from './sessionManager'

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
}

const groupUpdateSchema = z.object({
  name: z.string().optional(),
  color: z.string().optional()
})

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

  dashboard(DashboardChannels.testProxy, (id, draft) => {
    const profileId = parseOrThrow(nullableProfileIdSchema, id ?? null)
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
