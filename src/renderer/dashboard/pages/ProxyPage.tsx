import { Fragment, useState } from 'react'
import { describeProxy } from '@shared/proxy'
import type { Profile, ProxyTestResult } from '@shared/types'
import { errorMessage, unwrap } from '../../common/ipc'
import { Modal } from '../components/Modal'
import { ProfileAvatar } from '../components/ProfileBadge'
import { ProfileForm } from '../components/ProfileForm'
import { ProxyTestResultView } from '../components/ProxyTestResultView'
import { StatusBadge } from '../components/Bits'
import { useI18n } from '../i18n'
import type { AppData } from '../useAppData'

export function ProxyPage({ data }: { data: AppData }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState<Profile | null>(null)
  const [tests, setTests] = useState<
    Record<string, { running: boolean; result?: ProxyTestResult; error?: string; savedAt: string }>
  >({})
  const status = (id: string) => data.statuses[id] ?? 'closed'

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
          <h1>{t('nav.proxies')}</h1>
          <p className="subtitle">{t('proxyPage.subtitle')}</p>
        </div>
      </header>

      <div className="info-box">{t('proxyPage.info')}</div>

      {data.profiles.length === 0 ? (
        <div className="empty">{t('proxyPage.empty')}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('profiles.col.profile')}</th>
                <th>{t('profiles.col.proxy')}</th>
                <th>{t('proxyPage.col.auth')}</th>
                <th>{t('proxyPage.col.bypass')}</th>
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
                      {status(profile.id) !== 'closed' && <StatusBadge status={status(profile.id)} compact />}
                    </div>
                  </td>
                  <td>{describeProxy(profile.proxy) ?? <span className="muted">{t('common.direct')}</span>}</td>
                  <td>
                    {!profile.proxy ? (
                      <span className="muted">—</span>
                    ) : profile.proxy.username ? (
                      profile.proxy.hasPassword ? (
                        t('proxyPage.authSaved')
                      ) : (
                        <span className="warn">{t('profiles.passwordMissing')}</span>
                      )
                    ) : (
                      <span className="muted">{t('common.none')}</span>
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
                        {test?.running ? t('form.testing') : t('proxyPage.test')}
                      </button>
                      <button type="button" className="button small" onClick={() => setEditing(profile)}>
                        {t('proxyPage.configure')}
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
        <Modal title={t('proxyPage.modalTitle', { name: editing.name })} onClose={() => setEditing(null)}>
          <ProfileForm
            initial={editing}
            mode="proxy"
            submitLabel={t('form.saveProxy')}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              const profile = await data.updateProfile(editing.id, input)
              data.notify('success', t('profiles.saved', { name: profile.name }))
              setEditing(null)
            }}
          />
        </Modal>
      )}
    </section>
  )
}
