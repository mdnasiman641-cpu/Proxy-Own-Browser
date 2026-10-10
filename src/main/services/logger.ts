import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '@shared/proxy'

export interface Logger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

const MAX_LOG_BYTES = 2 * 1024 * 1024

function describe(detail: unknown): string {
  if (detail === undefined) return ''
  if (detail instanceof Error) return ` ${detail.name}: ${detail.message}`
  try {
    return ` ${JSON.stringify(detail)}`
  } catch {
    return ` ${String(detail)}`
  }
}

/**
 * File logger. Every line passes through `redactSecrets`, and callers must never pass
 * proxy credentials in the first place — redaction is a second line of defence.
 */
export function createFileLogger(directory: string, echoToConsole = false): Logger {
  const file = join(directory, 'app.log')
  mkdirSync(directory, { recursive: true })

  const write = (level: string, message: string, detail?: unknown): void => {
    const line = redactSecrets(`${new Date().toISOString()} [${level}] ${message}${describe(detail)}`)
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, join(directory, 'app.1.log'))
      }
      appendFileSync(file, `${line}\n`)
    } catch {
      /* logging must never crash the app */
    }
    if (echoToConsole) console.log(line)
  }

  return {
    info: (m, d) => write('INFO', m, d),
    warn: (m, d) => write('WARN', m, d),
    error: (m, d) => write('ERROR', m, d)
  }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }
