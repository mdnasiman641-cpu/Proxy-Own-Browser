import { describe, expect, it } from 'vitest'
import {
  assessDns,
  assessLocalWebRtc,
  assessProxyRoute,
  assessStun,
  classifyAddress,
  compareValue,
  parseCandidate,
  parseCandidates
} from '../src/shared/diagnostics'
import { proxyInputChanges } from '../src/shared/proxy'
import { buildDiagnostics, parseProbeResult, probeScript } from '../src/main/services/diagnostics'
import type { ProxyConfig } from '../src/shared/types'
import { createService } from './helpers'

const HTTP: ProxyConfig = { protocol: 'http', host: '10.0.0.1', port: 8080, username: 'u', hasPassword: true, bypassRules: '' }
const host = (address: string, type = 'host') => `candidate:1 1 udp 2122260223 ${address} 54321 typ ${type} generation 0`

describe('ICE candidate parsing', () => {
  it('reads address, type and protocol and classifies the address', () => {
    expect(parseCandidate(host('192.168.1.5'))).toEqual({ type: 'host', protocol: 'udp', address: '192.168.1.5', kind: 'private-ip' })
    expect(parseCandidate(host('3b1c1d2e-aaaa-bbbb-cccc-1234567890ab.local'))!.kind).toBe('mdns')
    expect(parseCandidate(host('203.0.113.50', 'srflx'))).toMatchObject({ type: 'srflx', kind: 'public-ip' })
    expect(parseCandidate('a=' + host('fe80::1'))!.kind).toBe('private-ip')
    expect(parseCandidate('not a candidate')).toBeNull()
    expect(classifyAddress('2001:db8::5')).toBe('public-ip')
    expect(classifyAddress('100.64.0.1')).toBe('private-ip')
    expect(parseCandidates([host('10.0.0.5'), host('10.0.0.5'), 'junk'])).toHaveLength(1)
  })
})

describe('WebRTC verdicts', () => {
  it('passes when local addresses are hidden behind mDNS names or nothing is gathered', () => {
    expect(assessLocalWebRtc({ error: null, candidates: [host('abc.local')] }, '203.0.113.7', true).verdict).toBe('pass')
    expect(assessLocalWebRtc({ error: null, candidates: [] }, '203.0.113.7', true).verdict).toBe('pass')
  })

  it('warns about a visible private address and fails only on an observed different public address', () => {
    expect(assessLocalWebRtc({ error: null, candidates: [host('192.168.1.5')] }, '203.0.113.7', true).verdict).toBe('warning')
    const leak = assessLocalWebRtc({ error: null, candidates: [host('198.51.100.20')] }, '203.0.113.7', true)
    expect(leak.verdict).toBe('fail')
    expect(leak.detail).toContain('198.51.100.20')
    // The proxy's own exit IP is not a leak.
    expect(assessLocalWebRtc({ error: null, candidates: [host('203.0.113.7')] }, '203.0.113.7', true).verdict).not.toBe('fail')
  })

  it('reports unknown when the test could not run', () => {
    expect(assessLocalWebRtc(null, null, true).verdict).toBe('unknown')
    expect(assessLocalWebRtc({ error: 'blocked', candidates: [] }, null, true).verdict).toBe('unknown')
  })

  it('STUN: fails only when the server saw an address other than the proxy exit IP', () => {
    const server = 'stun:example'
    expect(assessStun({ error: null, candidates: [host('198.51.100.20', 'srflx')] }, '203.0.113.7', true, server).verdict).toBe('fail')
    expect(assessStun({ error: null, candidates: [host('203.0.113.7', 'srflx')] }, '203.0.113.7', true, server).verdict).toBe('pass')
    expect(assessStun({ error: null, candidates: [host('abc.local')] }, '203.0.113.7', true, server).verdict).toBe('pass')
    // Without a known exit IP nothing can be concluded.
    expect(assessStun({ error: null, candidates: [host('198.51.100.20', 'srflx')] }, null, true, server).verdict).toBe('unknown')
    // Without a proxy the connection's own address is expected.
    expect(assessStun({ error: null, candidates: [host('198.51.100.20', 'srflx')] }, null, false, server).verdict).toBe('info')
    expect(assessStun({ error: 'timeout', candidates: [] }, '203.0.113.7', true, server).verdict).toBe('unknown')
  })
})

describe('DNS and proxy route', () => {
  it('describes where host names are resolved for each proxy type', () => {
    expect(assessDns(null, null).verdict).toBe('info')
    expect(assessDns({ ...HTTP, protocol: 'socks4' }, true)).toMatchObject({ verdict: 'warning', observed: 'resolved on this PC' })
    expect(assessDns(HTTP, true).verdict).toBe('pass')
    expect(assessDns(HTTP, true).detail).toMatch(/cannot be observed/)
    expect(assessDns({ ...HTTP, protocol: 'socks5' }, null).verdict).toBe('unknown')
    expect(assessDns({ ...HTTP, bypassRules: '*.lan' }, true).verdict).toBe('warning')
    // A subtractive rule sends nothing direct.
    expect(assessDns({ ...HTTP, bypassRules: '<-loopback>' }, true).verdict).toBe('pass')
  })

  it('checks the proxy Chromium resolves for the session, and flags a direct fallback', () => {
    expect(assessProxyRoute(HTTP, 'PROXY 10.0.0.1:8080').verdict).toBe('pass')
    expect(assessProxyRoute({ ...HTTP, protocol: 'socks5' }, 'SOCKS5 10.0.0.1:8080').verdict).toBe('pass')
    expect(assessProxyRoute(HTTP, 'DIRECT').verdict).toBe('fail')
    expect(assessProxyRoute(HTTP, 'PROXY 10.0.0.1:8080; DIRECT').verdict).toBe('fail')
    expect(assessProxyRoute(HTTP, 'PROXY 10.9.9.9:8080').verdict).toBe('fail')
    expect(assessProxyRoute(null, 'DIRECT').verdict).toBe('pass')
    expect(assessProxyRoute(HTTP, null).verdict).toBe('unknown')
  })

  it('compares page values with the configured ones', () => {
    expect(compareValue('Asia/Dhaka', 'Asia/Dhaka').verdict).toBe('pass')
    expect(compareValue('Europe/London', 'Asia/Dhaka').verdict).toBe('fail')
    expect(compareValue('en-US', null).verdict).toBe('info')
    expect(compareValue(null, 'Asia/Dhaka').verdict).toBe('unknown')
  })
})

describe('diagnostics report', () => {
  it('only tests the page when the profile is open, and keeps sections separate', async () => {
    const { service } = await createService()
    const profile = service.create({ name: 'A', proxy: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 8080 } })
    const closed = buildDiagnostics({
      profile,
      network: null,
      page: null,
      resolvedProxy: null,
      pagePartition: null,
      expected: null,
      systemTimezone: 'UTC',
      stunServer: null,
      now: new Date('2026-10-11T00:00:00.000Z')
    })
    expect(closed.pageTested).toBe(false)
    expect(closed.proxyConnection.verdict).toBe('unknown')
    expect(closed.timezone.verdict).toBe('unknown')
    expect(closed.webrtcLocal.verdict).toBe('unknown')
    expect(closed.webrtcStun).toBeNull()
    expect(closed.partition.expected).toBe(profile.partition)

    const open = buildDiagnostics({
      profile,
      network: null,
      page: {
        url: 'https://example.com/',
        timezone: 'Asia/Calcutta',
        language: 'bn-BD',
        languages: ['bn-BD', 'bn', 'en'],
        userAgent: 'UA/1',
        webrtc: { error: null, candidates: [host('abc.local')] },
        stun: null
      },
      resolvedProxy: 'PROXY 10.0.0.1:8080',
      pagePartition: profile.partition,
      expected: { timezone: 'Asia/Kolkata', locale: 'bn-BD', userAgent: 'UA/1' },
      systemTimezone: 'UTC',
      stunServer: null,
      now: new Date()
    })
    // Alias names of the same zone match.
    expect(open.timezone.verdict).toBe('pass')
    expect(open.language.verdict).toBe('pass')
    expect(open.userAgent.verdict).toBe('pass')
    expect(open.partition.verdict).toBe('pass')
    expect(open.proxyRoute.verdict).toBe('pass')
    expect(open.webrtcLocal.verdict).toBe('pass')
  })

  it('validates what the page returned', () => {
    expect(parseProbeResult(null)).toBeNull()
    expect(parseProbeResult('x')).toBeNull()
    const parsed = parseProbeResult({ url: 'u', timezone: 5, languages: ['a', 7], webrtc: { candidates: ['c', 1] } })!
    expect(parsed.timezone).toBeNull()
    expect(parsed.languages).toEqual(['a'])
    expect(parsed.webrtc).toEqual({ error: null, candidates: ['c'] })
    expect(parsed.stun).toBeNull()
  })

  it('contacts a STUN server only when one is given', () => {
    expect(probeScript(null)).not.toContain('urls:')
    expect(probeScript('stun:stun.example:3478')).toContain('"stun:stun.example:3478"')
  })
})

describe('proxy change detection for open profiles', () => {
  it('detects route and credential changes but not an unchanged form', () => {
    expect(proxyInputChanges(HTTP, undefined)).toBe(false)
    expect(proxyInputChanges(HTTP, { enabled: true, protocol: 'http', host: '10.0.0.1', port: 8080, username: 'u', bypassRules: '' })).toBe(false)
    expect(proxyInputChanges(HTTP, { enabled: true, protocol: 'http', host: '10.0.0.1', port: 8080, username: 'u', password: 'new', bypassRules: '' })).toBe(true)
    expect(proxyInputChanges(HTTP, { enabled: true, protocol: 'http', host: '10.0.0.2', port: 8080, username: 'u', bypassRules: '' })).toBe(true)
    expect(proxyInputChanges(HTTP, { enabled: true, protocol: 'socks5', host: '10.0.0.1', port: 8080, username: 'u', bypassRules: '' })).toBe(true)
    expect(proxyInputChanges(HTTP, { enabled: false })).toBe(true)
    expect(proxyInputChanges(null, { enabled: false })).toBe(false)
    expect(proxyInputChanges(null, { enabled: true, protocol: 'http', host: 'h', port: 1 })).toBe(true)
    // Clearing a stored password is a change; an empty password with none stored is not.
    expect(proxyInputChanges(HTTP, { enabled: true, protocol: 'http', host: '10.0.0.1', port: 8080, username: 'u', password: '', bypassRules: '' })).toBe(true)
    expect(
      proxyInputChanges({ ...HTTP, hasPassword: false }, { enabled: true, protocol: 'http', host: '10.0.0.1', port: 8080, username: 'u', password: '', bypassRules: '' })
    ).toBe(false)
  })
})
