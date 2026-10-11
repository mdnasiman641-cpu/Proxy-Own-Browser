import { useMemo, useState } from 'react'
import { describeProxy } from '@shared/proxy'
import type { BulkCreatePlan, BulkCreateSpec, BulkItemResult } from '@shared/types'
import { LIMITS } from '@shared/validation'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import type { AppData } from '../useAppData'
import { GroupSelect, TagInput, outcomeLabel } from './Bits'
import { Modal } from './Modal'

type Step = 'setup' | 'preview' | 'create'
const STEPS: Step[] = ['setup', 'preview', 'create']
/** Profiles created per IPC call, so progress can be shown between calls. */
const CHUNK = 10

interface Props {
  data: AppData
  initialTemplateId: string | null
  onClose: () => void
}

export function BulkCreateWizard({ data, initialTemplateId, onClose }: Props) {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('setup')
  const [nameTemplate, setNameTemplate] = useState('Profile-{number}')
  const [count, setCount] = useState('10')
  const [startNumber, setStartNumber] = useState('1')
  const [padding, setPadding] = useState(0)
  const [templateId, setTemplateId] = useState<string | null>(initialTemplateId)
  const [groupFromTemplate, setGroupFromTemplate] = useState(true)
  const [groupId, setGroupId] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [startUrl, setStartUrl] = useState('')
  /** 'inherit' (template), 'none', or the id of the profile whose proxy is copied. */
  const [proxyChoice, setProxyChoice] = useState<string>(initialTemplateId ? 'inherit' : 'none')
  /** Explicit confirmation needed when "Require unique proxy assignment" is on. */
  const [allowShared, setAllowShared] = useState(false)
  const [plan, setPlan] = useState<BulkCreatePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<BulkItemResult[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const proxyProfiles = useMemo(() => data.profiles.filter((p) => p.proxy), [data.profiles])
  const usable = data.templates.filter((tpl) => tpl.problems.length === 0)

  const spec = (): BulkCreateSpec => ({
    nameTemplate,
    count: Number(count),
    startNumber: Number(startNumber),
    padding,
    templateId,
    ...(templateId && groupFromTemplate ? {} : { groupId }),
    tags,
    ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}),
    ...(templateId && proxyChoice === 'inherit'
      ? {}
      : { proxySourceProfileId: proxyChoice === 'none' || proxyChoice === 'inherit' ? null : proxyChoice }),
    allowSharedProxy: allowShared
  })
  const sharesProxy = proxyChoice !== 'none' && Boolean(data.settings?.requireUniqueProxy)

  const preview = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setPlan(await unwrap(window.pob.planBulkCreate(spec())))
      setStep('preview')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  /** Creates in chunks; already-created names are never sent again. */
  const create = async (names: string[]): Promise<void> => {
    setStep('create')
    setBusy(true)
    setError(null)
    const done = results.filter((r) => r.ok)
    let next: BulkItemResult[] = [...done]
    setProgress({ done: 0, total: names.length })
    try {
      for (let i = 0; i < names.length; i += CHUNK) {
        const chunk = await unwrap(window.pob.bulkCreate(spec(), names.slice(i, i + CHUNK)))
        next = [...next, ...chunk]
        setResults(next)
        setProgress({ done: Math.min(i + CHUNK, names.length), total: names.length })
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      await data.refresh()
    }
  }

  const failed = results.filter((r) => !r.ok)
  const retryable = failed.filter((r) => r.outcome !== 'exists').map((r) => r.name)
  const created = results.filter((r) => r.ok).length
  const stepIndex = STEPS.indexOf(step)

  return (
    <Modal title={t('wizard.title')} onClose={busy ? () => {} : onClose} width={680}>
      <ol className="steps" aria-label={t('wizard.title')}>
        {STEPS.map((s, i) => (
          <li key={s} className={i === stepIndex ? 'current' : i < stepIndex ? 'done' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
            <span className="step-number">{i + 1}</span>
            {t(`wizard.step.${s}` as TKey)}
          </li>
        ))}
      </ol>

      {step === 'setup' && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void preview()
          }}
          noValidate
        >
          <div className="grid-name">
            <label className="field">
              <span>{t('wizard.nameTemplate')}</span>
              <input value={nameTemplate} onChange={(e) => setNameTemplate(e.target.value)} maxLength={LIMITS.nameMax} autoFocus />
              <small className="muted">{t('wizard.nameTemplateHint')}</small>
            </label>
            <label className="field">
              <span>{t('wizard.count')}</span>
              <input type="number" min={1} max={LIMITS.bulkCreateMax} value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('wizard.startNumber')}</span>
              <input type="number" min={0} value={startNumber} onChange={(e) => setStartNumber(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('wizard.padding')}</span>
              <select value={padding} onChange={(e) => setPadding(Number(e.target.value))}>
                <option value={0}>{t('wizard.paddingNone')}</option>
                {[2, 3, 4, 5, 6].map((d) => (
                  <option key={d} value={d}>
                    {'0'.repeat(d - 1)}1
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="field">
            <span>{t('wizard.template')}</span>
            <select
              value={templateId ?? ''}
              onChange={(e) => {
                const next = e.target.value || null
                setTemplateId(next)
                setProxyChoice(next ? 'inherit' : 'none')
                setGroupFromTemplate(Boolean(next))
              }}
            >
              <option value="">{t('wizard.noTemplate')}</option>
              {usable.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid-2">
            <GroupSelect
              groups={data.groups}
              value={groupId}
              onChange={(id) => {
                setGroupFromTemplate(false)
                setGroupId(id)
              }}
              label={t('wizard.group')}
              inheritLabel={templateId ? t('wizard.fromTemplate') : undefined}
              inherit={Boolean(templateId) && groupFromTemplate}
              onInherit={() => setGroupFromTemplate(true)}
            />
            <TagInput label={t('wizard.tags')} value={tags} onChange={setTags} suggestions={data.tags} />
          </div>

          <label className="field">
            <span>{t('wizard.homepage')}</span>
            <input
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder={t('wizard.homepagePlaceholder')}
              maxLength={LIMITS.urlMax}
            />
          </label>

          <label className="field">
            <span>{t('wizard.proxy')}</span>
            <select value={proxyChoice} onChange={(e) => setProxyChoice(e.target.value)}>
              {templateId && <option value="inherit">{t('wizard.fromTemplate')}</option>}
              <option value="none">{t('wizard.proxyNone')}</option>
              {proxyProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {t('wizard.proxyCopy', { name: `${p.name} — ${describeProxy(p.proxy)}` })}
                </option>
              ))}
            </select>
            <small className="muted">{t('wizard.proxyHint')}</small>
          </label>
          {sharesProxy && (
            <label className="toggle confirm-toggle">
              <input type="checkbox" checked={allowShared} onChange={(e) => setAllowShared(e.target.checked)} />
              <span>{t('wizard.allowShared')}</span>
            </label>
          )}

          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              {t('wizard.preview')}
            </button>
          </div>
        </form>
      )}

      {step === 'preview' && plan && (
        <div className="form">
          <h3 className="preview-title">{t('wizard.previewTitle', { count: plan.items.length })}</h3>
          <dl className="summary-grid">
            <dt>{t('wizard.summaryTemplate')}</dt>
            <dd>{plan.resolved.templateName ?? t('common.none')}</dd>
            <dt>{t('wizard.group')}</dt>
            <dd>{plan.resolved.groupName ?? t('common.noGroup')}</dd>
            <dt>{t('form.tags')}</dt>
            <dd>{plan.resolved.tags.length ? plan.resolved.tags.join(', ') : t('common.none')}</dd>
            <dt>{t('wizard.homepage')}</dt>
            <dd className="break">{plan.resolved.startUrl ?? data.settings?.homepage}</dd>
            <dt>{t('wizard.proxy')}</dt>
            <dd>{plan.resolved.proxyLabel ?? t('common.directConnection')}</dd>
          </dl>
          <ol className="name-preview" data-testid="bulk-preview">
            {plan.items.map((item) => (
              <li key={item.name} className={item.issue ? 'issue' : ''}>
                <span>{item.name}</span>
                {item.issue && <span className="issue-label">{t(`wizard.issue.${item.issue}` as TKey)}</span>}
              </li>
            ))}
          </ol>
          {plan.errors.map((e) => (
            <div key={e} className="alert error">{e}</div>
          ))}
          {!plan.ready && plan.errors.length === 0 && <div className="alert warn-box">{t('wizard.fixIssues')}</div>}
          <p className="hint">{t('wizard.notOpened')}</p>
          <div className="form-actions">
            <button type="button" className="button" onClick={() => setStep('setup')}>
              {t('wizard.edit')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!plan.ready || busy}
              onClick={() => void create(plan.items.map((i) => i.name))}
            >
              {t('wizard.create', { count: plan.items.length })}
            </button>
          </div>
        </div>
      )}

      {step === 'create' && (
        <div className="form" data-testid="bulk-create-result">
          {progress && (
            <div className="progress-block" aria-live="polite">
              <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <span>{t('wizard.progress', { done: progress.done, total: progress.total })}</span>
            </div>
          )}
          {!busy && (
            <p className="result-summary">
              <Icon name={failed.length ? 'warning' : 'check'} /> {t('wizard.summary', { ok: created, failed: failed.length })}
            </p>
          )}
          {failed.length > 0 && (
            <ul className="result-list">
              {failed.map((r) => (
                <li key={r.name} className="fail">
                  <Icon name="warning" size={16} />
                  <span className="result-name">{r.name}</span>
                  <span className="result-detail">{r.outcome === 'exists' ? outcomeLabel(t, r.outcome) : r.error}</span>
                </li>
              ))}
            </ul>
          )}
          {error && <div className="alert error" role="alert">{error}</div>}
          <p className="hint">{t('wizard.notOpened')}</p>
          <div className="form-actions">
            {retryable.length > 0 && (
              <button type="button" className="button" disabled={busy} onClick={() => void create(retryable)}>
                {t('wizard.retry', { count: retryable.length })}
              </button>
            )}
            <button type="button" className="button primary" disabled={busy} onClick={onClose}>
              {t('common.done')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
