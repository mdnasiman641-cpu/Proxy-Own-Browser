# Proxy Own Browser

A Windows desktop browser for running several accounts side by side. Every **profile** has its own
isolated, persistent browser session (cookies, logins, storage, cache) and can use its own proxy.

Built with Electron, React + TypeScript + Vite, SQLite (sql.js), and packaged with electron-builder.

## Features

### Profiles and sessions
- **Dashboard** — profile counts, open windows, recently used profiles.
- **All Profiles** — create, edit, delete and search profiles (name, notes, proxy host). Supports
  hundreds of saved profiles (tested with 100).
- **Isolated sessions** — each profile uses a unique persistent Electron partition
  (`persist:profile-<uuid>`). Logins and cookies survive app restarts and are never shared between
  profiles. A deleted profile's partition is never reused.
- **Backup & Restore** — export profiles and settings to JSON and restore them later.

### Tabs (Phase 2)
Each profile window has tabs. **All tabs in a window belong to that profile's session** — they
share its cookies, logins and proxy. To browse with a different identity, open a different profile.

| Action | How |
| --- | --- |
| New tab | `+` button or **Ctrl+T** |
| Close tab | `×` on the tab, middle-click, or **Ctrl+W** (closing the last tab closes the window) |
| Switch tab | Click it, **Ctrl+Tab** / **Ctrl+Shift+Tab**, **Ctrl+PageDown/PageUp**, **Ctrl+1…8**, **Ctrl+9** (last) |
| Open link in new tab | Middle-click / Ctrl+click a link, links with `target="_blank"`, or right-click → *Open link in new tab* |
| Address bar | **Ctrl+L** or **F6** |
| Back / Forward / Reload | **Alt+←** / **Alt+→** / **F5** or **Ctrl+R** |

The active tab is highlighted; loading tabs show a spinner and a crashed tab shows a warning icon
(press Reload to recover it). Up to 20 tabs per window. Pop-up windows opened by scripts
(for example "Sign in with…" windows) still open as separate windows in the same profile so
they keep working.

### Proxy settings and proxy testing (Phase 2)
- Per-profile HTTP, HTTPS, SOCKS4 or SOCKS5 proxy with optional username/password (HTTP/HTTPS),
  a bypass list, and a "paste `host:port:user:pass`" helper. Changes apply to open windows
  immediately.
- **Test proxy** — available in every profile's proxy form (tests what you typed, even before
  saving) and as a **Test** button per profile on the Proxy Settings page (tests the saved settings).

A test makes a **real HTTPS request through the proxy** to a public IP-check service
(`api.ipify.org`, falling back to `checkip.amazonaws.com`) and shows:

| Shown | Meaning |
| --- | --- |
| **Working** + public IP | The request succeeded; this is the IP websites will see |
| Response time | Time for the successful request |
| **Failed** + reason | e.g. proxy unreachable, timed out, rejected username/password, credentials missing, certificate problem, unexpected response |

How the test protects you:
- It only reports success when the service returns HTTP 2xx **and** a valid IP address.
- It gives up after 15 seconds in total, so a dead proxy can never hang the app.
- Proxy credentials are sent **only to the proxy server**, and only when it asks for them. If the
  test website itself asks for a login, the app refuses — your proxy password is never offered to
  it.
- When testing unsaved changes, a saved password is reused only if the host, port, type and
  username are unchanged; otherwise the password must be typed again, so it can't be sent to a
  different server.
- Tests run in a temporary in-memory session, so they never touch the profile's cookies.
- Results, logs and error messages never contain the username or password.

### Profile window management (Phase 2)
- **Limit on open profile windows**: default **2**, configurable from 1 to 10 in
  Application Settings. The limit is applied when a window opens; it is not unlimited.
- **Resource usage** panel (Application Settings) shows the app's total memory, process count, open
  windows and tabs. Open your usual sites in the windows you have, check the numbers, then raise
  the limit one step at a time. (In CI, two profile windows plus the dashboard used about 700 MB.)
- **Duplicate launches**: opening a profile that is already open focuses its window; clicking Open
  twice quickly still creates just one window; starting the app a second time focuses the existing
  dashboard.
- **Crashes**: a crashed tab is marked and recovers with Reload; a crashed toolbar is reloaded
  automatically (up to 3 times); closing a window releases its slot so the profile can be reopened.

### Security
- `contextIsolation`, `sandbox` and `webSecurity` on; `nodeIntegration` off everywhere.
- Websites run in `WebContentsView`s with **no preload**, so pages cannot reach the app API.
  (BrowserView, which is deprecated, is not used.)
- Every IPC call checks the sender (only the dashboard page or a profile toolbar page) and validates
  arguments with zod in the main process.
- Strict Content-Security-Policy for app pages; only `http(s)` URLs can be loaded in profiles.
- Website permissions (camera, microphone, location, notifications…) are denied by default.
- Proxy passwords are encrypted with Windows DPAPI via Electron `safeStorage`, are never sent back to
  the UI, never written to logs (log lines are additionally passed through a redaction filter), and
  are not included in backups.

## Requirements

- Windows 10/11 x64 (development also works on macOS/Linux)
- **Node.js 24 LTS** (includes npm 11). The committed `package-lock.json` was generated with
  Node 24.21.0 / npm 11.19.0.

## Getting started

```bash
git clone https://github.com/mdnasiman641-cpu/Proxy-Own-Browser.git
cd Proxy-Own-Browser
npm ci               # exact versions from package-lock.json
npm run dev          # start the app with hot reload
```

Use `npm ci` (not `npm install`) for a clean, reproducible install. Only use `npm install <pkg>`
when you intend to change dependencies, and commit the updated `package-lock.json`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app in development mode |
| `npm run build` | Compile main, preload and renderer into `out/` |
| `npm start` | Run the compiled app from `out/` |
| `npm run typecheck` | TypeScript checks for main/preload and renderer |
| `npm run lint` | ESLint (TypeScript + React hooks rules), zero warnings allowed |
| `npm test` | Unit tests (Vitest) |
| `npm run check` | Typecheck + lint + tests |
| `npm run smoke` | Build, then run the end-to-end smoke test (see below) |
| `npm run build:win` | Check, build and create **both** the Windows installer and portable EXE |
| `npm run build:win:installer` | NSIS installer only |
| `npm run build:win:portable` | Portable EXE only |

Windows builds are written to `release/<version>/`:

- `Proxy-Own-Browser-Setup-<version>.exe` — installer (choose install folder, desktop shortcut)
- `Proxy-Own-Browser-Portable-<version>.exe` — single-file portable app

The executables are not code-signed, so Windows SmartScreen will show a warning the first time
("More info" → "Run anyway").

### End-to-end smoke test

`npm run smoke` starts local test servers (an IP-check endpoint, an authenticated proxy, an open
proxy, a proxy whose website demands a login, a proxy that never answers, and a closed port), then
launches the real app twice with a temporary data folder. It checks, among other things:

- profiles, isolated sessions, and cookies restored after a restart
- duplicate open requests create one window; the window limit is enforced
- tabs: open, switch, close, `target="_blank"` links, shared cookies within a profile but not
  across profiles, crash and recovery, closing the last tab, reopening
- proxy tests: success with the proxied IP, wrong/missing password, unreachable proxy, 3-second
  timeout, no credentials sent to the website, password-reuse rules for unsaved drafts
- that the proxy username and password never appear in the log file

One optional check also contacts the real public IP services; it is reported but cannot fail the
run, so a temporary internet problem doesn't break the build.

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` or `feature/**` and on pull requests, on a
GitHub Windows runner with Node 24: `npm ci`, typecheck, lint, unit tests, build, the end-to-end
smoke test, and the Windows EXE build. The EXEs are attached to the workflow run as the
`proxy-own-browser-windows` artifact (kept 14 days).

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
    electron/                Electron-specific code: windows & tabs, sessions, proxy tester, IPC, cipher
    services/                Pure logic (unit-tested): SQLite, profiles, settings, backup, logger,
                             proxy test runner, tab list, window open coordinator
  preload/                   One sandboxed preload; each app page gets only its own API
  renderer/
    dashboard/               React dashboard (5 sections)
    browser/                 React tab strip + toolbar at the top of each profile window
  shared/                    Types, validation, URL and proxy helpers used by all processes
tests/                       Vitest unit tests
scripts/smoke-test.mjs       Launches the built app twice (end-to-end checks)
scripts/smoke-fixtures.mjs   Local proxy/endpoint servers used only by the smoke test
```

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `npm ci` fails with `Cannot read properties of null (reading 'edgesOut')` | You are on npm 10 (Node 22). Install Node 24 LTS. |
| `npm ci` says the lockfile is out of sync | Don't edit `package.json` by hand without updating the lockfile; run `npm install` on Node 24 and commit both files. |
| Test proxy: **Could not connect to the proxy server** | Host, port or proxy type is wrong, or the proxy is offline. Check with your provider. |
| Test proxy: **did not respond in time** | The proxy is overloaded or blocking you; try again or use another proxy. |
| Test proxy: **rejected the username or password** | Re-enter the password (it may be saved for a different username). |
| Test proxy: **requires a username and password** | Add the credentials; for SOCKS proxies use an HTTP/HTTPS endpoint from your provider instead. |
| Test proxy: **certificate checks** failed | The proxy may be intercepting HTTPS; don't use it for logins. |
| "Only N profile window(s) can be open" | Close a profile window or raise the limit in Application Settings (watch Resource usage). |
| A tab shows "stopped unexpectedly" | Press Reload. If it keeps happening, close the tab and check memory in Resource usage. |
| Proxy passwords stopped working after moving to another PC | Passwords are encrypted for the original Windows user; enter them again. |
| Need logs for a bug report | Application Settings → Open data folder → `logs\app.log` (contains no credentials). |

## Known limitations

- **SOCKS proxy authentication is not supported** by Chromium. Use an HTTP/HTTPS proxy when the
  provider requires a username and password.
- **Window limit** is 1–10 (default 2), and each window holds up to 20 tabs. Real capacity depends
  on your PC and the sites you use — measure with the Resource usage panel.
- **Proxy is per profile, not per tab.** Tabs always share their profile's session and proxy.
- **Open tabs are not restored** after closing a window or restarting; the profile opens its start
  page. Cookies and logins are restored.
- No drag-to-reorder tabs, no "reopen closed tab", no tab pinning yet.
- The proxy test checks connectivity and the visible IP only; it does not measure bandwidth or check
  whether a site blocks the proxy.
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
