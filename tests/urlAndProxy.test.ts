import { describe, expect, it } from 'vitest'
import {
  buildProxyRules,
  describeProxy,
  parseProxyString,
  redactSecrets,
  type ParsedProxyString
} from '../src/shared/proxy'
import { isNavigableUrl, normalizeAddressInput } from '../src/shared/url'

describe('address bar input', () => {
  const go = (input: string): string | null => normalizeAddressInput(input, 'google')

  it('keeps full http(s) URLs', () => {
    expect(go('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(go('http://example.com')).toBe('http://example.com/')
  })

  it('adds https:// to domains and http:// to local addresses', () => {
    expect(go('example.com')).toBe('https://example.com/')
    expect(go('www.facebook.com/page')).toBe('https://www.facebook.com/page')
    expect(go('localhost:3000')).toBe('http://localhost:3000/')
    expect(go('192.168.0.1')).toBe('http://192.168.0.1/')
  })

  it('searches for everything else', () => {
    expect(go('mobile phone price')).toBe('https://www.google.com/search?q=mobile%20phone%20price')
    expect(normalizeAddressInput('hello', 'duckduckgo')).toBe('https://duckduckgo.com/?q=hello')
  })

  it('blocks dangerous schemes and ignores empty input', () => {
    expect(go('javascript:alert(1)')).toBeNull()
    expect(go('file:///C:/Windows')).toBeNull()
    expect(go('chrome://settings')).toBeNull()
    expect(go('   ')).toBeNull()
  })

  it('identifies navigable URLs', () => {
    expect(isNavigableUrl('https://a.com')).toBe(true)
    expect(isNavigableUrl('about:blank')).toBe(true)
    expect(isNavigableUrl('file:///x')).toBe(false)
    expect(isNavigableUrl('data:text/html,hi')).toBe(false)
  })
})

describe('proxy helpers', () => {
  const base = { username: null, hasPassword: false, bypassRules: '' }

  it('builds Chromium proxy rules without credentials', () => {
    expect(buildProxyRules({ protocol: 'http', host: '1.2.3.4', port: 8080 })).toBe('http://1.2.3.4:8080')
    expect(buildProxyRules({ protocol: 'socks5', host: 'p.net', port: 1080 })).toBe('socks5://p.net:1080')
    expect(buildProxyRules({ protocol: 'https', host: '2001:db8::1', port: 443 })).toBe('https://[2001:db8::1]:443')
  })

  it('describes a proxy without revealing the username', () => {
    expect(describeProxy(null)).toBeNull()
    expect(describeProxy({ ...base, protocol: 'http', host: 'p.net', port: 80 })).toBe('HTTP p.net:80')
    const withAuth = describeProxy({ ...base, protocol: 'https', host: 'p.net', port: 443, username: 'secretuser', hasPassword: true })
    expect(withAuth).toBe('HTTPS p.net:443 (auth)')
    expect(withAuth).not.toContain('secretuser')
  })

  it('redacts credentials from log text', () => {
    const line = 'failed http://alice:hunter2@10.0.0.1:8080 password=hunter2 {"password":"hunter2"} Proxy-Authorization: Basic YWxpY2U6aHVudGVyMg=='
    const out = redactSecrets(line)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('alice')
    expect(out).not.toContain('YWxpY2U6aHVudGVyMg')
    expect(out).toContain('10.0.0.1:8080')
  })

  it.each<[string, ParsedProxyString]>([
    ['1.2.3.4:8080', { protocol: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' }],
    ['1.2.3.4:8080:user:pa:ss', { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pa:ss' }],
    ['user:pass@proxy.net:3128', { protocol: 'http', host: 'proxy.net', port: 3128, username: 'user', password: 'pass' }],
    ['socks5://proxy.net:1080', { protocol: 'socks5', host: 'proxy.net', port: 1080, username: '', password: '' }],
    ['https://u%40x:p@proxy.net:443/', { protocol: 'https', host: 'proxy.net', port: 443, username: 'u@x', password: 'p' }]
  ])('parses proxy string %s', (input, expected) => {
    expect(parseProxyString(input)).toEqual(expected)
  })

  it.each<string>(['', 'proxy.net', 'proxy.net:99999', 'a:b:c', 'proxy.net:abc'])('rejects proxy string %j', (input) => {
    expect(parseProxyString(input)).toBeNull()
  })
})
