# Proxy Own Browser

A Windows desktop browser for running several accounts side by side. Every **profile** has its own
isolated, persistent browser session (cookies, logins, storage, cache) and can use its own proxy.

Built with Electron, React + TypeScript + Vite, SQLite (sql.js), and packaged with electron-builder.

## Features (Phase 1)

- **Dashboard** — profile counts, open windows, recently used profiles.
- **All Profiles** — create, edit, delete and search profiles (name, notes, proxy host). Supports
  hundreds of saved profiles (tested with 100).
- **Isolated sessions** — each profile uses a unique persistent Electron partition
  (`persist:profile-<uuid>`). Logins and cookies survive app restarts and are never shared between
  profiles. A deleted profile's partition is never reused.
- **Profile windows** — each profile opens in its own window with back/forward, reload/stop, home,
  an address bar (URL or search), a loading indicator, and readable error messages.
- **Proxy Settings** — per-profile HTTP, HTTPS, SOCKS4 or SOCKS5 proxy with optional
  username/password (HTTP/HTTPS), bypass list, and a "paste `host:port:user:pass`" helper. Changes
  apply to open windows immediately.
- **Backup & Restore** — export profiles and settings to JSON and restore them later.
- **Application Settings** — homepage, search engine, concurrent-window limit, delete confirmation.

### Security

- `contextIsolation`, `sandbox` and `webSecurity` on; `nodeIntegration` off everywhere.
- Websites run in a separate `WebContentsView` with **no preload**, so pages cannot reach the app API.
- Every IPC call checks the sender (only the dashboard page or a profile toolbar page) and validates
  arguments with zod in the main process.
- Strict Content-Security-Policy for app pages; only `http(s)` URLs can be loaded in profiles.
- Website permissions (camera, microphone, location, notifications…) are denied by default.
- Proxy passwords are encrypted with Windows DPAPI via Electron `safeStorage`, are never sent back to
  the UI, never written to logs (log lines are additionally passed through a redaction filter), and
  are not included in backups.

## Requirements

- Windows 10/11 x64 (development also works on macOS/Linux)
- Node.js 22.12 or newer and npm

## Getting started

```bash
git clone https://github.com/mdnasiman641-cpu/Proxy-Own-Browser.git
cd Proxy-Own-Browser
npm install
npm run dev          # start the app with hot reload
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app in development mode |
| `npm run build` | Compile main, preload and renderer into `out/` |
| `npm start` | Run the compiled app from `out/` |
| `npm run typecheck` | TypeScript checks for main/preload and renderer |
| `npm test` | Unit tests (Vitest) |
| `npm run check` | Typecheck + tests |
| `npm run smoke` | Build, then launch the real app twice to verify two isolated profiles keep their own cookies across a restart |
| `npm run build:win` | Check, build and create **both** the Windows installer and portable EXE |
| `npm run build:win:installer` | NSIS installer only |
| `npm run build:win:portable` | Portable EXE only |

Windows builds are written to `release/<version>/`:

- `Proxy-Own-Browser-Setup-<version>.exe` — installer (choose install folder, desktop shortcut)
- `Proxy-Own-Browser-Portable-<version>.exe` — single-file portable app

The executables are not code-signed, so Windows SmartScreen will show a warning the first time
("More info" → "Run anyway").

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` or `feature/**` on a GitHub Windows runner:
install, typecheck, unit tests, the end-to-end smoke test, and the Windows EXE build. The EXEs are
attached to the workflow run as the `proxy-own-browser-windows` artifact (kept 14 days).

## Where data is stored

`%APPDATA%\Proxy Own Browser\` (open it from Application Settings → *Open data folder*):

| Path | Contents |
| --- | --- |
| `data\profiles.sqlite` | Profile list, proxy settings (passwords encrypted), app settings |
| `Partitions\profile-<uuid>\` | Each profile's cookies, storage and cache |
| `logs\app.log` | Application log (no credentials) |

Set the `POB_USER_DATA_DIR` environment variable to use a different data folder.

None of these files are committed to Git (see `.gitignore`).

## Project structure

```
src/
  main/
    index.ts                 App bootstrap, proxy-auth handler, shutdown
    smokeTest.ts             End-to-end self test (only runs when POB_SMOKE_TEST is set)
    electron/                Electron-specific code: windows, sessions, IPC, cipher
    services/                Pure logic (unit-tested): SQLite, profiles, settings, backup, logger
  preload/                   Minimal, typed bridges for the dashboard and the toolbar
  renderer/
    dashboard/               React dashboard (5 sections)
    browser/                 React toolbar shown at the top of each profile window
  shared/                    Types, validation, URL and proxy helpers used by all processes
tests/                       Vitest unit tests
scripts/smoke-test.mjs       Launches the built app twice to verify persistence and isolation
```

## Known limitations (Phase 1)

- **One tab per profile window.** Links that open a new window open as a popup in the same profile.
- **SOCKS proxy authentication is not supported** by Chromium. Use an HTTP/HTTPS proxy when the
  provider requires a username and password.
- **Concurrent windows default to 2.** Raise the limit (up to 10) in Application Settings once two
  sessions work well on your PC; every window is a full Chromium renderer and uses memory.
- **Proxy is per profile, not per tab**, and there is no built-in "check my IP" test yet.
- **Session-only cookies** (cookies without an expiry date) are, as in every browser, discarded when
  the app closes. Normal "remember me" logins persist.
- **Website HTTP basic-auth dialogs are not shown** (proxy authentication is handled automatically).
- Website permission requests (camera, microphone, location, notifications) are denied.
- **Backups do not include cookies or passwords.** Restored profiles start logged out and need their
  proxy password re-entered.
- Proxy passwords are encrypted for the current Windows user. If the database is copied to another
  PC or user account, passwords must be entered again.
- If an open profile is deleted it must be closed first. When "delete browsing data" is chosen,
  data is cleared immediately; an empty partition folder may remain until the next restart.
- The EXEs are unsigned (SmartScreen warning) and there is no auto-update yet.
- No downloads manager UI; downloads use the standard save dialog.

This project does not implement fingerprint spoofing or any mechanism to bypass website security,
identity checks or access restrictions.
