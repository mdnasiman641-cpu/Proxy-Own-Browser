import { SEARCH_ENGINES, type SearchEngineId } from './types'

const SAFE_PROTOCOLS = new Set(['http:', 'https:'])
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const LOOKS_LIKE_HOST =
  /^(localhost|\[[0-9a-f:.]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,63})(:\d{1,5})?([/?#].*)?$/i

/** True for URLs a profile window is allowed to load. */
export function isNavigableUrl(value: string): boolean {
  if (value === 'about:blank') return true
  try {
    return SAFE_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

export function buildSearchUrl(query: string, engine: SearchEngineId): string {
  return SEARCH_ENGINES[engine].template.replace('%s', encodeURIComponent(query))
}

/**
 * Converts address-bar input into a URL to load.
 * - `https://…` / `http://…` are used as-is
 * - `example.com/path`, `localhost:3000`, `192.168.1.1` get `https://` (or `http://` for local hosts)
 * - anything else becomes a search
 * Returns `null` for empty input or a blocked scheme (file:, javascript:, chrome:, …).
 */
export function normalizeAddressInput(input: string, engine: SearchEngineId): string | null {
  const value = input.trim()
  if (!value) return null
  if (value === 'about:blank') return value

  if (HAS_SCHEME.test(value) && !/^[^:/]+:\d+/.test(value)) {
    try {
      const url = new URL(value)
      return SAFE_PROTOCOLS.has(url.protocol) ? url.toString() : null
    } catch {
      return buildSearchUrl(value, engine)
    }
  }

  if (!/\s/.test(value) && LOOKS_LIKE_HOST.test(value)) {
    const isLocal = /^(localhost|127\.|10\.|192\.168\.|\[)/i.test(value)
    try {
      return new URL(`${isLocal ? 'http' : 'https'}://${value}`).toString()
    } catch {
      return buildSearchUrl(value, engine)
    }
  }

  return buildSearchUrl(value, engine)
}
