import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, type BrowserWindow, type WebContents, type WebFrameMain } from 'electron'

export type AppPage = 'dashboard' | 'browser'

const rendererDir = (): string => join(__dirname, '../renderer')

function devServerUrl(): string | null {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : null
}

/** Preload shared by the app's own pages; it exposes only the API matching each page. */
export function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

export function loadPage(window: BrowserWindow, page: AppPage): Promise<void> {
  const dev = devServerUrl()
  if (dev) return window.loadURL(`${dev}/${page}.html`)
  return window.loadFile(join(rendererDir(), `${page}.html`))
}

/** True when an IPC message comes from one of our own bundled pages (not from a website). */
export function isAppFrame(frame: WebFrameMain | null | undefined): boolean {
  if (!frame) return false
  const url = frame.url
  const dev = devServerUrl()
  if (dev && url.startsWith(`${dev}/`)) return true
  const base = pathToFileURL(rendererDir()).href
  return url.startsWith(`${base}/`)
}

/** App UI pages never navigate away or open windows. */
export function lockDownAppContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
