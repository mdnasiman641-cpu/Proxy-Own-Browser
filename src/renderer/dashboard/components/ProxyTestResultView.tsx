import type { ProxyTestResult } from '@shared/types'

export function ProxyTestResultView({ result }: { result: ProxyTestResult }) {
  return (
    <div className={`proxy-result ${result.ok ? 'ok' : 'fail'}`} role="status" data-testid="proxy-test-result">
      <div className="proxy-result-head">
        <span className={`pill ${result.ok ? 'green' : 'red'}`}>{result.ok ? 'Working' : 'Failed'}</span>
        <span>{result.message}</span>
      </div>
      <dl className="proxy-result-details">
        <dt>Route</dt>
        <dd>{result.route}</dd>
        {result.ip && (
          <>
            <dt>Public IP</dt>
            <dd className="mono">{result.ip}</dd>
          </>
        )}
        {result.responseTimeMs !== null && (
          <>
            <dt>Response time</dt>
            <dd>{result.responseTimeMs} ms</dd>
          </>
        )}
        {result.endpoint && (
          <>
            <dt>Checked with</dt>
            <dd>{result.endpoint}</dd>
          </>
        )}
        <dt>Tested</dt>
        <dd>{new Date(result.testedAt).toLocaleTimeString()}</dd>
      </dl>
    </div>
  )
}
