import { useCallback, useState } from 'react'
import { Icon, type IconName } from '../common/Icon'
import { I18nProvider, useI18n } from './i18n'
import { BackupPage } from './pages/BackupPage'
import { DashboardPage } from './pages/DashboardPage'
import { GroupsTagsPage } from './pages/GroupsTagsPage'
import { ProfilesPage } from './pages/ProfilesPage'
import { ProxyPage } from './pages/ProxyPage'
import { SettingsPage } from './pages/SettingsPage'
import { TemplatesPage } from './pages/TemplatesPage'
import type { TKey } from './strings'
import { useAppData, type AppData } from './useAppData'

export type PageId = 'dashboard' | 'profiles' | 'groups' | 'templates' | 'proxy' | 'backup' | 'settings'

const NAV: { id: PageId; label: TKey; icon: IconName }[] = [
  { id: 'dashboard', label: 'nav.dashboard', icon: 'dashboard' },
  { id: 'profiles', label: 'nav.profiles', icon: 'profiles' },
  { id: 'groups', label: 'nav.groups', icon: 'tag' },
  { id: 'templates', label: 'nav.templates', icon: 'template' },
  { id: 'proxy', label: 'nav.proxies', icon: 'proxy' },
  { id: 'backup', label: 'nav.backup', icon: 'backup' },
  { id: 'settings', label: 'nav.settings', icon: 'settings' }
]

export function App() {
  const data = useAppData()
  return (
    <I18nProvider language={data.settings?.language ?? 'en'}>
      <Shell data={data} />
    </I18nProvider>
  )
}

function Shell({ data }: { data: AppData }) {
  const { t, language } = useI18n()
  const [page, setPage] = useState<PageId>('dashboard')
  const [createRequested, setCreateRequested] = useState(false)
  /** '' opens the wizard without a template; null means no request. */
  const [wizardTemplate, setWizardTemplate] = useState<string | null>(null)

  const goCreate = useCallback((): void => {
    setPage('profiles')
    setCreateRequested(true)
  }, [])
  const handleCreate = useCallback(() => setCreateRequested(false), [])
  const handleWizard = useCallback(() => setWizardTemplate(null), [])

  return (
    <div className="app-shell" data-testid="app-shell" lang={language}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <span className="brand-name">{t('app.name')}</span>
        </div>
        <nav aria-label={t('nav.main')}>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => setPage(item.id)}
              data-nav={item.id}
            >
              <Icon name={item.icon} />
              <span>{t(item.label)}</span>
              {item.id === 'profiles' && <span className="nav-count">{data.profiles.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`live-dot ${data.runningCount ? 'on' : ''}`} aria-hidden="true" />
          {t('app.windowsOpen', { open: data.runningCount, max: data.settings?.maxOpenProfiles ?? '–' })}
        </div>
      </aside>

      <main className="content">
        {data.loading ? (
          <div className="empty">{t('app.loading')}</div>
        ) : data.loadError ? (
          <div className="alert error">
            {t('app.loadError', { error: data.loadError })}
            <button type="button" className="button" onClick={() => void data.refresh()}>
              {t('common.retry')}
            </button>
          </div>
        ) : (
          <>
            {page === 'dashboard' && <DashboardPage data={data} onCreate={goCreate} onNavigate={setPage} />}
            {page === 'profiles' && (
              <ProfilesPage
                data={data}
                createRequested={createRequested}
                onCreateHandled={handleCreate}
                wizardTemplateId={wizardTemplate}
                onWizardHandled={handleWizard}
              />
            )}
            {page === 'groups' && <GroupsTagsPage data={data} />}
            {page === 'templates' && (
              <TemplatesPage
                data={data}
                onUseTemplate={(id) => {
                  setWizardTemplate(id)
                  setPage('profiles')
                }}
              />
            )}
            {page === 'proxy' && <ProxyPage data={data} />}
            {page === 'backup' && <BackupPage data={data} />}
            {page === 'settings' && <SettingsPage data={data} />}
          </>
        )}
      </main>

      <div className="toasts" aria-live="polite">
        {data.toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  )
}
