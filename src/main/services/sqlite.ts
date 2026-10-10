import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsStatic } from 'sql.js'

let cached: Promise<SqlJsStatic> | null = null

/** Loads the sql.js WebAssembly engine once. Works in dev, tests and the packaged (asar) app. */
export function loadSqlJs(): Promise<SqlJsStatic> {
  if (!cached) {
    // CommonJS in the Electron build, ES modules under Vitest.
    const base = typeof __filename === 'string' ? __filename : import.meta.url
    const require = createRequire(base)
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
    const wasmBinary = readFileSync(wasmPath)
    cached = initSqlJs({
      wasmBinary: wasmBinary.buffer.slice(
        wasmBinary.byteOffset,
        wasmBinary.byteOffset + wasmBinary.byteLength
      ) as ArrayBuffer
    })
  }
  return cached
}
