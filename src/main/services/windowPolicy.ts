import type { ProfileOptions } from '@shared/profileOptions'

export const MAX_RESTORED_TABS = 20

/**
 * The pages a profile window opens with, by its startup behaviour. An explicit address (e.g.
 * "open this link in profile X") always wins. Restore falls back to the start page when no tabs
 * were saved.
 */
export function startupPages(
  options: Pick<ProfileOptions, 'startupMode' | 'startupUrls'>,
  startUrl: string | null,
  homepage: string,
  savedTabs: readonly string[],
  initialUrl?: string
): { urls: string[]; source: 'initial' | 'start-page' | 'urls' | 'restore' | 'restore-empty' } {
  if (initialUrl) return { urls: [initialUrl], source: 'initial' }
  const startPage = startUrl ?? homepage
  if (options.startupMode === 'urls' && options.startupUrls.length > 0) {
    return { urls: options.startupUrls.slice(0, MAX_RESTORED_TABS), source: 'urls' }
  }
  if (options.startupMode === 'restore') {
    const tabs = savedTabs.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_RESTORED_TABS)
    return tabs.length ? { urls: tabs, source: 'restore' } : { urls: [startPage], source: 'restore-empty' }
  }
  return { urls: [startPage], source: 'start-page' }
}

/** Window title: the page title, then the profile name (or only the app name when hidden). */
export function windowTitle(pageTitle: string, url: string, profileName: string, showName: boolean): string {
  const page = pageTitle && pageTitle !== url ? `${pageTitle} — ` : ''
  return `${page}${showName ? profileName : 'Proxy Own Browser'}`
}

/** Only web addresses are saved for "restore previous tabs" (no internal or file pages). */
export function tabsToSave(urls: readonly string[]): string[] {
  return urls.filter((u) => /^https?:\/\//i.test(u) && u.length <= 2048).slice(0, MAX_RESTORED_TABS)
}
