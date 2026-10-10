import { useEffect, useState, type FormEvent } from 'react'
import { SEARCH_ENGINES, type AppInfo, type SearchEngineId } from '@shared/types'
import { LIMITS } from '@shared/validation'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import type { AppData } from '../useAppData'

export function SettingsPage({ data }: { data: AppData }) {
  const s = data.settings!
  const [homepage, setHomepage] = useState(s.homepage)
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>(s.searchEngine)
  const [maxOpen, setMaxOpen] = useState(String(s.maxOpenProfiles))
  const [confirmDelete, setConfirmDelete] = useState(s.confirmBeforeDelete)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    unwrap(window.pob.appInfo())
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

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
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Application Settings</h1>
          <p className="subtitle">Defaults used by every profile window.</p>
        </div>
      </header>

      <form className="form panel" onSubmit={save} noValidate>
        <label className="field">
          <span>Homepage</span>
          <input value={homepage} onChange={(e) => setHomepage(e.target.value)} maxLength={LIMITS.urlMax} />
          <small className="muted">Opened when a profile has no start page of its own.</small>
        </label>
        <label className="field">
          <span>Search engine for the address bar</span>
          <select value={searchEngine} onChange={(e) => setSearchEngine(e.target.value as SearchEngineId)}>
            {(Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => (
              <option key={id} value={id}>
                {SEARCH_ENGINES[id].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Profile windows open at the same time</span>
          <input
            type="number"
            min={1}
            max={LIMITS.maxOpenProfilesCeiling}
            value={maxOpen}
            onChange={(e) => setMaxOpen(e.target.value)}
          />
          <small className="muted">
            Starts at 2. Each window is a full browser session and uses memory — raise this
            gradually (max {LIMITS.maxOpenProfilesCeiling}).
          </small>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={confirmDelete} onChange={(e) => setConfirmDelete(e.target.checked)} />
          <span>Ask for confirmation before deleting a profile</span>
        </label>
        {error && <div className="alert error">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>

      {info && (
        <div className="panel about">
          <h2>About</h2>
          <dl>
            <dt>Version</dt>
            <dd>{info.version}</dd>
            <dt>Electron / Chromium</dt>
            <dd>
              {info.electron} / {info.chrome}
            </dd>
            <dt>Password protection</dt>
            <dd>
              {info.secureStorageAvailable ? (
                'Encrypted by the operating system'
              ) : (
                <span className="warn">OS encryption unavailable — passwords are only encoded</span>
              )}
            </dd>
            <dt>Data folder</dt>
            <dd className="path">{info.userDataPath}</dd>
          </dl>
          <button
            type="button"
            className="button small"
            onClick={() =>
              void unwrap(window.pob.openDataFolder()).catch((e) => data.notify('error', errorMessage(e)))
            }
          >
            <Icon name="folder" size={16} /> Open data folder
          </button>
        </div>
      )}
    </section>
  )
}
