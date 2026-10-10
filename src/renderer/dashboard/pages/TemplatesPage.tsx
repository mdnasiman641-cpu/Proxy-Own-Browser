import { useState, type FormEvent } from 'react'
import { describeProxy } from '@shared/proxy'
import type { ProfileTemplate, TemplateInput } from '@shared/types'
import { LIMITS, PROFILE_COLORS } from '@shared/validation'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { GroupChip, GroupSelect, TagInput, TagList } from '../components/Bits'
import { ConfirmDialog, Modal } from '../components/Modal'
import { useI18n } from '../i18n'
import type { AppData, TemplateWithProblems } from '../useAppData'

interface Props {
  data: AppData
  /** Opens the bulk wizard on the Profiles page with this template preselected. */
  onUseTemplate: (templateId: string) => void
}

export function TemplatesPage({ data, onUseTemplate }: Props) {
  const { t } = useI18n()
  const [editing, setEditing] = useState<ProfileTemplate | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ProfileTemplate | null>(null)
  const [busy, setBusy] = useState(false)
  const groupById = new Map(data.groups.map((g) => [g.id, g]))
  const profileName = (id: string) => data.profiles.find((p) => p.id === id)?.name ?? '—'

  const run = async (fn: () => Promise<unknown>, success?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await data.refreshCatalog()
      if (success) data.notify('success', success)
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{t('nav.templates')}</h1>
          <p className="subtitle">{t('templates.subtitle')}</p>
        </div>
        <button type="button" className="button primary" onClick={() => setEditing('new')}>
          <Icon name="plus" /> {t('templates.new')}
        </button>
      </header>

      {data.templates.length === 0 ? (
        <div className="empty">
          <p>{t('templates.empty')}</p>
          <button type="button" className="button primary" onClick={() => setEditing('new')}>
            {t('templates.new')}
          </button>
        </div>
      ) : (
        <div className="template-list" data-testid="template-list">
          {data.templates.map((tpl: TemplateWithProblems) => (
            <article key={tpl.id} className="template-card">
              <header>
                <span className="group-swatch big" style={{ background: tpl.color ?? 'var(--border)' }} aria-hidden="true" />
                <h2>{tpl.name}</h2>
              </header>
              <dl className="card-facts">
                <dt>{t('form.group')}</dt>
                <dd>{tpl.groupId ? <GroupChip group={groupById.get(tpl.groupId)} /> : t('common.noGroup')}</dd>
                <dt>{t('form.tags')}</dt>
                <dd><TagList tags={tpl.tags} /></dd>
                <dt>{t('wizard.homepage')}</dt>
                <dd className="break">{tpl.startUrl ?? t('common.none')}</dd>
                <dt>{t('wizard.proxy')}</dt>
                <dd>
                  {tpl.proxy.mode === 'copy-from-profile'
                    ? t('templates.summaryProxy', { name: profileName(tpl.proxy.profileId) })
                    : t('templates.proxyNone')}
                </dd>
              </dl>
              {tpl.problems.length > 0 && (
                <div className="alert warn-box">{t('templates.problem', { problems: tpl.problems.join('; ') })}</div>
              )}
              <div className="row-actions start">
                <button
                  type="button"
                  className="button primary small"
                  disabled={tpl.problems.length > 0}
                  onClick={() => onUseTemplate(tpl.id)}
                >
                  <Icon name="layers" size={16} /> {t('templates.use')}
                </button>
                <button type="button" className="button small" onClick={() => setEditing(tpl)}>
                  {t('common.edit')}
                </button>
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() => void run(() => unwrap(window.pob.duplicateTemplate(tpl.id)))}
                >
                  {t('common.duplicate')}
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                  onClick={() => setDeleting(tpl)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <Modal title={editing === 'new' ? t('templates.new') : t('templates.editTitle')} onClose={() => setEditing(null)}>
          <TemplateForm
            data={data}
            initial={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSave={async (input) => {
              if (editing === 'new') await unwrap(window.pob.createTemplate(input))
              else await unwrap(window.pob.updateTemplate(editing.id, input))
              await data.refresh()
              data.notify('success', t('templates.saved'))
              setEditing(null)
            }}
          />
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={t('templates.deleteTitle', { name: deleting.name })}
          message={t('templates.deleteBody')}
          confirmLabel={t('common.delete')}
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            void run(async () => {
              await unwrap(window.pob.deleteTemplate(deleting.id))
              setDeleting(null)
            }, t('templates.deleted'))
          }
        />
      )}
    </section>
  )
}

function TemplateForm(props: {
  data: AppData
  initial: ProfileTemplate | null
  onSave: (input: TemplateInput) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useI18n()
  const init = props.initial
  const [name, setName] = useState(init?.name ?? '')
  const [notes, setNotes] = useState(init?.notes ?? '')
  const [color, setColor] = useState<string | null>(init?.color ?? null)
  const [startUrl, setStartUrl] = useState(init?.startUrl ?? '')
  const [groupId, setGroupId] = useState<string | null>(init?.groupId ?? null)
  const [tags, setTags] = useState<string[]>(init?.tags ?? [])
  const [proxySource, setProxySource] = useState<string>(
    init?.proxy.mode === 'copy-from-profile' ? init.proxy.profileId : ''
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const proxyProfiles = props.data.profiles.filter((p) => p.proxy)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await props.onSave({
        name: name.trim(),
        notes,
        color,
        startUrl: startUrl.trim() || null,
        groupId,
        tags,
        proxy: proxySource ? { mode: 'copy-from-profile', profileId: proxySource } : { mode: 'none' }
      })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)} noValidate>
      <label className="field">
        <span>{t('templates.name')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.nameMax} autoFocus />
      </label>
      <div className="field">
        <span>{t('form.color')}</span>
        <div className="swatches" role="radiogroup" aria-label={t('form.colorLabel')}>
          <button
            type="button"
            role="radio"
            aria-checked={color === null}
            className={`swatch auto ${color === null ? 'selected' : ''}`}
            onClick={() => setColor(null)}
            title={t('templates.colorAuto')}
            aria-label={t('templates.colorAuto')}
          >
            A
          </button>
          {PROFILE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              className={`swatch ${color === c ? 'selected' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
      <div className="grid-2">
        <GroupSelect groups={props.data.groups} value={groupId} onChange={setGroupId} />
        <TagInput label={t('form.tags')} value={tags} onChange={setTags} suggestions={props.data.tags} />
      </div>
      <label className="field">
        <span>{t('form.startPage')}</span>
        <input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder={t('form.startPagePlaceholder')} maxLength={LIMITS.urlMax} />
      </label>
      <label className="field">
        <span>{t('wizard.proxy')}</span>
        <select value={proxySource} onChange={(e) => setProxySource(e.target.value)}>
          <option value="">{t('templates.proxyNone')}</option>
          {proxyProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {t('wizard.proxyCopy', { name: `${p.name} — ${describeProxy(p.proxy)}` })}
            </option>
          ))}
        </select>
        {proxyProfiles.length === 0 && <small className="muted">{t('templates.noProxyProfiles')}</small>}
      </label>
      <label className="field">
        <span>{t('form.notes')}</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={LIMITS.notesMax} />
      </label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="form-actions">
        <button type="button" className="button" onClick={props.onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  )
}
