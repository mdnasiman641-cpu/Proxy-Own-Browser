import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  BROWSER_LIMITS,
  COMMON_LANGUAGES,
  CONFIGURABLE_PERMISSIONS,
  isValidLanguageTag,
  isValidTimeZone,
  supportedTimeZones,
  WEBRTC_POLICIES,
  type BrowserConfig,
  type ConfigurablePermission,
  type TimezoneMode
} from '@shared/browserConfig'
import type { BackupHistoryEntry, Profile, RuntimeInfo } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { FullBackupDialog, formatBytes } from '../components/BackupDialogs'
import { BackupStatusFacts } from '../components/BackupStatusLine'
import { GroupChip, StatusBadge, TagList } from '../components/Bits'
import { DuplicateDialog } from '../components/DuplicateDialog'
import { Modal } from '../components/Modal'
import { DiagnosticsPanel } from '../components/DiagnosticsPanel'
import { NetworkPanel } from '../components/NetworkStatusView'
import { ProfileAvatar } from '../components/ProfileBadge'
import { ProfileForm } from '../components/ProfileForm'
import { useSharedProxyGuard } from '../components/SharedProxyGuard'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import type { AppData } from '../useAppData'

const PERMISSION_LABEL: Record<ConfigurablePermission, TKey> = {
  notifications: 'perm.notifications',
  media: 'perm.media',
  geolocation: 'perm.geolocation',
  'clipboard-read': 'perm.clipboard'
}

const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300]

interface Props {
  data: AppData
  profileId: string
  onBack: () => void
}

type Dialog = 'edit' | 'duplicate' | 'full-backup' | null

/** Everything about one profile: status, network and IP, time zone, browser settings, backups. */
export function ProfileDetailsPage({ data, profileId, onBack }: Props) {
  const { t, formatDate } = useI18n()
  const profile = data.profiles.find((p) => p.id === profileId)
  const [checking, setChecking] = useState(false)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [history, setHistory] = useState<BackupHistoryEntry[]>([])
  const [dialog, setDialog] = useState<Dialog>(null)
  const { guard, dialog: sharedDialog } = useSharedProxyGuard()
  const { refreshBackups } = data

  const loadHistory = useCallback(() => {
    unwrap(window.pob.backupHistory(profileId))
      .then(setHistory)
      .catch(() => setHistory([]))
    void refreshBackups()
  }, [profileId, refreshBackups])

  useEffect(() => {
    unwrap(window.pob.runtimeInfo())
      .then(setRuntime)
      .catch(() => setRuntime(null))
    loadHistory()
  }, [loadHistory])

  if (!profile) {
    return (
      <section className="page">
        <div className="empty">
          <p>{t('details.missing')}</p>
          <button type="button" className="button" onClick={onBack}>
            {t('details.back')}
          </button>
        </div>
      </section>
    )
  }

  const status = data.statuses[profile.id] ?? 'closed'
  const running = status !== 'closed'
  const group = profile.groupId ? data.groups.find((g) => g.id === profile.groupId) : undefined

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await unwrap(window.pob.checkNetwork(profile.id))
      await data.refreshNetwork()
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setChecking(false)
    }
  }

  const backupMetadata = async (): Promise<void> => {
    try {
      const entry = await unwrap(window.pob.backupMetadata([profile.id]))
      data.notify('success', t('backup.metaDone', { file: entry.fileName ?? '' }))
      loadHistory()
    } catch (error) {
      data.notify('error', errorMessage(error))
    }
  }

  return (
    <section className="page wide details-page" data-testid="profile-details">
      <header className="page-header">
        <div className="details-title">
          <button type="button" className="icon-button bordered" onClick={onBack} aria-label={t('details.back')} title={t('details.back')}>
            <Icon name="back" />
          </button>
          <ProfileAvatar profile={profile} size={40} />
          <div>
            <h1>{profile.name}</h1>
            <p className="subtitle">
              <StatusBadge status={status} /> · <GroupChip group={group} /> · <TagList tags={profile.tags} />
            </p>
          </div>
        </div>
        <div className="header-actions">
          {running ? (
            <button type="button" className="button" onClick={() => void data.closeProfile(profile)}>
              {t('common.close')}
            </button>
          ) : null}
          <button type="button" className="button primary" onClick={() => void data.openProfile(profile)}>
            <Icon name="open" /> {running ? t('common.focus') : t('common.open')}
          </button>
          <button type="button" className="button" onClick={() => setDialog('edit')}>
            <Icon name="edit" /> {t('common.edit')}
          </button>
          <button type="button" className="button" onClick={() => setDialog('duplicate')}>
            <Icon name="copy" /> {t('dup.action')}
          </button>
        </div>
      </header>

      <div className="details-grid">
        <div className="details-col">
          <NetworkPanel
            profile={profile}
            status={data.network[profile.id]}
            reported={running ? data.reportedTimezones[profile.id] : undefined}
            checking={checking}
            onCheck={() => void check()}
            geoEnabled={data.settings?.ipGeolocation ?? true}
          />
          <BrowserSettingsPanel
            key={profile.updatedAt}
            profile={profile}
            runtime={runtime}
            detectedTz={data.network[profile.id]?.lastValidTimezoneCurrent ? data.network[profile.id]!.lastValidTimezone : null}
            running={running}
            onSave={async (browser) => {
              await data.updateProfile(profile.id, { browser })
              data.notify('success', t('details.saved'))
            }}
          />
        </div>
        <div className="details-col">
          <div className="panel">
            <h2>{t('details.overview')}</h2>
            <dl className="kv">
              <dt>{t('details.created')}</dt>
              <dd>{formatDate(profile.createdAt)}</dd>
              <dt>{t('profiles.col.lastOpened')}</dt>
              <dd>{formatDate(profile.lastOpenedAt)}</dd>
              <dt>{t('details.notes')}</dt>
              <dd>{profile.notes || <span className="muted">—</span>}</dd>
              <dt>{t('details.session')}</dt>
              <dd className="mono small">{profile.partition}</dd>
              <dt>{t('details.id')}</dt>
              <dd className="mono small">{profile.id}</dd>
            </dl>
            <p className="small muted">{t('details.isolation')}</p>
          </div>

          <div className="panel" data-testid="profile-backups">
            <div className="panel-head">
              <h2>{t('details.backups')}</h2>
            </div>
            <BackupStatusFacts status={data.backups[profile.id]} />
            {!data.settings?.backupFolder && <div className="alert info small">{t('backup.chooseFolderFirst')}</div>}
            <div className="button-row">
              <button type="button" className="button small" disabled={!data.settings?.backupFolder} onClick={() => void backupMetadata()}>
                <Icon name="download" size={16} /> {t('details.backupMeta')}
              </button>
              <button type="button" className="button small" disabled={!data.settings?.backupFolder} onClick={() => setDialog('full-backup')}>
                <Icon name="shield" size={16} /> {t('details.backupFull')}
              </button>
            </div>
            {history.length === 0 ? (
              <p className="muted small">{t('details.noBackups')}</p>
            ) : (
              <HistoryList entries={history} />
            )}
          </div>

          <DiagnosticsPanel
            profile={profile}
            running={running}
            onRestrictWebRtc={async () => {
              await data.updateProfile(profile.id, { browser: { webrtcPolicy: 'disable_non_proxied_udp' } })
              data.notify('success', t('details.saved'))
            }}
          />

          <StoragePanel />

          <RuntimePanel runtime={runtime} />
        </div>
      </div>

      {dialog === 'edit' && (
        <Modal title={t('profiles.editTitle', { name: profile.name })} onClose={() => setDialog(null)}>
          <ProfileForm
            initial={profile}
            submitLabel={t('form.saveChanges')}
            groups={data.groups}
            tagSuggestions={data.tags}
            onCancel={() => setDialog(null)}
            onSubmit={(input) =>
              guard(async (options) => {
                const saved = await data.updateProfile(profile.id, input, options)
                data.notify('success', t('profiles.saved', { name: saved.name }))
                setDialog(null)
              })
            }
          />
          {sharedDialog}
        </Modal>
      )}
      {dialog === 'duplicate' && (
        <DuplicateDialog
          profile={profile}
          onClose={() => setDialog(null)}
          onDone={(result) => {
            setDialog(null)
            data.notify(result.data === 'scheduled' ? 'info' : 'success', [t('dup.done', { name: result.profile.name }), ...result.details.slice(0, 1)].join(' '))
            void data.refresh()
          }}
        />
      )}
      {dialog === 'full-backup' && (
        <FullBackupDialog
          profiles={[profile]}
          backupFolder={data.settings?.backupFolder ?? null}
          onClose={() => setDialog(null)}
          onFinished={loadHistory}
        />
      )}
    </section>
  )
}

export function HistoryList({ entries, showProfile = false }: { entries: BackupHistoryEntry[]; showProfile?: boolean }) {
  const { t, formatDate, formatNumber } = useI18n()
  return (
    <ul className="history-list" data-testid="backup-history">
      {entries.map((e) => (
        <li key={e.id} className={`history-item history-${e.status}`}>
          <div className="history-head">
            <span className="status-pill">{t(`hist.status.${e.status}` as TKey)}</span>
            <strong>{t(`hist.kind.${e.kind}` as TKey)}</strong>
            {showProfile && <span>{e.profileName}</span>}
            <span className="muted small">{formatDate(e.createdAt)}</span>
          </div>
          {e.fileName && (
            <div className="small mono" title={e.path ?? undefined}>
              {e.fileName} {e.sizeBytes !== null && `· ${formatBytes(e.sizeBytes, formatNumber)}`}
            </div>
          )}
          {e.details && (
            <details className="small">
              <summary>{t('hist.details')}</summary>
              <pre className="detail-text">{e.details}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * What belongs to this profile alone and what every profile shares with this PC. Shown so the
 * isolation is not overstated.
 */
function StoragePanel() {
  const { t } = useI18n()
  return (
    <div className="panel" data-testid="storage-panel">
      <h2>{t('storage.title')}</h2>
      <h3 className="sub-heading">{t('storage.own')}</h3>
      <p className="small">{t('storage.ownList')}</p>
      <h3 className="sub-heading">{t('storage.shared')}</h3>
      <p className="small">{t('storage.sharedList')}</p>
      <p className="small muted">{t('storage.note')}</p>
    </div>
  )
}

function RuntimePanel({ runtime }: { runtime: RuntimeInfo | null }) {
  const { t, formatNumber } = useI18n()
  if (!runtime) return null
  return (
    <div className="panel" data-testid="runtime-panel">
      <h2>{t('runtime.title')}</h2>
      <p className="small muted">{t('runtime.note')}</p>
      <dl className="kv">
        <dt>{t('runtime.electron')}</dt>
        <dd>{runtime.electron}</dd>
        <dt>{t('runtime.chromium')}</dt>
        <dd>{runtime.chrome}</dd>
        <dt>{t('runtime.node')}</dt>
        <dd>{runtime.node}</dd>
        <dt>{t('runtime.ua')}</dt>
        <dd className="mono small break">{runtime.defaultUserAgent}</dd>
      </dl>
      <h3 className="sub-heading">{t('runtime.host')}</h3>
      <p className="small muted">{t('runtime.hostNote')}</p>
      <dl className="kv">
        <dt>{t('runtime.os')}</dt>
        <dd>
          {runtime.host.platform} {runtime.host.osRelease} ({runtime.host.arch})
        </dd>
        <dt>{t('runtime.cpu')}</dt>
        <dd>
          {runtime.host.cpuModel} · {t('runtime.cores', { count: runtime.host.cpuCores })}
        </dd>
        <dt>{t('runtime.memory')}</dt>
        <dd>{t('runtime.memoryValue', { total: formatNumber(runtime.host.totalMemoryMb), free: formatNumber(runtime.host.freeMemoryMb) })}</dd>
      </dl>
    </div>
  )
}

/** Time zone, language, window, zoom, User-Agent and permissions for one profile. */
function BrowserSettingsPanel({
  profile,
  runtime,
  detectedTz,
  running,
  onSave
}: {
  profile: Profile
  runtime: RuntimeInfo | null
  detectedTz: string | null
  running: boolean
  onSave: (browser: Partial<BrowserConfig>) => Promise<void>
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<BrowserConfig>(profile.browser)
  const [language, setLanguage] = useState(profile.browser.language ?? '')
  const [tzInput, setTzInput] = useState(profile.browser.timezoneManual ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const zones = useMemo(() => supportedTimeZones(), [])
  const set = <K extends keyof BrowserConfig>(key: K, value: BrowserConfig[K]): void => setDraft((d) => ({ ...d, [key]: value }))

  const languageProblem = language.trim() && !isValidLanguageTag(language.trim()) ? t('browser.languageInvalid') : null
  const tzProblem = draft.timezoneMode === 'manual' && !isValidTimeZone(tzInput.trim()) ? t('browser.tzInvalid') : null

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (languageProblem || tzProblem) return
    setBusy(true)
    setError(null)
    try {
      await onSave({
        ...draft,
        language: language.trim() || null,
        timezoneManual: draft.timezoneMode === 'manual' ? tzInput.trim() : draft.timezoneManual && isValidTimeZone(draft.timezoneManual) ? draft.timezoneManual : null
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const modeHint: Record<TimezoneMode, TKey> = { off: 'browser.tzOffHint', auto: 'browser.tzAutoHint', manual: 'browser.tzManualHint' }

  return (
    <form className="panel form" onSubmit={(e) => void save(e)} noValidate data-testid="browser-settings">
      <h2>{t('details.browser')}</h2>
      {running && <p className="small muted">{t('browser.appliesOpen')}</p>}

      <fieldset className="choice-list">
        <legend>{t('browser.timezone')}</legend>
        <div className="segmented wide" role="radiogroup" aria-label={t('browser.timezone')}>
          {(['off', 'auto', 'manual'] as TimezoneMode[]).map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={draft.timezoneMode === mode} aria-pressed={draft.timezoneMode === mode} onClick={() => set('timezoneMode', mode)}>
              {t(`browser.tz.${mode}` as TKey)}
            </button>
          ))}
        </div>
        <p className="small muted">{t(modeHint[draft.timezoneMode])}</p>
        {draft.timezoneMode === 'auto' && (
          <p className="small">
            {detectedTz ? t('browser.tzDetected', { tz: detectedTz }) : t('browser.tzNotDetected')}
          </p>
        )}
        {draft.timezoneMode === 'manual' && (
          <label className="field">
            <span>{t('browser.tzPick')}</span>
            <input list="pob-timezones" value={tzInput} onChange={(e) => setTzInput(e.target.value)} placeholder="Asia/Dhaka" />
            <datalist id="pob-timezones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            {tzProblem && <small className="warn">{tzProblem}</small>}
          </label>
        )}
        <p className="small muted">{t('browser.tzNote')}</p>
      </fieldset>

      <label className="field">
        <span>{t('browser.language')}</span>
        <input list="pob-languages" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder={t('browser.languageDefault')} maxLength={35} />
        <datalist id="pob-languages">
          {COMMON_LANGUAGES.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <small className="muted">{languageProblem ?? t('browser.languageHint')}</small>
      </label>

      <div className="field-row">
        <label className="field">
          <span>{t('browser.width')}</span>
          <input
            type="number"
            min={BROWSER_LIMITS.windowMinWidth}
            max={BROWSER_LIMITS.windowMaxWidth}
            value={draft.windowWidth}
            onChange={(e) => set('windowWidth', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>{t('browser.height')}</span>
          <input
            type="number"
            min={BROWSER_LIMITS.windowMinHeight}
            max={BROWSER_LIMITS.windowMaxHeight}
            value={draft.windowHeight}
            onChange={(e) => set('windowHeight', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>{t('browser.zoom')}</span>
          <select value={draft.zoomPercent} onChange={(e) => set('zoomPercent', Number(e.target.value))}>
            {[...new Set([...ZOOM_STEPS, draft.zoomPercent])].sort((a, b) => a - b).map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="choice-list">
        <legend>{t('browser.ua')}</legend>
        <label className={`choice ${draft.userAgent === 'default' ? 'chosen' : ''}`}>
          <input type="radio" name="ua" checked={draft.userAgent === 'default'} onChange={() => set('userAgent', 'default')} />
          <span>
            <strong>{t('browser.uaDefault')}</strong>
            <small className="mono break">{runtime?.defaultUserAgent ?? ''}</small>
          </span>
        </label>
        <label className={`choice ${draft.userAgent === 'chrome' ? 'chosen' : ''}`}>
          <input type="radio" name="ua" checked={draft.userAgent === 'chrome'} onChange={() => set('userAgent', 'chrome')} />
          <span>
            <strong>{t('browser.uaChrome')}</strong>
            <small className="mono break">{runtime?.chromeUserAgent ?? ''}</small>
          </span>
        </label>
        <p className="small muted">{t('browser.uaNote')}</p>
      </fieldset>

      <fieldset className="choice-list" data-testid="webrtc-setting">
        <legend>{t('browser.webrtc')}</legend>
        {WEBRTC_POLICIES.map((policy) => (
          <label key={policy} className={`choice ${draft.webrtcPolicy === policy ? 'chosen' : ''}`}>
            <input type="radio" name="webrtc" checked={draft.webrtcPolicy === policy} onChange={() => set('webrtcPolicy', policy)} />
            <span>
              <strong>{t(`webrtc.${policy}` as TKey)}</strong>
              <small>{t(`webrtc.${policy}.hint` as TKey)}</small>
            </span>
          </label>
        ))}
        <p className="small muted">{t('browser.webrtcNote')}</p>
      </fieldset>

      <fieldset className="choice-list">
        <legend>{t('browser.permissions')}</legend>
        {CONFIGURABLE_PERMISSIONS.map((perm) => (
          <label key={perm} className="toggle">
            <input
              type="checkbox"
              checked={draft.permissions[perm] === 'allow'}
              onChange={(e) => set('permissions', { ...draft.permissions, [perm]: e.target.checked ? 'allow' : 'block' })}
            />
            <span>{t(PERMISSION_LABEL[perm])}</span>
          </label>
        ))}
        <p className="small muted">{t('browser.permissionsNote')}</p>
      </fieldset>

      {error && <div className="alert error">{error}</div>}
      <div className="form-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            setDraft(profile.browser)
            setLanguage(profile.browser.language ?? '')
            setTzInput(profile.browser.timezoneManual ?? '')
          }}
        >
          {t('browser.reset')}
        </button>
        <button type="submit" className="button primary" disabled={busy || Boolean(languageProblem) || Boolean(tzProblem)}>
          {busy ? t('common.saving') : t('browser.save')}
        </button>
      </div>
    </form>
  )
}
