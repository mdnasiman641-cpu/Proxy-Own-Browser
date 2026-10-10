import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/shared/validation'
import { createApp } from './helpers'

describe('groups', () => {
  it('creates, renames and lists groups with profile counts', async () => {
    const { catalog, service } = await createApp()
    const shops = catalog.createGroup({ name: 'Shops' })
    const ads = catalog.createGroup({ name: 'Ads', color: '#dc2626' })
    service.create({ name: 'A', groupId: shops.id })
    service.create({ name: 'B', groupId: shops.id })
    expect(catalog.listGroups().map((g) => [g.name, g.profileCount])).toEqual([
      ['Ads', 0],
      ['Shops', 2]
    ])
    expect(catalog.updateGroup(ads.id, { name: 'Advertising' }).name).toBe('Advertising')
    expect(catalog.updateGroup(ads.id, { name: 'ADVERTISING' }).name).toBe('ADVERTISING')
  })

  it('rejects duplicate group names case-insensitively', async () => {
    const { catalog } = await createApp()
    const a = catalog.createGroup({ name: 'Shops' })
    catalog.createGroup({ name: 'Other' })
    expect(() => catalog.createGroup({ name: ' shops ' })).toThrow(/already exists/)
    expect(() => catalog.updateGroup(a.id, { name: 'other' })).toThrow(/already exists/)
  })

  it('deleting a group keeps its profiles and ungroups them', async () => {
    const { catalog, service } = await createApp()
    const g = catalog.createGroup({ name: 'Temp' })
    const p1 = service.create({ name: 'One', groupId: g.id })
    const p2 = service.create({ name: 'Two', groupId: g.id })
    expect(catalog.deleteGroup(g.id)).toBe(2)
    expect(service.count()).toBe(2)
    expect(service.get(p1.id).groupId).toBeNull()
    expect(service.get(p2.id).groupId).toBeNull()
    expect(catalog.listGroups()).toEqual([])
  })

  it('rejects references to groups that do not exist', async () => {
    const { service } = await createApp()
    const missing = '99999999-9999-4999-8999-999999999999'
    expect(() => service.create({ name: 'X', groupId: missing })).toThrow(/no longer exists/)
    const p = service.create({ name: 'Y' })
    expect(() => service.update(p.id, { groupId: missing })).toThrow(/no longer exists/)
    expect(() => service.update(p.id, { groupId: 'not-an-id' })).toThrow(ValidationError)
  })

  it('moves profiles between groups', async () => {
    const { catalog, service } = await createApp()
    const a = catalog.createGroup({ name: 'A' })
    const b = catalog.createGroup({ name: 'B' })
    const p = service.create({ name: 'Mover', groupId: a.id })
    expect(service.update(p.id, { groupId: b.id }).groupId).toBe(b.id)
    expect(service.update(p.id, { groupId: null }).groupId).toBeNull()
  })
})

describe('tags', () => {
  it('stores multiple tags per profile without duplicates (case-insensitive)', async () => {
    const { service, catalog } = await createApp()
    const p = service.create({ name: 'Tagged', tags: ['fb', 'Shop', 'FB', ' shop '] })
    expect(p.tags).toEqual(['fb', 'Shop'])
    expect(catalog.listTags().map((t) => t.name)).toEqual(['fb', 'Shop'])
    const q = service.create({ name: 'Other', tags: ['SHOP'] })
    expect(q.tags).toEqual(['Shop']) // reuses the existing tag's spelling
    expect(catalog.listTags().find((t) => t.name === 'Shop')!.profileCount).toBe(2)
  })

  it('adds and removes tags while keeping the others', async () => {
    const { service } = await createApp()
    const p = service.create({ name: 'P', tags: ['a', 'b'] })
    expect(service.changeTags(p.id, ['c', 'A'], ['b']).tags).toEqual(['a', 'c'])
    expect(service.changeTags(p.id, [], ['A', 'C']).tags).toEqual([])
  })

  it('validates tag names', async () => {
    const { service, catalog } = await createApp()
    expect(() => service.create({ name: 'P', tags: ['has,comma'] })).toThrow(/commas/)
    expect(() => service.create({ name: 'P', tags: [''] })).toThrow(/empty/)
    expect(() => service.create({ name: 'P', tags: ['x'.repeat(33)] })).toThrow(/at most 32/)
    expect(() => service.create({ name: 'P', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toThrow(/At most 20/)
    catalog.createTag('dup')
    expect(() => catalog.createTag('DUP')).toThrow(/already exists/)
  })

  it('deleting or renaming a tag never deletes profiles', async () => {
    const { service, catalog } = await createApp()
    service.create({ name: 'P1', tags: ['old'] })
    service.create({ name: 'P2', tags: ['old', 'keep'] })
    const old = catalog.listTags().find((t) => t.name === 'old')!
    expect(catalog.renameTag(old.id, 'new').name).toBe('new')
    expect(catalog.deleteTag(old.id)).toBe(2)
    expect(service.count()).toBe(2)
    expect(service.list().map((p) => p.tags)).toEqual([[], ['keep']])
  })

  it('removes tag links when a profile is deleted', async () => {
    const { service, catalog } = await createApp()
    const p = service.create({ name: 'P', tags: ['x'] })
    service.delete(p.id)
    expect(catalog.listTags()[0]!.profileCount).toBe(0)
  })
})

describe('templates', () => {
  it('creates, edits, duplicates and deletes templates', async () => {
    const { templates, catalog } = await createApp()
    const g = catalog.createGroup({ name: 'Shops' })
    const t = templates.create({ name: 'Shop', startUrl: 'https://example.com/', groupId: g.id, tags: ['fb'] })
    expect(t).toMatchObject({ name: 'Shop', startUrl: 'https://example.com/', groupId: g.id, tags: ['fb'], proxy: { mode: 'none' } })
    expect(templates.update(t.id, { name: 'Shop v2', tags: ['fb', 'bd'] }).tags).toEqual(['fb', 'bd'])
    expect(templates.duplicate(t.id).name).toBe('Shop v2 (copy)')
    expect(templates.duplicate(t.id).name).toBe('Shop v2 (copy 2)')
    templates.delete(t.id)
    expect(templates.list().map((x) => x.name)).toEqual(['Shop v2 (copy 2)', 'Shop v2 (copy)'])
  })

  it('validates every field before saving', async () => {
    const { templates, service } = await createApp()
    expect(() => templates.create({ name: '' })).toThrow(/required/)
    expect(() => templates.create({ name: 'Bad', startUrl: 'file:///C:/' })).toThrow(/http/)
    expect(() => templates.create({ name: 'Bad', groupId: '99999999-9999-4999-8999-999999999999' })).toThrow(/no longer exists/)
    const direct = service.create({ name: 'Direct' })
    expect(() =>
      templates.create({ name: 'Bad', proxy: { mode: 'copy-from-profile', profileId: direct.id } })
    ).toThrow(/has no proxy/)
    templates.create({ name: 'Ok' })
    expect(() => templates.create({ name: 'OK' })).toThrow(/already exists/)
  })

  it('stores a proxy as a reference to a profile, never the password', async () => {
    const { templates, service, db } = await createApp()
    const src = service.create({
      name: 'Proxy source',
      proxy: { enabled: true, protocol: 'http', host: '1.2.3.4', port: 80, username: 'u', password: 'top-secret' }
    })
    templates.create({ name: 'T', proxy: { mode: 'copy-from-profile', profileId: src.id } })
    const stored = JSON.stringify(db.all('SELECT * FROM templates'))
    expect(stored).not.toContain('top-secret')
    expect(stored).not.toContain('plain:v1:')
    expect(stored).toContain(src.id)
  })

  it('reports problems when a template refers to deleted data', async () => {
    const { templates, catalog, service } = await createApp()
    const g = catalog.createGroup({ name: 'G' })
    const src = service.create({ name: 'S', proxy: { enabled: true, protocol: 'http', host: '1.2.3.4', port: 80 } })
    const t = templates.create({ name: 'T', groupId: g.id, proxy: { mode: 'copy-from-profile', profileId: src.id } })
    expect(templates.problems(t)).toEqual([])
    catalog.deleteGroup(g.id)
    service.delete(src.id)
    expect(templates.problems(templates.get(t.id))).toEqual([
      'Its group no longer exists',
      'The profile it copies proxy settings from no longer exists'
    ])
  })
})
