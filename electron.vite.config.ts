import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const sharedAlias = { '@shared': resolve('src/shared') }

/**
 * The dev server injects an inline React Fast Refresh preamble, which the strict
 * Content-Security-Policy in the HTML would block. Relax script-src in dev only;
 * production builds keep `script-src 'self'`.
 */
const devCspPlugin: Plugin = {
  name: 'pob-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
      "connect-src 'self'",
      "connect-src 'self' ws: http://localhost:*"
    )
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // One entry only: sandboxed preloads cannot require() sibling chunk files.
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: sharedAlias },
    plugins: [react(), devCspPlugin],
    build: {
      rollupOptions: {
        input: {
          dashboard: resolve('src/renderer/dashboard.html'),
          browser: resolve('src/renderer/browser.html')
        }
      }
    }
  }
})
