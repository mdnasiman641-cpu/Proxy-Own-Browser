import { useEffect, useState, type FormEvent } from 'react'
import type { BackupProgress } from '@shared/ipc'
import type { BackupFileInfo, FullBackupOutcome, Profile, RestoreOutcome, RestoreTarget } from '@shared/types'
import { errorMessage, unwrap } from '../../common/ipc'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import { Modal } from './Modal'

const MIN_PASSWORD = 8

export function formatBytes(bytes: number | null, formatNumber: (n: number) => string): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${formatNumber(bytes)} B`
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 102.4) / 10)} KB`
  if (bytes < 1024 ** 3) return `${formatNumber(Math.round(bytes / (1024 * 102.4)) / 10)} MB`
  return `${formatNumber(Math.round(bytes / (1024 ** 2 * 102.4)) / 10)} GB`
}

/** Encrypted full browser-data backup of one or more profiles to the backup folder. */
export function FullBackupDialog({
  profiles,
  backupFolder,
  onClose,
  onFinished
}: {
  profiles: Profile[]
  backupFolder: string | null
  onClose: () => void
  onFinished: () => void
}) {
  const { t, formatNumber } = useI18n()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [results, setResults] = useState<FullBackupOutcome[] | null>(null)

  useEffect(() => window.pob.onBackupProgress(setProgress), [])

  const problem =
    password.length < MIN_PASSWORD ? t('fb.passwordShort', { min: MIN_PASSWORD }) : password !== confirm ? t('fb.passwordMismatch') : null

  const start = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (problem) return
    setBusy(true)
    setError(null)
    try {
      const outcomes = await unwrap(window.pob.backupFull({ profileIds: profiles.map((p) => p.id), password }))
      setResults(outcomes)
      onFinished()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      setPassword('')
      setConfirm('')
    }
  }

  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id
  const percent = progress && progress.totalBytes > 0 ? Math.round((progress.doneBytes / progress.totalBytes) * 100) : null

  return (
    <Modal title={t('fb.title', { count: profiles.length })} onClose={busy ? () => {} : onClose} width={620}>
      {results ? (
        <div className="outcome-list" data-testid="full-backup-results">
          {results.map((r) => (
            <div key={r.profileId} className={`outcome-item outcome-${r.status}`}>
              <strong>{r.name}</strong> — {t(`fb.status.${r.status}` as TKey)}
              <div className="small">{r.message}</div>
              {r.fileName && (
                <div className="small mono">
                  {r.fileName} · {formatBytes(r.sizeBytes, formatNumber)}
                </div>
              )}
              {r.excluded.length > 0 && (
                <details className="small">
                  <summary>{t('fb.excluded', { count: r.excluded.length })}</summary>
                  <ul>
                    {r.excluded.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
          {results.some((r) => r.status === 'scheduled') && <div className="alert info">{t('fb.scheduledNote')}</div>}
          <div className="form-actions">
            <button type="button" className="button primary" onClick={onClose}>
              {t('common.done')}
            </button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={(e) => void start(e)} noValidate>
          <p>{t('fb.intro')}</p>
          <ul className="small plain-list">
            {profiles.slice(0, 8).map((p) => (
              <li key={p.id}>{p.name}</li>
            ))}
            {profiles.length > 8 && <li>{t('fb.more', { count: profiles.length - 8 })}</li>}
          </ul>
          <p className="small">
            {t('fb.destination')} <span className="mono">{backupFolder ?? t('backup.noFolder')}</span>
          </p>
          <label className="field">
            <span>{t('fb.password')}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          </label>
          <label className="field">
            <span>{t('fb.confirm')}</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
          <div className="alert warning small">{t('fb.passwordWarning')}</div>
          <p className="small muted">{t('fb.inUseNote')}</p>
          {busy && (
            <div className="progress-block" role="status">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${percent ?? 5}%` }} />
              </div>
              <span className="small">
                {progress ? t('fb.progress', { name: nameOf(progress.profileId), percent: percent ?? 0 }) : t('fb.preparing')}
              </span>
            </div>
          )}
          {password && problem && <div className="small warn">{problem}</div>}
          {error && <div className="alert error">{error}</div>}
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="button primary" disabled={busy || Boolean(problem) || !backupFolder}>
              {busy ? t('common.working') : t('fb.start')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/** Asks for a backup password and verifies (full) or checks (metadata) a backup file. */
export function VerifyDialog({ file, onClose }: { file: BackupFileInfo; onClose: () => void }) {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const run = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    setBusy(true)
    try {
      setResult(await unwrap(window.pob.verifyBackup(file.path, file.encrypted ? password : undefined)))
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('verify.title')} onClose={onClose} width={520}>
      <form className="form" onSubmit={(e) => void run(e)} noValidate>
        <p className="mono small">{file.fileName}</p>
        {file.encrypted && (
          <label className="field">
            <span>{t('fb.password')}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
        )}
        {result && <div className={`alert ${result.ok ? 'success' : 'error'}`} data-testid="verify-result">{result.message}</div>}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="submit" className="button primary" disabled={busy || (file.encrypted && !password)}>
            {busy ? t('verify.running') : t('verify.run')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Restore into the original profile (only the profile the backup belongs to) or as a new profile. */
export function RestoreDialog({
  file,
  existingIds,
  openIds,
  onClose,
  onRestored
}: {
  file: BackupFileInfo
  existingIds: Set<string>
  openIds: Set<string>
  onClose: () => void
  onRestored: (outcome: RestoreOutcome) => void
}) {
  const { t, formatDate } = useI18n()
  const originals = file.profiles.filter((p) => p.id && existingIds.has(p.id))
  const [target, setTarget] = useState<RestoreTarget>(originals.length ? 'original' : 'new')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(file.profiles.map((p) => p.id ?? '').filter(Boolean)))
  const [password, setPassword] = useState('')
  const [newName, setNewName] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null)

  const single = file.profiles.length === 1
  const chosenIds = [...selected]
  const openTargets = target === 'original' ? chosenIds.filter((id) => openIds.has(id)) : []
  const canSubmit =
    !busy &&
    (!file.encrypted || password.length > 0) &&
    (single || chosenIds.length > 0) &&
    (target === 'new' || (understood && originals.length > 0 && openTargets.length === 0))

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await unwrap(
        window.pob.restoreBackup({
          path: file.path,
          target,
          ...(file.encrypted ? { password } : {}),
          ...(!single ? { profileIds: chosenIds } : file.profiles[0]?.id ? { profileIds: [file.profiles[0].id] } : {}),
          ...(target === 'new' && single && newName.trim() ? { newName: newName.trim() } : {})
        })
      )
      setOutcome(result)
      onRestored(result)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (outcome) {
    return (
      <Modal title={t('restore.title')} onClose={onClose} width={600}>
        <div className={`alert ${outcome.status === 'failed' ? 'error' : outcome.status === 'scheduled' ? 'info' : 'success'}`} data-testid="restore-outcome">
          {outcome.message}
        </div>
        {outcome.details.length > 0 && (
          <ul className="small detail-list">
            {outcome.details.filter((d) => !d.startsWith('Settings before the restore')).map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
        {outcome.status === 'scheduled' && (
          <div className="form-actions">
            <button type="button" className="button primary" onClick={() => void window.pob.restartApp()}>
              {t('jobs.restartNow')}
            </button>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={t('restore.title')} onClose={busy ? () => {} : onClose} width={620}>
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="mono small">{file.fileName}</p>
        <p className="small">
          {t(file.kind === 'full' ? 'restore.kindFull' : 'restore.kindMetadata')} · {formatDate(file.createdAt)} · {t('restore.appVersion', { version: file.appVersion ?? '—' })}
        </p>
        {!single && (
          <fieldset className="choice-list compact">
            <legend>{t('restore.which')}</legend>
            <div className="check-scroll">
              {file.profiles.map((p) => (
                <label key={p.id ?? p.name} className="toggle">
                  <input
                    type="checkbox"
                    disabled={!p.id}
                    checked={Boolean(p.id && selected.has(p.id))}
                    onChange={() =>
                      setSelected((s) => {
                        const next = new Set(s)
                        if (p.id && next.has(p.id)) next.delete(p.id)
                        else if (p.id) next.add(p.id)
                        return next
                      })
                    }
                  />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="choice-list">
          <legend>{t('restore.where')}</legend>
          <label className={`choice ${target === 'original' ? 'chosen' : ''} ${originals.length ? '' : 'disabled'}`}>
            <input type="radio" name="restore-target" checked={target === 'original'} disabled={!originals.length} onChange={() => setTarget('original')} />
            <span>
              <strong>{t('restore.original')}</strong>
              <small>{originals.length ? t(file.kind === 'full' ? 'restore.originalFullHint' : 'restore.originalMetaHint') : t('restore.originalMissing')}</small>
            </span>
          </label>
          <label className={`choice ${target === 'new' ? 'chosen' : ''}`}>
            <input type="radio" name="restore-target" checked={target === 'new'} onChange={() => setTarget('new')} />
            <span>
              <strong>{t('restore.asNew')}</strong>
              <small>{t('restore.asNewHint')}</small>
            </span>
          </label>
        </fieldset>
        {target === 'new' && single && (
          <label className="field">
            <span>{t('restore.newName')}</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={file.profiles[0]?.name} maxLength={60} />
          </label>
        )}
        {file.encrypted && (
          <label className="field">
            <span>{t('fb.password')}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </label>
        )}
        {target === 'original' && originals.length > 0 && (
          <label className="toggle confirm-toggle">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>{t(file.kind === 'full' ? 'restore.confirmFull' : 'restore.confirmMeta', { names: originals.map((p) => p.name).join(', ') })}</span>
          </label>
        )}
        {openTargets.length > 0 && <div className="alert warning">{t('restore.closeFirst')}</div>}
        {file.kind === 'full' && <p className="small muted">{t('restore.loginNote')}</p>}
        {busy && <div className="small" role="status">{t('restore.working')}</div>}
        {error && <div className="alert error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={`button ${target === 'original' ? 'danger' : 'primary'}`} disabled={!canSubmit}>
            {target === 'original' ? t('restore.doOriginal') : t('restore.doNew')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Choice for "Back up" on selected profiles: metadata file or encrypted full backup. */
export function BackupChoiceDialog({
  count,
  onMetadata,
  onFull,
  onClose
}: {
  count: number
  onMetadata: () => void
  onFull: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <Modal title={t('bchoice.title', { count })} onClose={onClose} width={520}>
      <div className="choice-buttons">
        <button type="button" className="choice-button" onClick={onMetadata}>
          <strong>{t('bchoice.metadata')}</strong>
          <small>{t('bchoice.metadataHint')}</small>
        </button>
        <button type="button" className="choice-button" onClick={onFull}>
          <strong>{t('bchoice.full')}</strong>
          <small>{t('bchoice.fullHint')}</small>
        </button>
      </div>
    </Modal>
  )
}
