import { useState } from 'react'
import { Icon, type IconName } from '../common/Icon'
import { BackupPage } from './pages/BackupPage'
import { DashboardPage } from './pages/DashboardPage'
import { ProfilesPage } from './pages/ProfilesPage'
import { ProxyPage } from './pages/ProxyPage'
import { SettingsPage } from './pages/SettingsPage'
import { useAppData } from './useAppData'

export type PageId = 'dashboard' | 'profiles' | 'proxy' | 'backup' | 'settings'

const NAV: { id: PageId; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'profiles', label: 'All Profiles', icon: 'profiles' },
  { id: 'proxy', label: 'Proxy Settings', icon: 'proxy' },
  { id: 'backup', label: 'Backup & Restore', icon: 'backup' },
  { id: 'settings', label: 'Application Settings', icon: 'settings' }
]

export function App() {
  const data = useAppData()
  const [page, setPage] = useState<PageId>('dashboard')
  const [createRequested, setCreateRequested] = useState(false)

  const goCreate = (): void => {
    setPage('profiles')
    setCreateRequested(true)
  }

  return (
    <div className="app-shell" data-testid="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <span className="brand-name">Proxy Own Browser</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => setPage(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === 'profiles' && <span className="nav-count">{data.profiles.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          {data.openIds.length} of {data.settings?.maxOpenProfiles ?? '–'} windows open
        </div>
      </aside>

      <main className="content">
        {data.loading ? (
          <div className="empty">Loading…</div>
        ) : data.loadError ? (
          <div className="alert error">
            Could not load data: {data.loadError}
            <button type="button" className="button" onClick={() => void data.refresh()}>
              Retry
            </button>
          </div>
        ) : (
          <>
            {page === 'dashboard' && <DashboardPage data={data} onCreate={goCreate} onNavigate={setPage} />}
            {page === 'profiles' && (
              <ProfilesPage
                data={data}
                createRequested={createRequested}
                onCreateHandled={() => setCreateRequested(false)}
              />
            )}
            {page === 'proxy' && <ProxyPage data={data} />}
            {page === 'backup' && <BackupPage data={data} />}
            {page === 'settings' && <SettingsPage data={data} />}
          </>
        )}
      </main>

      <div className="toasts" aria-live="polite">
        {data.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
