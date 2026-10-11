import { proxyEndpointKey } from '@shared/proxy'
import type {
  GeoStatus,
  IpGeolocation,
  Profile,
  ProfileNetworkStatus,
  ProxyTestResult,
  ProxyTestStatus
} from '@shared/types'
import { ValidationError } from '@shared/validation'
import type { AppDatabase } from './database'
import type { GeoLookupResult } from './geoLookup'
import type { Logger } from './logger'
import type { ProfileService, ProxyTestTarget } from './profileService'

/**
 * Performs one proxy check (public IP) and, optionally, the IP location lookup through it.
 * `geo` may be a function: it receives the exit IP and decides whether a lookup is needed.
 */
export interface RouteChecker {
  check(
    key: string,
    target: ProxyTestTarget,
    options: { geo: boolean | ((ip: string) => boolean) }
  ): Promise<{ proxy: ProxyTestResult; geo: GeoLookupResult | null }>
}

/** A location looked up for an exit IP is reused for that same IP for this long. */
export const GEO_CACHE_MS = 24 * 60 * 60 * 1000
/**
 * When an automatic-time-zone profile opens, the exit IP is checked again if the last check is
 * older than this (one small request; the location is only looked up again if the IP changed).
 */
export const LAUNCH_RECHECK_MS = 30 * 60 * 1000
/** @deprecated kept for older callers; see GEO_CACHE_MS. */
export const TIMEZONE_CACHE_MS = GEO_CACHE_MS

/** What a profile window applies to its pages. */
export interface LaunchPlan {
  timezone: string | null
  timezoneSource: 'off' | 'manual' | 'auto'
  locale: string | null
  /** Shown to the user (e.g. "using the time zone detected 2 days ago"). */
  warnings: string[]
}

interface StatusRow {
  profile_id: string
  route_key: string
  checked_at: string
  proxy_status: string
  proxy_message: string
  response_time_ms: number | null
  ip: string | null
  geo_status: string
  geo_message: string
  geo_json: string | null
  last_valid_timezone: string | null
  last_valid_timezone_at: string | null
  last_valid_timezone_route: string | null
  geo_checked_at: string | null
  geo_reused: number | null
  previous_ip: string | null
  ip_changed_at: string | null
}

function parseGeo(json: string | null): IpGeolocation | null {
  if (!json) return null
  try {
    const value = JSON.parse(json) as Partial<IpGeolocation>
    if (!value || typeof value.ip !== 'string') return null
    // Results stored by older versions have no ISP/organization fields: shown as unknown.
    return {
      ip: value.ip,
      country: value.country ?? null,
      countryCode: value.countryCode ?? null,
      region: value.region ?? null,
      city: value.city ?? null,
      latitude: value.latitude ?? null,
      longitude: value.longitude ?? null,
      timezone: value.timezone ?? null,
      isp: value.isp ?? null,
      org: value.org ?? null,
      asn: value.asn ?? null,
      provider: value.provider ?? 'unknown'
    }
  } catch {
    return null
  }
}

/**
 * Proxy connectivity, public IP, IP location and the proxy-based time zone of each profile.
 *
 * - Results are stored per profile together with the proxy endpoint they were made for, so a
 *   result for an older proxy is shown as out of date instead of being reused.
 * - A failed lookup never replaces a valid time zone: the last valid one is kept and shown.
 * - Nothing is ever filled in from this PC's own settings when a lookup fails.
 */
export class NetworkService {
  private readonly inFlight = new Map<string, Promise<ProfileNetworkStatus>>()

  constructor(
    private readonly deps: {
      db: AppDatabase
      profiles: ProfileService
      checker: RouteChecker
      geoEnabled: () => boolean
      logger: Logger
      now?: () => Date
    }
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  status(profileId: string): ProfileNetworkStatus | null {
    const profile = this.deps.profiles.get(profileId)
    return this.all([profile])[profileId] ?? null
  }

  /** Latest status of every profile that has been checked (keyed by profile id). */
  statuses(): Record<string, ProfileNetworkStatus> {
    return this.all(this.deps.profiles.list())
  }

  private all(profiles: Profile[]): Record<string, ProfileNetworkStatus> {
    const rows = this.deps.db.all<StatusRow>('SELECT * FROM profile_network_status')
    const byId = new Map(rows.map((r) => [r.profile_id, r]))
    const names = new Map(this.deps.profiles.list().map((p) => [p.id, p.name]))
    const currentKeys = new Map(this.deps.profiles.list().map((p) => [p.id, proxyEndpointKey(p.proxy)]))

    // Which current results share a public IP.
    const byIp = new Map<string, string[]>()
    for (const row of rows) {
      if (!row.ip || currentKeys.get(row.profile_id) !== row.route_key) continue
      byIp.set(row.ip, [...(byIp.get(row.ip) ?? []), row.profile_id])
    }

    const result: Record<string, ProfileNetworkStatus> = {}
    for (const profile of profiles) {
      const row = byId.get(profile.id)
      if (!row) continue
      const key = proxyEndpointKey(profile.proxy)
      const current = row.route_key === key
      const same = current && row.ip ? (byIp.get(row.ip) ?? []).filter((id) => id !== profile.id) : []
      result[profile.id] = {
        profileId: profile.id,
        routeKey: row.route_key,
        current,
        checkedAt: row.checked_at,
        proxy: {
          ok: row.proxy_status === 'success',
          status: row.proxy_status as ProxyTestStatus,
          message: row.proxy_message,
          responseTimeMs: row.response_time_ms === null ? null : Number(row.response_time_ms)
        },
        ip: row.ip,
        geo: {
          status: row.geo_status as GeoStatus,
          message: row.geo_message,
          data: parseGeo(row.geo_json)
        },
        lastValidTimezone: row.last_valid_timezone,
        lastValidTimezoneAt: row.last_valid_timezone_at,
        lastValidTimezoneCurrent: row.last_valid_timezone !== null && row.last_valid_timezone_route === key,
        sameExitIpAs: same.map((id) => ({ id, name: names.get(id) ?? id })),
        geoCheckedAt: row.geo_checked_at ?? null,
        geoReused: Number(row.geo_reused ?? 0) === 1,
        previousIp: row.previous_ip ?? null,
        ipChangedAt: row.ip_changed_at ?? null
      }
    }
    return result
  }

  /**
   * Checks the profile's saved proxy now: connectivity + public exit IP, then (if enabled) the
   * IP's location and time zone through the same proxy. A location stored for the same exit IP
   * within GEO_CACHE_MS is reused instead of asking the service again, unless `force` is set
   * (the user's "Refresh IP & location"). Concurrent checks of one profile are merged.
   * Only this profile's stored result is ever written.
   */
  check(profileId: string, options: { force?: boolean } = {}): Promise<ProfileNetworkStatus> {
    const running = this.inFlight.get(profileId)
    if (running) return running
    const promise = this.runCheck(profileId, options.force === true).finally(() => this.inFlight.delete(profileId))
    this.inFlight.set(profileId, promise)
    return promise
  }

  private async runCheck(profileId: string, force: boolean): Promise<ProfileNetworkStatus> {
    const profile = this.deps.profiles.get(profileId)
    const routeKey = proxyEndpointKey(profile.proxy)
    const target = this.deps.profiles.resolveProxyTestTarget(profileId)
    const previous = this.deps.db.get<StatusRow>('SELECT * FROM profile_network_status WHERE profile_id = ?', [
      profileId
    ])
    const startedAt = this.now().getTime()
    const reusable = (ip: string | null): boolean =>
      !force &&
      ip !== null &&
      previous !== undefined &&
      previous.route_key === routeKey &&
      previous.ip === ip &&
      previous.geo_status === 'success' &&
      previous.geo_json !== null &&
      previous.geo_checked_at !== null &&
      startedAt - Date.parse(previous.geo_checked_at) < GEO_CACHE_MS &&
      parseGeo(previous.geo_json)?.ip === ip
    const geoEnabled = this.deps.geoEnabled()
    const { proxy, geo } = await this.deps.checker.check(`network-${profileId}`, target, {
      geo: geoEnabled ? (ip: string) => !reusable(ip) : false
    })

    // The profile may have been deleted or its proxy changed while the check ran.
    if (!this.deps.profiles.exists(profileId)) throw new ValidationError('This profile was deleted.')
    const latest = this.deps.profiles.get(profileId)
    if (proxyEndpointKey(latest.proxy) !== routeKey) {
      throw new ValidationError('The proxy was changed while it was being checked. Check again.')
    }

    const checkedAt = this.now().toISOString()
    let geoStatus: GeoStatus = 'skipped'
    let geoMessage = ''
    let geoData: IpGeolocation | null = null
    let geoReused = false
    let geoCheckedAt: string | null = previous?.route_key === routeKey ? (previous.geo_checked_at ?? null) : null
    if (!proxy.ok) {
      geoMessage = 'Not looked up because the proxy check failed. Nothing is shown from this PC’s own connection.'
    } else if (!geoEnabled) {
      geoMessage = 'IP location lookup is turned off in Application Settings.'
    } else if (reusable(proxy.ip)) {
      geoStatus = 'success'
      geoData = parseGeo(previous!.geo_json)
      geoReused = true
      geoMessage = `The exit IP is unchanged, so the location found at ${previous!.geo_checked_at} was reused.`
    } else if (!geo) {
      geoStatus = 'failed'
      geoMessage = 'IP location lookup did not run.'
    } else {
      if (geo.status === 'success') geoCheckedAt = checkedAt
      geoStatus = geo.status
      geoMessage = geo.message
      geoData = geo.data
      if (geoData && proxy.ip && geoData.ip !== proxy.ip) {
        geoMessage +=
          ` The public IP changed between the two checks (${proxy.ip} → ${geoData.ip}); the proxy may rotate IPs. ` +
          'The location shown is for the second address.'
      }
      if (geo.status === 'success' && !geoData?.timezone) {
        geoMessage += ' The service did not report a time zone for this IP.'
      }
    }

    // Rotating proxies: remember the previous exit IP of the same proxy when it changes.
    let previousIp: string | null = null
    let ipChangedAt: string | null = null
    if (previous && previous.route_key === routeKey) {
      if (proxy.ip && previous.ip && previous.ip !== proxy.ip) {
        previousIp = previous.ip
        ipChangedAt = checkedAt
      } else {
        previousIp = previous.previous_ip ?? null
        ipChangedAt = previous.ip_changed_at ?? null
      }
    }
    const tz = geoData?.timezone ?? null
    const lastValid = tz
      ? { tz, at: checkedAt, route: routeKey }
      : {
          tz: previous?.last_valid_timezone ?? null,
          at: previous?.last_valid_timezone_at ?? null,
          route: previous?.last_valid_timezone_route ?? null
        }

    this.deps.db.run(
      `INSERT INTO profile_network_status (profile_id, route_key, checked_at, proxy_status, proxy_message,
         response_time_ms, ip, geo_status, geo_message, geo_json, last_valid_timezone, last_valid_timezone_at,
         last_valid_timezone_route, geo_checked_at, geo_reused, previous_ip, ip_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         route_key = excluded.route_key, checked_at = excluded.checked_at, proxy_status = excluded.proxy_status,
         proxy_message = excluded.proxy_message, response_time_ms = excluded.response_time_ms, ip = excluded.ip,
         geo_status = excluded.geo_status, geo_message = excluded.geo_message, geo_json = excluded.geo_json,
         last_valid_timezone = excluded.last_valid_timezone, last_valid_timezone_at = excluded.last_valid_timezone_at,
         last_valid_timezone_route = excluded.last_valid_timezone_route, geo_checked_at = excluded.geo_checked_at,
         geo_reused = excluded.geo_reused, previous_ip = excluded.previous_ip, ip_changed_at = excluded.ip_changed_at`,
      [
        profileId,
        routeKey,
        checkedAt,
        proxy.status,
        proxy.message,
        proxy.responseTimeMs,
        proxy.ip,
        geoStatus,
        geoMessage.trim(),
        geoData ? JSON.stringify(geoData) : null,
        lastValid.tz,
        lastValid.at,
        lastValid.route,
        geoCheckedAt,
        geoReused ? 1 : 0,
        previousIp,
        ipChangedAt
      ]
    )
    // Status only — no IP address, location or proxy host in the log.
    this.deps.logger.info(
      `Network check for profile ${profileId}: proxy ${proxy.status}, location ${geoStatus}${geoReused ? ' (reused)' : ''}${ipChangedAt === checkedAt ? ', exit IP changed' : ''}`
    )
    return this.status(profileId)!
  }

  /**
   * Decides the time zone and locale a profile window applies. In Auto mode a missing or old
   * time zone is detected first; if detection fails and no valid time zone exists for the
   * current proxy, opening is refused with the reason instead of quietly using this PC's zone.
   */
  async planLaunch(profileId: string): Promise<LaunchPlan> {
    const profile = this.deps.profiles.get(profileId)
    const { browser } = profile
    const plan: LaunchPlan = { timezone: null, timezoneSource: 'off', locale: browser.language, warnings: [] }

    if (browser.timezoneMode === 'manual' && browser.timezoneManual) {
      return { ...plan, timezone: browser.timezoneManual, timezoneSource: 'manual' }
    }
    if (browser.timezoneMode !== 'auto') return plan
    if (!this.deps.geoEnabled()) {
      throw new ValidationError(
        'Automatic time zone needs the IP location lookup, which is turned off in Application Settings. ' +
          'Turn it on, or set this profile’s time zone manually.'
      )
    }

    let status = this.status(profileId)
    const now = this.now().getTime()
    const fresh =
      status?.current &&
      status.proxy.ok &&
      status.lastValidTimezoneCurrent &&
      status.lastValidTimezoneAt &&
      now - Date.parse(status.checkedAt) < LAUNCH_RECHECK_MS &&
      now - Date.parse(status.lastValidTimezoneAt) < GEO_CACHE_MS
    if (fresh) return { ...plan, timezone: status!.lastValidTimezone, timezoneSource: 'auto' }

    let failure: string | null = null
    try {
      status = await this.check(profileId)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const detectedNow = status?.current && status.geo.data?.timezone
    if (detectedNow) return { ...plan, timezone: status!.geo.data!.timezone, timezoneSource: 'auto' }

    const reason =
      failure ??
      (status && !status.proxy.ok ? status.proxy.message : (status?.geo.message ?? 'unknown error'))
    if (status?.lastValidTimezoneCurrent && status.lastValidTimezone) {
      return {
        ...plan,
        timezone: status.lastValidTimezone,
        timezoneSource: 'auto',
        warnings: [
          `Could not refresh the time zone (${reason}). Using ${status.lastValidTimezone}, detected for this proxy on ${status.lastValidTimezoneAt}.`
        ]
      }
    }
    const older = status?.lastValidTimezone
      ? ` The last detected time zone (${status.lastValidTimezone}) was for a different proxy, so it was not used.`
      : ''
    throw new ValidationError(
      `The time zone could not be detected through this profile’s proxy: ${reason}${older} ` +
        'Check the proxy and try again, or choose the time zone manually in the profile’s settings.'
    )
  }

  /**
   * Removes a profile's stored result. Not needed after a proxy change (the old result is then
   * shown as out of date); used when the user asks to clear it.
   */
  forget(profileId: string): void {
    this.deps.db.run('DELETE FROM profile_network_status WHERE profile_id = ?', [profileId])
  }
}
