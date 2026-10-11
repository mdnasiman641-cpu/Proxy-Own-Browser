import type { ReactNode } from 'react'
import { useI18n } from '../../i18n'
import type { TKey } from '../../strings'

/** A section heading inside a settings category, with optional help text. */
export function Section({ title, help, children, testId }: { title: string; help?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="ed-section" data-testid={testId}>
      <h3>{title}</h3>
      {help && <p className="ed-help">{help}</p>}
      <div className="ed-section-body">{children}</div>
    </section>
  )
}

/** Labelled field with help text and an error from the validation map. */
export function Field({
  label,
  help,
  error,
  children,
  wide = false
}: {
  label: string
  help?: string
  error?: TKey | undefined
  children: ReactNode
  wide?: boolean
}) {
  const { t } = useI18n()
  return (
    <label className={`field ${wide ? 'wide' : ''} ${error ? 'has-error' : ''}`}>
      <span>{label}</span>
      {children}
      {error ? <small className="field-error" role="alert">{t(error)}</small> : help ? <small className="muted">{help}</small> : null}
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div className="segmented wide" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, help, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string; testId?: string }) {
  return (
    <div className="ed-toggle">
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
        <span>{label}</span>
      </label>
      {help && <small className="muted">{help}</small>}
    </div>
  )
}

/** Read-only fact with a label; `source` says where the value comes from. */
export function Fact({ label, value, source, mono = false }: { label: string; value: ReactNode; source?: string; mono?: boolean }) {
  return (
    <div className="ed-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'mono break' : ''}>
        {value}
        {source && <span className="ed-source">{source}</span>}
      </dd>
    </div>
  )
}

/** A control that this runtime cannot provide, shown disabled with the reason. */
export function Unsupported({ label, reason }: { label: string; reason: string }) {
  const { t } = useI18n()
  return (
    <div className="ed-unsupported" data-testid="unsupported-setting">
      <strong>{label}</strong>
      <span className="status-pill">{t('ed.unsupported')}</span>
      <small className="muted">{reason}</small>
    </div>
  )
}
