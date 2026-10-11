import type { ProfileBackupStatus } from '@shared/types'
import { Icon } from '../../common/Icon'
import { useI18n } from '../i18n'

/**
 * One-line backup state of a profile for lists: newest full browser-data backup, a scheduled
 * one, or a failed last attempt. Settings-only backups are mentioned when there is no full one.
 */
export function BackupStatusLine({ status }: { status: ProfileBackupStatus | undefined }) {
  const { t, formatDate } = useI18n()
  if (!status) return null
  if (status.fullScheduled) {
    return <div className="small muted" data-testid="backup-status">{t('bstat.scheduled')}</div>
  }
  if (status.lastFullFailed) {
    return (
      <div className="small warn" data-testid="backup-status">
        <Icon name="warning" size={14} /> {t('bstat.failed')}
      </div>
    )
  }
  if (status.lastFullAt) {
    return <div className="small muted" data-testid="backup-status">{t('bstat.full', { date: formatDate(status.lastFullAt) })}</div>
  }
  if (status.lastMetadataAt) {
    return <div className="small muted" data-testid="backup-status">{t('bstat.metaOnly', { date: formatDate(status.lastMetadataAt) })}</div>
  }
  return <div className="small muted" data-testid="backup-status">{t('bstat.none')}</div>
}

/** Backup facts for the details page. */
export function BackupStatusFacts({ status }: { status: ProfileBackupStatus | undefined }) {
  const { t, formatDate } = useI18n()
  return (
    <dl className="kv" data-testid="backup-facts">
      <dt>{t('bstat.lastFull')}</dt>
      <dd>
        {status?.lastFullAt ? formatDate(status.lastFullAt) : <span className="muted">{t('net.never')}</span>}
        {status?.lastFullFile && <div className="small mono muted break">{status.lastFullFile}</div>}
      </dd>
      <dt>{t('bstat.lastMeta')}</dt>
      <dd>{status?.lastMetadataAt ? formatDate(status.lastMetadataAt) : <span className="muted">{t('net.never')}</span>}</dd>
      {status?.fullScheduled && (
        <>
          <dt>{t('bstat.pending')}</dt>
          <dd>{t('bstat.scheduled')}</dd>
        </>
      )}
      {status?.lastFullFailed && (
        <>
          <dt>{t('bstat.lastAttempt')}</dt>
          <dd className="warn">{t('bstat.failed')}</dd>
        </>
      )}
    </dl>
  )
}
