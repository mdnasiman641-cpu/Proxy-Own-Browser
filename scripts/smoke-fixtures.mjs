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
export const PROXY_USER = 'smoke-user'
export const PROXY_PASS = 'smoke-S3cret!'

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

function createEcho() {
  const stats = { requests: 0, authorizationHeadersSeen: 0, proxyAuthorizationHeadersSeen: 0, paths: [] }
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
    if (url.pathname === '/ip') {
      if (req.headers['x-pob-want-401'] === '1') {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="website"' })
        res.end('login required')
        return
      }
      const viaProxy = req.headers['x-pob-test-proxy'] === '1'
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ip: viaProxy ? PROXIED_IP : '127.0.0.1' }))
      return
    }
    if (url.pathname === '/geo') {
      // Shaped like https://ipwho.is/ — a documentation IP in New York through the proxy;
      // a direct request comes from 127.0.0.1, which (like the real service) can't be located.
      const viaProxy = req.headers['x-pob-test-proxy'] === '1'
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(
        JSON.stringify(
          viaProxy
            ? {
                ip: PROXIED_IP,
                success: true,
                country: 'United States',
                country_code: 'US',
                region: 'New York',
                city: 'New York',
                latitude: 40.7128,
                longitude: -74.006,
                timezone: { id: 'America/New_York' }
              }
            : { ip: '127.0.0.1', success: false, message: 'Reserved range' }
        )
      )
      return
    }
    if (url.pathname === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ acceptLanguage: req.headers['accept-language'] ?? null, userAgent: req.headers['user-agent'] ?? null }))
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
function createProxy({ requireAuth, forceWebsite401 = false }) {
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
    const headers = { ...req.headers, 'x-pob-test-proxy': '1' }
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
  const openProxy = createProxy({ requireAuth: false })
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
        user: PROXY_USER,
        pass: PROXY_PASS
      })
    },
    stats: { echo: echo.stats, authProxy: authProxy.stats },
    async stop() {
      for (const s of sockets) s.destroy()
      for (const server of [echo.server, authProxy.server, openProxy.server, challengeProxy.server, blackhole]) {
        server.closeAllConnections?.()
        await new Promise((r) => server.close(r))
      }
    }
  }
}
