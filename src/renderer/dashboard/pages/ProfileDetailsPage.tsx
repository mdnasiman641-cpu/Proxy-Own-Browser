import { Fragment, useCallback, useEffect, useState } from 'react'
import type { BackupHistoryEntry, Profile, RuntimeInfo } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { FullBackupDialog, formatBytes } from '../components/BackupDialogs'
import { BackupStatusFacts } from '../components/BackupStatusLine'
import { GroupChip, StatusBadge, TagList } from '../components/Bits'
import { DuplicateDialog } from '../components/DuplicateDialog'
import { NetworkPanel } from '../components/NetworkStatusView'
import { ProfileAvatar } from '../components/ProfileBadge'
import { useProfileEditor, type EditorTab } from '../components/editor/ProfileEditor'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import type { AppData } from '../useAppData'


interface Props {
  data: AppData
  profileId: string
  onBack: () => void
}

type Dialog = 'duplicate' | 'full-backup' | null

/** Everything about one profile: status, network and IP, time zone, browser settings, backups. */
export function ProfileDetailsPage({ data, profileId, onBack }: Props) {
  const { t, formatDate } = useI18n()
  const profile = data.profiles.find((p) => p.id === profileId)
  const [checking, setChecking] = useState(false)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [history, setHistory] = useState<BackupHistoryEntry[]>([])
  const [dialog, setDialog] = useState<Dialog>(null)
  const { openEditor } = useProfileEditor()
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
          <button type="button" className="button" onClick={() => openEditor(profile.id)} data-testid="details-edit">
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
          <ConfigCard profile={profile} onEdit={(tab) => openEditor(profile.id, tab)} />
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


          <StoragePanel />

          <RuntimePanel runtime={runtime} />
        </div>
      </div>

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

/** The profile's main settings at a glance, each with a shortcut into the editor. */
function ConfigCard({ profile, onEdit }: { profile: Profile; onEdit: (tab: EditorTab) => void }) {
  const { t } = useI18n()
  const b = profile.browser
  const o = profile.options
  const rows: { label: string; value: string; tab: EditorTab }[] = [
    {
      label: t('browser.timezone'),
      value: `${t(`browser.tz.${b.timezoneMode}` as TKey)}${b.timezoneMode === 'manual' && b.timezoneManual ? `: ${b.timezoneManual}` : ''}`,
      tab: 'privacy'
    },
    { label: t('browser.language'), value: `${t(`ed.lang.${b.languageMode}` as TKey)}${b.languageMode === 'manual' && b.language ? `: ${b.language}` : ''}`, tab: 'browser' },
    { label: t('ed.geo.title'), value: t(`ed.geo.${b.geolocationMode}` as TKey), tab: 'privacy' },
    { label: t('browser.ua'), value: t(`ed.ua.${b.userAgent}` as TKey), tab: 'browser' },
    { label: t('browser.webrtc'), value: t(`webrtc.${b.webrtcPolicy}` as TKey), tab: 'privacy' },
    { label: t('ed.adv.startup'), value: t(`ed.startup.${o.startupMode}` as TKey), tab: 'advanced' },
    { label: t('ed.sum.window'), value: `${b.windowWidth} × ${b.windowHeight} · ${b.zoomPercent}%`, tab: 'browser' }
  ]
  return (
    <div className="panel" data-testid="config-card">
      <div className="panel-head">
        <h2>{t('details.browser')}</h2>
        <button type="button" className="button small primary" onClick={() => onEdit('general')}>
          <Icon name="edit" size={16} /> {t('ed.openEditor')}
        </button>
      </div>
      <dl className="kv">
        {rows.map((r) => (
          <Fragment key={r.label}>
            <dt>{r.label}</dt>
            <dd>
              <button type="button" className="link-button" onClick={() => onEdit(r.tab)}>
                {r.value}
              </button>
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="button-row">
        <button type="button" className="button small" onClick={() => onEdit('diagnostics')}>
          {t('diag.run')}
        </button>
        <button type="button" className="button small" onClick={() => onEdit('extensions')}>
          {t('ed.tab.extensions')}
        </button>
      </div>
    </div>
  )
}
