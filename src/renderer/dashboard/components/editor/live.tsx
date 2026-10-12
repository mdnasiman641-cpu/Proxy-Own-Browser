import { useCallback, useEffect, useState } from 'react'
import type { ClearDataKind, CookieSummary, Profile, ProfileEffectiveConfig, ProfileExtension, ProfileStorageInfo } from '@shared/types'
import { describeProxy } from '@shared/proxy'
import { Icon } from '../../../common/Icon'
import { errorMessage, unwrap } from '../../../common/ipc'
import { useI18n } from '../../i18n'
import type { TKey } from '../../strings'
import type { AppData } from '../../useAppData'
import { formatBytes } from '../BackupDialogs'
import { DiagnosticsPanel } from '../DiagnosticsPanel'
import { ConfirmDialog } from '../Modal'
import { Fact, Section } from './fields'

// ---------------------------------------------------------------- Extensions & Cookies

export function ExtensionsCookiesSection({ profile, data }: { profile: Profile; data: AppData }) {
  const { t, formatDate, formatNumber } = useI18n()
  const [extensions, setExtensions] = useState<ProfileExtension[]>([])
  const [extError, setExtError] = useState<string | null>(null)
  const [extNotes, setExtNotes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [storage, setStorage] = useState<ProfileStorageInfo | null>(null)
  const [cookies, setCookies] = useState<CookieSummary[] | null>(null)
  const [site, setSite] = useState('')
  const [confirm, setConfirm] = useState<{ kind: ClearDataKind; origin: string | null } | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const running = (data.statuses[profile.id] ?? 'closed') !== 'closed'

  const loadExtensions = useCallback(() => {
    unwrap(window.pob.listExtensions(profile.id))
      .then(setExtensions)
      .catch((e) => setExtError(errorMessage(e)))
  }, [profile.id])
  const loadStorage = useCallback(() => {
    unwrap(window.pob.storageInfo(profile.id))
      .then(setStorage)
      .catch(() => setStorage(null))
  }, [profile.id])

  useEffect(() => {
    loadExtensions()
    loadStorage()
  }, [loadExtensions, loadStorage])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setExtError(null)
    try {
      await fn()
    } catch (e) {
      setExtError(errorMessage(e))
    } finally {
      setBusy(false)
      loadExtensions()
    }
  }

  const add = (): Promise<void> =>
    act(async () => {
      const added = await unwrap(window.pob.addExtension(profile.id))
      if (!added) return
      setExtNotes([
        t('ext.added', { name: added.extension.name }),
        ...added.warnings,
        ...(added.loadError ? [t('ext.loadFailed', { error: added.loadError })] : running ? [t('ext.loadedNow')] : [t('ext.loadsOnOpen')])
      ])
    })

  const loadCookies = async (): Promise<void> => {
    try {
      setCookies(await unwrap(window.pob.listCookies(profile.id)))
      loadStorage()
    } catch (e) {
      setResult(errorMessage(e))
    }
  }

  const clear = async (kind: ClearDataKind, origin: string | null): Promise<void> => {
    setConfirm(null)
    try {
      const outcome = await unwrap(window.pob.clearProfileData(profile.id, kind, origin))
      setResult(outcome.message)
      if (cookies) await loadCookies()
      loadStorage()
    } catch (e) {
      setResult(errorMessage(e))
    }
  }

  const domains = cookies ? [...new Set(cookies.map((c) => c.domain.replace(/^\./, '')))] : []

  return (
    <>
      <Section title={t('ext.title')} help={t('ext.help')} testId="ed-extensions">
        <div className="button-row">
          <button type="button" className="button small primary" disabled={busy} onClick={() => void add()} data-testid="ext-add">
            <Icon name="plus" size={16} /> {t('ext.add')}
          </button>
        </div>
        <p className="ed-help">{t('ext.limits')}</p>
        {extNotes.length > 0 && (
          <div className="alert info small">
            {extNotes.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </div>
        )}
        {extError && <div className="alert error small">{extError}</div>}
        {extensions.length === 0 ? (
          <p className="muted small">{t('ext.none')}</p>
        ) : (
          <ul className="ed-list" data-testid="ext-list">
            {extensions.map((e) => (
              <li key={e.id}>
                <div>
                  <strong>{e.name}</strong> <span className="muted small">{e.version} · MV{e.manifestVersion}</span>
                  <div className="small mono muted">{e.chromeId ?? t('ext.notLoadedYet')}</div>
                  {e.lastError && <div className="small warn">{t('ext.lastError', { error: e.lastError })}</div>}
                </div>
                <div className="row-actions">
                  <label className="toggle small">
                    <input type="checkbox" checked={e.enabled} disabled={busy} onChange={(ev) => void act(() => unwrap(window.pob.setExtensionEnabled(profile.id, e.id, ev.target.checked)))} />
                    <span>{t('ext.enabled')}</span>
                  </label>
                  <button type="button" className="icon-button danger" disabled={busy} title={t('ext.remove')} aria-label={`${t('ext.remove')}: ${e.name}`} onClick={() => void act(() => unwrap(window.pob.removeExtension(profile.id, e.id)))}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="ed-help">{t('ext.noStore')}</p>
      </Section>

      <Section title={t('data.title')} help={t('data.help')} testId="ed-data">
        {storage && (
          <dl className="ed-facts">
            <Fact label={t('details.session')} value={storage.partition} mono />
            <Fact label={t('data.folder')} value={storage.folder} mono />
            <Fact label={t('data.size')} value={storage.exists ? `${formatBytes(storage.bytes ?? 0, formatNumber)} · ${t('data.files', { count: storage.files })}` : t('data.empty')} />
            <Fact label={t('data.extFolder')} value={storage.extensionsFolder} mono />
          </dl>
        )}
        {storage && !storage.inUseThisRun && <p className="ed-help">{t('data.opensStorage')}</p>}
        <div className="button-row">
          <button type="button" className="button small" onClick={() => void loadCookies()} data-testid="data-load-cookies">
            {t('data.showCookies')}
          </button>
          <button type="button" className="button small" onClick={() => setConfirm({ kind: 'cookies', origin: null })} data-testid="data-clear-cookies">
            {t('data.clearCookies')}
          </button>
          <button type="button" className="button small" onClick={() => setConfirm({ kind: 'cache', origin: null })}>
            {t('data.clearCache')}
          </button>
          <button type="button" className="button small danger" onClick={() => setConfirm({ kind: 'all', origin: null })}>
            {t('data.clearAll')}
          </button>
        </div>
        <div className="paste-row">
          <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://example.com" aria-label={t('data.site')} list="ed-cookie-domains" />
          <datalist id="ed-cookie-domains">
            {domains.map((d) => (
              <option key={d} value={`https://${d}`} />
            ))}
          </datalist>
          <button type="button" className="button small" disabled={!site.trim()} onClick={() => setConfirm({ kind: 'site', origin: site.trim() })}>
            {t('data.clearSite')}
          </button>
        </div>
        {result && <div className="alert info small" data-testid="data-result">{result}</div>}
        {cookies && (
          <div className="ed-cookies">
            <p className="small muted">{t('data.cookieCount', { count: cookies.length, domains: domains.length })}</p>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('data.domain')}</th>
                  <th>{t('data.name')}</th>
                  <th>{t('data.expires')}</th>
                </tr>
              </thead>
              <tbody>
                {cookies.slice(0, 200).map((c, i) => (
                  <tr key={`${c.domain}|${c.name}|${c.path}|${i}`}>
                    <td className="mono small">{c.domain}</td>
                    <td className="mono small">
                      {c.name}
                      {c.secure && <span className="muted"> · secure</span>}
                      {c.httpOnly && <span className="muted"> · httpOnly</span>}
                    </td>
                    <td className="small">{c.expires ? formatDate(c.expires) : t('data.session')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="ed-help">{t('data.noValues')}</p>
          </div>
        )}
      </Section>

      {confirm && (
        <ConfirmDialog
          title={t(`data.confirm.${confirm.kind}.title` as TKey)}
          message={<p>{t(`data.confirm.${confirm.kind}.body` as TKey, { name: profile.name, site: confirm.origin ?? '' })}</p>}
          confirmLabel={t(`data.confirm.${confirm.kind}.button` as TKey)}
          danger={confirm.kind !== 'cache'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void clear(confirm.kind, confirm.origin)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------- Diagnostics

export function DiagnosticsSection({ profile, data }: { profile: Profile; data: AppData }) {
  const { t } = useI18n()
  const running = (data.statuses[profile.id] ?? 'closed') !== 'closed'
  const [busy, setBusy] = useState<'ip' | 'location' | 'test' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const run = async (kind: 'ip' | 'location' | 'test'): Promise<void> => {
    setBusy(kind)
    setNote(null)
    try {
      if (kind === 'test') {
        const result = await unwrap(window.pob.testProxy(profile.id))
        setNote(result.message)
      } else {
        await unwrap(window.pob.checkNetwork(profile.id, { force: kind === 'location' }))
      }
      await data.refreshNetwork()
    } catch (e) {
      setNote(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <div className="button-row">
        <button type="button" className="button small" disabled={busy !== null} onClick={() => void run('test')}>
          {busy === 'test' ? t('form.testing') : t('form.testProxy')}
        </button>
        <button type="button" className="button small" disabled={busy !== null} onClick={() => void run('ip')}>
          {busy === 'ip' ? t('net.checking') : t('ed.refreshIp')}
        </button>
        <button type="button" className="button small" disabled={busy !== null} onClick={() => void run('location')}>
          {busy === 'location' ? t('net.checking') : t('ed.refreshLocation')}
        </button>
      </div>
      {note && <div className="alert info small">{note}</div>}
      <DiagnosticsPanel
        profile={profile}
        running={running}
        onRestrictWebRtc={async () => {
          await data.updateProfile(profile.id, { browser: { webrtcPolicy: 'disable_non_proxied_udp' } })
          data.notify('success', t('details.saved'))
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------- Summary

/** Effective configuration: saved values, stored network results and what the open window applied. */
export function SummaryPanel({ profile, data, dirty, refreshKey }: { profile: Profile; data: AppData; dirty: boolean; refreshKey: string }) {
  const { t, formatDate } = useI18n()
  const [config, setConfig] = useState<ProfileEffectiveConfig | null>(null)
  const network = data.network[profile.id]
  const geo = network?.current ? (network.geo.data ?? network.lastValidGeo) : null
  const running = data.statuses[profile.id] ?? 'closed'

  useEffect(() => {
    let alive = true
    unwrap(window.pob.effectiveConfig(profile.id))
      .then((c) => alive && setConfig(c))
      .catch(() => alive && setConfig(null))
    return () => {
      alive = false
    }
  }, [profile.id, refreshKey, running])
  useEffect(() => window.pob.onLaunchReportChanged((id) => {
    if (id === profile.id) {
      unwrap(window.pob.effectiveConfig(profile.id)).then(setConfig).catch(() => {})
    }
  }), [profile.id])

  const permissions = Object.entries(profile.browser.permissions)
    .filter(([, v]) => v !== 'block')
    .map(([k, v]) => `${t(`perm.${k}` as TKey)}: ${t(`ed.perm.${v}` as TKey)}`)

  return (
    <aside className="ed-summary" data-testid="config-summary" aria-label={t('ed.summary')}>
      <h2>{t('ed.summary')}</h2>
      {dirty && <div className="alert info small">{t('ed.summaryUnsaved')}</div>}
      <p className="small muted">{config?.open ? t('ed.summaryOpen') : t('ed.summaryClosed')}</p>
      <dl className="ed-summary-list">
        <dt>{t('details.id')}</dt>
        <dd className="mono small" data-testid="sum-id">{profile.id}</dd>
        <dt>{t('form.name')}</dt>
        <dd data-testid="sum-name">{profile.name}</dd>
        <dt>{t('ed.sum.proxy')}</dt>
        <dd data-testid="sum-proxy">
          {describeProxy(profile.proxy) ?? t('common.directConnection')}
          {network && <span className={network.proxy.ok ? 'ok-text' : 'warn'}> · {t(`net.state.${network.proxy.ok ? 'ok' : 'failed'}` as TKey)}</span>}
        </dd>
        <dt>{t('net.publicIp')}</dt>
        <dd className="mono" data-testid="sum-ip">{network?.current ? (network.ip ?? t('net.unknown')) : t('net.unknown')}</dd>
        <dt>{t('ed.sum.location')}</dt>
        <dd>{geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || t('net.unknown') : t('net.unknown')}</dd>
        <dt>{t('browser.timezone')}</dt>
        <dd data-testid="sum-tz">
          {config?.timezone.value ?? t('ed.tz.thisPc')}
          {config && config.timezone.source !== 'off' && <span className="muted"> ({t(`browser.tz.${config.timezone.source}` as TKey)})</span>}
          {config?.timezone.note && <div className="small muted">{config.timezone.note}</div>}
        </dd>
        <dt>{t('browser.language')}</dt>
        <dd data-testid="sum-lang">
          {config?.language.locale ?? t('ed.lang.appDefault')}
          {config?.language.acceptLanguage && <div className="small mono muted">{config.language.acceptLanguage}</div>}
        </dd>
        <dt>{t('ed.geo.title')}</dt>
        <dd>{config?.geolocation ? `${config.geolocation.latitude.toFixed(3)}, ${config.geolocation.longitude.toFixed(3)} (${t(`ed.geo.${config.geolocation.source}` as TKey)})` : t('ed.geo.none')}</dd>
        <dt>{t('ed.ua.effective')}</dt>
        <dd className="mono small break" data-testid="sum-ua">{config?.userAgent ?? '…'}</dd>
        {config?.userAgentConflict && (
          <dd className="warn small">{config.userAgentConflict}</dd>
        )}
        <dt>{t('runtime.electron')} / {t('runtime.chromium')}</dt>
        <dd>
          <RuntimeVersions />
        </dd>
        <dt>{t('details.session')}</dt>
        <dd className="mono small" data-testid="sum-partition">{profile.partition}</dd>
        <dt>{t('ed.sum.window')}</dt>
        <dd>
          {profile.browser.windowWidth} × {profile.browser.windowHeight} · {t(`ed.window.${profile.options.windowMode}` as TKey)} · {profile.browser.zoomPercent}%
        </dd>
        <dt>{t('browser.permissions')}</dt>
        <dd>{permissions.length ? permissions.join(', ') : t('ed.sum.allBlocked')}</dd>
      </dl>
      {config?.warnings.map((w, i) => (
        <p key={i} className="small warn">{w}</p>
      ))}
      {config?.launchReport && (
        <details className="disclosure" open>
          <summary>{t('ed.sum.applied', { date: formatDate(config.launchReport.openedAt) })}</summary>
          <ul className="ed-report" data-testid="launch-report">
            {config.launchReport.items.map((item, i) => (
              <li key={i} className={`report-${item.status}`}>
                <span className="status-pill">{t(`ed.report.${item.status}` as TKey)}</span> <strong>{item.setting}</strong>
                <div className="small muted">{item.detail}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  )
}

function RuntimeVersions() {
  const [versions, setVersions] = useState<string>('…')
  useEffect(() => {
    unwrap(window.pob.runtimeInfo())
      .then((r) => setVersions(`${r.electron} / ${r.chrome}`))
      .catch(() => setVersions('—'))
  }, [])
  return <span data-testid="sum-versions">{versions}</span>
}
