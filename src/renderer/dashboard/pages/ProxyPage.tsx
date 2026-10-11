import { useState } from 'react'
import { describeProxy } from '@shared/proxy'
import type { Profile } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { StatusBadge } from '../components/Bits'
import { LocalTime } from '../components/LocalTime'
import { ProfileAvatar } from '../components/ProfileBadge'
import { useProfileEditor } from '../components/editor/ProfileEditor'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import type { AppData } from '../useAppData'

const MODE_LABEL: Record<Profile['browser']['timezoneMode'], TKey> = {
  off: 'browser.tz.off',
  auto: 'browser.tz.auto',
  manual: 'browser.tz.manual'
}

/**
 * Proxy, public IP and location of every profile at a glance. Each row shows only that profile's
 * own stored result; "Refresh IP & location" checks through that profile's proxy again.
 */
export function ProxyPage({ data, onOpenDetails }: { data: AppData; onOpenDetails: (id: string) => void }) {
  const { t, formatDate } = useI18n()
  const { openEditor } = useProfileEditor()
  const [checking, setChecking] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [refreshingAll, setRefreshingAll] = useState(false)
  const status = (id: string) => data.statuses[id] ?? 'closed'

  const refresh = async (profile: Profile): Promise<void> => {
    setChecking((s) => new Set(s).add(profile.id))
    setErrors(({ [profile.id]: _old, ...rest }) => rest)
    try {
      await unwrap(window.pob.checkNetwork(profile.id))
      await data.refreshNetwork()
    } catch (e) {
      setErrors((x) => ({ ...x, [profile.id]: errorMessage(e) }))
    } finally {
      setChecking((s) => {
        const next = new Set(s)
        next.delete(profile.id)
        return next
      })
    }
  }

  /** One profile after another, so the location services are not flooded. */
  const refreshAll = async (): Promise<void> => {
    setRefreshingAll(true)
    for (const profile of data.profiles) await refresh(profile)
    setRefreshingAll(false)
  }

  const unknown = <span className="muted">{t('net.unknown')}</span>

  return (
    <section className="page wide" data-testid="proxy-page">
      <header className="page-header">
        <div>
          <h1>{t('nav.proxies')}</h1>
          <p className="subtitle">{t('loc.subtitle')}</p>
        </div>
        <button type="button" className="button" disabled={refreshingAll || data.profiles.length === 0} onClick={() => void refreshAll()}>
          <Icon name="reload" /> {refreshingAll ? t('net.checking') : t('loc.refreshAll')}
        </button>
      </header>

      <div className="info-box small">{t('loc.info')}</div>

      {data.profiles.length === 0 ? (
        <div className="empty">{t('proxyPage.empty')}</div>
      ) : (
        <div className="table-wrap">
          <table className="table location-table">
            <thead>
              <tr>
                <th>{t('profiles.col.profile')}</th>
                <th>{t('loc.col.proxy')}</th>
                <th>{t('loc.col.ip')}</th>
                <th>{t('loc.col.location')}</th>
                <th>{t('loc.col.isp')}</th>
                <th>{t('loc.col.timezone')}</th>
                <th>{t('loc.col.checked')}</th>
                <th className="actions-col" />
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((profile) => {
                const net = data.network[profile.id]
                const geo = net?.geo.data ?? null
                const running = status(profile.id) !== 'closed'
                const reported = running ? data.reportedTimezones[profile.id] : undefined
                const state = !net ? 'none' : net.proxy.ok ? 'ok' : 'failed'
                // Only a result made for the profile's current proxy is shown as detected.
                const detectedTz = net?.current ? (geo?.timezone ?? null) : null
                return (
                  <tr key={profile.id} data-testid={`location-row-${profile.id}`}>
                    <td>
                      <div className="profile-cell">
                        <ProfileAvatar profile={profile} size={28} />
                        <div className="profile-text">
                          <button type="button" className="profile-name link-button" onClick={() => onOpenDetails(profile.id)}>
                            {profile.name}
                          </button>
                          {running && <StatusBadge status={status(profile.id)} />}
                        </div>
                      </div>
                    </td>
                    <td className="small">
                      <div>{describeProxy(profile.proxy) ?? <span className="muted">{t('common.direct')}</span>}</div>
                      <span className={`status-pill state-pill-${state}`} title={net?.proxy.message}>
                        {t(`net.state.${state}` as TKey)}
                      </span>
                      {net?.proxy.responseTimeMs != null && <span className="muted"> {t('net.ms', { ms: net.proxy.responseTimeMs })}</span>}
                      {net && !net.current && <div className="muted">{t('net.outOfDate')}</div>}
                      {net && !net.proxy.ok && net.lastSuccessAt && (
                        <div className="muted">{t('loc.lastSuccess', { date: formatDate(net.lastSuccessAt) })}</div>
                      )}
                    </td>
                    <td className="small">
                      <div className="mono" data-testid="row-ip">{net?.ip ?? unknown}</div>
                      {net?.previousIp && (
                        <div className="muted" title={formatDate(net.ipChangedAt)}>
                          {t('loc.was', { ip: net.previousIp })}
                        </div>
                      )}
                      {net && net.sameExitIpAs.length > 0 && (
                        <div className="warn" title={t('net.sameIpTitle', { names: net.sameExitIpAs.map((p) => p.name).join(', ') })}>
                          <Icon name="warning" size={14} /> {t('loc.sharedIp')}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {geo ? (
                        <>
                          <div>
                            {geo.country ?? t('net.unknown')}
                            {geo.countryCode && ` (${geo.countryCode})`}
                            {geo.region && `, ${geo.region}`}
                          </div>
                          <div className={geo.city ? '' : 'muted'}>{geo.city ?? t('loc.cityUnknown')}</div>
                        </>
                      ) : net?.geo.status === 'failed' ? (
                        <span className="warn" title={net.geo.message}>
                          {t('loc.lookupFailed')}
                        </span>
                      ) : (
                        unknown
                      )}
                    </td>
                    <td className="small">{geo?.isp ?? geo?.org ?? unknown}</td>
                    <td className="small">
                      <div data-testid="row-tz">{detectedTz ?? unknown}</div>
                      <div>
                        <LocalTime timeZone={detectedTz} />
                      </div>
                      <div className="muted">
                        {t(MODE_LABEL[profile.browser.timezoneMode])}
                        {profile.browser.timezoneMode === 'manual' && profile.browser.timezoneManual && `: ${profile.browser.timezoneManual}`}
                      </div>
                      {reported && !reported.matches && (
                        <div className="warn">{t('loc.reportedBad', { tz: reported.reported })}</div>
                      )}
                    </td>
                    <td className="small nowrap">
                      {net?.geoCheckedAt ? formatDate(net.geoCheckedAt) : t('net.never')}
                      {net && <div className="muted">{t('loc.ipChecked', { date: formatDate(net.checkedAt) })}</div>}
                    </td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button small primary"
                          disabled={checking.has(profile.id)}
                          onClick={() => void refresh(profile)}
                          data-testid={`refresh-location-${profile.id}`}
                          title={t('net.refresh')}
                          aria-label={`${t('net.refresh')}: ${profile.name}`}
                        >
                          <Icon name="reload" size={16} /> <span className="btn-text">{checking.has(profile.id) ? t('net.checking') : t('loc.refresh')}</span>
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title={t('proxyPage.configure')}
                          aria-label={`${t('proxyPage.configure')}: ${profile.name}`}
                          onClick={() => openEditor(profile.id, 'proxy')}
                        >
                          <Icon name="edit" />
                        </button>
                      </div>
                      {errors[profile.id] && <div className="warn small">{errors[profile.id]}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

    </section>
  )
}
