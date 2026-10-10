import type { ProfileRuntimeStatus } from '@shared/types'

export interface OpenWindowInfo {
  profileId: string
  /** Number of tabs whose page process crashed and has not been reloaded. */
  crashedTabs: number
}

/**
 * Status of every profile that is not simply closed. Derived on demand from the live window
 * state, so it can never drift: after a crash or an unexpected close the window is gone from
 * the live state and the profile reports `closed` again.
 */
export function deriveStatuses(
  pendingIds: Iterable<string>,
  openWindows: Iterable<OpenWindowInfo>
): Record<string, ProfileRuntimeStatus> {
  const statuses: Record<string, ProfileRuntimeStatus> = {}
  for (const id of pendingIds) statuses[id] = 'starting'
  for (const w of openWindows) statuses[w.profileId] = w.crashedTabs > 0 ? 'crashed' : 'running'
  return statuses
}

export function statusOf(statuses: Record<string, ProfileRuntimeStatus>, id: string): ProfileRuntimeStatus {
  return statuses[id] ?? 'closed'
}
