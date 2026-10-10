import { describe, expect, it } from 'vitest'
import { NotFoundError } from '../src/main/services/profileService'
import { EncodingOnlyCipher } from '../src/main/services/secretCipher'
import { ValidationError } from '../src/shared/validation'
import { createService } from './helpers'

describe('ProfileService — creation', () => {
  it('creates a profile with defaults and a persistent partition', async () => {
    const { service } = await createService()
    const profile = service.create({ name: '  Shop Page  ' })

    expect(profile.name).toBe('Shop Page')
    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(profile.partition).toBe(`persist:profile-${profile.id}`)
    expect(profile.proxy).toBeNull()
    expect(profile.startUrl).toBeNull()
    expect(profile.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(profile.lastOpenedAt).toBeNull()
    expect(service.count()).toBe(1)
  })

  it('stores at least 20 profiles, each with its own partition', async () => {
    const { service } = await createService()
    for (let i = 1; i <= 25; i++) service.create({ name: `Profile ${i}` })

    const all = service.list()
    expect(all).toHaveLength(25)
    expect(new Set(all.map((p) => p.partition)).size).toBe(25)
    expect(new Set(all.map((p) => p.id)).size).toBe(25)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const { service } = await createService()
    service.create({ name: 'Main' })
    expect(() => service.create({ name: 'MAIN' })).toThrow(ValidationError)
  })

  it('rejects invalid input with a readable message', async () => {
    const { service } = await createService()
    expect(() => service.create({ name: '' })).toThrow('Profile name is required')
    expect(() => service.create({ name: 'x'.repeat(61) })).toThrow(/at most 60/)
    expect(() => service.create({ name: 'Ok', startUrl: 'file:///C:/secret' })).toThrow(/http/)
    expect(() => service.create({ name: 'Ok', color: 'red' })).toThrow(/hex/)
  })

  it('enforces the maximum number of profiles', async () => {
    const { service } = await createService({ maxProfiles: 3 })
    service.create({ name: 'A' })
    service.create({ name: 'B' })
    service.create({ name: 'C' })
    expect(() => service.create({ name: 'D' })).toThrow(/at most 3/)
  })

  it('creates a profile with an authenticated HTTP proxy and never exposes the password', async () => {
    const { service, repo } = await createService()
    const profile = service.create({
      name: 'Proxied',
      proxy: { enabled: true, protocol: 'http', host: '10.0.0.5', port: 3128, username: 'bob', password: 's3cret' }
    })

    expect(profile.proxy).toEqual({
      protocol: 'http',
      host: '10.0.0.5',
      port: 3128,
      username: 'bob',
      hasPassword: true,
      bypassRules: ''
    })
    expect(JSON.stringify(profile)).not.toContain('s3cret')
    // Stored value is passed through the cipher, not saved as typed.
    expect(repo.findById(profile.id)?.proxyPassword).not.toBe('s3cret')
    expect(service.getProxyCredentials(profile.id)).toEqual({ username: 'bob', password: 's3cret' })
  })

  it('rejects SOCKS proxies with credentials (unsupported by Chromium)', async () => {
    const { service } = await createService()
    expect(() =>
      service.create({
        name: 'Socks',
        proxy: { enabled: true, protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u', password: 'p' }
      })
    ).toThrow(/SOCKS/)
    const ok = service.create({
      name: 'Socks ok',
      proxy: { enabled: true, protocol: 'socks5', host: 'proxy.example.com', port: 1080 }
    })
    expect(ok.proxy?.protocol).toBe('socks5')
  })
})

describe('ProfileService — editing, deleting, searching', () => {
  it('updates fields and keeps the partition unchanged', async () => {
    const { service } = await createService()
    const created = service.create({ name: 'Before' })
    const updated = service.update(created.id, {
      name: 'After',
      notes: 'note',
      startUrl: 'https://example.com/'
    })
    expect(updated.name).toBe('After')
    expect(updated.notes).toBe('note')
    expect(updated.startUrl).toBe('https://example.com/')
    expect(updated.partition).toBe(created.partition)
    expect(service.get(created.id).name).toBe('After')
  })

  it('allows renaming to the same name with different case', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'shop' })
    expect(service.update(p.id, { name: 'Shop' }).name).toBe('Shop')
  })

  it('keeps the stored proxy password when the password field is left empty, and clears it on request', async () => {
    const { service } = await createService()
    const p = service.create({
      name: 'P',
      proxy: { enabled: true, protocol: 'https', host: 'p.example.com', port: 443, username: 'u', password: 'pw1' }
    })
    service.update(p.id, {
      proxy: { enabled: true, protocol: 'https', host: 'p.example.com', port: 8443, username: 'u' }
    })
    expect(service.getProxyCredentials(p.id)?.password).toBe('pw1')
    expect(service.get(p.id).proxy?.port).toBe(8443)

    const cleared = service.update(p.id, {
      proxy: { enabled: true, protocol: 'https', host: 'p.example.com', port: 8443, username: 'u', password: '' }
    })
    expect(cleared.proxy?.hasPassword).toBe(false)
  })

  it('removes all proxy data when the proxy is disabled', async () => {
    const { service, repo } = await createService()
    const p = service.create({
      name: 'P',
      proxy: { enabled: true, protocol: 'http', host: '1.2.3.4', port: 80, username: 'u', password: 'x' }
    })
    const updated = service.update(p.id, { proxy: { enabled: false } })
    expect(updated.proxy).toBeNull()
    expect(repo.findById(p.id)?.proxyPassword).toBeNull()
    expect(service.getProxyCredentials(p.id)).toBeNull()
  })

  it('deletes a profile and reports unknown ids', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'Gone' })
    expect(service.delete(p.id).id).toBe(p.id)
    expect(service.count()).toBe(0)
    expect(() => service.get(p.id)).toThrow(NotFoundError)
    expect(() => service.delete(p.id)).toThrow(NotFoundError)
    expect(() => service.get('not-a-uuid')).toThrow(ValidationError)
  })

  it('searches by name, notes and proxy host', async () => {
    const { service } = await createService()
    service.create({ name: 'Facebook Shop', notes: 'main page' })
    service.create({ name: 'Second', notes: 'backup account' })
    service.create({
      name: 'Third',
      proxy: { enabled: true, protocol: 'http', host: 'dhaka.proxy.net', port: 8080 }
    })

    expect(service.list('facebook').map((p) => p.name)).toEqual(['Facebook Shop'])
    expect(service.list('BACKUP').map((p) => p.name)).toEqual(['Second'])
    expect(service.list('dhaka').map((p) => p.name)).toEqual(['Third'])
    expect(service.list('nothing-matches')).toEqual([])
    expect(service.list('%')).toEqual([])
    expect(service.list('')).toHaveLength(3)
  })

  it('records when a profile was last opened', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'Opened' })
    service.markOpened(p.id)
    expect(service.get(p.id).lastOpenedAt).not.toBeNull()
  })

  it('reports undecryptable passwords as an error instead of returning garbage', async () => {
    const cipher = new EncodingOnlyCipher()
    const { service, repo } = await createService({ cipher })
    const p = service.create({
      name: 'Moved PC',
      proxy: { enabled: true, protocol: 'http', host: '1.2.3.4', port: 80, username: 'u', password: 'pw' }
    })
    const record = repo.findById(p.id)!
    repo.update({ ...record, proxyPassword: 'enc:v1:not-for-this-machine' })
    expect(() => service.getProxyCredentials(p.id)).toThrow()
  })
})

describe('ProfileService — proxy test target', () => {
  const savedProxy = {
    enabled: true,
    protocol: 'http' as const,
    host: 'proxy.example.com',
    port: 3128,
    username: 'bob',
    password: 'saved-pw'
  }

  it('uses the saved proxy and decrypted credentials when no draft is given', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'P', proxy: savedProxy })
    const target = service.resolveProxyTestTarget(p.id)
    expect(target.proxy).toMatchObject({ protocol: 'http', host: 'proxy.example.com', port: 3128 })
    expect(target.credentials).toEqual({ username: 'bob', password: 'saved-pw' })
  })

  it('tests a direct connection for a profile without a proxy', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'Direct' })
    expect(service.resolveProxyTestTarget(p.id)).toEqual({ proxy: null, credentials: null })
  })

  it('reuses the saved password only for a draft with the same server and username', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'P', proxy: savedProxy })
    const { password: _omit, ...draft } = savedProxy

    expect(service.resolveProxyTestTarget(p.id, draft).credentials?.password).toBe('saved-pw')
    expect(service.resolveProxyTestTarget(p.id, { ...draft, host: 'other.example.com' }).credentials).toEqual({
      username: 'bob',
      password: ''
    })
    expect(service.resolveProxyTestTarget(p.id, { ...draft, port: 9999 }).credentials?.password).toBe('')
  })

  it('uses a typed password, and treats an empty password as "no password"', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'P', proxy: savedProxy })
    expect(service.resolveProxyTestTarget(p.id, { ...savedProxy, password: 'typed' }).credentials?.password).toBe(
      'typed'
    )
    expect(service.resolveProxyTestTarget(p.id, { ...savedProxy, password: '' }).credentials?.password).toBe('')
  })

  it('tests drafts for new (unsaved) profiles without any stored secrets', async () => {
    const { service } = await createService()
    const target = service.resolveProxyTestTarget(null, {
      enabled: true,
      protocol: 'socks5',
      host: '10.0.0.1',
      port: 1080
    })
    expect(target.proxy?.protocol).toBe('socks5')
    expect(target.credentials).toBeNull()
  })

  it('validates drafts before testing', async () => {
    const { service } = await createService()
    expect(() => service.resolveProxyTestTarget(null, { enabled: true, protocol: 'http', host: 'bad host', port: 80 })).toThrow(
      ValidationError
    )
    expect(() => service.resolveProxyTestTarget(null)).toThrow(/Choose a profile/)
  })
})
