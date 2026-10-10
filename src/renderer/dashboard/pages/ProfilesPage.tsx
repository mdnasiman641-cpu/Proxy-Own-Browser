import { useEffect, useMemo, useState } from 'react'
import { describeProxy } from '@shared/proxy'
import type { Profile, ProfileInput } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { ConfirmDialog, Modal } from '../components/Modal'
import { ProfileAvatar, formatDate } from '../components/ProfileBadge'
import { ProfileForm } from '../components/ProfileForm'
import type { AppData } from '../useAppData'

interface Props {
  data: AppData
  createRequested: boolean
  onCreateHandled: () => void
}

export function ProfilesPage({ data, createRequested, onCreateHandled }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Profile[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [deleting, setDeleting] = useState<Profile | null>(null)
  const [clearData, setClearData] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (createRequested) {
      setCreating(true)
      onCreateHandled()
    }
  }, [createRequested, onCreateHandled])

  // Server-side search (name, notes, proxy host), debounced. Re-runs when profiles change.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearchError(null)
      return
    }
    const timer = setTimeout(() => {
      unwrap(window.pob.listProfiles(q))
        .then((list) => {
          setResults(list)
          setSearchError(null)
        })
        .catch((e) => setSearchError(errorMessage(e)))
    }, 150)
    return () => clearTimeout(timer)
  }, [query, data.profiles])

  const visible = results ?? data.profiles
  const openSet = useMemo(() => new Set(data.openIds), [data.openIds])

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    setBusy(true)
    try {
      await data.deleteProfile(deleting, clearData)
      setDeleting(null)
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const askDelete = (profile: Profile): void => {
    if (data.settings?.confirmBeforeDelete === false) {
      void data.deleteProfile(profile, true).catch((e) => data.notify('error', errorMessage(e)))
      return
    }
    setClearData(true)
    setDeleting(profile)
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>All Profiles</h1>
          <p className="subtitle">Each profile has its own cookies, storage and proxy.</p>
        </div>
        <button type="button" className="button primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New profile
        </button>
      </header>

      <div className="search-box">
        <Icon name="search" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, notes or proxy host"
          aria-label="Search profiles"
          maxLength={200}
        />
      </div>
      {searchError && <div className="alert error">{searchError}</div>}

      {visible.length === 0 ? (
        <div className="empty">
          {query.trim() ? (
            'No profiles match your search.'
          ) : (
            <>
              <p>No profiles yet.</p>
              <button type="button" className="button primary" onClick={() => setCreating(true)}>
                Create your first profile
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Proxy</th>
                <th>Last opened</th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((profile) => {
                const isOpen = openSet.has(profile.id)
                return (
                  <tr key={profile.id}>
                    <td>
                      <div className="profile-cell">
                        <ProfileAvatar profile={profile} />
                        <div>
                          <div className="profile-name">
                            {profile.name}
                            {isOpen && <span className="pill green">Open</span>}
                          </div>
                          {profile.notes && <div className="muted small">{profile.notes}</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      {describeProxy(profile.proxy) ?? <span className="muted">Direct</span>}
                      {profile.proxy?.username && !profile.proxy.hasPassword && (
                        <div className="warn small">Password not set</div>
                      )}
                    </td>
                    <td className="muted nowrap">{formatDate(profile.lastOpenedAt)}</td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button primary small"
                          onClick={() => void data.openProfile(profile)}
                        >
                          <Icon name="open" size={16} /> {isOpen ? 'Focus' : 'Open'}
                        </button>
                        {isOpen && (
                          <button
                            type="button"
                            className="button small"
                            onClick={() => void data.closeProfile(profile)}
                          >
                            Close
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-button"
                          title="Edit"
                          aria-label={`Edit ${profile.name}`}
                          onClick={() => setEditing(profile)}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          type="button"
                          className="icon-button danger"
                          title={isOpen ? 'Close the window before deleting' : 'Delete'}
                          aria-label={`Delete ${profile.name}`}
                          disabled={isOpen}
                          onClick={() => askDelete(profile)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <Modal title="New profile" onClose={() => setCreating(false)}>
          <ProfileForm
            submitLabel="Create profile"
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              await data.createProfile(input as ProfileInput)
              setCreating(false)
            }}
          />
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ProfileForm
            initial={editing}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              await data.updateProfile(editing.id, input)
              setEditing(null)
            }}
          />
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete profile?"
          message={
            <>
              <strong>{deleting.name}</strong> will be removed from the list. This cannot be undone.
            </>
          }
          confirmLabel="Delete profile"
          danger
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <label className="toggle">
            <input
              type="checkbox"
              checked={clearData}
              onChange={(e) => setClearData(e.target.checked)}
            />
            <span>Also delete its cookies, logins and browsing data</span>
          </label>
        </ConfirmDialog>
      )}
    </section>
  )
}
