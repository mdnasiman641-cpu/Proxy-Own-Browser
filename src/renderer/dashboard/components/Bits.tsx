import { useId, useState, type KeyboardEvent } from 'react'
import type { BulkSummary, ProfileGroup, ProfileRuntimeStatus, ProfileTag } from '@shared/types'
import { Icon } from '../../common/Icon'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import { Modal } from './Modal'

const STATUS_KEY: Record<ProfileRuntimeStatus, TKey> = {
  closed: 'status.closed',
  starting: 'status.starting',
  running: 'status.running',
  crashed: 'status.crashed'
}

/** Colored dot plus text, so status is never conveyed by color alone. */
export function StatusBadge({ status, compact = false }: { status: ProfileRuntimeStatus; compact?: boolean }) {
  const { t } = useI18n()
  const label = t(STATUS_KEY[status])
  return (
    <span className={`status status-${status}`} title={label}>
      <span className="status-dot" aria-hidden="true" />
      {compact ? <span className="sr-only">{label}</span> : <span>{label}</span>}
    </span>
  )
}

export function GroupChip({ group }: { group: ProfileGroup | undefined }) {
  const { t } = useI18n()
  if (!group) return <span className="muted">{t('common.ungrouped')}</span>
  return (
    <span className="group-chip">
      <span className="group-swatch" style={{ background: group.color }} aria-hidden="true" />
      {group.name}
    </span>
  )
}

export function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="muted">—</span>
  return (
    <span className="tag-list">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          {tag}
        </span>
      ))}
    </span>
  )
}

interface GroupSelectProps {
  groups: ProfileGroup[]
  value: string | null
  onChange: (id: string | null) => void
  label?: string
  /** Extra option shown first (e.g. "use template setting"); selecting it calls onInherit. */
  inheritLabel?: string
  inherit?: boolean
  onInherit?: () => void
}

export function GroupSelect({ groups, value, onChange, label, inheritLabel, inherit, onInherit }: GroupSelectProps) {
  const { t } = useI18n()
  const current = inherit ? '__inherit' : (value ?? '')
  return (
    <label className="field">
      <span>{label ?? t('form.group')}</span>
      <select
        value={current}
        onChange={(e) => {
          if (e.target.value === '__inherit') onInherit?.()
          else onChange(e.target.value || null)
        }}
      >
        {inheritLabel && <option value="__inherit">{inheritLabel}</option>}
        <option value="">{t('common.noGroup')}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  )
}

interface TagInputProps {
  label: string
  value: string[]
  onChange: (tags: string[]) => void
  suggestions: ProfileTag[]
}

/** Chips with a text box: Enter or comma adds a tag, Backspace on an empty box removes the last one. */
export function TagInput({ label, value, onChange, suggestions }: TagInputProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const listId = useId()

  const add = (raw: string): void => {
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (!parts.length) return
    const existing = new Set(value.map((v) => v.toLocaleLowerCase()))
    const next = [...value]
    for (const part of parts) {
      // Reuse the saved spelling of an existing tag.
      const known = suggestions.find((s) => s.name.toLocaleLowerCase() === part.toLocaleLowerCase())
      const name = known?.name ?? part.slice(0, 32)
      if (!existing.has(name.toLocaleLowerCase())) {
        existing.add(name.toLocaleLowerCase())
        next.push(name)
      }
    }
    onChange(next)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="field">
      <span>{label}</span>
      <div className="tag-input">
        {value.map((tag) => (
          <span key={tag} className="tag removable">
            {tag}
            <button
              type="button"
              aria-label={t('form.removeTag', { name: tag })}
              onClick={() => onChange(value.filter((v) => v !== tag))}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          placeholder={value.length ? '' : t('form.tagsPlaceholder')}
          list={listId}
          aria-label={label}
          maxLength={32}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
      </div>
    </div>
  )
}

const ACTION_KEY: Record<string, TKey> = {
  open: 'bulk.action.open',
  close: 'bulk.action.close',
  'assign-group': 'bulk.action.assign-group',
  'change-tags': 'bulk.action.change-tags',
  delete: 'bulk.action.delete'
}

export function outcomeLabel(t: ReturnType<typeof useI18n>['t'], outcome: string | null): string {
  const key = `outcome.${outcome}` as TKey
  return outcome ? t(key) : ''
}

/** Lists what happened to each profile in a bulk action. */
export function BulkResultDialog({ summary, onClose }: { summary: BulkSummary; onClose: () => void }) {
  const { t } = useI18n()
  const action = ACTION_KEY[summary.action] ? t(ACTION_KEY[summary.action]!) : summary.action
  return (
    <Modal
      title={t('bulk.resultTitle', { action, ok: summary.succeeded, failed: summary.failed })}
      onClose={onClose}
      width={560}
    >
      <ul className="result-list" data-testid="bulk-results">
        {summary.results.map((r) => (
          <li key={`${r.id}-${r.name}`} className={r.ok ? 'ok' : 'fail'}>
            <Icon name={r.ok ? 'check' : 'warning'} size={16} />
            <span className="result-name">{r.name}</span>
            <span className="result-detail">{r.ok ? outcomeLabel(t, r.outcome) : r.error}</span>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button type="button" className="button primary" onClick={onClose} autoFocus>
          {t('common.done')}
        </button>
      </div>
    </Modal>
  )
}
