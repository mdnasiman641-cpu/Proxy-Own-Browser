// Local network fixtures for the end-to-end smoke test. Nothing here ships with the app.
//
// - echo server: an "IP-check" endpoint plus simple pages for the tab tests
// - auth proxy:  HTTP forward proxy that requires Basic credentials
// - open proxy:  HTTP forward proxy without authentication
// - challenge proxy: forwards requests and asks the echo server to answer 401, to check that
//   proxy credentials are never offered to a website that asks for a login
// - blackhole:   accepts TCP connections and never answers (timeout test)
// - closed port: nothing listens there (unreachable test)
import http from 'node:http'
import net from 'node:net'

export const PROXIED_IP = '203.0.113.7' // TEST-NET-3 documentation address

/**
 * Exit identities of the fixture proxies (documentation IP ranges only). The echo server answers
 * IP and location requests according to the proxy a request came through, like a real IP service.
 */
export const EXITS = {
  ny: { ip: PROXIED_IP, country: 'United States', country_code: 'US', region: 'New York', city: 'New York', latitude: 40.7128, longitude: -74.006, timezone: { id: 'America/New_York' }, connection: { asn: 64500, org: 'Example NY Hosting', isp: 'Example NY ISP' } },
  chi: { ip: '198.51.100.23', country: 'United States', country_code: 'US', region: 'Illinois', city: 'Chicago', latitude: 41.8781, longitude: -87.6298, timezone: { id: 'America/Chicago' }, connection: { asn: 64501, org: 'Example Chicago Cloud', isp: 'Example Chicago ISP' } },
  'lab-a': { ip: '192.0.2.10', country: 'United Kingdom', country_code: 'GB', region: 'England', city: 'London', latitude: 51.5072, longitude: -0.1276, timezone: { id: 'Europe/London' }, connection: { asn: 64502, org: 'Example UK', isp: 'Example UK ISP' } },
  'lab-b': { ip: '192.0.2.11', country: 'Germany', country_code: 'DE', region: 'Berlin', city: null, latitude: 52.52, longitude: 13.405, timezone: { id: 'Europe/Berlin' }, connection: { asn: 64503, org: null, isp: 'Example DE ISP' } }
}
export const PROXY_USER = 'smoke-user'
export const PROXY_PASS = 'smoke-S3cret!'

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

function createEcho() {
  // The "lab" proxy's exit IP and the location service's behaviour can be changed by the test:
  // GET /lab?exit=lab-b&geo=fail|hang|ok
  const lab = { exit: 'lab-a', geo: 'ok' }
  const exitOf = (req) => {
    if (req.headers['x-pob-test-proxy'] !== '1') return null
    const id = req.headers['x-pob-exit'] ?? 'ny'
    return id === 'lab' ? lab.exit : id
  }
  const stats = { requests: 0, authorizationHeadersSeen: 0, proxyAuthorizationHeadersSeen: 0, geoRequests: 0, paths: [] }
  const server = http.createServer((req, res) => {
    stats.requests++
    if (req.headers.authorization) stats.authorizationHeadersSeen++
    if (req.headers['proxy-authorization']) stats.proxyAuthorizationHeadersSeen++
    const url = new URL(req.url, 'http://127.0.0.1')
    if (stats.paths.length < 500) stats.paths.push(url.pathname + url.search)

    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(stats))
      return
    }
    if (url.pathname === '/lab') {
      if (url.searchParams.get('exit')) lab.exit = url.searchParams.get('exit')
      if (url.searchParams.get('geo')) lab.geo = url.searchParams.get('geo')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(lab))
      return
    }
    if (url.pathname === '/ip') {
      if (req.headers['x-pob-want-401'] === '1') {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="website"' })
        res.end('login required')
        return
      }
      const exit = exitOf(req)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ip: exit ? EXITS[exit].ip : '127.0.0.1' }))
      return
    }
    if (url.pathname === '/geo') {
      // Shaped like https://ipwho.is/ — a documentation IP in New York through the proxy;
      // a direct request comes from 127.0.0.1, which (like the real service) can't be located.
      stats.geoRequests++
      const exit = exitOf(req)
      const viaLab = req.headers['x-pob-exit'] === 'lab'
      if (viaLab && lab.geo === 'hang') return // never answers: the app must time out
      if (viaLab && lab.geo === 'fail') {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: 'Service unavailable' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(exit ? { success: true, ...EXITS[exit] } : { ip: '127.0.0.1', success: false, message: 'Reserved range' }))
      return
    }
    if (url.pathname === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ acceptLanguage: req.headers['accept-language'] ?? null, userAgent: req.headers['user-agent'] ?? null, dnt: req.headers.dnt ?? null }))
      return
    }
    if (url.pathname === '/page') {
      const n = Number(url.searchParams.get('n') ?? '1')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><title>Smoke page ${n}</title><h1>Page ${n}</h1>` +
          `<a id="new-tab-link" href="/page?n=${n + 1}" target="_blank">open next</a>`
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  return { server, stats }
}

/** Minimal HTTP forward proxy (absolute-form requests only — the endpoints are plain HTTP). */
function createProxy({ requireAuth, forceWebsite401 = false, exit = 'ny' }) {
  const expected = 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64')
  const stats = { requests: 0, rejectedAuth: 0 }
  const server = http.createServer((req, res) => {
    stats.requests++
    if (requireAuth && req.headers['proxy-authorization'] !== expected) {
      if (req.headers['proxy-authorization']) stats.rejectedAuth++
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pob-smoke"' })
      res.end()
      return
    }
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const headers = { ...req.headers, 'x-pob-test-proxy': '1', 'x-pob-exit': exit }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    if (forceWebsite401) headers['x-pob-want-401'] = '1'
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Not Allowed\r\n\r\n'))
  return { server, stats }
}

export async function startFixtures() {
  const echo = createEcho()
  const authProxy = createProxy({ requireAuth: true })
  const openProxy = createProxy({ requireAuth: false, exit: 'chi' })
  const sameExitProxy = createProxy({ requireAuth: false, exit: 'ny' })
  const labProxy = createProxy({ requireAuth: false, exit: 'lab' })
  const challengeProxy = createProxy({ requireAuth: false, forceWebsite401: true })
  const sockets = new Set()
  const blackhole = net.createServer((socket) => {
    sockets.add(socket) // accept, never answer
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })

  const closedServer = net.createServer()
  const closedPort = await listen(closedServer)
  await new Promise((r) => closedServer.close(r))

  const ports = {
    echoPort: await listen(echo.server),
    authProxyPort: await listen(authProxy.server),
    openProxyPort: await listen(openProxy.server),
    sameExitProxyPort: await listen(sameExitProxy.server),
    labProxyPort: await listen(labProxy.server),
    challengeProxyPort: await listen(challengeProxy.server),
    blackholePort: await listen(blackhole),
    closedPort
  }

  return {
    env: {
      POB_PROXY_TEST_URL: `http://127.0.0.1:${ports.echoPort}/ip`,
      POB_GEO_TEST_URL: `http://127.0.0.1:${ports.echoPort}/geo`,
      POB_PROXY_TEST_TIMEOUT_MS: '3000',
      POB_SMOKE_FIXTURES: JSON.stringify({
        ...ports,
        echoBase: `http://127.0.0.1:${ports.echoPort}`,
        proxiedIp: PROXIED_IP,
        exits: Object.fromEntries(Object.entries(EXITS).map(([id, e]) => [id, { ip: e.ip, city: e.city, timezone: e.timezone.id, isp: e.connection.isp }])),
        user: PROXY_USER,
        pass: PROXY_PASS
      })
    },
    stats: { echo: echo.stats, authProxy: authProxy.stats },
    async stop() {
      for (const s of sockets) s.destroy()
      for (const server of [echo.server, authProxy.server, openProxy.server, sameExitProxy.server, labProxy.server, challengeProxy.server, blackhole]) {
        server.closeAllConnections?.()
        await new Promise((r) => server.close(r))
      }
    }
  }
}
