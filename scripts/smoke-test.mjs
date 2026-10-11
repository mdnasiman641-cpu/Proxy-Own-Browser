// End-to-end smoke test: launches the built app twice against a temporary data folder.
// Run after `npm run build` (or via `npm run smoke`).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtures } from './smoke-fixtures.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const appDir = resolve(import.meta.dirname, '..')

if (!existsSync(join(appDir, 'out', 'main', 'index.js'))) {
  console.error('Build output not found. Run `npm run build` first.')
  process.exit(1)
}

const dataDir = mkdtempSync(join(tmpdir(), 'pob-smoke-'))
const fixtures = await startFixtures()
const extraArgs = process.platform === 'linux' ? ['--no-sandbox'] : []
let failed = false

for (const stage of ['setup', 'verify']) {
  const resultFile = join(dataDir, `result-${stage}.json`)
  const run = await spawnAsync(electronPath, [appDir, ...extraArgs], {
    env: {
      ...process.env,
      POB_SMOKE_TEST: stage,
      POB_USER_DATA_DIR: join(dataDir, 'user-data'),
      POB_SMOKE_RESULT: resultFile,
      ELECTRON_ENABLE_LOGGING: '1',
      ...fixtures.env
    },
    stdio: 'inherit',
    timeout: 300_000
  })

  if (!existsSync(resultFile)) {
    console.error(`[smoke] stage "${stage}" produced no result (exit code ${run.status})`)
    failed = true
    break
  }
  const result = JSON.parse(readFileSync(resultFile, 'utf8'))
  for (const c of result.checks) {
    const label = c.passed ? 'PASS' : c.optional ? 'WARN' : 'FAIL'
    console.log(`[smoke] ${stage}: ${label} ${c.name}${c.optional ? ' (optional)' : ''}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  if (!result.passed) {
    failed = true
    break
  }
}

if (failed) {
  // Show the end of the app's own log (it never contains credentials) to explain the failure.
  const log = join(dataDir, 'user-data', 'logs', 'app.log')
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').trim().split(/\r?\n/).slice(-70)) console.log(`[smoke-log] ${line}`)
  }
}

await fixtures.stop()
try {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
} catch {
  console.warn(`[smoke] could not remove ${dataDir}`)
}
console.log(failed ? '[smoke] FAILED' : '[smoke] all checks passed')
process.exit(failed ? 1 : 0)

/**
 * Like spawnSync, but keeps this process's event loop running so the local fixture servers
 * can answer the app's requests.
 */
function spawnAsync(command, args, { timeout, ...options }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options)
    const timer = setTimeout(() => child.kill(), timeout)
    child.on('exit', (status) => {
      clearTimeout(timer)
      resolve({ status })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ status: null })
    })
  })
}
