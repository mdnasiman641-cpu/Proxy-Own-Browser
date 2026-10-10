// End-to-end smoke test: launches the built app twice against a temporary data folder.
// Run after `npm run build` (or via `npm run smoke`).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const appDir = resolve(import.meta.dirname, '..')

if (!existsSync(join(appDir, 'out', 'main', 'index.js'))) {
  console.error('Build output not found. Run `npm run build` first.')
  process.exit(1)
}

const dataDir = mkdtempSync(join(tmpdir(), 'pob-smoke-'))
const extraArgs = process.platform === 'linux' ? ['--no-sandbox'] : []
let failed = false

for (const stage of ['setup', 'verify']) {
  const resultFile = join(dataDir, `result-${stage}.json`)
  const run = spawnSync(electronPath, [appDir, ...extraArgs], {
    env: {
      ...process.env,
      POB_SMOKE_TEST: stage,
      POB_USER_DATA_DIR: join(dataDir, 'user-data'),
      POB_SMOKE_RESULT: resultFile,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: 'inherit',
    timeout: 120_000
  })

  if (!existsSync(resultFile)) {
    console.error(`[smoke] stage "${stage}" produced no result (exit code ${run.status})`)
    failed = true
    break
  }
  const result = JSON.parse(readFileSync(resultFile, 'utf8'))
  for (const c of result.checks) {
    console.log(`[smoke] ${stage}: ${c.passed ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  if (!result.passed) {
    failed = true
    break
  }
}

rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
console.log(failed ? '[smoke] FAILED' : '[smoke] all checks passed')
process.exit(failed ? 1 : 0)
