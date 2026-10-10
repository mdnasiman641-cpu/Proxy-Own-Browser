import { describe, expect, it } from 'vitest'
import {
  isValidProxyHost,
  profileInputSchema,
  proxyInputSchema,
  settingsUpdateSchema
} from '../src/shared/validation'

describe('profile input validation', () => {
  it('accepts a minimal profile and normalises fields', () => {
    const parsed = profileInputSchema.parse({ name: '  Main  ', startUrl: '' })
    expect(parsed.name).toBe('Main')
    expect(parsed.startUrl).toBeNull()
    expect(parsed.notes).toBe('')
  })

  it('rejects control characters and blank names', () => {
    expect(profileInputSchema.safeParse({ name: '   ' }).success).toBe(false)
    expect(profileInputSchema.safeParse({ name: 'bad\u0000name' }).success).toBe(false)
  })

  it('only accepts http(s) start pages', () => {
    expect(profileInputSchema.safeParse({ name: 'a', startUrl: 'https://ok.com' }).success).toBe(true)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'not a url']) {
      expect(profileInputSchema.safeParse({ name: 'a', startUrl: url }).success).toBe(false)
    }
  })
})

describe('proxy validation', () => {
  it('accepts a valid proxy', () => {
    expect(
      proxyInputSchema.safeParse({ enabled: true, protocol: 'http', host: '192.168.1.10', port: 8080 }).success
    ).toBe(true)
  })

  it('does not validate fields of a disabled proxy', () => {
    expect(proxyInputSchema.safeParse({ enabled: false, host: '!!!', port: -1 }).success).toBe(true)
  })

  it.each<[Record<string, unknown>, string]>([
    [{ protocol: 'http', host: '', port: 80 }, 'host'],
    [{ protocol: 'http', host: 'bad host', port: 80 }, 'host'],
    [{ protocol: 'http', host: 'ok.com', port: 0 }, 'port'],
    [{ protocol: 'http', host: 'ok.com', port: 70000 }, 'port'],
    [{ protocol: 'http', host: 'ok.com', port: 80.5 }, 'port'],
    [{ host: 'ok.com', port: 80 }, 'protocol'],
    [{ protocol: 'ftp', host: 'ok.com', port: 80 }, 'protocol'],
    [{ protocol: 'http', host: 'ok.com', port: 80, password: 'x' }, 'username'],
    [{ protocol: 'socks5', host: 'ok.com', port: 80, username: 'u' }, 'username']
  ])('rejects %o (problem: %s)', (proxy, field) => {
    const result = proxyInputSchema.safeParse({ enabled: true, ...proxy })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true)
    }
  })

  it('validates hosts', () => {
    expect(isValidProxyHost('proxy.example.com')).toBe(true)
    expect(isValidProxyHost('10.0.0.1')).toBe(true)
    expect(isValidProxyHost('::1')).toBe(true)
    expect(isValidProxyHost('[2001:db8::1]')).toBe(true)
    expect(isValidProxyHost('localhost')).toBe(true)
    expect(isValidProxyHost('exa mple.com')).toBe(false)
    expect(isValidProxyHost('http://x.com')).toBe(false)
    expect(isValidProxyHost('-bad.com')).toBe(false)
  })

  it('rejects unexpected characters in the bypass list', () => {
    expect(
      proxyInputSchema.safeParse({
        enabled: true,
        protocol: 'http',
        host: 'a.com',
        port: 1,
        bypassRules: 'localhost, *.local, <-loopback>'
      }).success
    ).toBe(true)
    expect(
      proxyInputSchema.safeParse({ enabled: true, protocol: 'http', host: 'a.com', port: 1, bypassRules: '"; rm' })
        .success
    ).toBe(false)
  })
})

describe('settings validation', () => {
  it('limits concurrent windows to 1–10', () => {
    expect(settingsUpdateSchema.safeParse({ maxOpenProfiles: 2 }).success).toBe(true)
    expect(settingsUpdateSchema.safeParse({ maxOpenProfiles: 0 }).success).toBe(false)
    expect(settingsUpdateSchema.safeParse({ maxOpenProfiles: 11 }).success).toBe(false)
  })

  it('requires an http(s) homepage and a known search engine', () => {
    expect(settingsUpdateSchema.safeParse({ homepage: 'file:///c:/' }).success).toBe(false)
    expect(settingsUpdateSchema.safeParse({ searchEngine: 'yahoo' }).success).toBe(false)
    expect(settingsUpdateSchema.safeParse({ searchEngine: 'duckduckgo' }).success).toBe(true)
  })
})
