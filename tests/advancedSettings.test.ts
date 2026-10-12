import { mkdirSync, readdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_BROWSER_CONFIG,
  acceptLanguageSchema,
  customUserAgentSchema,
  effectiveUserAgent,
  mergeBrowserConfig,
  parseStoredBrowserConfig,
  userAgentConflict
} from '../src/shared/browserConfig'
import { languageForCountry } from '../src/shared/countryLanguage'
import {
  DEFAULT_PROFILE_OPTIONS,
  parseStoredProfileOptions,
  profileOptionsProblem,
  profileOptionsUpdateSchema
} from '../src/shared/profileOptions'
import type { IpGeolocation } from '../src/shared/types'
import { resolveLanguageAndGeolocation } from '../src/main/services/launchPlan'
import { LastTabsStore } from '../src/main/services/lastTabs'
import { permissionKeys, uniqueDownloadPath } from '../src/main/services/sessionPolicy'
import { startupPages, tabsToSave, windowTitle } from '../src/main/services/windowPolicy'
import { EXTENSIONS_DIR, ExtensionStore, inspectExtension } from '../src/main/services/extensionStore'
import { ProfileDataService, cookieMatchesHost, normalizeOrigin } from '../src/main/electron/profileData'
import { backupDigest, parseBackup } from '../src/main/services/backupService'
import { createApp, createService, tempDir } from './helpers'

const RUNTIME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7000.0 Safari/537.36'
const geo = (over: Partial<IpGeolocation> = {}): IpGeolocation => ({
  ip: '203.0.113.7',
  country: 'Bangladesh',
  countryCode: 'BD',
  region: 'Dhaka',
  city: 'Dhaka',
  latitude: 23.81,
  longitude: 90.41,
  timezone: 'Asia/Dhaka',
  isp: null,
  org: null,
  asn: null,
  provider: 'test',
  ...over
})

describe('advanced settings: persistence of every supported setting', () => {
  let dir: ReturnType<typeof tempDir>
  beforeEach(() => {
    dir = tempDir()
  })
  afterEach(() => dir.cleanup())

  it('saves every browser setting and option and loads them back after a restart', async () => {
    const file = join(dir.path, 'profiles.sqlite')
    const downloads = join(dir.path, 'downloads')
    mkdirSync(downloads)
    const first = await createService({ filePath: file })
    const created = first.service.create({ name: 'Shop', startUrl: 'https://shop.example/' })
    const updated = first.service.update(created.id, {
      browser: {
        languageMode: 'manual',
        language: 'bn-BD',
        acceptLanguage: 'bn-BD, bn, en',
        timezoneMode: 'manual',
        timezoneManual: 'Asia/Dhaka',
        windowWidth: 1400,
        windowHeight: 900,
        zoomPercent: 125,
        userAgent: 'custom',
        customUserAgent: RUNTIME_UA,
        webrtcPolicy: 'disable_non_proxied_udp',
        geolocationMode: 'manual',
        geoLatitude: 23.81,
        geoLongitude: 90.41,
        permissions: { camera: 'ask', microphone: 'allow', geolocation: 'allow', midi: 'ask', 'window-management': 'allow' }
      },
      options: {
        purpose: 'Ads',
        icon: '🛒',
        startupMode: 'urls',
        startupUrls: ['https://a.example/', 'https://b.example/', 'https://a.example/'],
        confirmBeforeOpen: true,
        windowMode: 'maximized',
        showNameInTitle: false,
        downloadMode: 'folder',
        downloadFolder: downloads,
        doNotTrack: true,
        proxyLabel: 'Plan A',
        proxyNotes: 'renews monthly'
      }
    })
    expect(updated.browser.acceptLanguage).toBe('bn-BD,bn,en')
    expect(updated.options.startupUrls).toEqual(['https://a.example/', 'https://b.example/'])
    first.db.close()

    const second = await createService({ filePath: file })
    const loaded = second.service.get(created.id)
    expect(loaded.browser).toEqual(updated.browser)
    expect(loaded.options).toEqual(updated.options)
    expect(loaded.options).toMatchObject({ purpose: 'Ads', icon: '🛒', windowMode: 'maximized', doNotTrack: true, proxyLabel: 'Plan A' })
    expect(loaded.browser.permissions).toMatchObject({ camera: 'ask', microphone: 'allow', notifications: 'block' })
    second.db.close()
  })

  it('a partial update keeps every other saved setting (no accidental defaults)', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'A', browser: { languageMode: 'manual', language: 'fr-FR', zoomPercent: 150 }, options: { purpose: 'Mail', doNotTrack: true } })
    const after = service.update(p.id, { options: { icon: 'M' } })
    expect(after.browser.language).toBe('fr-FR')
    expect(after.browser.zoomPercent).toBe(150)
    expect(after.options).toMatchObject({ purpose: 'Mail', doNotTrack: true, icon: 'M' })
    const after2 = service.update(p.id, { name: 'A2' })
    expect(after2.options).toEqual(after.options)
    expect(after2.browser).toEqual(after.browser)
  })

  it('validates settings before saving', async () => {
    const { service } = await createService()
    const p = service.create({ name: 'A' })
    expect(() => service.update(p.id, { options: { startupUrls: ['javascript:alert(1)'] } })).toThrow()
    expect(() => service.update(p.id, { options: { startupUrls: ['file:///C:/x'] } })).toThrow()
    expect(() => service.update(p.id, { options: { startupMode: 'urls', startupUrls: [] } })).toThrow()
    expect(() => service.update(p.id, { options: { downloadMode: 'folder', downloadFolder: 'relative\\path' } })).toThrow()
    expect(() => service.update(p.id, { options: { downloadMode: 'folder', downloadFolder: join(dir.path, 'missing') } })).toThrow()
    expect(() => service.update(p.id, { options: { icon: 'ABCDE' } })).toThrow()
    expect(() => service.update(p.id, { browser: { geolocationMode: 'manual', geoLatitude: 91, geoLongitude: 0 } })).toThrow()
    expect(() => service.update(p.id, { browser: { acceptLanguage: 'not a language!!' } })).toThrow()
    expect(() => service.update(p.id, { browser: { userAgent: 'custom', customUserAgent: 'short' } })).toThrow()
    expect(() => service.update(p.id, { browser: { languageMode: 'manual', language: null } })).toThrow()
    // Nothing was changed by the refused updates.
    expect(service.get(p.id).options).toEqual(DEFAULT_PROFILE_OPTIONS)
    expect(service.get(p.id).browser).toEqual(DEFAULT_BROWSER_CONFIG)
  })

  it('reads damaged or unknown stored values safely, field by field', () => {
    const options = parseStoredProfileOptions({
      purpose: 'x'.repeat(500),
      startupMode: 'urls',
      startupUrls: ['https://ok.example/', 42, 'ftp://bad'],
      windowMode: 'fullscreen-hack',
      doNotTrack: 'yes',
      downloadMode: 'folder'
    })
    expect(options.purpose).toBeNull()
    expect(options.startupUrls).toEqual(['https://ok.example/'])
    expect(options.startupMode).toBe('urls')
    expect(options.windowMode).toBe('normal')
    expect(options.doNotTrack).toBe(false)
    // A folder mode without a folder falls back to asking.
    expect(options.downloadMode).toBe('ask')
    expect(parseStoredProfileOptions('not json')).toEqual(DEFAULT_PROFILE_OPTIONS)
    expect(parseStoredProfileOptions({ startupMode: 'urls', startupUrls: [] }).startupMode).toBe('start-page')
    expect(profileOptionsProblem({ ...DEFAULT_PROFILE_OPTIONS, startupMode: 'urls' })).toMatch(/startup URL/)
    expect(profileOptionsUpdateSchema.safeParse({ startupUrls: Array.from({ length: 11 }, (_, i) => `https://e${i}.example/`) }).success).toBe(false)

    const browser = parseStoredBrowserConfig({ geolocationMode: 'teleport', acceptLanguage: 5, userAgent: 'custom', customUserAgent: null })
    expect(browser.geolocationMode).toBe('off')
    expect(browser.acceptLanguage).toBeNull()
    expect(browser.userAgent).toBe('default')
  })
})

describe('language, Accept-Language, User-Agent and geolocation', () => {
  it('normalizes Accept-Language lists and rejects invalid ones', () => {
    expect(acceptLanguageSchema.parse('bn-bd, BN ,en')).toBe('bn-BD,bn,en')
    expect(acceptLanguageSchema.safeParse('en;q=0.9').success).toBe(false)
    expect(customUserAgentSchema.safeParse('Mozilla/5.0 ünïcode-is-not-allowed-here').success).toBe(false)
  })

  it('keeps old "language only" updates working as manual language', () => {
    const next = mergeBrowserConfig(DEFAULT_BROWSER_CONFIG, { language: 'de-DE' })
    expect(next.languageMode).toBe('manual')
    expect(mergeBrowserConfig(next, { language: null }).languageMode).toBe('default')
    // The earlier combined "media" permission sets camera and microphone.
    expect(mergeBrowserConfig(DEFAULT_BROWSER_CONFIG, { permissions: { media: 'allow' } }).permissions).toMatchObject({ camera: 'allow', microphone: 'allow' })
  })

  it('flags a custom User-Agent that does not describe the installed engine', () => {
    expect(userAgentConflict(RUNTIME_UA, RUNTIME_UA)).toBeNull()
    expect(userAgentConflict(RUNTIME_UA.replace('Chrome/152', 'Chrome/120'), RUNTIME_UA)).toMatch(/Chrome 120.*Chromium 152/)
    expect(userAgentConflict('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/152.0.0.0', RUNTIME_UA)).toMatch(/operating system/)
    expect(userAgentConflict('Some/1.0 crawler without version info', RUNTIME_UA)).toMatch(/does not name a Chrome version/)
    expect(effectiveUserAgent({ userAgent: 'chrome', customUserAgent: 'x' }, { defaultUserAgent: 'D', chromeUserAgent: 'C' })).toBe('C')
    expect(effectiveUserAgent({ userAgent: 'custom', customUserAgent: 'X' }, { defaultUserAgent: 'D', chromeUserAgent: 'C' })).toBe('X')
  })

  it('derives language and geolocation from the verified proxy location only', () => {
    const base = { ...DEFAULT_BROWSER_CONFIG }
    const manual = resolveLanguageAndGeolocation({ ...base, languageMode: 'manual', language: 'fr-FR' }, geo(), null)
    expect(manual).toMatchObject({ locale: 'fr-FR', languageSource: 'manual', acceptLanguage: 'fr-FR,fr,en' })

    const auto = resolveLanguageAndGeolocation({ ...base, languageMode: 'auto', geolocationMode: 'auto' }, geo(), null)
    expect(auto).toMatchObject({ locale: 'bn-BD', languageSource: 'auto', geolocationSource: 'auto' })
    expect(auto.geolocation).toEqual({ latitude: 23.81, longitude: 90.41, accuracy: 25_000 })

    // No location known: nothing is invented, and the reason is reported.
    const unknown = resolveLanguageAndGeolocation({ ...base, languageMode: 'auto', geolocationMode: 'auto' }, null, 'lookup failed')
    expect(unknown).toMatchObject({ locale: null, languageSource: 'default', geolocation: null, geolocationSource: 'off' })
    expect(unknown.warnings.join(' ')).toMatch(/lookup failed/)
    const noCoords = resolveLanguageAndGeolocation({ ...base, geolocationMode: 'auto' }, geo({ latitude: null, longitude: null }), null)
    expect(noCoords.geolocation).toBeNull()
    const noMapping = resolveLanguageAndGeolocation({ ...base, languageMode: 'auto' }, geo({ countryCode: 'AQ' }), null)
    expect(noMapping.locale).toBeNull()
    expect(noMapping.warnings[0]).toMatch(/AQ/)

    // An explicit Accept-Language wins over the derived one.
    expect(resolveLanguageAndGeolocation({ ...base, languageMode: 'manual', language: 'en-US', acceptLanguage: 'en-US,de' }, null, null).acceptLanguage).toBe('en-US,de')
    const manualGeo = resolveLanguageAndGeolocation({ ...base, geolocationMode: 'manual', geoLatitude: 1, geoLongitude: 2 }, null, null)
    expect(manualGeo.geolocation).toEqual({ latitude: 1, longitude: 2, accuracy: 100 })
    expect(languageForCountry('bd')).toBe('bn-BD')
    expect(languageForCountry(null)).toBeNull()
  })
})

describe('startup, window title and restored tabs', () => {
  it('chooses the startup pages by the profile’s startup behaviour', () => {
    const opts = (startupMode: 'start-page' | 'urls' | 'restore', startupUrls: string[] = []) => ({ startupMode, startupUrls })
    expect(startupPages(opts('start-page'), 'https://start/', 'https://home/', [])).toEqual({ urls: ['https://start/'], source: 'start-page' })
    expect(startupPages(opts('start-page'), null, 'https://home/', [])).toEqual({ urls: ['https://home/'], source: 'start-page' })
    expect(startupPages(opts('urls', ['https://a/', 'https://b/']), null, 'https://home/', []).urls).toEqual(['https://a/', 'https://b/'])
    expect(startupPages(opts('restore'), null, 'https://home/', ['https://x/', 'chrome://settings'])).toEqual({ urls: ['https://x/'], source: 'restore' })
    expect(startupPages(opts('restore'), null, 'https://home/', [])).toEqual({ urls: ['https://home/'], source: 'restore-empty' })
    expect(startupPages(opts('urls', ['https://a/']), null, 'https://home/', [], 'https://link/').urls).toEqual(['https://link/'])
  })

  it('builds the window title with or without the profile name', () => {
    expect(windowTitle('Inbox', 'https://mail/', 'Shop', true)).toBe('Inbox — Shop')
    expect(windowTitle('Inbox', 'https://mail/', 'Shop', false)).toBe('Inbox — Proxy Own Browser')
    expect(windowTitle('', 'https://mail/', 'Shop', true)).toBe('Shop')
    expect(tabsToSave(['https://a/', 'file:///etc/passwd', 'about:blank'])).toEqual(['https://a/'])
  })

  it('stores the last tabs per profile and removes them with the profile', async () => {
    const { db, service } = await createService()
    const a = service.create({ name: 'A' })
    const b = service.create({ name: 'B' })
    const tabs = new LastTabsStore(db)
    tabs.save(a.id, ['https://a1/', 'https://a2/', 'file:///x'])
    tabs.save(b.id, ['https://b1/'])
    expect(tabs.load(a.id)).toEqual(['https://a1/', 'https://a2/'])
    expect(tabs.load(b.id)).toEqual(['https://b1/'])
    service.delete(a.id)
    expect(tabs.load(a.id)).toEqual([])
    expect(tabs.load(b.id)).toEqual(['https://b1/'])
  })
})

describe('permissions and downloads', () => {
  it('maps Electron permission requests to profile settings', () => {
    expect(permissionKeys('media', ['video'])).toEqual(['camera'])
    expect(permissionKeys('media', ['audio', 'video'])).toEqual(['camera', 'microphone'])
    expect(permissionKeys('media')).toEqual(['camera', 'microphone'])
    expect(permissionKeys('notifications')).toEqual(['notifications'])
    expect(permissionKeys('midiSysex')).toEqual(['midi'])
    expect(permissionKeys('openExternal')).toBeNull()
  })

  it('keeps downloads inside the chosen folder whatever name the site suggests', () => {
    const dir = tempDir()
    try {
      expect(uniqueDownloadPath(dir.path, '..\\..\\Windows\\evil.exe')).toBe(join(dir.path, 'evil.exe'))
      expect(uniqueDownloadPath(dir.path, '../../etc/passwd')).toBe(join(dir.path, 'passwd'))
      expect(uniqueDownloadPath(dir.path, 'a<b>:c?.txt')).toBe(join(dir.path, 'a_b__c_.txt'))
      writeFileSync(join(dir.path, 'report.pdf'), 'x')
      expect(uniqueDownloadPath(dir.path, 'report.pdf')).toBe(join(dir.path, 'report (1).pdf'))
      expect(uniqueDownloadPath(dir.path, '...')).toBe(join(dir.path, 'download'))
    } finally {
      dir.cleanup()
    }
  })
})

describe('extensions', () => {
  let dir: ReturnType<typeof tempDir>
  beforeEach(() => {
    dir = tempDir()
  })
  afterEach(() => dir.cleanup())

  const makeExtension = (name: string, manifest: Record<string, unknown> | string) => {
    const path = join(dir.path, 'src', name)
    mkdirSync(join(path, 'js'), { recursive: true })
    writeFileSync(join(path, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    writeFileSync(join(path, 'js', 'content.js'), 'console.log(1)')
    return path
  }

  it('explains why a folder cannot be installed', async () => {
    await expect(inspectExtension('relative')).rejects.toThrow(/Choose the extension folder/)
    await expect(inspectExtension(join(dir.path, 'nope'))).rejects.toThrow(/does not exist/)
    await expect(inspectExtension(join(dir.path, 'x.crx'))).rejects.toThrow(/\.crx files are not supported/)
    mkdirSync(join(dir.path, 'empty'))
    await expect(inspectExtension(join(dir.path, 'empty'))).rejects.toThrow(/no manifest\.json/)
    await expect(inspectExtension(makeExtension('bad-json', '{oops'))).rejects.toThrow(/not valid JSON/)
    await expect(inspectExtension(makeExtension('mv1', { name: 'Old', version: '1', manifest_version: 1 }))).rejects.toThrow(/manifest_version/)
    await expect(inspectExtension(makeExtension('nover', { name: 'X', manifest_version: 3 }))).rejects.toThrow(/version/)
    const info = await inspectExtension(makeExtension('ok', { name: 'Helper', version: '1.2', manifest_version: 3, action: {}, side_panel: {} }))
    expect(info).toMatchObject({ name: 'Helper', version: '1.2', manifestVersion: 3 })
    expect(info.warnings.join(' ')).toMatch(/side_panel/)
    expect(info.warnings.join(' ')).toMatch(/Toolbar buttons/)
  })

  it('copies an extension into one profile only, and removes it from that profile only', async () => {
    const app = await createApp()
    const a = app.service.create({ name: 'A' })
    const b = app.service.create({ name: 'B' })
    const userData = join(dir.path, 'user-data')
    const store = new ExtensionStore({ db: app.db, userDataPath: userData })
    const source = makeExtension('helper', { name: 'Helper', version: '1.0', manifest_version: 3 })
    const { extension } = await store.add(a.id, source)
    expect(store.list(a.id)).toHaveLength(1)
    expect(store.list(b.id)).toHaveLength(0)
    const copied = store.folderOf(a.id, extension.id)
    expect(existsSync(join(copied, 'js', 'content.js'))).toBe(true)
    expect(copied.startsWith(join(userData, EXTENSIONS_DIR, a.id))).toBe(true)
    await expect(store.add(a.id, source)).rejects.toThrow(/already installed/)
    await store.add(b.id, source)
    expect(() => store.folderOf(a.id, '../../etc')).toThrow()
    expect(() => store.get(b.id, extension.id)).toThrow(/not installed in this profile/)
    expect(store.setEnabled(a.id, extension.id, false).enabled).toBe(false)
    await store.remove(a.id, extension.id)
    expect(store.list(a.id)).toHaveLength(0)
    expect(store.list(b.id)).toHaveLength(1)
    await store.removeAll(b.id)
    expect(readdirSync(join(userData, EXTENSIONS_DIR))).toEqual([a.id].filter((id) => existsSync(join(userData, EXTENSIONS_DIR, id))))
  })

  it('refuses extension folders that contain links', async () => {
    const source = makeExtension('linked', { name: 'L', version: '1.0', manifest_version: 3 })
    try {
      symlinkSync(join(dir.path, 'src'), join(source, 'escape'))
    } catch {
      return // Creating links needs extra rights on some Windows machines.
    }
    const app = await createApp()
    const a = app.service.create({ name: 'A' })
    const store = new ExtensionStore({ db: app.db, userDataPath: join(dir.path, 'ud') })
    await expect(store.add(a.id, source)).rejects.toThrow(/links/)
    expect(store.list(a.id)).toHaveLength(0)
  })
})

describe('cookies and website data', () => {
  /** A stand-in for Electron sessions that records what was cleared in which one. */
  function fakeSessions() {
    const calls: { partition: string; call: string; arg?: unknown }[] = []
    const cookies: Record<string, { domain: string; name: string; path: string; secure: boolean }[]> = {}
    const sessionFor = (partition: string) => ({
      cookies: {
        get: async () => cookies[partition] ?? [],
        remove: async (url: string, name: string) => {
          calls.push({ partition, call: 'remove', arg: `${url}|${name}` })
          cookies[partition] = (cookies[partition] ?? []).filter((c) => !(c.name === name && url.includes(c.domain.replace(/^\./, ''))))
        },
        flushStore: async () => {}
      },
      clearStorageData: async (arg?: unknown) => {
        calls.push({ partition, call: 'clearStorageData', arg })
        if (!arg || (arg as { storages?: string[] }).storages?.includes('cookies')) cookies[partition] = []
      },
      clearCache: async () => calls.push({ partition, call: 'clearCache' }),
      clearCodeCaches: async () => calls.push({ partition, call: 'clearCodeCaches' })
    })
    return { calls, cookies, sessions: { sessionFor, isLoadedThisRun: () => false } }
  }

  it('clears data only in the selected profile’s session', async () => {
    const { service } = await createService()
    const a = service.create({ name: 'A' })
    const b = service.create({ name: 'B' })
    const fake = fakeSessions()
    fake.cookies[a.partition] = [
      { domain: '.example.com', name: 'sid', path: '/', secure: true },
      { domain: 'other.org', name: 'x', path: '/', secure: false }
    ]
    fake.cookies[b.partition] = [{ domain: '.example.com', name: 'sid', path: '/', secure: true }]
    const data = new ProfileDataService({
      profiles: service,
      sessions: fake.sessions as never,
      userDataPath: '/nowhere',
      isOpen: () => false,
      logger: { info() {}, warn() {}, error() {} }
    })

    const site = await data.clear(a.id, 'site', 'example.com')
    expect(site).toMatchObject({ origin: 'https://example.com', removedCookies: 1 })
    expect(fake.cookies[a.partition]!.map((c) => c.name)).toEqual(['x'])
    expect(fake.cookies[b.partition]).toHaveLength(1)

    await data.clear(a.id, 'cookies', null)
    await data.clear(a.id, 'cache', null)
    await data.clear(a.id, 'all', null)
    expect(fake.calls.every((c) => c.partition === a.partition)).toBe(true)
    expect(fake.cookies[b.partition]).toHaveLength(1)
    await expect(data.clear(a.id, 'site', null)).rejects.toThrow(/Enter the website/)
  })

  it('accepts only http(s) site addresses and matches cookie domains', () => {
    expect(normalizeOrigin('example.com/path?q')).toBe('https://example.com')
    expect(normalizeOrigin('http://Example.com:8080/')).toBe('http://example.com:8080')
    expect(() => normalizeOrigin('file:///C:/x')).toThrow()
    expect(cookieMatchesHost('.example.com', 'www.example.com')).toBe(true)
    expect(cookieMatchesHost('example.com', 'example.com')).toBe(true)
    expect(cookieMatchesHost('example.com', 'notexample.com')).toBe(false)
  })
})

describe('backup and restore of the advanced settings', () => {
  it('keeps options and browser settings through a metadata backup and restore', async () => {
    const source = await createApp()
    const p = source.service.create({
      name: 'Shop',
      browser: { languageMode: 'auto', geolocationMode: 'auto', userAgent: 'chrome', permissions: { camera: 'ask' } },
      options: { purpose: 'Ads', startupMode: 'urls', startupUrls: ['https://a.example/'], showNameInTitle: false, proxyLabel: 'Plan A' }
    })
    const file = source.backups.buildBackup('0.7.0')
    const parsed = parseBackup(JSON.stringify(file))

    const target = await createApp()
    target.backups.restore(parsed)
    const restored = target.service.list().find((x) => x.name === 'Shop')!
    expect(restored.options).toEqual(p.options)
    expect(restored.browser).toEqual(p.browser)
  })

  it('restores older backups without options using the defaults', async () => {
    const source = await createApp()
    source.service.create({ name: 'Old', browser: { language: 'de-DE' } })
    const file = source.backups.buildBackup('0.6.0') as unknown as { profiles: Record<string, unknown>[] }
    for (const profile of file.profiles) delete profile.options
    // Re-sign it the way an older app version wrote it (without the options field).
    ;(file as unknown as { integrity: { digest: string } }).integrity.digest = backupDigest(file as unknown as Record<string, unknown>)
    const target = await createApp()
    target.backups.restore(parseBackup(JSON.stringify(file)))
    const restored = target.service.list().find((x) => x.name === 'Old')!
    expect(restored.options).toEqual(DEFAULT_PROFILE_OPTIONS)
    expect(restored.browser).toMatchObject({ language: 'de-DE', languageMode: 'manual' })
  })
})

describe('New Profile with the full settings', () => {
  it('creates a profile with every setting the editor offers, and the editor reads them back', async () => {
    const { blankProfile, draftFromProfile, draftToUpdate } = await import('../src/renderer/dashboard/components/editor/draft')
    const { service, catalog } = await createService()
    const group = catalog.createGroup({ name: 'Shops' })
    const blank = blankProfile(group.id)
    const draft = draftFromProfile(blank)
    draft.name = '  New shop  '
    draft.notes = 'note'
    draft.color = '#16a34a'
    draft.tags = ['fb', 'ads']
    draft.startUrl = 'https://start.example/'
    draft.proxy = { ...draft.proxy, enabled: true, protocol: 'http', host: '10.0.0.5', port: '8080', username: 'bob', password: 'secret' }
    draft.browser = {
      ...draft.browser,
      timezoneMode: 'manual',
      languageMode: 'manual',
      userAgent: 'chrome',
      webrtcPolicy: 'disable_non_proxied_udp',
      geolocationMode: 'manual',
      windowWidth: 1500,
      zoomPercent: 110,
      permissions: { ...draft.browser.permissions, camera: 'ask', notifications: 'allow' }
    }
    draft.timezoneManual = 'Asia/Dhaka'
    draft.language = 'bn-BD'
    draft.acceptLanguage = 'bn-BD,bn,en'
    draft.geoLatitude = '23.8'
    draft.geoLongitude = '90.4'
    draft.startupUrls = 'https://a.example/\nhttps://b.example/'
    draft.options = {
      ...draft.options,
      purpose: 'Ads',
      icon: '🛒',
      startupMode: 'urls',
      confirmBeforeOpen: true,
      windowMode: 'maximized',
      showNameInTitle: false,
      doNotTrack: true,
      proxyLabel: 'Plan A',
      proxyNotes: 'monthly'
    }

    const created = service.create(draftToUpdate(draft, blank) as never)
    expect(created).toMatchObject({ name: 'New shop', notes: 'note', color: '#16a34a', groupId: group.id, startUrl: 'https://start.example/', tags: ['ads', 'fb'] })
    expect(created.proxy).toMatchObject({ protocol: 'http', host: '10.0.0.5', port: 8080, username: 'bob', hasPassword: true })
    expect(service.getProxyCredentials(created.id)?.password).toBe('secret')
    expect(created.browser).toMatchObject({
      timezoneMode: 'manual',
      timezoneManual: 'Asia/Dhaka',
      languageMode: 'manual',
      language: 'bn-BD',
      acceptLanguage: 'bn-BD,bn,en',
      userAgent: 'chrome',
      webrtcPolicy: 'disable_non_proxied_udp',
      geolocationMode: 'manual',
      geoLatitude: 23.8,
      geoLongitude: 90.4,
      windowWidth: 1500,
      zoomPercent: 110
    })
    expect(created.browser.permissions).toMatchObject({ camera: 'ask', notifications: 'allow', microphone: 'block' })
    expect(created.options).toMatchObject({
      purpose: 'Ads',
      icon: '🛒',
      startupMode: 'urls',
      startupUrls: ['https://a.example/', 'https://b.example/'],
      confirmBeforeOpen: true,
      windowMode: 'maximized',
      showNameInTitle: false,
      doNotTrack: true,
      proxyLabel: 'Plan A',
      proxyNotes: 'monthly'
    })

    // Opening the new profile in Edit shows what was entered: the editor would save the same
    // values again (the stored password is never sent back to the UI).
    const saved = service.get(created.id)
    const reread = draftFromProfile(saved)
    const { proxy: _sentProxy, ...sent } = draftToUpdate(draft, blank)
    expect(draftToUpdate(reread, saved)).toEqual({ ...sent, tags: ['ads', 'fb'] })
    expect(reread.proxy).toMatchObject({ enabled: true, protocol: 'http', host: '10.0.0.5', port: '8080', username: 'bob', password: '' })
  })

  it('an untouched New Profile gets the same defaults as before', async () => {
    const { blankProfile, draftFromProfile, draftToUpdate } = await import('../src/renderer/dashboard/components/editor/draft')
    const { service } = await createService()
    const blank = blankProfile(null)
    const draft = { ...draftFromProfile(blank), name: 'Plain' }
    const created = service.create(draftToUpdate(draft, blank) as never)
    const reference = service.create({ name: 'Reference' })
    expect(created.browser).toEqual(reference.browser)
    expect(created.options).toEqual(reference.options)
    expect(created.proxy).toBeNull()
  })
})
