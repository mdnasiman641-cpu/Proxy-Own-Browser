import type { ProxyTestResult } from '@shared/types'
import { useI18n } from '../i18n'

export function ProxyTestResultView({ result }: { result: ProxyTestResult }) {
  const { t, locale } = useI18n()
  return (
    <div className={`proxy-result ${result.ok ? 'ok' : 'fail'}`} role="status" data-testid="proxy-test-result">
      <div className="proxy-result-head">
        <span className={`pill ${result.ok ? 'green' : 'red'}`}>{result.ok ? t('proxyResult.working') : t('proxyResult.failed')}</span>
        <span>{result.message}</span>
      </div>
      <dl className="proxy-result-details">
        <dt>{t('proxyResult.route')}</dt>
        <dd>{result.route}</dd>
        {result.ip && (
          <>
            <dt>{t('proxyResult.ip')}</dt>
            <dd className="mono">{result.ip}</dd>
          </>
        )}
        {result.responseTimeMs !== null && (
          <>
            <dt>{t('proxyResult.time')}</dt>
            <dd>{t('proxyResult.ms', { ms: result.responseTimeMs })}</dd>
          </>
        )}
        {result.endpoint && (
          <>
            <dt>{t('proxyResult.checkedWith')}</dt>
            <dd>{result.endpoint}</dd>
          </>
        )}
        <dt>{t('proxyResult.tested')}</dt>
        <dd>{new Date(result.testedAt).toLocaleTimeString(locale)}</dd>
      </dl>
    </div>
  )
}
