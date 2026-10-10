import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { managedPartitionDir, removeManagedPartitionDir } from '../src/main/services/managedPaths'
import { attributeMemory } from '../src/main/services/resourceAttribution'
import { deriveStatuses, statusOf } from '../src/main/services/runtimeStatus'
import { DEFAULT_QUERY, filterAndSortProfiles } from '../src/shared/profileQuery'
import type { Profile, ProfileGroup } from '../src/shared/types'
import { tempDir } from './helpers'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('managed browser-data paths (deletion isolation)', () => {
  let dir: ReturnType<typeof tempDir>
  beforeEach(() => {
    dir = tempDir()
    for (const id of [A, B]) {
      mkdirSync(join(dir.path, 'Partitions', `profile-${id}`, 'Network'), { recursive: true })
      writeFileSync(join(dir.path, 'Partitions', `profile-${id}`, 'Network', 'Cookies'), id)
    }
    writeFileSync(join(dir.path, 'outside.txt'), 'keep me')
  })
  afterEach(() => dir.cleanup())

  it("deletes only the selected profile's folder", async () => {
    expect(await removeManagedPartitionDir(dir.path, `persist:profile-${A}`)).toBe(true)
    expect(existsSync(join(dir.path, 'Partitions', `profile-${A}`))).toBe(false)
    expect(existsSync(join(dir.path, 'Partitions', `profile-${B}`, 'Network', 'Cookies'))).toBe(true)
    expect(existsSync(join(dir.path, 'outside.txt'))).toBe(true)
    expect(await removeManagedPartitionDir(dir.path, `persist:profile-${A}`)).toBe(false)
  })

  it.each([
    'persist:profile-../../outside',
    'persist:profile-..',
    'persist:../Partitions',
    `persist:profile-${A}/../profile-${B}`,
    `persist:profile-${A}\\..\\..`,
    'persist:other',
    `profile-${A}`,
    ''
  ])('rejects path traversal / foreign partition %j', async (partition) => {
    expect(() => managedPartitionDir(dir.path, partition)).toThrow()
    let failed = false
    try {
      await removeManagedPartitionDir(dir.path, partition)
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    expect(existsSync(join(dir.path, 'Partitions', `profile-${B}`))).toBe(true)
    expect(existsSync(join(dir.path, 'outside.txt'))).toBe(true)
  })

  it('refuses to follow a symbolic link planted as a partition folder', async () => {
    const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const target = join(dir.path, 'elsewhere')
    mkdirSync(target)
    writeFileSync(join(target, 'important.txt'), 'x')
    let linked = true
    try {
      symlinkSync(target, join(dir.path, 'Partitions', `profile-${C}`), 'junction')
    } catch {
      linked = false // creating links may need privileges on some systems
    }
    if (!linked) return
    let failed = false
    try {
      await removeManagedPartitionDir(dir.path, `persist:profile-${C}`)
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    expect(existsSync(join(target, 'important.txt'))).toBe(true)
  })
})

describe('profile runtime status (crash recovery consistency)', () => {
  it('derives starting, running, crashed and closed from live state', () => {
    const statuses = deriveStatuses(['p1', 'p2'], [
      { profileId: 'p2', crashedTabs: 0 },
      { profileId: 'p3', crashedTabs: 1 }
    ])
    expect(statuses).toEqual({ p1: 'starting', p2: 'running', p3: 'crashed' })
    expect(statusOf(statuses, 'p4')).toBe('closed')
  })

  it('returns to closed when a crashed window is gone', () => {
    const during = deriveStatuses([], [{ profileId: 'p1', crashedTabs: 2 }])
    expect(statusOf(during, 'p1')).toBe('crashed')
    const after = deriveStatuses([], [])
    expect(statusOf(after, 'p1')).toBe('closed')
  })
})

describe('per-profile memory attribution', () => {
  it('attributes page processes to their profile and counts the rest as shared', () => {
    const samples = [
      { pid: 1, memoryKb: 200 * 1024 }, // browser
      { pid: 2, memoryKb: 100 * 1024 }, // GPU
      { pid: 10, memoryKb: 150 * 1024 }, // profile A tab
      { pid: 11, memoryKb: 50 * 1024 }, // profile A tab
      { pid: 20, memoryKb: 80 * 1024 }, // profile B tab
      { pid: 30, memoryKb: 40 * 1024 }, // used by both (e.g. shared toolbar) → shared
      { pid: 10, memoryKb: 150 * 1024 } // duplicate sample is counted once
    ]
    const result = attributeMemory(samples, [
      { profileId: 'A', pids: [10, 11, 30] },
      { profileId: 'B', pids: [20, 30, -1] },
      { profileId: 'C', pids: [] }
    ])
    expect(result.totalMb).toBe(620)
    expect(result.sharedMb).toBe(340)
    expect(result.perProfile.get('A')).toEqual({ memoryMb: 200, processCount: 2 })
    expect(result.perProfile.get('B')).toEqual({ memoryMb: 80, processCount: 1 })
    expect(result.perProfile.get('C')).toEqual({ memoryMb: 0, processCount: 0 })
  })
})

describe('profile filtering and sorting', () => {
  const groups: ProfileGroup[] = [
    { id: 'g1', name: 'Shops', color: '#000000', profileCount: 2, createdAt: '' },
    { id: 'g2', name: 'Ads', color: '#000000', profileCount: 1, createdAt: '' }
  ]
  const make = (name: string, extra: Partial<Profile>): Profile => ({
    id: name,
    name,
    notes: '',
    color: '#2563eb',
    startUrl: null,
    partition: `persist:profile-${name}`,
    proxy: null,
    groupId: null,
    tags: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    lastOpenedAt: null,
    ...extra
  })
  const profiles = [
    make('Profile-10', { groupId: 'g1', tags: ['fb', 'bd'], createdAt: '2026-01-03' }),
    make('Profile-2', { groupId: 'g1', tags: ['fb'], createdAt: '2026-01-01' }),
    make('Ad account', { groupId: 'g2', tags: ['ads'], createdAt: '2026-01-02', notes: 'billing' }),
    make('Loose', { createdAt: '2026-01-04' })
  ]
  const statuses = { 'Profile-10': 'running' as const, Loose: 'crashed' as const }
  const names = (q: Partial<typeof DEFAULT_QUERY>): string[] =>
    filterAndSortProfiles(profiles, { ...DEFAULT_QUERY, ...q }, statuses, groups).map((p) => p.name)

  it('sorts by name with natural numbers', () => {
    expect(names({})).toEqual(['Ad account', 'Loose', 'Profile-2', 'Profile-10'])
    expect(names({ direction: 'desc' })).toEqual(['Profile-10', 'Profile-2', 'Loose', 'Ad account'])
  })

  it('sorts by creation date, group and status', () => {
    expect(names({ sort: 'created' })).toEqual(['Profile-2', 'Ad account', 'Profile-10', 'Loose'])
    expect(names({ sort: 'group' })).toEqual(['Ad account', 'Profile-2', 'Profile-10', 'Loose'])
    expect(names({ sort: 'status' })).toEqual(['Profile-10', 'Loose', 'Ad account', 'Profile-2'])
  })

  it('filters by group, ungrouped, tags, status and search text', () => {
    expect(names({ group: 'g1' })).toEqual(['Profile-2', 'Profile-10'])
    expect(names({ group: 'none' })).toEqual(['Loose'])
    expect(names({ tags: ['FB', 'bd'] })).toEqual(['Profile-10'])
    expect(names({ status: 'running' })).toEqual(['Loose', 'Profile-10'])
    expect(names({ status: 'closed' })).toEqual(['Ad account', 'Profile-2'])
    expect(names({ search: 'BILLING' })).toEqual(['Ad account'])
    expect(names({ search: 'shops' })).toEqual(['Profile-2', 'Profile-10'])
  })
})
