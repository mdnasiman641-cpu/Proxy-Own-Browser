import { describe, expect, it } from 'vitest'
import { OpenCoordinator } from '../src/main/services/openCoordinator'
import { TabList } from '../src/main/services/tabList'
import { ValidationError } from '../src/shared/validation'

function tabs(...ids: string[]): TabList<string> {
  const list = new TabList<string>(5)
  for (const id of ids) list.add(id, id)
  return list
}

describe('TabList', () => {
  it('adds tabs at the end and activates them by default', () => {
    const list = tabs('a', 'b', 'c')
    expect(list.ids()).toEqual(['a', 'b', 'c'])
    expect(list.active).toBe('c')
    expect(list.activeItem()).toBe('c')
  })

  it('can add a background tab without changing the active tab', () => {
    const list = tabs('a')
    list.add('b', 'b', { activate: false })
    expect(list.active).toBe('a')
  })

  it('places link tabs right after the active tab, keeping their opening order', () => {
    const list = tabs('a', 'b', 'c')
    list.activate('a')
    list.add('x', 'x', { position: 'after-active', activate: false })
    list.add('y', 'y', { position: 'after-active', activate: false })
    expect(list.ids()).toEqual(['a', 'x', 'y', 'b', 'c'])
    expect(list.active).toBe('a')
  })

  it('activates the right neighbour when the active tab closes, or the left one at the end', () => {
    const list = tabs('a', 'b', 'c')
    list.activate('b')
    expect(list.remove('b').activeId).toBe('c')
    expect(list.remove('c').activeId).toBe('a')
    expect(list.remove('a').activeId).toBeNull()
    expect(list.size).toBe(0)
  })

  it('keeps the active tab when a background tab closes', () => {
    const list = tabs('a', 'b', 'c')
    list.activate('a')
    expect(list.remove('c').activeId).toBe('a')
  })

  it('cycles forwards and backwards with wrap-around', () => {
    const list = tabs('a', 'b', 'c')
    list.activate('c')
    expect(list.cycle(1)).toBe('a')
    expect(list.cycle(-1)).toBe('c')
    expect(list.cycle(-1)).toBe('b')
  })

  it('selects tabs by position, with -1 meaning the last tab', () => {
    const list = tabs('a', 'b', 'c')
    expect(list.activateIndex(0)).toBe('a')
    expect(list.activateIndex(-1)).toBe('c')
    expect(list.activateIndex(7)).toBeNull()
    expect(list.active).toBe('c')
  })

  it('enforces the tab limit', () => {
    const list = tabs('a', 'b', 'c', 'd', 'e')
    expect(list.canAdd()).toBe(false)
    expect(() => list.add('f', 'f')).toThrow(ValidationError)
    expect(list.size).toBe(5)
  })

  it('rejects duplicate and unknown ids', () => {
    const list = tabs('a')
    expect(() => list.add('a', 'a')).toThrow(/Duplicate/)
    expect(() => list.remove('zzz')).toThrow(/Unknown/)
    expect(list.activate('zzz')).toBe(false)
  })
})

describe('OpenCoordinator (profile window concurrency)', () => {
  function setup(limit: number) {
    const open = new Set<string>()
    const focused: string[] = []
    let creates = 0
    const coordinator = new OpenCoordinator({
      limit: () => limit,
      openCount: () => open.size,
      isOpen: (id) => open.has(id),
      focus: (id) => focused.push(id)
    })
    const create = (id: string, delayMs = 20, fail = false) => async (): Promise<void> => {
      creates++
      await new Promise((r) => setTimeout(r, delayMs))
      if (fail) throw new Error('window failed to start')
      open.add(id)
    }
    return { coordinator, open, focused, create, creates: () => creates }
  }

  it('opens up to the limit and refuses more', async () => {
    const s = setup(2)
    expect(await s.coordinator.open('a', s.create('a'))).toBe('opened')
    expect(await s.coordinator.open('b', s.create('b'))).toBe('opened')
    let error: unknown
    try {
      await s.coordinator.open('c', s.create('c'))
    } catch (e) {
      error = e
    }
    expect(error instanceof ValidationError).toBe(true)
    expect((error as Error).message).toMatch(/Only 2 profile window/)
    expect(s.open.size).toBe(2)
  })

  it('focuses an already open profile instead of opening a duplicate', async () => {
    const s = setup(2)
    await s.coordinator.open('a', s.create('a'))
    expect(await s.coordinator.open('a', s.create('a'))).toBe('focused')
    expect(s.focused).toEqual(['a'])
    expect(s.creates()).toBe(1)
  })

  it('merges simultaneous opens of the same profile into one window', async () => {
    const s = setup(2)
    const results = await Promise.all([
      s.coordinator.open('a', s.create('a')),
      s.coordinator.open('a', s.create('a')),
      s.coordinator.open('a', s.create('a'))
    ])
    expect(results).toEqual(['opened', 'joined', 'joined'])
    expect(s.creates()).toBe(1)
  })

  it('counts windows that are still starting toward the limit', async () => {
    const s = setup(2)
    const results = await Promise.allSettled([
      s.coordinator.open('a', s.create('a')),
      s.coordinator.open('b', s.create('b')),
      s.coordinator.open('c', s.create('c'))
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(s.creates()).toBe(2)
    expect(s.coordinator.pendingCount).toBe(0)
  })

  it('releases the slot when opening fails', async () => {
    const s = setup(1)
    let failed = false
    try {
      await s.coordinator.open('a', s.create('a', 5, true))
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    expect(s.coordinator.pendingCount).toBe(0)
    expect(await s.coordinator.open('b', s.create('b'))).toBe('opened')
  })

  it('applies a changed limit to the next open', async () => {
    let limit = 1
    const open = new Set<string>()
    const coordinator = new OpenCoordinator({
      limit: () => limit,
      openCount: () => open.size,
      isOpen: (id) => open.has(id),
      focus: () => {}
    })
    await coordinator.open('a', async () => void open.add('a'))
    limit = 3
    expect(await coordinator.open('b', async () => void open.add('b'))).toBe('opened')
  })
})
