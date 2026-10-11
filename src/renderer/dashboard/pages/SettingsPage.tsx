import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  SEARCH_ENGINES,
  UI_LANGUAGES,
  type AppInfo,
  type ResourceUsage,
  type SearchEngineId,
  type UiLanguage
} from '@shared/types'
import { LIMITS } from '@shared/validation'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { StatusBadge } from '../components/Bits'
import { useI18n } from '../i18n'
import type { AppData } from '../useAppData'

const LANGUAGE_NAMES: Record<UiLanguage, string> = { en: 'English', bn: 'বাংলা (Bangla)' }

export function SettingsPage({ data }: { data: AppData }) {
  const { t, locale, formatNumber } = useI18n()
  const s = data.settings!
  const [homepage, setHomepage] = useState(s.homepage)
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>(s.searchEngine)
  const [maxOpen, setMaxOpen] = useState(String(s.maxOpenProfiles))
  const [confirmDelete, setConfirmDelete] = useState(s.confirmBeforeDelete)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [usage, setUsage] = useState<ResourceUsage | null>(null)

  /** Measured on demand only — no background polling. */
  const refreshUsage = useCallback(() => {
    unwrap(window.pob.resourceUsage())
      .then(setUsage)
      .catch(() => setUsage(null))
  }, [])

  useEffect(() => {
    unwrap(window.pob.appInfo())
      .then(setInfo)
      .catch(() => setInfo(null))
    refreshUsage()
  }, [refreshUsage])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await data.saveSettings({
        homepage: homepage.trim(),
        searchEngine,
        maxOpenProfiles: Number(maxOpen),
        confirmBeforeDelete: confirmDelete
      })
      data.notify('success', t('settings.saved'))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const changeLanguage = async (language: UiLanguage): Promise<void> => {
    try {
      await data.saveSettings({ language })
    } catch (e) {
      data.notify('error', errorMessage(e))
    }
  }

  const toggle = async (update: { requireUniqueProxy?: boolean; ipGeolocation?: boolean }): Promise<void> => {
    try {
      await data.saveSettings(update)
      data.notify('success', t('settings.saved'))
    } catch (e) {
      data.notify('error', errorMessage(e))
    }
  }

  const mb = (value: number): string => t('settings.mb', { value: formatNumber(value) })

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{t('nav.settings')}</h1>
          <p className="subtitle">{t('settings.subtitle')}</p>
        </div>
      </header>

      <div className="panel form-panel">
        <label className="field">
          <span>{t('settings.language')}</span>
          <select
            value={s.language}
            onChange={(e) => void changeLanguage(e.target.value as UiLanguage)}
            data-testid="language-select"
          >
            {UI_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {LANGUAGE_NAMES[lang]}
              </option>
            ))}
          </select>
          <small className="muted">{t('settings.languageHint')}</small>
        </label>
      </div>

      <div className="panel form-panel" data-testid="network-settings">
        <h2>{t('settings.networkTitle')}</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={s.requireUniqueProxy}
            onChange={(e) => void toggle({ requireUniqueProxy: e.target.checked })}
            data-testid="unique-proxy-toggle"
          />
          <span>{t('settings.uniqueProxy')}</span>
        </label>
        <p className="small muted">{t('settings.uniqueProxyHint')}</p>
        <label className="toggle">
          <input type="checkbox" checked={s.ipGeolocation} onChange={(e) => void toggle({ ipGeolocation: e.target.checked })} />
          <span>{t('settings.geo')}</span>
        </label>
        <p className="small muted">{t('settings.geoHint')}</p>
      </div>

      <form className="form panel form-panel" onSubmit={(e) => void save(e)} noValidate>
        <label className="field">
          <span>{t('settings.homepage')}</span>
          <input value={homepage} onChange={(e) => setHomepage(e.target.value)} maxLength={LIMITS.urlMax} />
          <small className="muted">{t('settings.homepageHint')}</small>
        </label>
        <label className="field">
          <span>{t('settings.searchEngine')}</span>
          <select value={searchEngine} onChange={(e) => setSearchEngine(e.target.value as SearchEngineId)}>
            {(Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => (
              <option key={id} value={id}>
                {SEARCH_ENGINES[id].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('settings.maxOpen')}</span>
          <input
            type="number"
            min={1}
            max={LIMITS.maxOpenProfilesCeiling}
            value={maxOpen}
            onChange={(e) => setMaxOpen(e.target.value)}
          />
          <small className="muted">{t('settings.maxOpenHint', { max: LIMITS.maxOpenProfilesCeiling })}</small>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={confirmDelete} onChange={(e) => setConfirmDelete(e.target.checked)} />
          <span>{t('settings.confirmDelete')}</span>
        </label>
        {error && <div className="alert error">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? t('common.saving') : t('settings.save')}
          </button>
        </div>
      </form>

      <div className="panel" data-testid="resource-usage">
        <div className="panel-head">
          <h2>{t('settings.resources')}</h2>
          <button type="button" className="button small" onClick={refreshUsage}>
            <Icon name="reload" size={16} /> {t('common.refresh')}
          </button>
        </div>
        <p>{t('settings.resourcesHint')}</p>
        {usage ? (
          <>
            {usage.pressure.level !== 'ok' && (
              <div className={`alert ${usage.pressure.level === 'high' ? 'error' : 'warning'}`} role="status" data-testid="resource-pressure">
                <strong>{t(usage.pressure.level === 'high' ? 'settings.pressureHigh' : 'settings.pressureWarning')}</strong>
                <ul>
                  {usage.pressure.messages.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                <p className="small">{t('settings.pressureNote')}</p>
              </div>
            )}
            <dl className="about-grid">
              <dt>{t('settings.totalMemory')}</dt>
              <dd>{mb(usage.totalMemoryMb)}</dd>
              <dt>{t('settings.shared')}</dt>
              <dd>{mb(usage.sharedMemoryMb)}</dd>
              <dt>{t('settings.processes')}</dt>
              <dd>{formatNumber(usage.processCount)}</dd>
              <dt>{t('settings.windowsOpen')}</dt>
              <dd>{t('settings.windowsOf', { open: usage.openWindows, max: usage.maxOpenProfiles })}</dd>
              <dt>{t('settings.tabsOpen')}</dt>
              <dd>{formatNumber(usage.openTabs)}</dd>
            </dl>
            <h3 className="sub-heading">{t('settings.perProfile')}</h3>
            {usage.profiles.length === 0 ? (
              <p className="muted">{t('settings.noneOpen')}</p>
            ) : (
              <table className="table compact" data-testid="resource-table">
                <thead>
                  <tr>
                    <th>{t('profiles.col.profile')}</th>
                    <th>{t('profiles.sort.status')}</th>
                    <th>{t('settings.col.tabs')}</th>
                    <th>{t('settings.col.processes')}</th>
                    <th>{t('settings.col.memory')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.profiles.map((p) => (
                    <tr key={p.profileId}>
                      <td>{p.name}</td>
                      <td><StatusBadge status={p.status} /></td>
                      <td>{formatNumber(p.tabs)}</td>
                      <td>{formatNumber(p.processCount)}</td>
                      <td>{mb(p.memoryMb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">{t('settings.perProfileNote')}</p>
            <p className="muted small">
              {t('settings.measuredAt', { time: new Date(usage.measuredAt).toLocaleTimeString(locale) })}
            </p>
          </>
        ) : (
          <p className="muted">{t('settings.unavailable')}</p>
        )}
      </div>

      {info && (
        <div className="panel">
          <h2>{t('settings.about')}</h2>
          <dl className="about-grid">
            <dt>{t('settings.version')}</dt>
            <dd>{info.version}</dd>
            <dt>{t('settings.electron')}</dt>
            <dd>
              {info.electron} / {info.chrome}
            </dd>
            <dt>{t('settings.passwordProtection')}</dt>
            <dd>
              {info.secureStorageAvailable ? (
                t('settings.osEncrypted')
              ) : (
                <span className="warn">{t('settings.encodedOnly')}</span>
              )}
            </dd>
            <dt>{t('settings.dataFolder')}</dt>
            <dd className="path">{info.userDataPath}</dd>
          </dl>
          <button
            type="button"
            className="button small"
            onClick={() =>
              void unwrap(window.pob.openDataFolder()).catch((e) => data.notify('error', errorMessage(e)))
            }
          >
            <Icon name="folder" size={16} /> {t('settings.openDataFolder')}
          </button>
        </div>
      )}
    </section>
  )
}
