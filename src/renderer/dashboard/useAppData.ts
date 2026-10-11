import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  BrowserTimezoneReport,
  Profile,
  ProfileGroup,
  ProfileInput,
  ProfileRuntimeStatus,
  ProfileTag,
  ProfileNetworkStatus,
  ProfileBackupStatus,
  ProfileTemplate,
  ProfileUpdate,
  SaveProfileOptions
} from '@shared/types'
import { errorMessage, unwrap } from '../common/ipc'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

export type TemplateWithProblems = ProfileTemplate & { problems: string[] }

/**
 * Central dashboard state: profiles, groups, tags, templates, live statuses, settings and
 * toasts. Everything is loaded from the main process; nothing is cached across restarts here.
 */
export function useAppData() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [groups, setGroups] = useState<ProfileGroup[]>([])
  const [tags, setTags] = useState<ProfileTag[]>([])
  const [templates, setTemplates] = useState<TemplateWithProblems[]>([])
  const [statuses, setStatuses] = useState<Record<string, ProfileRuntimeStatus>>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [network, setNetwork] = useState<Record<string, ProfileNetworkStatus>>({})
  const [reportedTimezones, setReportedTimezones] = useState<Record<string, BrowserTimezoneReport>>({})
  const [backups, setBackups] = useState<Record<string, ProfileBackupStatus>>({})
  const [startupNotes, setStartupNotes] = useState<string[]>([])
  /** Profiles marked "ask before opening" that are waiting for the user's answer. */
  const [pendingOpen, setPendingOpen] = useState<{ profiles: Profile[]; run: () => Promise<void> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])

  const refreshCatalog = useCallback(async () => {
    const [g, tg, tpl] = await Promise.all([
      unwrap(window.pob.listGroups()),
      unwrap(window.pob.listTags()),
      unwrap(window.pob.listTemplates())
    ])
    setGroups(g)
    setTags(tg)
    setTemplates(tpl)
  }, [])

  /** Stored proxy/IP status of every checked profile (no network requests are made here). */
  const refreshNetwork = useCallback(async () => {
    try {
      const [stored, reported] = await Promise.all([
        unwrap(window.pob.networkStatuses()),
        unwrap(window.pob.reportedTimezones())
      ])
      setNetwork(stored)
      setReportedTimezones(reported)
    } catch {
      /* shown as "not checked" */
    }
  }, [])

  /** Per-profile backup status, derived from the stored backup history. */
  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await unwrap(window.pob.backupStatus()))
    } catch {
      /* shown as "no backup" */
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [list, st, s] = await Promise.all([
        unwrap(window.pob.listProfiles()),
        unwrap(window.pob.profileStatuses()),
        unwrap(window.pob.getSettings())
      ])
      setProfiles(list)
      setStatuses(st)
      setSettings(s)
      await Promise.all([refreshCatalog(), refreshNetwork(), refreshBackups()])
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [refreshCatalog, refreshNetwork, refreshBackups])

  useEffect(() => {
    void refresh()
    void unwrap(window.pob.startupNotes())
      .then(setStartupNotes)
      .catch(() => {})
    const offNetwork = window.pob.onNetworkStatusChanged(() => void refreshNetwork())
    const offProfiles = window.pob.onProfilesChanged(() => void refresh())
    const offStatuses = window.pob.onProfileStatusesChanged((s) => setStatuses(s))
    const offCatalog = window.pob.onCatalogChanged(() => void refreshCatalog().catch(() => {}))
    return () => {
      offNetwork()
      offProfiles()
      offStatuses()
      offCatalog()
    }
  }, [refresh, refreshCatalog, refreshNetwork])

  const createProfile = useCallback(
    async (input: ProfileInput, options?: SaveProfileOptions) => {
      const profile = await unwrap(window.pob.createProfile(input, options))
      await refresh()
      return profile
    },
    [refresh]
  )

  const updateProfile = useCallback(
    async (id: string, update: ProfileUpdate, options?: SaveProfileOptions) => {
      const profile = await unwrap(window.pob.updateProfile(id, update, options))
      await refresh()
      return profile
    },
    [refresh]
  )

  const deleteProfile = useCallback(
    async (profile: Profile, clearData: boolean) => {
      await unwrap(window.pob.deleteProfile(profile.id, { clearData }))
      await refresh()
    },
    [refresh]
  )

  /**
   * Runs `run` right away, or after confirmation when one of `profiles` is closed and marked
   * "ask before opening".
   */
  const confirmOpening = useCallback(
    async (profiles: Profile[], run: () => Promise<void>) => {
      const flagged = profiles.filter((p) => p.options.confirmBeforeOpen && (statuses[p.id] ?? 'closed') === 'closed')
      if (flagged.length === 0) return run()
      setPendingOpen({ profiles: flagged, run })
    },
    [statuses]
  )

  const openProfile = useCallback(
    async (profile: Profile) =>
      confirmOpening([profile], async () => {
        try {
          await unwrap(window.pob.openProfile(profile.id))
        } catch (error) {
          notify('error', errorMessage(error))
        }
      }),
    [notify, confirmOpening]
  )

  const closeProfile = useCallback(
    async (profile: Profile) => {
      try {
        await unwrap(window.pob.closeProfile(profile.id))
      } catch (error) {
        notify('error', errorMessage(error))
      }
    },
    [notify]
  )

  const saveSettings = useCallback(async (update: Partial<AppSettings>) => {
    const next = await unwrap(window.pob.updateSettings(update))
    setSettings(next)
    return next
  }, [])

  const runningCount = Object.values(statuses).filter((s) => s !== 'closed').length

  return {
    profiles,
    groups,
    tags,
    templates,
    statuses,
    runningCount,
    settings,
    network,
    reportedTimezones,
    refreshNetwork,
    backups,
    refreshBackups,
    startupNotes,
    pendingOpen,
    confirmOpening,
    resolvePendingOpen: (go: boolean) => {
      const pending = pendingOpen
      setPendingOpen(null)
      if (go && pending) void pending.run()
    },
    dismissStartupNotes: () => setStartupNotes([]),
    loading,
    loadError,
    toasts,
    notify,
    refresh,
    refreshCatalog,
    createProfile,
    updateProfile,
    deleteProfile,
    openProfile,
    closeProfile,
    saveSettings
  }
}

export type AppData = ReturnType<typeof useAppData>
