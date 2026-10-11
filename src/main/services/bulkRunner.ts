import type { BulkItemResult, BulkSummary } from '@shared/types'
import { ValidationError } from '@shared/validation'
import { NotFoundError } from './errors'

/** Message safe to show the user: our own validation messages, otherwise a generic one. */
export function userMessage(error: unknown): string {
  if (error instanceof ValidationError || error instanceof NotFoundError) return error.message
  return 'Unexpected error — details were written to the log file'
}

export interface BulkTarget {
  id: string
  name: string
}

/**
 * Runs an action for each item, one at a time. A failure never stops the remaining items;
 * every item gets its own result so the user sees exactly what happened.
 */
export async function runBulk(
  action: string,
  items: BulkTarget[],
  fn: (item: BulkTarget) => Promise<string> | string,
  onUnexpected?: (item: BulkTarget, error: unknown) => void
): Promise<BulkSummary> {
  const results: BulkItemResult[] = []
  for (const item of items) {
    try {
      const outcome = await fn(item)
      results.push({ id: item.id, name: item.name, ok: true, outcome, error: null })
    } catch (error) {
      if (!(error instanceof ValidationError || error instanceof NotFoundError)) onUnexpected?.(item, error)
      results.push({ id: item.id, name: item.name, ok: false, outcome: null, error: userMessage(error) })
    }
  }
  return summarize(action, results)
}

export function summarize(action: string, results: BulkItemResult[]): BulkSummary {
  const succeeded = results.filter((r) => r.ok).length
  return { action, succeeded, failed: results.length - succeeded, results }
}
