# Proxy Own Browser

A Windows desktop browser for running several accounts side by side. Every **profile** has its own
isolated, persistent browser session (cookies, logins, storage, cache) and can use its own proxy.

Built with Electron, React + TypeScript + Vite, SQLite (sql.js), and packaged with electron-builder.

## Features

### Profiles and sessions
- **Dashboard** — profile, running, group and proxy counts, recently used profiles.
- **Isolated sessions** — each profile uses a unique persistent Electron partition
  (`persist:profile-<uuid>`). Cookies, logins, localStorage, IndexedDB, cache, service workers,
  site permissions, proxy, language and time zone are separate per profile and survive restarts.
  A deleted profile's partition is never reused. The smoke test checks this with two profiles
  running at the same time on the same website.
- **Profile details page** (click a profile's name or the ⓘ button): proxy and IP status, time
  zone, language and browser settings, the real browser engine versions, this PC's hardware (shown
  separately and never changed), and the profile's backups.
- **What is separate and what is shared** — the details page lists it, and so does this table:

  | Kept only in the profile | Shared by every profile (this PC) |
  | --- | --- |
  | Cookies, logins, localStorage, IndexedDB, cache, service workers, site permissions; its proxy and password; its time zone, language, User-Agent and WebRTC setting | Windows and its installed fonts, graphics card and drivers, screen size, the system clock, the Windows certificate store, the single browser engine version, app-wide Chromium state (`Local State`, spellcheck dictionaries), and this PC's network outside the proxy |

  Websites can read shared properties such as screen size, fonts and graphics hardware; the app
  does not alter them.
- **Diagnostics** (details page → *Run diagnostics*), with every row showing the **test result**,
  the **expected** value and a verdict (*Passed / Failed / Warning / Unknown / Info*):
  - *Proxy connection and public IP*: the latest connection test, the proxy Chromium actually
    resolves for the profile's session (a `DIRECT` fallback is reported as failed), and the
    verified exit IP (with a warning if another profile shares it).
  - *DNS*: HTTP, HTTPS and SOCKS5 proxies receive host names and resolve them; **SOCKS4 resolves on
    this PC** (warning). Proof that the proxy resolved a name is the latest IP check by host name
    through it; whether this PC's DNS server also saw lookups cannot be observed and is shown as
    unknown. Bypass rules are pointed out.
  - *What the pages report*: time zone, `navigator.language(s)` and User-Agent read inside the
    open profile's active tab (an isolated world the site cannot see), compared with the profile's
    settings, and the session partition the page really runs in.
  - *WebRTC*: a local test with no servers lists the addresses a page could read (random `.local`
    names = hidden; a raw private address = warning; a raw public address other than the proxy's =
    failed). An optional **STUN test** runs only after you confirm it: the page contacts
    `stun.l.google.com` over UDP, and the result is *failed* only when the STUN server saw an
    address different from the proxy exit IP. If WebRTC exposed an address, the panel offers to
    switch the profile to *WebRTC only through the proxy* — only when you confirm.
  - Passing tests do not prove anonymity; they cover only what they test.
- **WebRTC network access** per profile (browser settings): *Chromium default* (the default),
  *Public interface only*, or *Only through the proxy* (no direct UDP; calls may not work). Applied
  with Chromium's own WebRTC IP handling policy to every tab and pop-up; never changed by the app
  on its own.
- **Duplicate** a profile with an explicit choice: *settings only* (new empty storage) or *settings
  and browser data* (cookies, logins and site storage copied into the copy's own new storage). A
  duplicate never shares the original's storage.

> Separate sessions keep profiles from mixing data. They do **not** make a profile anonymous or
> undetectable — websites can still recognise browsers in other ways. This app does not try to
> hide that it is a browser or bypass website security checks.

### Proxy status, public IP and location (Phase 4)
- Every profile shows its assigned proxy and, after a check, **two separate results**:
  1. **Proxy connection** — working / failed (with the reason: invalid settings, rejected
     password, timeout, cannot connect, …) and the **public IP seen through the proxy**.
  2. **IP location lookup** — country, region, city, ISP/organization (and ASN), approximate
     coordinates and the IANA time zone of that IP, from `ipwho.is` (fallback `ipapi.co`), the
     **current local time there**, and when it was last detected. A working proxy does not imply a
     successful lookup; a failed lookup shows **Unknown/Failed**, never a guess.
- **Proxies & location** page: one row per profile with proxy connection status, public IP (and
  the previous IP if it rotated), country/region/city, ISP/organization, detected time zone with
  its live local time, time zone mode and last detection time, plus **Refresh IP & location** per
  profile and **Refresh all**.
- **When it is detected**: when a profile with a proxy is created in the dashboard, when a proxy
  is configured or changed, when you press *Test* or *Refresh IP & location*, and when an
  Automatic-time-zone profile opens and its last check is older than 30 minutes.
- **Caching and rotating IPs**: the location found for an exit IP is reused for that same IP for
  up to 24 hours (no new request). When a check sees a **new exit IP** (rotating proxy), the
  location is looked up again and the previous IP is shown. *Refresh IP & location* always asks
  the service again.
- The lookup is made **through the profile's proxy** in a temporary cookie-less session, so it can
  never report this PC's own IP by mistake. The services only see the proxy's IP. No API keys are
  used. Turn lookups off in Application Settings.
- Results are stored per profile with the proxy they were made for; after a proxy change the old
  result is marked *out of date*. **Check now** re-checks on demand (no background polling).
- The **last successful test** (time and exit IP) is kept per profile and shown next to a later
  failure; it is cleared when the proxy changes.
- **Changing the proxy of an open profile** asks for confirmation first (all its tabs switch
  route at once and sites see a new IP in the same session). Without confirmation nothing is
  saved; this is enforced by the main process, not only by the dashboard.
- If two profiles' latest checks saw the **same public exit IP**, both are flagged. Providers can
  share or rotate exit IPs, so different proxy addresses do not guarantee different IPs.
- **Require unique proxy assignment** (Application Settings): saving a profile whose proxy (same
  host, port and username) is already assigned to another profile is refused unless you confirm it
  explicitly. Also applies to duplicates and the bulk wizard.
- When a profile has a proxy, **its pages never fall back to a direct connection**: if the proxy
  fails, the page shows the proxy error (checked by the smoke test).

### Time zone, language and browser settings (Phase 4)
Per profile, in its details page:
- **Time zone**: *Automatic* (the IANA time zone of the proxy's public IP — **the default for every
  profile that has a proxy**; when a proxy is configured for the first time the profile switches
  to it), *Manual* (any IANA zone, e.g. `Asia/Dhaka`) or *This PC* (no change — default for profiles
  without a proxy). In Automatic mode a profile whose time
  zone can't be detected **does not open** and says why; if a valid zone was detected before for the
  same proxy it is used with a warning. It never silently uses this PC's zone. IP geolocation is
  approximate and can be wrong — use Manual mode when you know better.
- **Language** (e.g. `bn-BD`): Accept-Language header, `navigator.language(s)` and date/number
  formats (`Intl`).
- **Window size**, **zoom**, **User-Agent** (*Default* or *Chrome* — both the real installed
  Chromium version; no other versions are offered or invented), and **site permissions**
  (notifications, camera/microphone, location, clipboard read; everything else stays blocked).
- Time zone and language are applied with Chromium's documented DevTools-protocol emulation
  (`Emulation.setTimezoneOverride`, `setLocaleOverride`, `setUserAgentOverride` for the language
  list) through Electron's `webContents.debugger`, **before the first page loads**. This changes what
  web pages see; it does **not** change the Windows clock or other programs. The smoke test checks
  the values pages actually report. The app also reads
  `Intl.DateTimeFormat().resolvedOptions().timeZone` from every loaded page (in an isolated world
  page scripts can't change) and shows "Verified in the open window" — or a warning if it differs.
- Nothing about the PC's hardware (CPU, RAM, GPU, canvas/WebGL) is faked. The details page shows the
  real Electron/Chromium versions and this PC's hardware for information only.

### Profile Manager (Phase 3)
- **Table and card views** of all profiles with a live status for each one (Closed, Starting,
  Running, Crashed) and the number of running profiles.
- **Search** (name, notes, proxy host, group, tags) and **filters** by group, tag and status.
- **Sorting** by name, creation date, group, status or last opened (ascending/descending).
- **Selection checkboxes** and a bulk action bar: Open, Close, Move to group, Add/remove tags,
  Export, Delete. Every bulk action ends with a summary of what succeeded and what failed (and why).
  - *Open* goes through the same window coordinator as a single Open, so it never exceeds the
    open-window limit; profiles over the limit are reported as not opened.
  - *Delete* asks which kind of deletion you want: **Remove from list only** (browser data stays on
    disk) or **Remove and delete browser data** (that profile's own partition folder only). Open
    profiles are never deleted.
- **Keyboard**: `/` or **Ctrl+F** search, **Ctrl+N** new profile, **Ctrl+A** select all shown,
  **Space** select, **Enter** open, **Del** delete selected, arrow keys move between rows, **Esc**
  clears the selection.
- Empty, loading and error states, confirmation dialogs, and a layout that adapts down to 1024 px wide.

### Bulk creation wizard (Phase 3)
Create **1–100 profiles at once**:
1. **Setup** — name template with `{number}` (e.g. `Shop-{number}`), start number, zero padding,
   optional template, group, tags, start page, and proxy *copied from an existing profile you pick*
   (the password is copied encrypted; it is never shown).
2. **Preview** — every name is listed; names that already exist, repeat within the batch or are
   invalid are flagged and creation is blocked until they are fixed.
3. **Create** — progress bar and a summary. Each profile is written in its own database
   transaction with a new unique id and partition. If some fail, **Retry failed** retries only
   those; names that now exist are reported, never duplicated. Created profiles are **not opened**.

### Groups, tags and templates (Phase 3)
- **Groups**: create, rename (with color), delete. A profile is in at most one group. Deleting a
  group never deletes profiles — they become *Ungrouped*.
- **Tags**: any number of tags per profile (up to 20), case-insensitive without duplicates; rename
  and delete tags from the Groups & Tags page.
- **Templates**: reusable defaults (notes, color, start page, group, tags, and optionally "copy the
  proxy from profile X"). Create, edit, duplicate, delete, and apply them in the profile form or the
  bulk wizard. Templates never contain cookies, sessions, tokens or proxy passwords; a template
  whose group or proxy source was removed is flagged instead of silently applied.

### Language
English (default) and **Bangla (বাংলা)** — switch in Application Settings. Every dashboard string has
a Bangla translation (checked by a unit test).

### Local backup & restore (Phase 4)
- Each profile shows its **backup status** in the profile list and on its details page: the last
  full (browser-data) backup, the last settings backup that included it, a full backup scheduled
  for the next start, or a failed last attempt.
Backups stay **on this PC**, in a folder you choose with the folder dialog (Backup & Restore →
Backup folder). Nothing is uploaded. Actions: back up *this profile* (details page), *selected
profiles* (Profiles → select → Back up), *all profiles*; browse the backups in the folder (or choose
any file), **verify**, **restore into the original profile** or **restore as a new profile**, export
and import (merge) metadata. Every backup and restore is recorded in the backup history.

| | Metadata backup (`POB_metadata_….json`) | Full browser-data backup (`POB_full_<name>_<id>_<date>.pobfull`) |
| --- | --- | --- |
| Contents | Profile names and IDs, groups, tags, notes, start pages, browser/time zone settings, proxy addresses (no passwords), templates, app settings, creation dates, schema and app version | Everything in the metadata of that profile **plus** cookies, logins, localStorage, IndexedDB, service workers and other Chromium profile data |
| Not included | Passwords, cookies, browser data | Proxy passwords; caches Chromium rebuilds (HTTP, code, GPU caches), temporary blob storage and offline site caches (each listed in the result) |
| Protection | SHA-256 integrity digest (detects damage/edits) | **AES-256-GCM, key from your password with scrypt** (random salt; nothing hard-coded); SHA-256 per file; the whole file is authenticated; a `.sha256` file is written next to it |

How full backups stay safe:
- Chromium keeps a profile's database files open once its session has been used in the current
  run. Such a profile is **never copied while in use**: the backup is scheduled and made
  automatically at the **next app start, before any profile opens** (the password-derived key is
  kept until then protected by Windows DPAPI and erased after the task). "Restart now" does it
  immediately. Profiles not used since the app started are backed up right away.
- The file is written as `….partial` and only renamed when every file was read completely and
  unchanged; then it is **read back and verified** before success is reported.
- **Restore** first decrypts and verifies everything (tag, every file's checksum, the manifest lists
  exactly the files present, no path can leave the target folder) into a staging folder. Only then:
  - *as a new profile*: a new profile with a **new ID and new session** is created and the data
    moved into its own folder;
  - *into the original*: only the profile the backup belongs to (same ID) can be overwritten, it must
    be closed, its current data is **kept** in `Partitions\.pob-work\previous\…`, and the swap is
    journaled so an interruption is completed or rolled back at the next start. If the profile was
    used in this run, the verified data is staged and swapped in at the next start.
  - Damaged, modified, truncated, wrong-password and newer-version backups are rejected **without
    changing anything**.
- Logins can still expire after a restore, and restored cookies may not work on another PC or
  Windows account.
- Metadata backups v1 (Phase 1/2), v2 (Phase 3) and v3 (Phase 4) can all be restored.

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

### Profile window management
- **Limit on open profile windows**: default **2**, configurable from 1 to 10 in
  Application Settings. The limit is applied when a window opens; it is not unlimited.
- **Resource usage** panel (Application Settings) shows the app's total memory, process count, open
  windows and tabs, plus **memory per running profile** where it can be attributed reliably (a
  process used by more than one profile is counted as *shared*). It is measured only when the page
  opens or you press Refresh — there is no background polling. Open your usual sites in the windows you have, check the numbers, then raise
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
- Website permissions (camera, microphone, location, notifications…) are denied by default and can
  be allowed per profile.
- Backup files can only be read from paths the app listed itself or that you picked in a file
  dialog; archive paths are validated (no `..`, absolute paths, drive letters, links or reserved
  names), and manifests are size-limited and schema-checked.
- The only external requests the app makes on its own are the IP check and IP location lookup when
  you check a profile (described above). The WebRTC STUN test contacts a public STUN server only
  after you start and confirm it.
- The DevTools-protocol connection used for time zone/language is internal to the app; it is not a
  remote debugging port and is not reachable from outside.
- Proxy passwords are encrypted with Windows DPAPI via Electron `safeStorage`, are never sent back to
  the UI, never written to logs (log lines are additionally passed through a redaction filter), and
  are not included in backups.
- Deleting browser data only ever removes `Partitions\profile-<uuid>` of the profile being deleted.
  The path is rebuilt from the partition name, checked to be inside the app's `Partitions` folder
  (no `..`, separators or symlinks), so one profile's deletion cannot touch another's storage.
- Backups are validated (size, schema, integrity digest) before anything is written.
- Diagnostic logs record events, crash reasons and counts, never URLs, passwords, cookies, proxy
  credentials or tokens. The app sends no telemetry and uploads nothing.

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
| `npm run dist:win` | Build and create the NSIS installer |
| `npm run dist:portable` | Build and create the portable EXE |
| `npm run build:win:installer` / `build:win:portable` | Same as `dist:win` / `dist:portable` (kept for compatibility) |

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
- Phase 4: localStorage and IndexedDB isolated between two profiles running at the same time on
  the same site; a failing proxy never falling back to a direct connection; the IP check and
  location lookup going through the profile's proxy; a failed lookup shown as failed; Automatic time
  zone refusing to open when detection fails; same-exit-IP warning; pages reporting the automatic
  (America/New_York) and manual (Asia/Tokyo) time zones, the profile language (Intl,
  Accept-Language, navigator.language(s)) and per-profile permissions while another profile keeps
  its own; real runtime versions and the *Chrome* User-Agent; zoom and window size; unique proxy
  assignment; local metadata backup; full backup and data copy scheduled while in use and done at
  the next start; full backup of a closed profile, wrong password and damaged backup rejected,
  restore as a new profile with the original cookies; settings, network status and time zone
  persisted after restart; the new pages in Bangla
- Proxy location & time zone: two profiles on proxies with different exit IPs (New York and
  Chicago) open at the same time — each shows its own IP, city, ISP and time zone, each page
  reports its own `Intl` time zone and reaches the internet through its own proxy, and the app's
  in-window verification agrees; the Proxies & location page shows the right row for each;
  changing one profile's proxy re-detects only that profile (its open window switches time zone)
  while the other is unchanged; cached lookups for an unchanged IP; a rotating proxy's new IP
  noticed and located; manual refresh; a missing city shown as unknown; location-service failure
  and timeout reported as failed with the last valid time zone kept
- Profile Manager (through the real dashboard IPC): bulk wizard preview and creation of 25
  profiles with unique partitions and no windows opened, retry without duplicates, groups, bulk
  move and tag changes, templates, bulk open stopping at the window limit, status changes on a tab
  crash and recovery, bulk delete with browser data removing only that profile's cookies, refusing to
  delete an open profile, the Bangla UI, and group/tags/template/language restored after restart

One optional check also contacts the real public IP services; it is reported but cannot fail the
run, so a temporary internet problem doesn't break the build.

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` or `feature/**` and on pull requests, on a
GitHub Windows runner with Node 24: `npm ci`, typecheck, lint, unit tests, build, the end-to-end
smoke test, and the Windows EXE builds (`npm run dist:win` and `npm run dist:portable`). It then
reads the product name, version, company and copyright from each EXE and checks that it carries
the app icon. The EXEs are attached to the workflow run as the `proxy-own-browser-windows`
artifact (kept 14 days).

The app icon is `build/icon.png` (1024 px source) and `build/icon.ico` (16–256 px), used for the
EXEs, the installer and the uninstaller.

## Where data is stored

`%APPDATA%\Proxy Own Browser\` (open it from Application Settings → *Open data folder*):

| Path | Contents |
| --- | --- |
| `data\profiles.sqlite` | Profiles, groups, tags, templates, proxy settings (passwords encrypted), app settings |
| `data\profiles.sqlite.pre-v<N>-<time>.bak` | Verified copy of the database made automatically before an upgrade migration |
| `Partitions\profile-<uuid>\` | Each profile's cookies, storage and cache |
| `Partitions\.pob-work\` | Restore staging, journals, and each profile's data as it was before an in-place restore (`previous\` — delete it yourself when no longer needed) |
| your backup folder | Backups you made (only where you chose) |
| `logs\app.log` | Application log (no credentials) |

Set the `POB_USER_DATA_DIR` environment variable to use a different data folder.

None of these files are committed to Git (see `.gitignore`).

### Database migrations
The schema version is stored in SQLite (`PRAGMA user_version`). Version 0.3.0 upgrades the database
from schema 1 to 2 by **adding** the `groups`, `tags`, `profile_tags` and `templates` tables and a
`group_id` column on profiles; existing profiles, proxy settings, partitions and settings are kept
unchanged. Before migrating, the app copies the database to `profiles.sqlite.pre-v2-<time>.bak`.
If a migration fails, the file is left untouched and the app shows the error instead of starting
with an empty list. A database created by a newer version of the app is refused rather than
modified.

Version 0.6.0 upgrades schema 4 to 5, only **adding**: the last successful proxy test (time and
exit IP) to `profile_network_status` (filled from existing successful results) and the list of
profiles a multi-profile backup covered to `backup_history`. The WebRTC setting is stored in the
existing `browser_config` JSON; profiles without it get *Chromium default*. A verified
`profiles.sqlite.pre-v5-<time>.bak` copy is made first.

Version 0.5.0 upgrades schema 3 to 4: adds when a location was detected, whether it was reused,
and the previous exit IP to `profile_network_status`, and switches profiles **that use a proxy and
have no manual time zone** to the automatic, proxy-based time zone (manual choices are kept;
profiles without a proxy are unchanged). The usual verified pre-upgrade copy is made first.

Version 0.4.0 upgrades schema 2 to 3, again only **adding**: a `browser_config` column on profiles
(existing profiles get the defaults, which keep the previous behaviour — no time zone or language
override, same window size, 100 % zoom, default User-Agent, permissions blocked), and the tables
`profile_network_status`, `backup_history` and `jobs`. Before upgrading, the database is copied
to `profiles.sqlite.pre-v3-<time>.bak` and the copy is **verified** (same SHA-256 and readable with
the old schema); if that fails, the upgrade does not start and the data is untouched.

## Project structure

```
src/
  main/
    index.ts                 App bootstrap, proxy-auth handler, shutdown
    smokeTest.ts, smokePhase4.ts, smokeHelpers.ts
                             End-to-end self test (only runs when POB_SMOKE_TEST is set)
    electron/                Electron-specific code: windows & tabs, sessions, proxy tester, IPC, cipher
    services/                Pure logic (unit-tested): SQLite, profiles, settings, backup, logger,
                             proxy test runner, tab list, window open coordinator, groups/tags
                             (catalogService), templates, bulk creation and bulk runner,
                             metadata backup, managed partition paths, status and memory attribution,
                             network status + IP geolocation, encrypted full backup archive,
                             backup center (backup/restore/duplicate/start-up jobs), resource pressure
  preload/                   One sandboxed preload; each app page gets only its own API
  renderer/
    dashboard/               React dashboard (7 sections), bulk wizard, English/Bangla strings
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
| Bulk open says "Only N profile window(s) can be open" for some profiles | Expected: bulk open respects the window limit. Close windows or raise the limit. |
| Restore says the backup is **damaged or was modified** | The file was edited or truncated; the integrity digest no longer matches. Use an unmodified backup. |
| App says the database is from a **newer version** | You opened data from a newer app version. Update the app; the data was not changed. |
| Delete reports "browser data partially removed" | Chromium still had a file open. The data is cleared; an empty folder may remain until restart. |
| Profile won't open: "time zone could not be detected" | Automatic time zone needs a working proxy and IP lookup. Press *Check now* on the details page to see which part failed, fix the proxy, or switch the profile to Manual time zone. |
| IP location shows **Unknown** | The lookup failed or is turned off; the proxy itself may still work (see *Proxy connection*). |
| "already assigned to …" when saving | *Require unique proxy assignment* is on. Choose another proxy or confirm the shared use. |
| Full backup says "scheduled" | The profile was used since the app started. Restart the app (Backup & Restore → *Restart now*); it is made before any profile opens. |
| Restore: "The password is not correct" | Full backups can only be opened with the password chosen when they were made. |
| Logged out after restoring | Websites can end sessions; restored cookies may also not work on another PC or Windows account. |
| Need logs for a bug report | Application Settings → Open data folder → `logs\app.log` (contains no credentials). |

## Checking it yourself

### Several profiles with different proxies
1. Create profile **A** with proxy 1 and profile **B** with proxy 2 (Profiles → New profile → Proxy).
   With *Require unique proxy assignment* on, giving B the same proxy as A asks for confirmation.
2. Open each profile's details page (click its name) and press **Check now**. Each shows its own
   *Proxy connection* (public IP) and *IP location lookup* (country/city/time zone). If both show
   the same public IP, a warning appears.
3. Set A's time zone to **Automatic** and B's to **Manual → Europe/London**; set A's language to
   `bn-BD`.
4. Open A and B at the same time. In each, visit a page that shows your IP and browser time zone
   (for example a "what is my IP" site). A shows proxy 1's IP and its detected zone; B shows proxy
   2's IP and London time. Log in to a site in A — B stays logged out.
5. Change A's proxy and check again: the old result is marked out of date; B is unchanged.
6. Restart the app: proxies, time zones, languages and logins of both profiles are kept.
7. Put a wrong port on a test profile and open it: pages show the proxy error, not your own IP.
8. With A open, change its proxy: a confirmation appears; *Cancel* leaves everything unchanged.
9. With A open, go to its details page → **Run diagnostics**: proxy route, public IP, DNS, page
   time zone/language/User-Agent, partition and the local WebRTC test each show a result.
   **Run STUN test** (after confirming) compares the address the STUN server saw with the proxy
   IP. Try *WebRTC network access → Only through the proxy* and run it again.

### Local backup and restore
1. Backup & Restore → **Choose folder…** and pick a folder on your PC (e.g. on another drive).
2. Close profile A (or restart the app without opening it), then on A's details page choose **Full
   backup (encrypted)…**, enter a password twice and start. The result lists the file name, size and
   what was not included; the file appears under *Backups in the folder*. If A was used since the
   app started, the backup is *scheduled* — press **Restart now**.
3. Press **Verify** on the file and enter the password: all checksums are checked.
4. **Restore… → A new profile**: a new profile appears with a new ID, logged in like A was.
5. **Restore… → The original profile** (A closed): A's current data is kept under
   `Partitions\.pob-work\previous\`, the backup's data is put in place and verified.
6. Try a wrong password, or a copy of the file with a byte changed: both are rejected and nothing
   changes.
7. **Back up all (metadata)** writes `POB_metadata_all-profiles_<date>.json` (no passwords, no
   browser data); *Import metadata* merges such a file into another install.

## Known limitations

- **WebRTC through an HTTP or SOCKS proxy**: Chromium sends WebRTC's UDP traffic directly, not
  through the proxy. With *Chromium default* a STUN server (and so a website) can learn this PC's
  real public IP; *Only through the proxy* prevents that but can break calls. The setting only
  affects new connections; reload open pages.
- **DNS with SOCKS4** is resolved on this PC. The app cannot see whether this PC's DNS server
  received lookups, so diagnostics report that part as unknown.
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
- Website permission requests are denied unless allowed in the profile's settings. *Location* may
  not work even when allowed, because this Electron build has no location provider.
- **Full backups of profiles used since the app started** are made at the next start (Chromium
  keeps their files open until the app exits). Proxy passwords are never backed up. Caches are not
  backed up. A forgotten backup password cannot be recovered.
- **Logins after restore** can still be ended by websites, and restored cookies may not work on a
  different PC or Windows account.
- **IP geolocation is approximate** and comes from third-party services (`ipwho.is`, `ipapi.co`)
  that can rate-limit; the time zone of an IP can be wrong. Use Manual time zone when needed.
- The time zone/language override applies to web pages of the profile (tabs and pop-ups). Pop-up
  windows opened by scripts may start loading before the override is applied to them (they share
  the opener's renderer in most cases, which already has it).
- Only one browser engine version is installed (the one shipped with Electron); the *Chrome*
  User-Agent option keeps that same real version. Multiple Chromium versions are not supported.
- Per-profile memory is an attribution of renderer processes; GPU, network and browser processes
  are shared and shown as such, so per-profile numbers do not add up to the total.
- Bulk actions run one profile after another; very large selections take a few seconds.
- Proxy passwords are encrypted for the current Windows user. If the database is copied to another
  PC or user account, passwords must be entered again.
- If an open profile is deleted it must be closed first. When "delete browsing data" is chosen,
  data is cleared immediately; an empty partition folder may remain until the next restart.
- The EXEs are unsigned (SmartScreen warning) and there is no auto-update yet.
- No downloads manager UI; downloads use the standard save dialog.

This project does not implement fingerprint spoofing (no fake CPU, RAM, GPU, canvas or WebGL values, no stealth patches) or any mechanism to bypass website security,
identity checks or access restrictions.
