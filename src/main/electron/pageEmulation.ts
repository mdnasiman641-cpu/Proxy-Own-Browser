import type { WebContents } from 'electron'
import type { Logger } from '../services/logger'

/**
 * Time zone and locale for a profile's pages, applied with the Chrome DevTools Protocol
 * commands `Emulation.setTimezoneOverride` and `Emulation.setLocaleOverride` through Electron's
 * documented `webContents.debugger` API. This changes what JavaScript in the page sees
 * (Date, Intl); it does not change the Windows clock or any other application.
 */
export interface PageEmulation {
  timezone: string | null
  locale: string | null
}

const state = new WeakMap<WebContents, PageEmulation>()

/** True when nothing needs to be overridden. */
export function isEmpty(emulation: PageEmulation): boolean {
  return !emulation.timezone && !emulation.locale
}

async function send(contents: WebContents, emulation: PageEmulation): Promise<void> {
  if (contents.isDestroyed()) return
  const dbg = contents.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  // An empty timezoneId / locale removes an earlier override.
  await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: emulation.timezone ?? '' })
  await dbg.sendCommand('Emulation.setLocaleOverride', emulation.locale ? { locale: emulation.locale } : {})
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
  if (isEmpty(emulation) && !contents.debugger.isAttached()) return true
  try {
    await send(contents, emulation)
    return true
  } catch (error) {
    logger.warn('Could not apply the time zone/locale to a tab', error)
    return false
  }
}
