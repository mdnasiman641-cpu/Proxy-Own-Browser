import type { BrowserApi, DashboardApi } from '@shared/ipc'

declare global {
  interface Window {
    /** Exposed by the dashboard preload. */
    pob: DashboardApi
    /** Exposed by the profile-window toolbar preload. */
    pobBrowser: BrowserApi
  }
}

export {}
