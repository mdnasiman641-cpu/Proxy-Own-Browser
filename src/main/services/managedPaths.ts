import { existsSync, lstatSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isProfilePartition, partitionDirectoryName } from '@shared/partition'
import { ValidationError } from '@shared/validation'

/** Folder (under the app's data folder) where Electron keeps persistent partitions. */
export const PARTITIONS_DIR = 'Partitions'

/**
 * Resolves the on-disk folder of a profile partition and proves it is inside
 * `<userData>/Partitions/`. Anything that is not exactly `persist:profile-<uuid>`, or that would
 * resolve elsewhere (`..`, absolute paths, separators), is rejected.
 */
export function managedPartitionDir(userDataPath: string, partition: string): string {
  if (!isProfilePartition(partition)) throw new ValidationError('Not a profile partition')
  const name = partitionDirectoryName(partition)
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new ValidationError('Invalid partition folder name')
  }
  const base = resolve(userDataPath, PARTITIONS_DIR)
  const dir = resolve(base, name)
  const rel = relative(base, dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
    throw new ValidationError('Partition folder is outside the managed data folder')
  }
  return dir
}

/**
 * Deletes one profile's partition folder — and nothing else. Refuses symbolic links so a
 * link planted inside the data folder can't redirect the deletion elsewhere.
 * Returns false if the folder did not exist.
 */
export async function removeManagedPartitionDir(userDataPath: string, partition: string): Promise<boolean> {
  const dir = managedPartitionDir(userDataPath, partition)
  if (!existsSync(dir)) return false
  if (lstatSync(dir).isSymbolicLink()) throw new ValidationError('Refusing to delete a linked folder')
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  return true
}

/** Exposed for diagnostics/tests: the managed partitions root. */
export function partitionsRoot(userDataPath: string): string {
  return join(resolve(userDataPath), PARTITIONS_DIR)
}
