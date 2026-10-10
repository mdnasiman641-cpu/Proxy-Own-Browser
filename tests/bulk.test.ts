import { describe, expect, it } from 'vitest'
import { generateNames } from '../src/main/services/bulkCreate'
import { runBulk, summarize } from '../src/main/services/bulkRunner'
import { OpenCoordinator } from '../src/main/services/openCoordinator'
import { isProfilePartition } from '../src/shared/partition'
import { ValidationError } from '../src/shared/validation'
import { createApp } from './helpers'

describe('name templates', () => {
  it('numbers names with optional start and zero-padding', () => {
    expect(generateNames('Profile-{number}', 3)).toEqual(['Profile-1', 'Profile-2', 'Profile-3'])
    expect(generateNames('Shop {number}', 2, 9, 3)).toEqual(['Shop 009', 'Shop 010'])
    expect(generateNames('{number}-{number}', 1, 5)).toEqual(['5-5'])
    expect(generateNames('Single', 1)).toEqual(['Single'])
  })

  it('requires {number} when creating more than one profile', () => {
    expect(() => generateNames('Same name', 2)).toThrow(ValidationError)
  })
})

describe('bulk creation', () => {
  it('previews names and flags existing, repeated and invalid names', async () => {
    const { bulk, service } = await createApp()
    service.create({ name: 'P-2' })
    const plan = bulk.plan({ nameTemplate: 'P-{number}', count: 3 })
    expect(plan.items.map((i) => [i.name, i.issue])).toEqual([
      ['P-1', null],
      ['P-2', 'exists'],
      ['P-3', null]
    ])
    expect(plan.ready).toBe(false)

    const invalid = bulk.plan({ nameTemplate: 'Bad\u0001{number}', count: 2 })
    expect(invalid.items.every((i) => i.issue === 'invalid-name')).toBe(true)
    expect(invalid.ready).toBe(false)
  })

  it('creates 100 profiles, each with its own id and unique partition, without opening them', async () => {
    const { bulk, service } = await createApp()
    const spec = { nameTemplate: 'Bulk-{number}', count: 100, padding: 3 }
    const plan = bulk.plan(spec)
    expect(plan.ready).toBe(true)
    const results = bulk.create(spec, plan.items.map((i) => i.name))
    expect(results.every((r) => r.ok)).toBe(true)
    const all = service.list()
    expect(all).toHaveLength(100)
    expect(all[0]!.name).toBe('Bulk-001')
    expect(new Set(all.map((p) => p.id)).size).toBe(100)
    expect(new Set(all.map((p) => p.partition)).size).toBe(100)
    expect(all.every((p) => isProfilePartition(p.partition) && p.lastOpenedAt === null)).toBe(true)
  })

  it('rejects batches over 100 and beyond the saved-profile limit', async () => {
    const { bulk } = await createApp({ maxProfiles: 5 })
    expect(() => bulk.plan({ nameTemplate: 'X-{number}', count: 101 })).toThrow(/At most 100/)
    const plan = bulk.plan({ nameTemplate: 'X-{number}', count: 6 })
    expect(plan.errors.join()).toMatch(/Only 5 more/)
    expect(plan.ready).toBe(false)
  })

  it('reports partial failures and retries only the failed names without duplicates', async () => {
    const { bulk, service } = await createApp()
    const spec = { nameTemplate: 'R-{number}', count: 4 }
    // Someone else creates R-3 between preview and creation.
    service.create({ name: 'R-3' })
    const first = bulk.create(spec, ['R-1', 'R-2', 'R-3', 'R-4'])
    expect(first.map((r) => [r.name, r.ok, r.outcome])).toEqual([
      ['R-1', true, 'created'],
      ['R-2', true, 'created'],
      ['R-3', false, 'exists'],
      ['R-4', true, 'created']
    ])
    // Retrying everything (including the successes) never duplicates a profile.
    const retry = bulk.create(spec, ['R-1', 'R-2', 'R-3', 'R-4'])
    expect(retry.every((r) => !r.ok && r.outcome === 'exists')).toBe(true)
    expect(service.count()).toBe(4)
  })

  it('refuses names that are not part of the batch', async () => {
    const { bulk } = await createApp()
    expect(() => bulk.create({ nameTemplate: 'B-{number}', count: 2 }, ['B-1', 'Sneaky'])).toThrow(/not part of this batch/)
  })

  it('applies group, tags, homepage and an explicitly chosen proxy (password kept encrypted)', async () => {
    const { bulk, service, catalog } = await createApp()
    const g = catalog.createGroup({ name: 'Shops' })
    const src = service.create({
      name: 'Source',
      proxy: { enabled: true, protocol: 'http', host: '1.2.3.4', port: 3128, username: 'bob', password: 'secret' }
    })
    const spec = {
      nameTemplate: 'S-{number}',
      count: 2,
      groupId: g.id,
      tags: ['fb', 'new'],
      startUrl: 'https://facebook.com/',
      proxySourceProfileId: src.id
    }
    const plan = bulk.plan(spec)
    expect(plan.resolved).toEqual({
      groupName: 'Shops',
      tags: ['fb', 'new'],
      startUrl: 'https://facebook.com/',
      proxyLabel: 'HTTP 1.2.3.4:3128 (auth)',
      templateName: null
    })
    const [r1] = bulk.create(spec, ['S-1', 'S-2'])
    const created = service.get(r1!.id)
    expect(created).toMatchObject({ groupId: g.id, tags: ['fb', 'new'], startUrl: 'https://facebook.com/' })
    expect(created.proxy).toMatchObject({ host: '1.2.3.4', port: 3128, username: 'bob', hasPassword: true })
    expect(service.getProxyCredentials(created.id)).toEqual({ username: 'bob', password: 'secret' })
  })

  it('uses template defaults and lets explicit choices override them', async () => {
    const { bulk, service, catalog, templates } = await createApp()
    const g1 = catalog.createGroup({ name: 'G1' })
    const g2 = catalog.createGroup({ name: 'G2' })
    const t = templates.create({ name: 'Tpl', groupId: g1.id, tags: ['tpl'], startUrl: 'https://a.example/', color: '#9333ea' })
    const [r] = bulk.create({ nameTemplate: 'T-{number}', count: 1, templateId: t.id, groupId: g2.id, tags: ['extra'] }, ['T-1'])
    expect(service.get(r!.id)).toMatchObject({
      groupId: g2.id,
      tags: ['extra', 'tpl'],
      startUrl: 'https://a.example/',
      color: '#9333ea'
    })
  })

  it('blocks creation when the chosen group or proxy source is invalid', async () => {
    const { bulk, service } = await createApp()
    const direct = service.create({ name: 'Direct' })
    const plan = bulk.plan({ nameTemplate: 'Z-{number}', count: 2, proxySourceProfileId: direct.id })
    expect(plan.errors).toEqual(['The profile chosen for proxy settings has no proxy'])
    expect(() =>
      bulk.create({ nameTemplate: 'Z-{number}', count: 2, groupId: '99999999-9999-4999-8999-999999999999' }, ['Z-1'])
    ).toThrow(/no longer exists/)
    expect(service.count()).toBe(1)
  })
})

describe('bulk actions', () => {
  const items = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' }
  ]

  it('continues after a failure and reports every item', async () => {
    const unexpected: string[] = []
    const summary = await runBulk(
      'test',
      items,
      (item) => {
        if (item.id === 'b') throw new ValidationError('B is busy')
        if (item.id === 'c') throw new Error('disk on fire: C:\\secret\\path')
        return 'done'
      },
      (item) => unexpected.push(item.id)
    )
    expect(summary.succeeded).toBe(1)
    expect(summary.failed).toBe(2)
    expect(summary.results.map((r) => [r.id, r.ok, r.outcome, r.error])).toEqual([
      ['a', true, 'done', null],
      ['b', false, null, 'B is busy'],
      ['c', false, null, 'Unexpected error — details were written to the log file']
    ])
    // Internal error details are logged, not shown.
    expect(unexpected).toEqual(['c'])
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('summarizes results', () => {
    expect(summarize('x', [])).toEqual({ action: 'x', succeeded: 0, failed: 0, results: [] })
  })

  it('opening selected profiles goes through the coordinator and never exceeds the limit', async () => {
    const open = new Set<string>()
    const coordinator = new OpenCoordinator({
      limit: () => 2,
      openCount: () => open.size,
      isOpen: (id) => open.has(id),
      focus: () => {}
    })
    const summary = await runBulk('open', items, (item) =>
      coordinator.open(item.id, async () => {
        open.add(item.id)
      })
    )
    expect(open.size).toBe(2)
    expect(summary.results.map((r) => [r.id, r.ok])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false]
    ])
    expect(summary.results[2]!.error).toMatch(/Only 2 profile window/)
  })
})
