import type { Session } from 'electron'
import type { LaunchReportItem, ProfileExtension } from '@shared/types'
import type { ExtensionStore } from '../services/extensionStore'
import type { Logger } from '../services/logger'

/** The part of Electron's extensions API (`session.extensions`) the app uses. */
interface ExtensionsApi {
  loadExtension(path: string, options?: { allowFileAccess?: boolean }): Promise<{ id: string; name: string; version: string }>
  removeExtension(id: string): void
  getAllExtensions(): { id: string; name: string }[]
}

function api(ses: Session): ExtensionsApi {
  const withNamespace = ses as unknown as { extensions?: ExtensionsApi }
  return withNamespace.extensions ?? (ses as unknown as ExtensionsApi)
}

/**
 * Loads a profile's enabled extensions into its own session (and only that session). Electron
 * does not remember extensions between runs, so this runs every time the profile opens.
 */
export class ExtensionLoader {
  constructor(
    private readonly store: ExtensionStore,
    private readonly logger: Logger
  ) {}

  /** Chromium ids currently loaded in a session. */
  loadedIds(ses: Session): Set<string> {
    try {
      return new Set(api(ses).getAllExtensions().map((e) => e.id))
    } catch {
      return new Set()
    }
  }

  async loadOne(ses: Session, extension: ProfileExtension): Promise<string | null> {
    try {
      const loaded = await api(ses).loadExtension(this.store.folderOf(extension.profileId, extension.id), { allowFileAccess: false })
      this.store.recordLoad(extension.profileId, extension.id, loaded.id, null)
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.recordLoad(extension.profileId, extension.id, null, message)
      this.logger.warn(`Extension ${extension.id} of profile ${extension.profileId} could not be loaded`)
      return message
    }
  }

  unloadOne(ses: Session, extension: ProfileExtension): void {
    if (!extension.chromeId) return
    try {
      if (this.loadedIds(ses).has(extension.chromeId)) api(ses).removeExtension(extension.chromeId)
    } catch (error) {
      this.logger.warn(`Extension ${extension.id} could not be unloaded`, error)
    }
  }

  /** Loads every enabled extension of the profile; returns one launch-report line per extension. */
  async loadForProfile(ses: Session, profileId: string): Promise<LaunchReportItem[]> {
    const items: LaunchReportItem[] = []
    const loaded = this.loadedIds(ses)
    for (const extension of this.store.list(profileId)) {
      if (!extension.enabled) continue
      if (extension.chromeId && loaded.has(extension.chromeId)) {
        items.push({ setting: `Extension: ${extension.name}`, status: 'applied', detail: 'Already loaded in this session.' })
        continue
      }
      const error = await this.loadOne(ses, extension)
      items.push(
        error
          ? { setting: `Extension: ${extension.name}`, status: 'failed', detail: error }
          : { setting: `Extension: ${extension.name}`, status: 'applied', detail: `Version ${extension.version} loaded.` }
      )
    }
    return items
  }
}
