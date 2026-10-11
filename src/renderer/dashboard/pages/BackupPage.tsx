import { useCallback, useEffect, useState } from 'react'
import type { BackupFileInfo, BackupHistoryEntry, BackupImportResult, PendingJob } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { FullBackupDialog, RestoreDialog, VerifyDialog, formatBytes } from '../components/BackupDialogs'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import type { AppData } from '../useAppData'
import { HistoryList } from './ProfileDetailsPage'

type Dialog =
  | { kind: 'full-all' }
  | { kind: 'verify'; file: BackupFileInfo }
  | { kind: 'restore'; file: BackupFileInfo }
  | null

/** Local backups: folder on this PC, metadata and encrypted full backups, verify and restore. */
export function BackupPage({ data }: { data: AppData }) {
  const { t, formatDate, formatNumber } = useI18n()
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<BackupFileInfo[] | null>(null)
  const [history, setHistory] = useState<BackupHistoryEntry[]>([])
  const [jobs, setJobs] = useState<PendingJob[]>([])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [lastImport, setLastImport] = useState<BackupImportResult | null>(null)
  const folder = data.settings?.backupFolder ?? null
  const { notify } = data

  const reload = useCallback(async () => {
    try {
      const [list, hist, pending] = await Promise.all([
        unwrap(window.pob.listBackups()),
        unwrap(window.pob.backupHistory()),
        unwrap(window.pob.pendingJobs())
      ])
      setFiles(list)
      setHistory(hist)
      setJobs(pending)
    } catch (error) {
      setFiles([])
      notify('error', errorMessage(error))
    }
  }, [notify])

  useEffect(() => {
    void reload()
  }, [reload, folder])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = () =>
    run(async () => {
      const updated = await unwrap(window.pob.chooseBackupFolder())
      if (updated) {
        await data.refresh()
        data.notify('success', t('backup.folderSet'))
      }
    })

  const metadataAll = () =>
    run(async () => {
      const entry = await unwrap(window.pob.backupMetadata('all'))
      data.notify('success', t('backup.metaDone', { file: entry.fileName ?? '' }))
      await reload()
    })

  const chooseFile = () =>
    run(async () => {
      const file = await unwrap(window.pob.chooseBackupFile())
      if (file) setDialog({ kind: 'restore', file })
    })

  const importMerge = () =>
    run(async () => {
      const result = await unwrap(window.pob.importBackup())
      if (!result.cancelled) {
        setLastImport(result)
        data.notify('success', t('backup.restored', { count: result.imported }))
        await data.refresh()
      }
    })

  const exportFile = () =>
    run(async () => {
      const result = await unwrap(window.pob.exportBackup())
      if (result.saved) data.notify('success', t('backup.exported', { count: result.profileCount }))
    })

  const cancelJob = (id: string) =>
    run(async () => {
      await unwrap(window.pob.cancelJob(id))
      await reload()
    })

  return (
    <section className="page wide" data-testid="backup-page">
      <header className="page-header">
        <div>
          <h1>{t('nav.backup')}</h1>
          <p className="subtitle">{t('backup.subtitle2')}</p>
        </div>
      </header>

      {data.startupNotes.length > 0 && (
        <div className="alert info" role="status">
          <strong>{t('jobs.startupTitle')}</strong>
          <ul>
            {data.startupNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel" data-testid="backup-folder">
        <div className="panel-head">
          <h2>{t('backup.folder')}</h2>
          <div className="button-row">
            <button type="button" className="button small" onClick={() => void chooseFolder()} disabled={busy}>
              <Icon name="folder" size={16} /> {folder ? t('backup.changeFolder') : t('backup.chooseFolder')}
            </button>
            {folder && (
              <button type="button" className="button small" onClick={() => void run(() => unwrap(window.pob.openBackupFolder()))}>
                {t('backup.openFolder')}
              </button>
            )}
          </div>
        </div>
        <p className="mono small">{folder ?? t('backup.noFolder')}</p>
        <p className="small muted">{t('backup.localOnly')}</p>
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h2>{t('backup.metaTitle')}</h2>
          <p className="small">{t('backup.metaBody')}</p>
          <button type="button" className="button primary" disabled={busy || !folder} onClick={() => void metadataAll()}>
            <Icon name="download" /> {t('backup.metaAll', { count: data.profiles.length })}
          </button>
        </div>
        <div className="panel">
          <h2>{t('backup.fullTitle')}</h2>
          <p className="small">{t('backup.fullBody')}</p>
          <button
            type="button"
            className="button primary"
            disabled={busy || !folder || data.profiles.length === 0}
            onClick={() => setDialog({ kind: 'full-all' })}
          >
            <Icon name="shield" /> {t('backup.fullAll', { count: data.profiles.length })}
          </button>
        </div>
      </div>
      <p className="small muted">{t('backup.selectedHint')}</p>

      {jobs.length > 0 && (
        <div className="panel" data-testid="pending-jobs">
          <div className="panel-head">
            <h2>{t('jobs.title')}</h2>
            <button type="button" className="button small primary" onClick={() => void window.pob.restartApp()}>
              {t('jobs.restartNow')}
            </button>
          </div>
          <p className="small muted">{t('jobs.body')}</p>
          <ul className="plain-list">
            {jobs.map((job) => (
              <li key={job.id} className="job-row">
                <Icon name="clock" size={16} /> {t(`jobs.kind.${job.kind}` as TKey, { name: job.profileName })}
                <span className="muted small"> · {formatDate(job.createdAt)}</span>
                <button type="button" className="button small" onClick={() => void cancelJob(job.id)}>
                  {t('common.cancel')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel" data-testid="backup-files">
        <div className="panel-head">
          <h2>{t('backup.browse')}</h2>
          <div className="button-row">
            <button type="button" className="button small" onClick={() => void reload()} disabled={busy}>
              <Icon name="reload" size={16} /> {t('common.refresh')}
            </button>
            <button type="button" className="button small" onClick={() => void chooseFile()} disabled={busy}>
              {t('backup.chooseFile')}
            </button>
          </div>
        </div>
        {files === null ? (
          <p className="muted">{t('app.loading')}</p>
        ) : files.length === 0 ? (
          <p className="muted">{folder ? t('backup.noFiles') : t('backup.chooseFolderFirst')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>{t('backup.col.file')}</th>
                  <th>{t('backup.col.type')}</th>
                  <th>{t('backup.col.profiles')}</th>
                  <th>{t('backup.col.date')}</th>
                  <th>{t('backup.col.size')}</th>
                  <th>{t('backup.col.check')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.path}>
                    <td className="mono small break">{f.fileName}</td>
                    <td>{t(f.kind === 'full' ? 'backup.kind.full' : 'backup.kind.metadata')}</td>
                    <td className="small">
                      {f.profiles.length === 1 ? f.profiles[0]!.name : t('backup.nProfiles', { count: f.profiles.length })}
                    </td>
                    <td className="small nowrap">
                      {formatDate(f.createdAt)}
                      {f.appVersion && <div className="muted">v{f.appVersion}</div>}
                    </td>
                    <td className="small nowrap">{formatBytes(f.sizeBytes, formatNumber)}</td>
                    <td className="small">{f.readable ? t('backup.readable') : <span className="warn">{f.problem}</span>}</td>
                    <td className="nowrap">
                      <button type="button" className="button small" onClick={() => setDialog({ kind: 'verify', file: f })} disabled={!f.readable}>
                        {t('backup.verify')}
                      </button>{' '}
                      <button type="button" className="button small primary" onClick={() => setDialog({ kind: 'restore', file: f })} disabled={!f.readable}>
                        {t('backup.restore')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h2>{t('backup.exportTitle')}</h2>
          <p className="small">{t('backup.exportBody', { count: data.profiles.length })}</p>
          <button type="button" className="button" disabled={busy} onClick={() => void exportFile()}>
            {t('backup.exportButton')}
          </button>
        </div>
        <div className="panel">
          <h2>{t('backup.importTitle')}</h2>
          <p className="small">{t('backup.importBody')}</p>
          <button type="button" className="button" disabled={busy} onClick={() => void importMerge()}>
            {t('backup.restoreButton')}
          </button>
          {lastImport && (
            <div className="alert info" data-testid="restore-result">
              {t('backup.result', {
                imported: lastImport.imported,
                skipped: lastImport.skipped,
                created: lastImport.groupsCreated ?? 0,
                merged: lastImport.groupsMerged ?? 0,
                templates: lastImport.templatesImported ?? 0
              })}
              {lastImport.warnings && lastImport.warnings.length > 0 && (
                <ul>
                  {lastImport.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>{t('backup.historyTitle')}</h2>
        {history.length === 0 ? <p className="muted">{t('backup.noHistory')}</p> : <HistoryList entries={history} showProfile />}
      </div>

      <div className="info-box">
        <strong>{t('backup.limitsTitle')}</strong>
        <ul className="small">
          <li>{t('backup.limit.passwords')}</li>
          <li>{t('backup.limit.inUse')}</li>
          <li>{t('backup.limit.logins')}</li>
          <li>{t('backup.limit.otherPc')}</li>
          <li>{t('backup.limit.caches')}</li>
        </ul>
      </div>

      {dialog?.kind === 'full-all' && (
        <FullBackupDialog
          profiles={data.profiles}
          backupFolder={folder}
          onClose={() => setDialog(null)}
          onFinished={() => void reload()}
        />
      )}
      {dialog?.kind === 'verify' && <VerifyDialog file={dialog.file} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'restore' && (
        <RestoreDialog
          file={dialog.file}
          existingIds={new Set(data.profiles.map((p) => p.id))}
          openIds={new Set(Object.entries(data.statuses).filter(([, s]) => s !== 'closed').map(([id]) => id))}
          onClose={() => setDialog(null)}
          onRestored={() => {
            void data.refresh()
            void reload()
          }}
        />
      )}
    </section>
  )
}
