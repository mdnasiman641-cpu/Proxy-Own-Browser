import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, Profile, ProfileInput, ProfileUpdate } from '@shared/types'
import { errorMessage, unwrap } from '../common/ipc'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

/** Central dashboard state: profiles, open windows, settings and toast notifications. */
export function useAppData() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [openIds, setOpenIds] = useState<string[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [list, ids, s] = await Promise.all([
        unwrap(window.pob.listProfiles()),
        unwrap(window.pob.openProfileIds()),
        unwrap(window.pob.getSettings())
      ])
      setProfiles(list)
      setOpenIds(ids)
      setSettings(s)
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offProfiles = window.pob.onProfilesChanged(() => void refresh())
    const offOpen = window.pob.onOpenProfilesChanged((ids) => setOpenIds(ids))
    return () => {
      offProfiles()
      offOpen()
    }
  }, [refresh])

  const createProfile = useCallback(
    async (input: ProfileInput) => {
      const profile = await unwrap(window.pob.createProfile(input))
      notify('success', `Profile "${profile.name}" created`)
      await refresh()
      return profile
    },
    [notify, refresh]
  )

  const updateProfile = useCallback(
    async (id: string, update: ProfileUpdate) => {
      const profile = await unwrap(window.pob.updateProfile(id, update))
      notify('success', `Profile "${profile.name}" saved`)
      await refresh()
      return profile
    },
    [notify, refresh]
  )

  const deleteProfile = useCallback(
    async (profile: Profile, clearData: boolean) => {
      await unwrap(window.pob.deleteProfile(profile.id, { clearData }))
      notify('success', `Profile "${profile.name}" deleted`)
      await refresh()
    },
    [notify, refresh]
  )

  const openProfile = useCallback(
    async (profile: Profile) => {
      try {
        await unwrap(window.pob.openProfile(profile.id))
      } catch (error) {
        notify('error', errorMessage(error))
      }
    },
    [notify]
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

  const saveSettings = useCallback(
    async (update: Partial<AppSettings>) => {
      const next = await unwrap(window.pob.updateSettings(update))
      setSettings(next)
      notify('success', 'Settings saved')
      return next
    },
    [notify]
  )

  return {
    profiles,
    openIds,
    settings,
    loading,
    loadError,
    toasts,
    notify,
    refresh,
    createProfile,
    updateProfile,
    deleteProfile,
    openProfile,
    closeProfile,
    saveSettings
  }
}

export type AppData = ReturnType<typeof useAppData>
