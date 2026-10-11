import type { ProxyConfig, ProxyInput } from './types'

const PROTOCOL_LABEL: Record<ProxyConfig['protocol'], string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5'
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** Chromium `proxyRules` string for a profile proxy. Never contains credentials. */
export function buildProxyRules(proxy: Pick<ProxyConfig, 'protocol' | 'host' | 'port'>): string {
  return `${proxy.protocol}://${formatHost(proxy.host)}:${proxy.port}`
}

/** Human-readable proxy summary that is safe to display and log (no username/password). */
export function describeProxy(proxy: ProxyConfig | null): string | null {
  if (!proxy) return null
  const auth = proxy.username ? ' (auth)' : ''
  return `${PROTOCOL_LABEL[proxy.protocol]} ${formatHost(proxy.host)}:${proxy.port}${auth}`
}

export interface ParsedProxyString {
  protocol: ProxyConfig['protocol']
  host: string
  port: number
  username: string
  password: string
}

/**
 * Parses common proxy formats so they can be pasted into the form:
 * `host:port`, `host:port:user:pass`, `user:pass@host:port`, `socks5://host:port`,
 * `http://user:pass@host:port`. Returns null if the text is not recognised.
 */
export function parseProxyString(text: string): ParsedProxyString | null {
  let value = text.trim()
  if (!value) return null
  let protocol: ProxyConfig['protocol'] = 'http'
  const scheme = /^(https?|socks4|socks5|socks5h):\/\//i.exec(value)
  if (scheme) {
    const s = scheme[1]!.toLowerCase()
    protocol = s === 'socks5h' ? 'socks5' : (s as ProxyConfig['protocol'])
    value = value.slice(scheme[0].length)
  }
  value = value.replace(/\/+$/, '')

  let username = ''
  let password = ''
  const at = value.lastIndexOf('@')
  if (at !== -1) {
    const auth = value.slice(0, at)
    value = value.slice(at + 1)
    const colon = auth.indexOf(':')
    username = colon === -1 ? auth : auth.slice(0, colon)
    password = colon === -1 ? '' : auth.slice(colon + 1)
  }

  let host: string
  let rest: string[]
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return null
    host = value.slice(1, end)
    rest = value.slice(end + 2).split(':')
  } else {
    const parts = value.split(':')
    host = parts[0] ?? ''
    rest = parts.slice(1)
  }
  const port = Number(rest[0])
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (at === -1 && rest.length >= 3) {
    username = rest[1] ?? ''
    password = rest.slice(2).join(':')
  } else if (rest.length !== 1) {
    return null
  }
  try {
    username = decodeURIComponent(username)
    password = decodeURIComponent(password)
  } catch {
    /* keep raw values */
  }
  return { protocol, host, port, username, password }
}

/**
 * Removes credentials from free text before it is written to a log:
 * `scheme://user:pass@host`, `password=…`, `"password":"…"` and Proxy-Authorization headers.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(:[^/\s@]*)?@/gi, '$1***:***@')
    .replace(/((?:password|passwd|pwd|secret|token)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1***')
    .replace(/(proxy-authorization\s*:\s*)\S+(\s+\S+)?/gi, '$1***')
}

/**
 * Normalized identity of a proxy endpoint, used to detect two profiles sharing one proxy and to
 * tell whether a stored IP check still applies. Host is lower-cased (trailing dot removed),
 * the protocol is ignored (one server, one endpoint), and the username is included because
 * many providers hand out a different exit IP per username/session. Never contains a password.
 */
export function proxyEndpointKey(
  proxy: Pick<ProxyConfig, 'host' | 'port'> & { username?: string | null } | null
): string {
  if (!proxy) return 'direct'
  const host = proxy.host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  return `${host}:${proxy.port}|${proxy.username ?? ''}`
}

/** Main-process refusal when an open profile's proxy would change without confirmation. */
export const RUNNING_PROXY_CHANGE_MESSAGE =
  'This profile is open in a window. Changing its proxy switches the network route of every open tab: pages that are loading may fail, and sites can see a new IP address in the same session. Confirm to change it now.'

/**
 * Whether saving `input` would change the profile's proxy route or credentials. Used to ask for
 * confirmation before changing the proxy of a profile whose window is open. A typed password
 * counts as a change (stored passwords are never sent back to compare).
 */
export function proxyInputChanges(current: ProxyConfig | null, input: ProxyInput | undefined): boolean {
  if (input === undefined) return false
  if (!input.enabled) return current !== null
  if (!current) return true
  const host = (input.host ?? '').trim().toLowerCase()
  const username = (input.username ?? '').trim() || null
  if (
    input.protocol !== current.protocol ||
    host !== current.host.toLowerCase() ||
    Number(input.port) !== current.port ||
    username !== (current.username ?? null) ||
    (input.bypassRules ?? '').trim() !== current.bypassRules
  ) {
    return true
  }
  if (input.password === undefined) return false
  return input.password !== '' || current.hasPassword
}
