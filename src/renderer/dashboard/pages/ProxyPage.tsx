import { useState } from 'react'
import { describeProxy } from '@shared/proxy'
import type { Profile } from '@shared/types'
import { Modal } from '../components/Modal'
import { ProfileAvatar } from '../components/ProfileBadge'
import { ProfileForm } from '../components/ProfileForm'
import type { AppData } from '../useAppData'

export function ProxyPage({ data }: { data: AppData }) {
  const [editing, setEditing] = useState<Profile | null>(null)
  const openSet = new Set(data.openIds)

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Proxy Settings</h1>
          <p className="subtitle">
            Every profile can use its own HTTP, HTTPS, SOCKS4 or SOCKS5 proxy. Changes apply to
            open windows immediately.
          </p>
        </div>
      </header>

      <div className="info-box">
        Passwords are encrypted with Windows data protection for your user account and are never
        shown again or written to logs. Backups do not include passwords.
      </div>

      {data.profiles.length === 0 ? (
        <div className="empty">Create a profile first, then assign it a proxy here.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Proxy</th>
                <th>Authentication</th>
                <th>Bypass</th>
                <th className="actions-col" />
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    <div className="profile-cell">
                      <ProfileAvatar profile={profile} size={28} />
                      <span>{profile.name}</span>
                      {openSet.has(profile.id) && <span className="pill green">Open</span>}
                    </div>
                  </td>
                  <td>{describeProxy(profile.proxy) ?? <span className="muted">Direct</span>}</td>
                  <td>
                    {!profile.proxy ? (
                      <span className="muted">—</span>
                    ) : profile.proxy.username ? (
                      profile.proxy.hasPassword ? (
                        'Username & password saved'
                      ) : (
                        <span className="warn">Password not set</span>
                      )
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td className="muted">{profile.proxy?.bypassRules || '—'}</td>
                  <td className="actions-col">
                    <button type="button" className="button small" onClick={() => setEditing(profile)}>
                      Configure
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal title={`Proxy for ${editing.name}`} onClose={() => setEditing(null)}>
          <ProfileForm
            initial={editing}
            mode="proxy"
            submitLabel="Save proxy"
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              await data.updateProfile(editing.id, input)
              setEditing(null)
            }}
          />
        </Modal>
      )}
    </section>
  )
}
