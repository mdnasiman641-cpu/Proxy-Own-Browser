import { describeProxy } from '@shared/proxy'
import type { Profile, ProfileNetworkStatus } from '@shared/types'
import { Icon } from '../../common/Icon'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'

/** Compact proxy/IP line for the profile list. Shows nothing until the profile was checked. */
export function NetworkBadge({ status }: { status: ProfileNetworkStatus | undefined }) {
  const { t } = useI18n()
  if (!status) return null
  if (!status.current) {
    return <div className="net-line muted small">{t('net.outOfDate')}</div>
  }
  if (!status.proxy.ok) {
    return (
      <div className="net-line small net-failed" title={status.proxy.message}>
        <Icon name="warning" size={14} /> {t('net.proxyFailedShort')}
      </div>
    )
  }
  const place = status.geo.data?.countryCode ?? (status.geo.status === 'failed' ? '?' : '')
  return (
    <div className="net-line small" title={status.geo.message || status.proxy.message}>
      <Icon name="globe" size={14} /> <span className="mono">{status.ip}</span>
      {place && <span className="muted"> · {place}</span>}
      {status.sameExitIpAs.length > 0 && (
        <span className="warn" title={t('net.sameIpTitle', { names: status.sameExitIpAs.map((p) => p.name).join(', ') })}>
          {' '}
          <Icon name="warning" size={14} />
        </span>
      )}
    </div>
  )
}

interface PanelProps {
  profile: Profile
  status: ProfileNetworkStatus | undefined
  checking: boolean
  onCheck: () => void
  geoEnabled: boolean
}

/**
 * Proxy connectivity and public-IP location, shown separately: a working proxy does not imply
 * a successful location lookup. Missing values are shown as unknown, never guessed.
 */
export function NetworkPanel({ profile, status, checking, onCheck, geoEnabled }: PanelProps) {
  const { t, formatDate } = useI18n()
  const unknown = <span className="muted">{t('net.unknown')}</span>
  const geo = status?.geo.data ?? null

  const proxyState = !status ? 'none' : status.proxy.ok ? 'ok' : 'failed'
  const geoState = !status ? 'none' : status.geo.status === 'success' ? 'ok' : status.geo.status === 'failed' ? 'failed' : 'skipped'

  return (
    <div className="panel" data-testid="network-panel">
      <div className="panel-head">
        <h2>{t('details.network')}</h2>
        <button type="button" className="button small primary" onClick={onCheck} disabled={checking}>
          <Icon name="reload" size={16} /> {checking ? t('net.checking') : t('net.checkNow')}
        </button>
      </div>
      {status && !status.current && <div className="alert info">{t('net.staleNotice')}</div>}
      {status && status.sameExitIpAs.length > 0 && (
        <div className="alert warning" role="status">
          {t('net.sameIp', { names: status.sameExitIpAs.map((p) => p.name).join(', ') })}
        </div>
      )}
      <div className="status-grid">
        <section className={`status-card state-${proxyState}`}>
          <h3>{t('net.proxyConnection')}</h3>
          <p className="status-line">
            <span className="status-pill">{t(`net.state.${proxyState}` as TKey)}</span>
            {status?.proxy.responseTimeMs != null && <span className="muted"> {t('net.ms', { ms: status.proxy.responseTimeMs })}</span>}
          </p>
          <dl className="kv">
            <dt>{t('net.assigned')}</dt>
            <dd>{describeProxy(profile.proxy) ?? t('common.directConnection')}</dd>
            <dt>{t('net.publicIp')}</dt>
            <dd className="mono">{status?.ip ?? unknown}</dd>
            <dt>{t('net.checkedAt')}</dt>
            <dd>{status ? formatDate(status.checkedAt) : t('net.never')}</dd>
          </dl>
          {status && !status.proxy.ok && <p className="small">{status.proxy.message}</p>}
        </section>
        <section className={`status-card state-${geoState}`}>
          <h3>{t('net.ipVerification')}</h3>
          <p className="status-line">
            <span className="status-pill">{t(`net.state.${geoState}` as TKey)}</span>
          </p>
          <dl className="kv">
            <dt>{t('net.country')}</dt>
            <dd>{geo?.country ? `${geo.country}${geo.countryCode ? ` (${geo.countryCode})` : ''}` : unknown}</dd>
            <dt>{t('net.region')}</dt>
            <dd>{geo?.region ?? unknown}</dd>
            <dt>{t('net.city')}</dt>
            <dd>{geo?.city ?? unknown}</dd>
            <dt>{t('net.coordinates')}</dt>
            <dd>{geo && geo.latitude !== null && geo.longitude !== null ? t('net.approx', { lat: geo.latitude.toFixed(2), lon: geo.longitude.toFixed(2) }) : unknown}</dd>
            <dt>{t('net.detectedTz')}</dt>
            <dd>{geo?.timezone ?? unknown}</dd>
            <dt>{t('net.provider')}</dt>
            <dd>{geo?.provider ?? unknown}</dd>
          </dl>
          {status?.geo.message && <p className="small">{status.geo.message}</p>}
          {!geoEnabled && <p className="small muted">{t('net.geoOff')}</p>}
        </section>
      </div>
      {status?.lastValidTimezone && (
        <p className="small">
          {t('net.lastValid', { tz: status.lastValidTimezone, date: formatDate(status.lastValidTimezoneAt) })}{' '}
          {!status.lastValidTimezoneCurrent && <strong>{t('net.lastValidOtherProxy')}</strong>}
        </p>
      )}
      <details className="disclosure">
        <summary>{t('net.disclosureTitle')}</summary>
        <p className="small">{t('net.disclosure')}</p>
        <p className="small">{t('net.anonymity')}</p>
      </details>
    </div>
  )
}
