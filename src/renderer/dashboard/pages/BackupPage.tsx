import { useState } from 'react'
import type { BackupImportResult } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { useI18n } from '../i18n'
import type { AppData } from '../useAppData'

export function BackupPage({ data }: { data: AppData }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [lastImport, setLastImport] = useState<BackupImportResult | null>(null)

  const exportBackup = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await unwrap(window.pob.exportBackup())
      if (result.saved) data.notify('success', t('backup.exported', { count: result.profileCount }))
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const importBackup = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await unwrap(window.pob.importBackup())
      if (!result.cancelled) {
        setLastImport(result)
        data.notify('success', t('backup.restored', { count: result.imported }))
        await data.refresh()
      }
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{t('nav.backup')}</h1>
          <p className="subtitle">{t('backup.subtitle')}</p>
        </div>
      </header>

      <div className="panel-grid">
        <div className="panel">
          <h2>{t('backup.exportTitle')}</h2>
          <p>{t('backup.exportBody', { count: data.profiles.length })}</p>
          <button type="button" className="button primary" disabled={busy} onClick={() => void exportBackup()}>
            <Icon name="download" /> {t('backup.exportButton')}
          </button>
        </div>
        <div className="panel">
          <h2>{t('backup.restoreTitle')}</h2>
          <p>{t('backup.restoreBody')}</p>
          <button type="button" className="button" disabled={busy} onClick={() => void importBackup()}>
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
              {lastImport.renamed.length > 0 && (
                <ul>
                  {lastImport.renamed.map((r) => (
                    <li key={r}>{t('backup.renamed', { item: r })}</li>
                  ))}
                </ul>
              )}
              {lastImport.warnings && lastImport.warnings.length > 0 && (
                <>
                  <strong>{t('backup.warnings')}</strong>
                  <ul>
                    {lastImport.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="info-box">
        <strong>{t('backup.notIncludedTitle')}</strong>
        <p>{t('backup.notIncluded')}</p>
      </div>
      <div className="info-box">
        <strong>{t('backup.browserDataTitle')}</strong>
        <p>{t('backup.browserDataBody')}</p>
      </div>
    </section>
  )
}
