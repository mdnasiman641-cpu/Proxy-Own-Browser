export const PARTITION_PREFIX = 'persist:profile-'

/**
 * Persistent Electron session partition for a profile. Because the id is a random UUID
 * and partitions are stored with a UNIQUE constraint, two profiles can never share
 * cookies, storage or cache — even after one is deleted and another is created.
 */
export function partitionForProfile(profileId: string): string {
  return `${PARTITION_PREFIX}${profileId}`
}

export function isProfilePartition(partition: string): boolean {
  return /^persist:profile-[0-9a-f-]{36}$/i.test(partition)
}

/** Folder name Electron uses under `<userData>/Partitions/` for a persistent partition. */
export function partitionDirectoryName(partition: string): string {
  return partition.replace(/^persist:/, '')
}
