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

/**
 * Working folders for backups/restores, inside `Partitions/` so that moving a verified
 * restore into place is a rename on the same drive:
 * - `.pob-work/staging/<id>`   extracted and verified data waiting to be moved in
 * - `.pob-work/previous/...`   a profile's data as it was before an in-place restore
 * - `.pob-work/journal/<id>.json` progress of a folder swap, for recovery after a crash
 */
export function workDir(userDataPath: string, kind: 'staging' | 'previous' | 'journal'): string {
  return join(partitionsRoot(userDataPath), '.pob-work', kind)
}

/** A new, unique folder path under the work area (not created). Ids are validated. */
export function workPath(userDataPath: string, kind: 'staging' | 'previous' | 'journal', name: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name) || name.includes('..')) throw new ValidationError('Invalid work folder name')
  return join(workDir(userDataPath, kind), name)
}
