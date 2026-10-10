import { describe, expect, it } from 'vitest'
import {
  isProfilePartition,
  partitionDirectoryName,
  partitionForProfile
} from '../src/shared/partition'
import { createService } from './helpers'

describe('session partitions', () => {
  it('uses a persistent partition derived from the profile id', () => {
    const id = '3f0c6c2e-1d2b-4c3a-9e8f-0123456789ab'
    const partition = partitionForProfile(id)
    expect(partition).toBe(`persist:profile-${id}`)
    expect(partition.startsWith('persist:')).toBe(true)
    expect(isProfilePartition(partition)).toBe(true)
    expect(partitionDirectoryName(partition)).toBe(`profile-${id}`)
  })

  it('rejects partitions that are not profile partitions', () => {
    expect(isProfilePartition('persist:other')).toBe(false)
    expect(isProfilePartition('profile-3f0c6c2e-1d2b-4c3a-9e8f-0123456789ab')).toBe(false)
    expect(isProfilePartition('')).toBe(false)
  })

  it('gives 100 profiles 100 distinct partitions', async () => {
    const { service } = await createService()
    for (let i = 0; i < 100; i++) service.create({ name: `P${i}` })
    const partitions = service.list().map((p) => p.partition)
    expect(new Set(partitions).size).toBe(100)
    expect(partitions.every(isProfilePartition)).toBe(true)
  })

  it("never reuses a deleted profile's partition, even if the id generator repeats", async () => {
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', // repeated on purpose
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    ]
    const { service } = await createService({ newId: () => ids.shift()! })
    const first = service.create({ name: 'First' })
    service.delete(first.id)

    const second = service.create({ name: 'Second' })
    expect(second.partition).not.toBe(first.partition)
    expect(second.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  })

  it('fails safely if no unique partition can be allocated', async () => {
    const { service } = await createService({ newId: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    service.create({ name: 'Only' })
    expect(() => service.create({ name: 'Another' })).toThrow(/unique session partition/)
  })

  it('keeps the partition when a profile is edited', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'Stable' })
    const after = service.update(p.id, {
      name: 'Renamed',
      proxy: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080 }
    })
    expect(after.partition).toBe(p.partition)
  })
})
