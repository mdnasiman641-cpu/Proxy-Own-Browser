import type { WebContents } from 'electron'
import type { Logger } from '../services/logger'

/**
 * Time zone, locale and language for a profile's pages, applied with the Chrome DevTools
 * Protocol commands `Emulation.setTimezoneOverride`, `Emulation.setLocaleOverride` and
 * `Emulation.setUserAgentOverride` (Accept-Language only — the User-Agent stays the profile's
 * real one) through Electron's documented `webContents.debugger` API. This changes what
 * JavaScript in the page sees (Date, Intl, navigator.language); it does not change the Windows
 * clock or any other application.
 */
export interface PageEmulation {
  timezone: string | null
  locale: string | null
  /** The profile's User-Agent (real runtime version; see browserConfig.ts). */
  userAgent: string
  /** Ordered language list for the profile language, e.g. "bn-BD,bn,en" (no q-values). */
  acceptLanguage: string | null
}

const state = new WeakMap<WebContents, PageEmulation>()

/** True when no DevTools-protocol override is needed (only the User-Agent, set directly). */
export function isEmpty(emulation: PageEmulation): boolean {
  return !emulation.timezone && !emulation.locale
}

async function send(contents: WebContents, emulation: PageEmulation): Promise<void> {
  if (contents.isDestroyed()) return
  if (contents.getUserAgent() !== emulation.userAgent) contents.setUserAgent(emulation.userAgent)
  const dbg = contents.debugger
  if (isEmpty(emulation) && !dbg.isAttached()) return
  if (!dbg.isAttached()) dbg.attach('1.3')
  // An empty timezoneId / locale removes an earlier override.
  await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: emulation.timezone ?? '' })
  await dbg.sendCommand('Emulation.setLocaleOverride', emulation.locale ? { locale: emulation.locale } : {})
  // navigator.language(s) follow the Accept-Language list; the User-Agent stays the profile's own.
  await dbg.sendCommand(
    'Emulation.setUserAgentOverride',
    emulation.acceptLanguage ? { userAgent: emulation.userAgent, acceptLanguage: emulation.acceptLanguage } : { userAgent: emulation.userAgent }
  )
}

/**
 * Applies (or updates) the emulation of one tab or pop-up. Must be awaited before the first
 * page load so the first document already sees the profile's time zone. Re-applied
 * automatically after a renderer crash or if the debugger session is detached.
 */
export async function applyPageEmulation(
  contents: WebContents,
  emulation: PageEmulation,
  logger: Logger
): Promise<boolean> {
  const known = state.has(contents)
  state.set(contents, emulation)
  if (!known) {
    let needsReapply = false
    contents.debugger.on('detach', (_event, reason) => {
      needsReapply = true
      logger.warn(`Page emulation detached (${reason}); it will be applied again on the next navigation`)
    })
    contents.on('render-process-gone', () => {
      needsReapply = true
    })
    contents.on('did-start-navigation', (details) => {
      if (!needsReapply || !details.isMainFrame) return
      needsReapply = false
      const current = state.get(contents)
      if (current && !isEmpty(current)) {
        send(contents, current).catch((error) => logger.warn('Could not re-apply page emulation', error))
      }
    })
  }
  try {
    await send(contents, emulation)
    return true
  } catch (error) {
    logger.warn('Could not apply the time zone/locale to a tab', error)
    return false
  }
}
