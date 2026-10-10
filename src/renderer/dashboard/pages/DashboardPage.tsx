import { describeProxy } from '@shared/proxy'
import { Icon } from '../../common/Icon'
import type { PageId } from '../App'
import { StatusBadge } from '../components/Bits'
import { ProfileAvatar } from '../components/ProfileBadge'
import { useI18n } from '../i18n'
import type { AppData } from '../useAppData'

interface Props {
  data: AppData
  onCreate: () => void
  onNavigate: (page: PageId) => void
}

export function DashboardPage({ data, onCreate, onNavigate }: Props) {
  const { t, formatDate, formatNumber } = useI18n()
  const withProxy = data.profiles.filter((p) => p.proxy).length
  const status = (id: string) => data.statuses[id] ?? 'closed'
  const recent = [...data.profiles]
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt))
    .slice(0, 6)

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{t('nav.dashboard')}</h1>
          <p className="subtitle">{t('dashboard.subtitle')}</p>
        </div>
        <button type="button" className="button primary" onClick={onCreate}>
          <Icon name="plus" /> {t('profiles.new')}
        </button>
      </header>

      <div className="stats four">
        <button type="button" className="stat" onClick={() => onNavigate('profiles')}>
          <span className="stat-value">{formatNumber(data.profiles.length)}</span>
          <span className="stat-label">{t('dashboard.saved')}</span>
        </button>
        <div className="stat">
          <span className="stat-value">
            {formatNumber(data.runningCount)}
            <span className="stat-of"> / {formatNumber(data.settings?.maxOpenProfiles ?? 0)}</span>
          </span>
          <span className="stat-label">{t('dashboard.running')}</span>
        </div>
        <button type="button" className="stat" onClick={() => onNavigate('groups')}>
          <span className="stat-value">{formatNumber(data.groups.length)}</span>
          <span className="stat-label">{t('dashboard.groups')}</span>
        </button>
        <button type="button" className="stat" onClick={() => onNavigate('proxy')}>
          <span className="stat-value">{formatNumber(withProxy)}</span>
          <span className="stat-label">{t('dashboard.withProxy')}</span>
        </button>
      </div>

      <h2 className="section-title">{t('dashboard.recent')}</h2>
      {recent.length === 0 ? (
        <div className="empty">
          <p>{t('dashboard.empty')}</p>
          <button type="button" className="button primary" onClick={onCreate}>
            {t('form.create')}
          </button>
        </div>
      ) : (
        <div className="cards">
          {recent.map((profile) => {
            const running = status(profile.id) !== 'closed'
            return (
              <div key={profile.id} className="card" style={{ ['--spine' as string]: profile.color }}>
                <div className="card-top">
                  <ProfileAvatar profile={profile} size={40} />
                  <div className="card-title">
                    <strong>{profile.name}</strong>
                    <span className="muted small">{describeProxy(profile.proxy) ?? t('common.directConnection')}</span>
                  </div>
                  <StatusBadge status={status(profile.id)} compact />
                </div>
                <div className="card-bottom">
                  <span className="muted small">{t('dashboard.lastOpened', { date: formatDate(profile.lastOpenedAt) })}</span>
                  <button type="button" className="button primary small" onClick={() => void data.openProfile(profile)}>
                    {running ? t('common.focus') : t('common.open')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
