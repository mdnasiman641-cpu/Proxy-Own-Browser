import { net, session, type Session } from 'electron'
import { buildProxyRules } from '@shared/proxy'
import type { ProxyTestResult } from '@shared/types'
import { ValidationError } from '@shared/validation'
import type { Logger } from '../services/logger'
import type { ProxyTestTarget } from '../services/profileService'
import { DEFAULT_GEO_TIMEOUT_MS, GEO_ENDPOINTS, runGeoLookup, type GeoEndpoint, type GeoLookupResult } from '../services/geoLookup'
import type { RouteChecker } from '../services/networkService'
import {
  DEFAULT_PROXY_TEST_TIMEOUT_MS,
  FetchError,
  IP_CHECK_ENDPOINTS,
  MAX_RESPONSE_BYTES,
  SYNTHETIC_CODES,
  isConfiguredProxyHost,
  netErrorCode,
  routeLabel,
  runProxyTest,
  type Fetcher,
  type IpCheckEndpoint
} from '../services/proxyTest'

const MAX_CONCURRENT_TESTS = 4

interface CheckResult {
  proxy: ProxyTestResult
  geo: GeoLookupResult | null
}

export interface ProxyTesterOptions {
  endpoints?: readonly IpCheckEndpoint[]
  timeoutMs?: number
  geoEndpoints?: readonly GeoEndpoint[]
  geoTimeoutMs?: number
}

/**
 * Tests a proxy by making a real HTTPS request through it with Chromium's network stack
 * (the same one the profile windows use).
 *
 * Each test runs in a throw-away in-memory session, so it never touches a profile's cookies or
 * cache and an unsaved draft can be tested safely. Proxy credentials are given only to the
 * configured proxy server when it challenges for them, and are never logged.
 */
export class ProxyTester implements RouteChecker {
  private readonly inFlight = new Map<string, Promise<CheckResult>>()
  private readonly endpoints: readonly IpCheckEndpoint[]
  private readonly timeoutMs: number
  private readonly geoEndpoints: readonly GeoEndpoint[]
  private readonly geoTimeoutMs: number

  constructor(
    private readonly logger: Logger,
    options: ProxyTesterOptions = {}
  ) {
    this.endpoints = options.endpoints ?? IP_CHECK_ENDPOINTS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TEST_TIMEOUT_MS
    this.geoEndpoints = options.geoEndpoints ?? GEO_ENDPOINTS
    this.geoTimeoutMs = options.geoTimeoutMs ?? DEFAULT_GEO_TIMEOUT_MS
  }

  /**
   * @param key identifies what is being tested (one test per key at a time — a second request
   *            for the same key while one is running receives the same result).
   */
  test(key: string, target: ProxyTestTarget): Promise<ProxyTestResult> {
    return this.check(key, target, { geo: false }).then((r) => r.proxy)
  }

  /**
   * Proxy test plus, when `geo` is set and the proxy works, an IP location lookup made through
   * the same proxy and throw-away session — so the location is that of the proxy's exit IP,
   * never this PC's own connection.
   */
  check(key: string, target: ProxyTestTarget, options: { geo: boolean }): Promise<CheckResult> {
    const running = this.inFlight.get(key)
    if (running) return running
    if (this.inFlight.size >= MAX_CONCURRENT_TESTS) {
      return Promise.reject(
        new ValidationError('Several proxy tests are already running. Try again in a moment.')
      )
    }
    const promise = this.run(key, target, options.geo).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  private async run(key: string, target: ProxyTestTarget, geo: boolean): Promise<CheckResult> {
    const ses = session.fromPartition(`proxy-test-${key}`, { cache: false })
    const route = routeLabel(target.proxy)
    try {
      await this.configure(ses, target)
      const result = await runProxyTest({
        fetcher: this.createFetcher(ses, target),
        route,
        endpoints: this.endpoints,
        timeoutMs: this.timeoutMs
      })
      // Status and timing only — no IP address, host or credentials in the log.
      this.logger.info(
        `Proxy test ${key}: ${result.status}${result.responseTimeMs !== null ? ` in ${result.responseTimeMs} ms` : ''}`
      )
      let location: GeoLookupResult | null = null
      if (geo && result.ok) {
        location = await runGeoLookup({
          fetcher: this.createFetcher(ses, target),
          endpoints: this.geoEndpoints,
          timeoutMs: this.geoTimeoutMs
        })
        this.logger.info(`IP location lookup ${key}: ${location.status}`)
      }
      return { proxy: result, geo: location }
    } finally {
      await this.reset(ses)
    }
  }

  private async configure(ses: Session, target: ProxyTestTarget): Promise<void> {
    await ses.clearAuthCache()
    await ses.clearStorageData()
    if (target.proxy) {
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: buildProxyRules(target.proxy),
        proxyBypassRules: target.proxy.bypassRules || undefined
      })
    } else {
      await ses.setProxy({ mode: 'direct' })
    }
    await ses.closeAllConnections()
  }

  /** Drops cached proxy credentials and pooled connections after each test. */
  private async reset(ses: Session): Promise<void> {
    try {
      await ses.clearAuthCache()
      await ses.closeAllConnections()
    } catch (error) {
      this.logger.warn('Could not reset proxy test session', error)
    }
  }

  private createFetcher(ses: Session, target: ProxyTestTarget): Fetcher {
    return (url, timeoutMs) =>
      new Promise((resolve, reject) => {
        let settled = false
        let proxyChallenges = 0
        let authProblem: string | null = null
        const chunks: Buffer[] = []
        let size = 0

        const request = net.request({
          url,
          session: ses,
          method: 'GET',
          redirect: 'error',
          useSessionCookies: false,
          cache: 'no-store'
        })

        const fail = (code: string): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // An auth problem explains whatever generic error Chromium reports afterwards.
          const finalCode = authProblem ?? code
          reject(new FetchError(finalCode, finalCode))
        }

        const timer = setTimeout(() => {
          request.abort()
          fail(SYNTHETIC_CODES.timeout)
        }, timeoutMs)

        request.on('login', (authInfo, callback) => {
          const fromOurProxy =
            authInfo.isProxy &&
            target.proxy !== null &&
            isConfiguredProxyHost(authInfo.host, target.proxy.host)
          if (!fromOurProxy) {
            // A website (not the proxy) asked for credentials: never answer.
            callback()
            return
          }
          proxyChallenges++
          if (!target.credentials) {
            authProblem = SYNTHETIC_CODES.authRequired
            callback()
          } else if (proxyChallenges > 1) {
            // The proxy challenged again after receiving the credentials: they were rejected.
            authProblem = SYNTHETIC_CODES.authRejected
            callback()
          } else {
            callback(target.credentials.username, target.credentials.password)
          }
        })

        request.on('response', (response) => {
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) {
              request.abort()
              fail(SYNTHETIC_CODES.tooLarge)
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (authProblem && response.statusCode === 407) {
              reject(new FetchError(authProblem, authProblem))
              return
            }
            resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
          })
          response.on('error', () => fail('ERR_FAILED'))
        })

        request.on('error', (error) => fail(netErrorCode(error.message)))
        request.end()
      })
  }
}
