import { useMemo, useState } from 'react'
import {
  BROWSER_LIMITS,
  COMMON_LANGUAGES,
  CONFIGURABLE_PERMISSIONS,
  PERMISSION_SETTINGS,
  WEBRTC_POLICIES,
  acceptLanguageFor,
  supportedTimeZones,
  userAgentConflict,
  type BrowserConfig,
  type ConfigurablePermission,
  type GeolocationMode,
  type LanguageMode,
  type PermissionSetting,
  type TimezoneMode,
  type UserAgentMode
} from '@shared/browserConfig'
import { languageForCountry } from '@shared/countryLanguage'
import type { ReportedHardware } from '@shared/diagnostics'
import { OPTION_LIMITS, type DownloadMode, type ProfileOptions, type StartupMode, type WindowMode } from '@shared/profileOptions'
import { describeProxy, parseProxyString } from '@shared/proxy'
import { PROXY_PROTOCOLS, type Profile, type ProxyProtocol, type ProxyTestResult, type RuntimeInfo } from '@shared/types'
import { LIMITS, PROFILE_COLORS } from '@shared/validation'
import { Icon } from '../../../common/Icon'
import { errorMessage, unwrap } from '../../../common/ipc'
import { useI18n } from '../../i18n'
import type { TKey } from '../../strings'
import type { AppData } from '../../useAppData'
import { GroupSelect, StatusBadge, TagInput } from '../Bits'
import { LocalTime } from '../LocalTime'
import { NetworkPanel } from '../NetworkStatusView'
import { ProxyTestResultView } from '../ProxyTestResultView'
import { buildProxyInput, type EditorDraft, type ProxyDraft } from './draft'
import { Fact, Field, Section, Segmented, Toggle, Unsupported } from './fields'

export interface SectionProps {
  draft: EditorDraft
  update: (fn: (d: EditorDraft) => EditorDraft) => void
  errors: Partial<Record<string, TKey>>
  profile: Profile
  data: AppData
  runtime: RuntimeInfo | null
}

const setBrowser = <K extends keyof BrowserConfig>(key: K, value: BrowserConfig[K]) => (d: EditorDraft): EditorDraft => ({
  ...d,
  browser: { ...d.browser, [key]: value }
})
const setOption = <K extends keyof ProfileOptions>(key: K, value: ProfileOptions[K]) => (d: EditorDraft): EditorDraft => ({
  ...d,
  options: { ...d.options, [key]: value }
})
const setProxy = <K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]) => (d: EditorDraft): EditorDraft => ({
  ...d,
  proxy: { ...d.proxy, [key]: value }
})

// ---------------------------------------------------------------- General

export function GeneralSection({ draft, update, errors, profile, data }: SectionProps) {
  const { t, formatDate } = useI18n()
  const status = data.statuses[profile.id] ?? 'closed'
  const [copied, setCopied] = useState(false)
  return (
    <>
      <Section title={t('ed.general.identity')}>
        <Field label={t('form.name')} error={errors.name}>
          <input value={draft.name} maxLength={LIMITS.nameMax} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} data-testid="ed-name" />
        </Field>
        <div className="ed-row">
          <Fact
            label={t('details.id')}
            mono
            value={
              <>
                {profile.id}{' '}
                <button
                  type="button"
                  className="icon-button"
                  title={t('ed.copy')}
                  aria-label={t('ed.copy')}
                  onClick={() => {
                    void navigator.clipboard.writeText(profile.id).then(() => setCopied(true))
                  }}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={14} />
                </button>
              </>
            }
          />
          <Fact label={t('ed.status')} value={<StatusBadge status={status} />} />
        </div>
        <div className="grid-2">
          <Field label={t('ed.purpose')} help={t('ed.purposeHelp')}>
            <input
              value={draft.options.purpose ?? ''}
              maxLength={OPTION_LIMITS.purposeMax}
              onChange={(e) => update(setOption('purpose', e.target.value))}
              placeholder={t('ed.purposePlaceholder')}
            />
          </Field>
          <Field label={t('ed.icon')} help={t('ed.iconHelp')}>
            <input value={draft.options.icon ?? ''} maxLength={OPTION_LIMITS.iconMax} onChange={(e) => update(setOption('icon', e.target.value))} placeholder="🛒" />
          </Field>
        </div>
        <div className="field">
          <span>{t('form.color')}</span>
          <div className="swatches" role="radiogroup" aria-label={t('form.colorLabel')}>
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={draft.color === c}
                aria-label={c}
                className={`swatch ${draft.color === c ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => update((d) => ({ ...d, color: c }))}
              />
            ))}
          </div>
        </div>
      </Section>

      <Section title={t('ed.general.organize')}>
        <div className="grid-2">
          <GroupSelect groups={data.groups} value={draft.groupId} onChange={(groupId) => update((d) => ({ ...d, groupId }))} />
          <TagInput label={t('form.tags')} value={draft.tags} onChange={(tags) => update((d) => ({ ...d, tags }))} suggestions={data.tags} />
        </div>
        <Field label={t('form.notes')} error={errors.notes}>
          <textarea value={draft.notes} rows={3} maxLength={LIMITS.notesMax} onChange={(e) => update((d) => ({ ...d, notes: e.target.value }))} />
        </Field>
        <dl className="ed-facts">
          <Fact label={t('details.created')} value={formatDate(profile.createdAt)} />
          <Fact label={t('profiles.col.lastOpened')} value={formatDate(profile.lastOpenedAt)} />
          <Fact label={t('ed.updated')} value={formatDate(profile.updatedAt)} />
        </dl>
      </Section>

      <Section title={t('ed.general.opening')}>
        <Toggle
          checked={draft.options.confirmBeforeOpen}
          onChange={(v) => update(setOption('confirmBeforeOpen', v))}
          label={t('ed.confirmOpen')}
          help={t('ed.confirmOpenHelp')}
          testId="ed-confirm-open"
        />
        <p className="ed-help">{t('ed.singleInstance')}</p>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Proxy

export function ProxySection({ draft, update, errors, profile, data }: SectionProps) {
  const { t, formatDate } = useI18n()
  const p = draft.proxy
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ key: string; result?: ProxyTestResult; error?: string } | null>(null)
  const [refreshing, setRefreshing] = useState<'ip' | 'location' | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const isSocks = p.protocol === 'socks4' || p.protocol === 'socks5'
  const key = JSON.stringify(buildProxyInput(draft, profile))
  const current = test?.key === key ? test : null
  const network = data.network[profile.id]

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTest(null)
    try {
      setTest({ key, result: await unwrap(window.pob.testProxy(profile.id, buildProxyInput(draft, profile))) })
    } catch (e) {
      setTest({ key, error: errorMessage(e) })
    } finally {
      setTesting(false)
    }
  }

  const refresh = async (force: boolean): Promise<void> => {
    setRefreshing(force ? 'location' : 'ip')
    setRefreshError(null)
    try {
      await unwrap(window.pob.checkNetwork(profile.id, { force }))
      await data.refreshNetwork()
    } catch (e) {
      setRefreshError(errorMessage(e))
    } finally {
      setRefreshing(null)
    }
  }

  return (
    <>
      <Section title={t('ed.proxy.settings')} help={t('ed.proxy.help')} testId="ed-proxy-settings">
        <Toggle checked={p.enabled} onChange={(v) => update(setProxy('enabled', v))} label={t('form.useProxy')} testId="ed-proxy-enabled" />
        {p.enabled ? (
          <>
            <div className="paste-row">
              <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t('form.pastePlaceholder')} aria-label={t('form.pasteLabel')} autoComplete="off" />
              <button
                type="button"
                className="button"
                disabled={!paste.trim()}
                onClick={() => {
                  const parsed = parseProxyString(paste)
                  if (!parsed) {
                    setPasteError(t('form.pasteError'))
                    return
                  }
                  update((d) => ({
                    ...d,
                    proxy: { ...d.proxy, enabled: true, protocol: parsed.protocol, host: parsed.host, port: String(parsed.port), username: parsed.username, password: parsed.password, clearPassword: false }
                  }))
                  setPaste('')
                  setPasteError(null)
                }}
              >
                {t('form.fill')}
              </button>
            </div>
            {pasteError && <small className="field-error">{pasteError}</small>}
            <div className="grid-3">
              <Field label={t('form.type')}>
                <select value={p.protocol} onChange={(e) => update(setProxy('protocol', e.target.value as ProxyProtocol))}>
                  {PROXY_PROTOCOLS.map((v) => (
                    <option key={v} value={v}>
                      {v.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('form.host')} error={errors.proxyHost}>
                <input value={p.host} onChange={(e) => update(setProxy('host', e.target.value))} placeholder="1.2.3.4" data-testid="ed-proxy-host" />
              </Field>
              <Field label={t('form.port')} error={errors.proxyPort}>
                <input value={p.port} inputMode="numeric" onChange={(e) => update(setProxy('port', e.target.value.replace(/[^0-9]/g, '')))} placeholder="8080" data-testid="ed-proxy-port" />
              </Field>
            </div>
            {p.protocol === 'socks4' && <p className="ed-help warn">{t('ed.proxy.socks4')}</p>}
            {isSocks ? (
              <p className="ed-help">{t('form.socksNote')}</p>
            ) : (
              <div className="grid-2">
                <Field label={t('form.username')} error={errors.proxyUser}>
                  <input value={p.username} onChange={(e) => update(setProxy('username', e.target.value))} autoComplete="off" />
                </Field>
                <Field label={t('form.password')} help={t('ed.proxy.passwordHelp')}>
                  <input
                    type="password"
                    value={p.password}
                    onChange={(e) => update(setProxy('password', e.target.value))}
                    placeholder={profile.proxy?.hasPassword && !p.clearPassword ? t('form.passwordSaved') : ''}
                    autoComplete="new-password"
                  />
                </Field>
              </div>
            )}
            {!isSocks && profile.proxy?.hasPassword && (
              <Toggle checked={p.clearPassword} onChange={(v) => update(setProxy('clearPassword', v))} label={t('form.removePassword')} />
            )}
            <Field label={t('form.bypass')} help={t('ed.proxy.bypassHelp')}>
              <input value={p.bypass} onChange={(e) => update(setProxy('bypass', e.target.value))} placeholder="localhost, *.example.com" />
            </Field>
            <div className="grid-2">
              <Field label={t('ed.proxy.label')} help={t('ed.proxy.labelHelp')}>
                <input value={draft.options.proxyLabel ?? ''} maxLength={OPTION_LIMITS.proxyLabelMax} onChange={(e) => update(setOption('proxyLabel', e.target.value))} />
              </Field>
              <Field label={t('ed.proxy.notes')}>
                <input value={draft.options.proxyNotes} maxLength={OPTION_LIMITS.proxyNotesMax} onChange={(e) => update(setOption('proxyNotes', e.target.value))} />
              </Field>
            </div>
          </>
        ) : (
          <p className="ed-help">{t('form.directNote')}</p>
        )}
        <div className="button-row">
          <button type="button" className="button" onClick={() => void runTest()} disabled={testing} data-testid="ed-test-proxy">
            <Icon name="check" size={16} /> {testing ? t('form.testing') : t('form.testProxy')}
          </button>
          {profile.proxy && p.enabled && (
            <button type="button" className="button" onClick={() => update(setProxy('enabled', false))}>
              <Icon name="trash" size={16} /> {t('ed.proxy.remove')}
            </button>
          )}
        </div>
        <p className="ed-help">{t('form.testHint')}</p>
        {current?.result && <ProxyTestResultView result={current.result} />}
        {current?.error && <div className="alert error">{current.error}</div>}
      </Section>

      <Section title={t('ed.proxy.status')} help={t('ed.proxy.statusHelp')}>
        <div className="button-row">
          <button type="button" className="button small" disabled={refreshing !== null} onClick={() => void refresh(false)} data-testid="ed-refresh-ip">
            <Icon name="reload" size={16} /> {refreshing === 'ip' ? t('net.checking') : t('ed.refreshIp')}
          </button>
          <button type="button" className="button small" disabled={refreshing !== null} onClick={() => void refresh(true)} data-testid="ed-refresh-location">
            <Icon name="globe" size={16} /> {refreshing === 'location' ? t('net.checking') : t('ed.refreshLocation')}
          </button>
        </div>
        {refreshError && <div className="alert error small">{refreshError}</div>}
        <p className="small muted">
          {t('ed.proxy.saved', { proxy: describeProxy(profile.proxy) ?? t('common.directConnection') })}
          {network?.lastSuccessAt && ` · ${t('net.lastSuccess')}: ${formatDate(network.lastSuccessAt)}`}
        </p>
        <NetworkPanel
          profile={profile}
          status={network}
          checking={refreshing !== null}
          onCheck={() => void refresh(true)}
          geoEnabled={data.settings?.ipGeolocation ?? true}
          reported={data.reportedTimezones[profile.id]}
        />
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Privacy & Network

export function PrivacySection({ draft, update, errors, profile, data }: SectionProps) {
  const { t, formatDate } = useI18n()
  const zones = useMemo(() => supportedTimeZones(), [])
  const network = data.network[profile.id]
  const detectedTz = network?.lastValidTimezoneCurrent ? network.lastValidTimezone : null
  const b = draft.browser
  const location = network?.current ? (network.lastValidGeo ?? null) : null
  const previewZone = b.timezoneMode === 'manual' ? draft.timezoneManual.trim() : b.timezoneMode === 'auto' ? detectedTz : null

  return (
    <>
      <Section title={t('browser.timezone')} help={t('browser.tzNote')} testId="ed-timezone">
        <Segmented<TimezoneMode>
          label={t('browser.timezone')}
          value={b.timezoneMode}
          onChange={(v) => update(setBrowser('timezoneMode', v))}
          options={(['off', 'auto', 'manual'] as const).map((m) => ({ value: m, label: t(`browser.tz.${m}` as TKey) }))}
        />
        <p className="ed-help">{t(({ off: 'browser.tzOffHint', auto: 'browser.tzAutoHint', manual: 'browser.tzManualHint' } as const)[b.timezoneMode])}</p>
        {b.timezoneMode === 'manual' && (
          <Field label={t('browser.tzPick')} error={errors.timezone}>
            <input list="ed-timezones" value={draft.timezoneManual} onChange={(e) => update((d) => ({ ...d, timezoneManual: e.target.value }))} placeholder="Asia/Dhaka" data-testid="ed-tz-manual" />
            <datalist id="ed-timezones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>
        )}
        <dl className="ed-facts">
          <Fact label={t('ed.tz.detected')} value={detectedTz ?? t('net.unknown')} source={t('ed.src.proxyIp')} />
          <Fact label={t('ed.tz.lastUpdate')} value={network?.lastValidTimezoneAt ? formatDate(network.lastValidTimezoneAt) : t('net.never')} />
          <Fact label={t('ed.tz.preview')} value={previewZone ? <LocalTime timeZone={previewZone} /> : t('ed.tz.thisPc')} />
        </dl>
      </Section>

      <Section title={t('ed.geo.title')} help={t('ed.geo.help')} testId="ed-geolocation">
        <Segmented<GeolocationMode>
          label={t('ed.geo.title')}
          value={b.geolocationMode}
          onChange={(v) => update(setBrowser('geolocationMode', v))}
          options={(['off', 'auto', 'manual'] as const).map((m) => ({ value: m, label: t(`ed.geo.${m}` as TKey) }))}
        />
        {b.geolocationMode === 'manual' && (
          <div className="grid-2">
            <Field label={t('ed.geo.lat')} error={errors.latitude}>
              <input value={draft.geoLatitude} inputMode="decimal" onChange={(e) => update((d) => ({ ...d, geoLatitude: e.target.value }))} placeholder="23.8103" />
            </Field>
            <Field label={t('ed.geo.lon')} error={errors.longitude}>
              <input value={draft.geoLongitude} inputMode="decimal" onChange={(e) => update((d) => ({ ...d, geoLongitude: e.target.value }))} placeholder="90.4125" />
            </Field>
          </div>
        )}
        {b.geolocationMode === 'auto' && (
          <dl className="ed-facts">
            <Fact
              label={t('ed.geo.preview')}
              value={
                location && location.latitude !== null && location.longitude !== null
                  ? `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)} (±25 km)`
                  : t('ed.geo.unavailable')
              }
              source={t('ed.src.proxyIp')}
            />
          </dl>
        )}
        <Fact
          label={t('ed.geo.permission')}
          value={t(`ed.perm.${b.permissions.geolocation}` as TKey)}
          source={t('ed.geo.permissionWhere')}
        />
        {b.geolocationMode !== 'off' && b.permissions.geolocation === 'block' && <p className="ed-help warn">{t('ed.geo.blocked')}</p>}
      </Section>

      <Section title={t('browser.webrtc')} help={t('browser.webrtcNote')} testId="webrtc-setting">
        <div className="choice-list">
          {WEBRTC_POLICIES.map((policy) => (
            <label key={policy} className={`choice ${b.webrtcPolicy === policy ? 'chosen' : ''}`}>
              <input type="radio" name="ed-webrtc" checked={b.webrtcPolicy === policy} onChange={() => update(setBrowser('webrtcPolicy', policy))} />
              <span>
                <strong>{t(`webrtc.${policy}` as TKey)}</strong>
                <small>{t(`webrtc.${policy}.hint` as TKey)}</small>
              </span>
            </label>
          ))}
        </div>
      </Section>

      <Section title={t('ed.dnt.title')}>
        <Toggle checked={draft.options.doNotTrack} onChange={(v) => update(setOption('doNotTrack', v))} label={t('ed.dnt.label')} help={t('ed.dnt.help')} testId="ed-dnt" />
      </Section>

      <Section title={t('ed.privacy.network')}>
        <dl className="ed-facts">
          <Fact label={t('net.proxyConnection')} value={network ? t(`net.state.${network.proxy.ok ? 'ok' : 'failed'}` as TKey) : t('net.never')} />
          <Fact label={t('net.publicIp')} value={network?.ip ?? t('net.unknown')} mono />
          <Fact label={t('details.session')} value={profile.partition} mono />
        </dl>
        <p className="ed-help">{t('ed.privacy.diagHint')}</p>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Browser & Navigator

const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300]

export function BrowserSection({ draft, update, errors, profile, data, runtime }: SectionProps) {
  const { t } = useI18n()
  const b = draft.browser
  const network = data.network[profile.id]
  const autoLanguage = languageForCountry(network?.current ? network.lastValidGeo?.countryCode : null)
  const effectiveLocale = b.languageMode === 'manual' ? draft.language.trim() : b.languageMode === 'auto' ? autoLanguage : null
  const effectiveAccept = draft.acceptLanguage.trim() || (effectiveLocale ? acceptLanguageFor(effectiveLocale) : null)
  const customConflict = b.userAgent === 'custom' && runtime && draft.customUserAgent.trim() ? userAgentConflict(draft.customUserAgent.trim(), runtime.defaultUserAgent) : null
  const effectiveUa = b.userAgent === 'custom' ? draft.customUserAgent.trim() : b.userAgent === 'chrome' ? (runtime?.chromeUserAgent ?? '') : (runtime?.defaultUserAgent ?? '')

  return (
    <>
      <Section title={t('ed.browser.runtime')} help={t('runtime.note')} testId="browser-settings">
        <dl className="ed-facts">
          <Fact label={t('runtime.chromium')} value={runtime?.chrome ?? '…'} source={t('ed.src.real')} />
          <Fact label={t('runtime.electron')} value={runtime?.electron ?? '…'} source={t('ed.src.real')} />
          <Fact label={t('runtime.node')} value={runtime?.node ?? '…'} source={t('ed.src.real')} />
        </dl>
      </Section>

      <Section title={t('browser.ua')} help={t('browser.uaNote')}>
        <div className="choice-list">
          {(['default', 'chrome', 'custom'] as UserAgentMode[]).map((mode) => (
            <label key={mode} className={`choice ${b.userAgent === mode ? 'chosen' : ''}`}>
              <input type="radio" name="ed-ua" checked={b.userAgent === mode} onChange={() => update(setBrowser('userAgent', mode))} />
              <span>
                <strong>{t(`ed.ua.${mode}` as TKey)}</strong>
                <small className={mode === 'custom' ? '' : 'mono break'}>
                  {mode === 'default' ? runtime?.defaultUserAgent : mode === 'chrome' ? runtime?.chromeUserAgent : t('ed.ua.customHint')}
                </small>
              </span>
            </label>
          ))}
        </div>
        {b.userAgent === 'custom' && (
          <Field label={t('ed.ua.customLabel')} error={errors.userAgent}>
            <textarea rows={2} value={draft.customUserAgent} onChange={(e) => update((d) => ({ ...d, customUserAgent: e.target.value }))} data-testid="ed-custom-ua" />
          </Field>
        )}
        {customConflict && (
          <div className="alert warning small" data-testid="ua-conflict">
            {t('ed.ua.conflict')} {customConflict}
          </div>
        )}
        <Fact label={t('ed.ua.effective')} value={effectiveUa || '…'} mono />
      </Section>

      <Section title={t('browser.language')} help={t('browser.languageHint')} testId="ed-language">
        <Segmented<LanguageMode>
          label={t('browser.language')}
          value={b.languageMode}
          onChange={(v) => update(setBrowser('languageMode', v))}
          options={(['default', 'auto', 'manual'] as const).map((m) => ({ value: m, label: t(`ed.lang.${m}` as TKey) }))}
        />
        <p className="ed-help">{t(`ed.lang.${b.languageMode}.hint` as TKey)}</p>
        {b.languageMode === 'manual' && (
          <Field label={t('ed.lang.locale')} error={errors.language}>
            <input list="ed-languages" value={draft.language} onChange={(e) => update((d) => ({ ...d, language: e.target.value }))} placeholder="bn-BD" maxLength={35} data-testid="ed-language-input" />
            <datalist id="ed-languages">
              {COMMON_LANGUAGES.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
        )}
        <Field label={t('ed.lang.accept')} help={t('ed.lang.acceptHelp')} error={errors.acceptLanguage}>
          <input value={draft.acceptLanguage} onChange={(e) => update((d) => ({ ...d, acceptLanguage: e.target.value }))} placeholder={effectiveLocale ? acceptLanguageFor(effectiveLocale) : 'bn-BD,bn,en'} />
        </Field>
        <dl className="ed-facts">
          <Fact label={t('ed.lang.effectiveLocale')} value={effectiveLocale || t('ed.lang.appDefault')} />
          <Fact label={t('ed.lang.effectiveAccept')} value={effectiveAccept ?? t('ed.lang.appDefault')} mono />
        </dl>
      </Section>

      <Section title={t('ed.browser.window')}>
        <div className="field-row">
          <Field label={t('browser.width')}>
            <input type="number" min={BROWSER_LIMITS.windowMinWidth} max={BROWSER_LIMITS.windowMaxWidth} value={b.windowWidth} onChange={(e) => update(setBrowser('windowWidth', Number(e.target.value)))} />
          </Field>
          <Field label={t('browser.height')}>
            <input type="number" min={BROWSER_LIMITS.windowMinHeight} max={BROWSER_LIMITS.windowMaxHeight} value={b.windowHeight} onChange={(e) => update(setBrowser('windowHeight', Number(e.target.value)))} />
          </Field>
          <Field label={t('browser.zoom')}>
            <select value={b.zoomPercent} onChange={(e) => update(setBrowser('zoomPercent', Number(e.target.value)))}>
              {[...new Set([...ZOOM_STEPS, b.zoomPercent])].sort((x, y) => x - y).map((z) => (
                <option key={z} value={z}>
                  {z}%
                </option>
              ))}
            </select>
          </Field>
        </div>
        <dl className="ed-facts">
          <Fact
            label={t('ed.browser.screen')}
            value={runtime ? `${runtime.host.screen.width} × ${runtime.host.screen.height} @ ${runtime.host.screen.scaleFactor}x` : '…'}
            source={t('ed.src.host')}
          />
          <Fact label={t('ed.browser.platform')} value={runtime ? `${runtime.host.platform} (${runtime.host.arch})` : '…'} source={t('ed.src.host')} />
        </dl>
        <Unsupported label={t('ed.unsup.screen')} reason={t('ed.unsup.screenWhy')} />
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Hardware & Permissions

export function HardwareSection({ draft, update, profile, data, runtime }: SectionProps) {
  const { t, formatNumber } = useI18n()
  const [reported, setReported] = useState<ReportedHardware | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const running = (data.statuses[profile.id] ?? 'closed') !== 'closed'

  const read = async (): Promise<void> => {
    setReading(true)
    setReadError(null)
    try {
      const report = await unwrap(window.pob.runDiagnostics(profile.id, { stun: false }))
      setReported(report.reportedHardware)
      if (!report.reportedHardware) setReadError(report.pageProblem ?? t('ed.hw.noPage'))
    } catch (e) {
      setReadError(errorMessage(e))
    } finally {
      setReading(false)
    }
  }

  const setPermission = (key: ConfigurablePermission, value: PermissionSetting) =>
    update((d) => ({ ...d, browser: { ...d.browser, permissions: { ...d.browser.permissions, [key]: value } } }))

  return (
    <>
      <Section title={t('ed.hw.host')} help={t('runtime.hostNote')} testId="ed-host-hardware">
        <dl className="ed-facts">
          <Fact label={t('runtime.cpu')} value={runtime?.host.cpuModel ?? '…'} source={t('ed.src.host')} />
          <Fact label={t('ed.hw.logical')} value={runtime ? String(runtime.host.cpuCores) : '…'} source={t('ed.src.host')} />
          <Fact
            label={t('runtime.memory')}
            value={runtime ? t('runtime.memoryValue', { total: formatNumber(runtime.host.totalMemoryMb), free: formatNumber(runtime.host.freeMemoryMb) }) : '…'}
            source={t('ed.src.host')}
          />
          <Fact
            label={t('ed.browser.screen')}
            value={runtime ? `${runtime.host.screen.width} × ${runtime.host.screen.height}, ${t('ed.hw.dpr')} ${runtime.host.screen.scaleFactor}` : '…'}
            source={t('ed.src.host')}
          />
        </dl>
      </Section>

      <Section title={t('ed.hw.reported')} help={t('ed.hw.reportedHelp')} testId="ed-reported-hardware">
        <button type="button" className="button small" disabled={!running || reading} onClick={() => void read()} title={running ? undefined : t('diag.openFirst')}>
          <Icon name="reload" size={16} /> {reading ? t('diag.running') : t('ed.hw.read')}
        </button>
        {!running && <p className="ed-help">{t('ed.hw.openFirst')}</p>}
        {readError && <div className="alert info small">{readError}</div>}
        {reported && (
          <dl className="ed-facts">
            <Fact label="navigator.hardwareConcurrency" value={reported.hardwareConcurrency ?? t('net.unknown')} source={t('ed.src.page')} />
            <Fact label="navigator.deviceMemory" value={reported.deviceMemory ?? t('net.unknown')} source={t('ed.src.page')} />
            <Fact label="screen" value={reported.screenWidth && reported.screenHeight ? `${reported.screenWidth} × ${reported.screenHeight}` : t('net.unknown')} source={t('ed.src.page')} />
            <Fact label="devicePixelRatio" value={reported.devicePixelRatio ?? t('net.unknown')} source={t('ed.src.page')} />
            <Fact label="navigator.platform" value={reported.platform ?? t('net.unknown')} source={t('ed.src.page')} />
          </dl>
        )}
      </Section>

      <Section title={t('browser.permissions')} help={t('ed.perm.help')} testId="ed-permissions">
        <table className="table ed-perm-table">
          <thead>
            <tr>
              <th>{t('ed.perm.permission')}</th>
              {PERMISSION_SETTINGS.map((s) => (
                <th key={s}>{t(`ed.perm.${s}` as TKey)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CONFIGURABLE_PERMISSIONS.map((perm) => (
              <tr key={perm}>
                <td>{t(`perm.${perm}` as TKey)}</td>
                {PERMISSION_SETTINGS.map((s) => (
                  <td key={s}>
                    <input
                      type="radio"
                      name={`perm-${perm}`}
                      aria-label={`${t(`perm.${perm}` as TKey)}: ${t(`ed.perm.${s}` as TKey)}`}
                      checked={draft.browser.permissions[perm] === s}
                      onChange={() => setPermission(perm, s)}
                      data-testid={`perm-${perm}-${s}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ed-help">{t('ed.perm.always')}</p>
      </Section>

      <Section title={t('ed.unsup.title')} help={t('ed.unsup.help')}>
        <Unsupported label={t('ed.unsup.hardware')} reason={t('ed.unsup.hardwareWhy')} />
        <Unsupported label={t('ed.unsup.screenCapture')} reason={t('ed.unsup.screenCaptureWhy')} />
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Other / Advanced

export function AdvancedSection({ draft, update, errors, profile, data }: SectionProps) {
  const { t } = useI18n()
  const o = draft.options
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState<string | null>(null)

  const chooseFolder = async (): Promise<void> => {
    try {
      const folder = await unwrap(window.pob.chooseDownloadFolder())
      if (folder) update((d) => ({ ...d, options: { ...d.options, downloadFolder: folder, downloadMode: 'folder' } }))
    } catch (e) {
      data.notify('error', errorMessage(e))
    }
  }

  const exportConfig = async (): Promise<void> => {
    setExporting(true)
    try {
      const result = await unwrap(window.pob.exportProfileConfig(profile.id))
      setExportNote(result.saved ? t('ed.adv.exported', { file: result.filePath ?? '' }) : null)
    } catch (e) {
      setExportNote(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <Section title={t('ed.adv.startup')} help={t('ed.adv.startupHelp')} testId="ed-startup">
        <Segmented<StartupMode>
          label={t('ed.adv.startup')}
          value={o.startupMode}
          onChange={(v) => update(setOption('startupMode', v))}
          options={(['start-page', 'urls', 'restore'] as const).map((m) => ({ value: m, label: t(`ed.startup.${m}` as TKey) }))}
        />
        <Field label={t('form.startPage')} error={errors.startUrl} help={t('ed.adv.startPageHelp')}>
          <input value={draft.startUrl} onChange={(e) => update((d) => ({ ...d, startUrl: e.target.value }))} placeholder={data.settings?.homepage ?? 'https://'} />
        </Field>
        <Field label={t('ed.adv.startupUrls')} help={t('ed.adv.startupUrlsHelp')} error={errors.startupUrls}>
          <textarea rows={4} value={draft.startupUrls} onChange={(e) => update((d) => ({ ...d, startupUrls: e.target.value }))} placeholder={'https://example.com\nhttps://example.org'} data-testid="ed-startup-urls" />
        </Field>
      </Section>

      <Section title={t('ed.adv.window')}>
        <Segmented<WindowMode>
          label={t('ed.adv.window')}
          value={o.windowMode}
          onChange={(v) => update(setOption('windowMode', v))}
          options={(['normal', 'maximized'] as const).map((m) => ({ value: m, label: t(`ed.window.${m}` as TKey) }))}
        />
        <Toggle checked={o.showNameInTitle} onChange={(v) => update(setOption('showNameInTitle', v))} label={t('ed.adv.nameInTitle')} help={t('ed.adv.nameInTitleHelp')} />
      </Section>

      <Section title={t('ed.adv.downloads')} testId="ed-downloads">
        <Segmented<DownloadMode>
          label={t('ed.adv.downloads')}
          value={o.downloadMode}
          onChange={(v) => update(setOption('downloadMode', v))}
          options={(['ask', 'folder'] as const).map((m) => ({ value: m, label: t(`ed.download.${m}` as TKey) }))}
        />
        {o.downloadMode === 'folder' && (
          <div className="ed-row">
            <span className={`mono break ${o.downloadFolder ? '' : 'muted'}`}>{o.downloadFolder ?? t('ed.adv.noFolder')}</span>
            <button type="button" className="button small" onClick={() => void chooseFolder()}>
              <Icon name="folder" size={16} /> {t('ed.adv.chooseFolder')}
            </button>
          </div>
        )}
        {errors.downloadFolder && <small className="field-error">{t(errors.downloadFolder)}</small>}
      </Section>

      <Section title={t('ed.adv.launchArgs')}>
        <Unsupported label={t('ed.adv.launchArgs')} reason={t('ed.adv.launchArgsWhy')} />
      </Section>

      <Section title={t('ed.adv.export')} help={t('ed.adv.exportHelp')}>
        <button type="button" className="button small" disabled={exporting} onClick={() => void exportConfig()}>
          <Icon name="download" size={16} /> {t('ed.adv.exportButton')}
        </button>
        {exportNote && <p className="ed-help">{exportNote}</p>}
      </Section>
    </>
  )
}
