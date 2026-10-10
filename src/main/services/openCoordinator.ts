import { ValidationError } from '@shared/validation'

export type OpenOutcome = 'opened' | 'focused' | 'joined'

export interface OpenCoordinatorDeps {
  /** Current limit on profile windows open at the same time. */
  limit: () => number
  /** Number of profile windows that are fully open. */
  openCount: () => number
  isOpen: (profileId: string) => boolean
  focus: (profileId: string) => void
}

/**
 * Serialises profile-window opening so that:
 * - opening a profile that is already open focuses its window instead of creating a second one
 * - a second open request while the first is still starting joins it (no duplicate windows)
 * - windows still being created count toward the concurrency limit
 * - a failed open releases its slot
 */
export class OpenCoordinator {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly deps: OpenCoordinatorDeps) {}

  get pendingCount(): number {
    return this.pending.size
  }

  async open(profileId: string, create: () => Promise<void>): Promise<OpenOutcome> {
    if (this.deps.isOpen(profileId)) {
      this.deps.focus(profileId)
      return 'focused'
    }
    const running = this.pending.get(profileId)
    if (running) {
      await running
      return 'joined'
    }
    const limit = this.deps.limit()
    if (this.deps.openCount() + this.pending.size >= limit) {
      throw new ValidationError(
        `Only ${limit} profile window(s) can be open at the same time. Close one, or raise the limit in Application Settings.`
      )
    }
    const promise = create().finally(() => this.pending.delete(profileId))
    this.pending.set(profileId, promise)
    await promise
    return 'opened'
  }
}
