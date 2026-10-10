import { Fragment, useState } from 'react'
import { describeProxy } from '@shared/proxy'
import type { Profile, ProxyTestResult } from '@shared/types'
import { errorMessage, unwrap } from '../../common/ipc'
import { Modal } from '../components/Modal'
import { ProfileAvatar } from '../components/ProfileBadge'
import { ProfileForm } from '../components/ProfileForm'
import { ProxyTestResultView } from '../components/ProxyTestResultView'
import type { AppData } from '../useAppData'

export function ProxyPage({ data }: { data: AppData }) {
  const [editing, setEditing] = useState<Profile | null>(null)
  const [tests, setTests] = useState<
    Record<string, { running: boolean; result?: ProxyTestResult; error?: string; savedAt: string }>
  >({})
  const openSet = new Set(data.openIds)

  /** Tests the saved proxy of a profile with a real request. */
  const runTest = async (profile: Profile): Promise<void> => {
    setTests((t) => ({ ...t, [profile.id]: { running: true, savedAt: profile.updatedAt } }))
    try {
      const result = await unwrap(window.pob.testProxy(profile.id))
      setTests((t) => ({ ...t, [profile.id]: { running: false, result, savedAt: profile.updatedAt } }))
    } catch (e) {
      setTests((t) => ({
        ...t,
        [profile.id]: { running: false, error: errorMessage(e), savedAt: profile.updatedAt }
      }))
    }
  }

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
              {data.profiles.map((profile) => {
                // A result is only shown while it still describes the saved settings.
                const test = tests[profile.id]?.savedAt === profile.updatedAt ? tests[profile.id] : undefined
                return (
                <Fragment key={profile.id}>
                <tr>
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
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button small"
                        disabled={test?.running}
                        onClick={() => void runTest(profile)}
                        data-testid={`test-proxy-${profile.id}`}
                      >
                        {test?.running ? 'Testing…' : 'Test'}
                      </button>
                      <button type="button" className="button small" onClick={() => setEditing(profile)}>
                        Configure
                      </button>
                    </div>
                  </td>
                </tr>
                {(test?.result || test?.error) && (
                  <tr className="result-row">
                    <td colSpan={5}>
                      {test.result && <ProxyTestResultView result={test.result} />}
                      {test.error && <div className="alert error">{test.error}</div>}
                    </td>
                  </tr>
                )}
                </Fragment>
                )
              })}
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
