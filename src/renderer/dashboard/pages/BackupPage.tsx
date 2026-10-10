import { useState } from 'react'
import type { BackupImportResult } from '@shared/types'
import { errorMessage, unwrap } from '../../common/ipc'
import type { AppData } from '../useAppData'

export function BackupPage({ data }: { data: AppData }) {
  const [busy, setBusy] = useState(false)
  const [lastImport, setLastImport] = useState<BackupImportResult | null>(null)

  const exportBackup = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await unwrap(window.pob.exportBackup())
      if (result.saved) data.notify('success', `Saved ${result.profileCount} profile(s) to backup`)
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
        data.notify('success', `Restored ${result.imported} profile(s)`)
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
          <h1>Backup &amp; Restore</h1>
          <p className="subtitle">Save your profile list and settings to a file, or restore them.</p>
        </div>
      </header>

      <div className="panel-grid">
        <div className="panel">
          <h2>Export backup</h2>
          <p>
            Saves {data.profiles.length} profile(s) — names, notes, colors, start pages and proxy
            addresses — plus application settings to a <code>.json</code> file.
          </p>
          <button type="button" className="button primary" disabled={busy} onClick={() => void exportBackup()}>
            Export to file…
          </button>
        </div>
        <div className="panel">
          <h2>Restore from backup</h2>
          <p>
            Adds the profiles from a backup file. Existing profiles are kept; duplicate names get a
            number added. Settings from the backup are applied.
          </p>
          <button type="button" className="button" disabled={busy} onClick={() => void importBackup()}>
            Choose backup file…
          </button>
          {lastImport && (
            <div className="alert info">
              Imported {lastImport.imported}, skipped {lastImport.skipped}.
              {lastImport.renamed.length > 0 && (
                <ul>
                  {lastImport.renamed.map((r) => (
                    <li key={r}>Renamed: {r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="info-box">
        <strong>Not included in backups:</strong> proxy passwords, cookies, saved logins and other
        browsing data. Restored profiles start with a fresh, empty session, and any proxy passwords
        must be entered again on the Proxy Settings page.
      </div>
    </section>
  )
}
