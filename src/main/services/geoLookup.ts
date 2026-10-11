import { isValidTimeZone } from '@shared/browserConfig'
import type { GeoStatus, IpGeolocation } from '@shared/types'
import { FetchError, SYNTHETIC_CODES, classifyNetworkError, isIpAddress, type Fetcher } from './proxyTest'

/**
 * IP geolocation services, tried in order. The request is made through the profile's proxy in
 * a throw-away session (no cookies, no profile data); the service only learns the proxy's
 * public exit IP. Neither service needs an API key.
 */
export const GEO_ENDPOINTS: readonly GeoEndpoint[] = [
  { url: 'https://ipwho.is/', format: 'ipwhois' },
  { url: 'https://ipapi.co/json/', format: 'ipapi' }
]

export interface GeoEndpoint {
  url: string
  /** Response shape: `ipwhois` (ipwho.is) or `ipapi` (ipapi.co). */
  format: 'ipwhois' | 'ipapi'
}

export const DEFAULT_GEO_TIMEOUT_MS = 10_000

export interface GeoLookupResult {
  status: Exclude<GeoStatus, 'skipped'>
  message: string
  data: IpGeolocation | null
}

const text = (v: unknown, max = 100): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null

/**
 * Parses a geolocation response. Returns null data with a reason when the service reports an
 * error or the response does not contain a valid IP address. Values are never invented: a
 * missing field stays null, and an unknown time zone name is dropped.
 */
export function parseGeoResponse(
  body: string,
  format: GeoEndpoint['format'],
  provider: string
): { data: IpGeolocation | null; reason: string | null } {
  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object') return { data: null, reason: 'unexpected response' }
    json = parsed as Record<string, unknown>
  } catch {
    return { data: null, reason: 'unexpected response' }
  }

  if (format === 'ipwhois' && json.success === false) {
    return { data: null, reason: text(json.message, 200) ?? 'the service could not locate this IP' }
  }
  if (format === 'ipapi' && json.error === true) {
    return { data: null, reason: text(json.reason, 200) ?? 'the service could not locate this IP' }
  }

  const ip = text(json.ip, 64)
  if (!ip || !isIpAddress(ip)) return { data: null, reason: 'the response did not contain an IP address' }

  const tzRaw =
    format === 'ipwhois'
      ? text((json.timezone as Record<string, unknown> | undefined)?.id, 64)
      : text(json.timezone, 64)
  const timezone = tzRaw && isValidTimeZone(tzRaw) ? tzRaw : null

  const data: IpGeolocation = {
    ip,
    country: text(format === 'ipwhois' ? json.country : json.country_name),
    countryCode: text(json.country_code, 2)?.toUpperCase() ?? null,
    region: text(json.region),
    city: text(json.city),
    latitude: num(json.latitude, -90, 90),
    longitude: num(json.longitude, -180, 180),
    timezone,
    provider
  }
  return { data, reason: null }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Looks up the location of the public IP the fetcher's route exits from. Success requires a
 * 2xx response with a valid IP; a lookup without a time zone is still a success (the time zone
 * is then reported as unknown by the caller).
 */
export async function runGeoLookup(options: {
  fetcher: Fetcher
  endpoints?: readonly GeoEndpoint[]
  timeoutMs?: number
  now?: () => number
}): Promise<GeoLookupResult> {
  const endpoints = options.endpoints ?? GEO_ENDPOINTS
  const budget = options.timeoutMs ?? DEFAULT_GEO_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  const started = now()
  let lastReason = 'no location service is configured'

  for (const endpoint of endpoints) {
    const remaining = budget - (now() - started)
    if (remaining <= 0) {
      lastReason = 'the location services did not answer in time'
      break
    }
    const host = hostOf(endpoint.url)
    try {
      const response = await withDeadline(options.fetcher(endpoint.url, remaining), remaining)
      if (response.status === 429) {
        lastReason = `${host} is rate-limiting requests; try again later`
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        lastReason = `${host} answered with HTTP ${response.status}`
        continue
      }
      const { data, reason } = parseGeoResponse(response.body, endpoint.format, host)
      if (data) {
        const where = [data.city, data.region, data.country].filter(Boolean).join(', ') || 'unknown place'
        return { status: 'success', message: `Located ${data.ip} in ${where}.`, data }
      }
      lastReason = `${host}: ${reason}`
    } catch (error) {
      const code = error instanceof FetchError ? error.code : 'ERR_FAILED'
      lastReason = `${host}: ${classifyNetworkError(code).message}`
    }
  }
  return { status: 'failed', message: `IP location lookup failed — ${lastReason}`, data: null }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FetchError('Timed out', SYNTHETIC_CODES.timeout)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
