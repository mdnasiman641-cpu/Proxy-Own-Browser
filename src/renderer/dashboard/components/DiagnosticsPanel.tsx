import { useState, type ReactNode } from 'react'
import type { DiagnosticCheck, DiagnosticVerdict, ProfileDiagnostics } from '@shared/diagnostics'
import type { Profile } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import { ConfirmDialog } from './Modal'

interface Props {
  profile: Profile
  running: boolean
  /** Saves `disable_non_proxied_udp` after the user confirmed it. */
  onRestrictWebRtc: () => Promise<void>
}

/**
 * Diagnostics for one profile. Sections are kept apart: proxy connection, public IP, DNS,
 * what the profile's pages report, and WebRTC. Each row states the test result, the expected
 * value and a verdict; untested things are shown as unknown.
 */
export function DiagnosticsPanel({ profile, running, onRestrictWebRtc }: Props) {
  const { t, formatDate } = useI18n()
  const [report, setReport] = useState<ProfileDiagnostics | null>(null)
  const [busy, setBusy] = useState<'basic' | 'stun' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmStun, setConfirmStun] = useState(false)
  const [confirmPolicy, setConfirmPolicy] = useState(false)

  const run = async (stun: boolean): Promise<void> => {
    setBusy(stun ? 'stun' : 'basic')
    setError(null)
    try {
      setReport(await unwrap(window.pob.runDiagnostics(profile.id, { stun })))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const webrtcProblem =
    report && (report.webrtcLocal.verdict === 'fail' || report.webrtcStun?.verdict === 'fail') && profile.browser.webrtcPolicy !== 'disable_non_proxied_udp'

  return (
    <div className="panel" data-testid="diagnostics-panel">
      <div className="panel-head">
        <h2>{t('diag.title')}</h2>
        <div className="button-row">
          <button type="button" className="button small primary" disabled={busy !== null} onClick={() => void run(false)} data-testid="run-diagnostics">
            <Icon name="reload" size={16} /> {busy === 'basic' ? t('diag.running') : t('diag.run')}
          </button>
          <button type="button" className="button small" disabled={busy !== null || !running} title={running ? undefined : t('diag.openFirst')} onClick={() => setConfirmStun(true)}>
            {busy === 'stun' ? t('diag.running') : t('diag.runStun')}
          </button>
        </div>
      </div>
      <p className="small muted">{t('diag.intro')}</p>
      {!running && <div className="alert info small">{t('diag.openFirst')}</div>}
      {error && <div className="alert error small">{error}</div>}

      {report && (
        <>
          <p className="small muted">
            {t('diag.ranAt', { date: formatDate(report.ranAt) })}
            {report.pageUrl && <> · {t('diag.testedPage', { url: report.pageUrl })}</>}
          </p>
          {report.pageProblem && <div className="alert warning small">{report.pageProblem}</div>}

          <DiagSection title={t('diag.sec.connection')}>
            <DiagRow label={t('diag.proxyConnection')} check={report.proxyConnection} />
            <DiagRow label={t('diag.proxyRoute')} check={report.proxyRoute} />
            <DiagRow label={t('diag.publicIp')} check={report.publicIp} testId="diag-public-ip" />
          </DiagSection>

          <DiagSection title={t('diag.sec.dns')}>
            <DiagRow label={t('diag.dns')} check={report.dns} testId="diag-dns" />
          </DiagSection>

          <DiagSection title={t('diag.sec.page')}>
            <DiagRow label={t('diag.timezone')} check={report.timezone} testId="diag-timezone" />
            <DiagRow label={t('diag.language')} check={report.language} testId="diag-language" />
            <DiagRow label={t('diag.userAgent')} check={report.userAgent} mono testId="diag-ua" />
            <DiagRow label={t('diag.partition')} check={report.partition} mono testId="diag-partition" />
          </DiagSection>

          <DiagSection title={t('diag.sec.webrtc')}>
            <p className="small muted">
              {t('diag.policy', { policy: t(`webrtc.${report.webrtcPolicy}` as TKey) })}
            </p>
            <DiagRow label={t('diag.webrtcLocal')} check={report.webrtcLocal} testId="diag-webrtc" />
            {report.webrtcStun ? (
              <DiagRow label={t('diag.webrtcStun', { server: report.webrtcStun.server })} check={report.webrtcStun} testId="diag-stun" />
            ) : (
              <p className="small muted">{t('diag.stunNotRun')}</p>
            )}
            {webrtcProblem && (
              <div className="alert warning small">
                <p>{t('diag.webrtcFix')}</p>
                <button type="button" className="button small" onClick={() => setConfirmPolicy(true)}>
                  {t('diag.webrtcFixButton')}
                </button>
              </div>
            )}
          </DiagSection>
          <p className="small muted">{t('diag.limits')}</p>
        </>
      )}

      {confirmStun && (
        <ConfirmDialog
          title={t('diag.stunTitle')}
          message={<p>{t('diag.stunBody')}</p>}
          confirmLabel={t('diag.runStun')}
          onCancel={() => setConfirmStun(false)}
          onConfirm={() => {
            setConfirmStun(false)
            void run(true)
          }}
        />
      )}
      {confirmPolicy && (
        <ConfirmDialog
          title={t('diag.policyTitle')}
          message={<p>{t('diag.policyBody')}</p>}
          confirmLabel={t('diag.webrtcFixButton')}
          onCancel={() => setConfirmPolicy(false)}
          onConfirm={() => {
            setConfirmPolicy(false)
            onRestrictWebRtc()
              .then(() => setReport(null))
              .catch((e) => setError(errorMessage(e)))
          }}
        />
      )}
    </div>
  )
}

function DiagSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="diag-section">
      <h3 className="sub-heading">{title}</h3>
      <dl className="diag-list">{children}</dl>
    </section>
  )
}

const VERDICT_ICON: Record<DiagnosticVerdict, string> = {
  pass: '✓',
  fail: '✕',
  warning: '!',
  unknown: '?',
  info: 'i',
  'not-tested': '–'
}

function DiagRow({ label, check, mono = false, testId }: { label: string; check: DiagnosticCheck; mono?: boolean; testId?: string }) {
  const { t } = useI18n()
  return (
    <div className={`diag-row verdict-${check.verdict}`} data-testid={testId} data-verdict={check.verdict}>
      <dt>
        <span className="diag-verdict" aria-hidden="true">
          {VERDICT_ICON[check.verdict]}
        </span>
        {label}
      </dt>
      <dd>
        <div>
          <span className="status-pill">{t(`diag.verdict.${check.verdict}` as TKey)}</span>
        </div>
        <div className="small">
          <span className="muted">{t('diag.observed')}: </span>
          <span className={mono ? 'mono break' : ''}>{check.observed ?? t('net.unknown')}</span>
        </div>
        {check.expected !== null && (
          <div className="small">
            <span className="muted">{t('diag.expected')}: </span>
            <span className={mono ? 'mono break' : ''}>{check.expected}</span>
          </div>
        )}
        <div className="small muted">{check.detail}</div>
      </dd>
    </div>
  )
}
