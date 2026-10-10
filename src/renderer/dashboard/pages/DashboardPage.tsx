import { describeProxy } from '@shared/proxy'
import { Icon } from '../../common/Icon'
import type { PageId } from '../App'
import { ProfileAvatar, formatDate } from '../components/ProfileBadge'
import type { AppData } from '../useAppData'

interface Props {
  data: AppData
  onCreate: () => void
  onNavigate: (page: PageId) => void
}

export function DashboardPage({ data, onCreate, onNavigate }: Props) {
  const withProxy = data.profiles.filter((p) => p.proxy).length
  const openSet = new Set(data.openIds)
  const recent = [...data.profiles]
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt))
    .slice(0, 6)

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="subtitle">Open a profile to browse with its own session and proxy.</p>
        </div>
        <button type="button" className="button primary" onClick={onCreate}>
          <Icon name="plus" /> New profile
        </button>
      </header>

      <div className="stats">
        <button type="button" className="stat" onClick={() => onNavigate('profiles')}>
          <span className="stat-value">{data.profiles.length}</span>
          <span className="stat-label">Saved profiles</span>
        </button>
        <button type="button" className="stat" onClick={() => onNavigate('proxy')}>
          <span className="stat-value">{withProxy}</span>
          <span className="stat-label">Using a proxy</span>
        </button>
        <div className="stat">
          <span className="stat-value">
            {data.openIds.length}
            <span className="stat-of"> / {data.settings?.maxOpenProfiles ?? '–'}</span>
          </span>
          <span className="stat-label">Windows open</span>
        </div>
      </div>

      <h2 className="section-title">Recent profiles</h2>
      {recent.length === 0 ? (
        <div className="empty">
          <p>Create a profile to get started. Each profile keeps its own logins after restarting.</p>
          <button type="button" className="button primary" onClick={onCreate}>
            Create profile
          </button>
        </div>
      ) : (
        <div className="cards">
          {recent.map((profile) => (
            <div key={profile.id} className="card">
              <div className="card-top">
                <ProfileAvatar profile={profile} size={40} />
                <div className="card-title">
                  <strong>{profile.name}</strong>
                  <span className="muted small">
                    {describeProxy(profile.proxy) ?? 'Direct connection'}
                  </span>
                </div>
                {openSet.has(profile.id) && <span className="pill green">Open</span>}
              </div>
              <div className="card-bottom">
                <span className="muted small">Last opened: {formatDate(profile.lastOpenedAt)}</span>
                <button
                  type="button"
                  className="button primary small"
                  onClick={() => void data.openProfile(profile)}
                >
                  {openSet.has(profile.id) ? 'Focus' : 'Open'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
