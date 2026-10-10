import type { IpcResult } from '@shared/types'

/** Unwraps an IPC result, throwing an Error with the main process's message on failure. */
export async function unwrap<T>(call: Promise<IpcResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
