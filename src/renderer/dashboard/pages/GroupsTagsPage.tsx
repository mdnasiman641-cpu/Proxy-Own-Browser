import { useState, type FormEvent } from 'react'
import type { ProfileGroup, ProfileTag } from '@shared/types'
import { LIMITS, PROFILE_COLORS } from '@shared/validation'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { ConfirmDialog } from '../components/Modal'
import { useI18n } from '../i18n'
import type { AppData } from '../useAppData'

export function GroupsTagsPage({ data }: { data: AppData }) {
  const { t } = useI18n()
  const [groupName, setGroupName] = useState('')
  const [tagName, setTagName] = useState('')
  const [deletingGroup, setDeletingGroup] = useState<ProfileGroup | null>(null)
  const [deletingTag, setDeletingTag] = useState<ProfileTag | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await fn()
      await data.refresh()
      return true
    } catch (error) {
      data.notify('error', errorMessage(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const addGroup = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!groupName.trim()) return
    if (await run(() => unwrap(window.pob.createGroup({ name: groupName.trim() })))) setGroupName('')
  }

  const addTag = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!tagName.trim()) return
    if (await run(() => unwrap(window.pob.createTag(tagName.trim())))) setTagName('')
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{t('nav.groups')}</h1>
          <p className="subtitle">{t('groups.subtitle')}</p>
        </div>
      </header>

      <div className="panel-grid">
        <div className="panel stretch" data-testid="groups-panel">
          <h2>{t('groups.groups')}</h2>
          <form className="inline-form" onSubmit={(e) => void addGroup(e)}>
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={t('groups.namePlaceholder')}
              aria-label={t('groups.namePlaceholder')}
              maxLength={LIMITS.groupNameMax}
            />
            <button type="submit" className="button primary" disabled={busy || !groupName.trim()}>
              <Icon name="plus" /> {t('groups.add')}
            </button>
          </form>
          {data.groups.length === 0 ? (
            <p className="muted">{t('groups.empty')}</p>
          ) : (
            <ul className="manage-list">
              {data.groups.map((g) => (
                <GroupRow key={g.id} group={g} busy={busy} run={run} onDelete={() => setDeletingGroup(g)} />
              ))}
            </ul>
          )}
        </div>

        <div className="panel stretch" data-testid="tags-panel">
          <h2>{t('groups.tags')}</h2>
          <form className="inline-form" onSubmit={(e) => void addTag(e)}>
            <input
              value={tagName}
              onChange={(e) => setTagName(e.target.value)}
              placeholder={t('groups.tagPlaceholder')}
              aria-label={t('groups.tagPlaceholder')}
              maxLength={LIMITS.tagMax}
            />
            <button type="submit" className="button primary" disabled={busy || !tagName.trim()}>
              <Icon name="plus" /> {t('groups.addTag')}
            </button>
          </form>
          {data.tags.length === 0 ? (
            <p className="muted">{t('groups.tagsEmpty')}</p>
          ) : (
            <ul className="manage-list">
              {data.tags.map((tag) => (
                <TagRow key={tag.id} tag={tag} busy={busy} run={run} onDelete={() => setDeletingTag(tag)} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {deletingGroup && (
        <ConfirmDialog
          title={t('groups.deleteTitle', { name: deletingGroup.name })}
          message={t('groups.deleteBody', { count: deletingGroup.profileCount })}
          confirmLabel={t('common.delete')}
          danger
          busy={busy}
          onCancel={() => setDeletingGroup(null)}
          onConfirm={() =>
            void run(async () => {
              const ungrouped = await unwrap(window.pob.deleteGroup(deletingGroup.id))
              data.notify('success', t('groups.deleted', { count: ungrouped }))
              setDeletingGroup(null)
            })
          }
        />
      )}
      {deletingTag && (
        <ConfirmDialog
          title={t('groups.deleteTagTitle', { name: deletingTag.name })}
          message={t('groups.deleteTagBody', { count: deletingTag.profileCount })}
          confirmLabel={t('common.delete')}
          danger
          busy={busy}
          onCancel={() => setDeletingTag(null)}
          onConfirm={() =>
            void run(async () => {
              await unwrap(window.pob.deleteTag(deletingTag.id))
              setDeletingTag(null)
            })
          }
        />
      )}
    </section>
  )
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>

function GroupRow({ group, busy, run, onDelete }: { group: ProfileGroup; busy: boolean; run: Run; onDelete: () => void }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (await run(() => unwrap(window.pob.updateGroup(group.id, { name: name.trim() })))) setEditing(false)
  }
  return (
    <li className="manage-row">
      <label className="color-dot" title={t('groups.color')}>
        <span className="group-swatch big" style={{ background: group.color }} aria-hidden="true" />
        <select
          className="color-select"
          value={group.color}
          aria-label={t('groups.color')}
          onChange={(e) => void run(() => unwrap(window.pob.updateGroup(group.id, { color: e.target.value })))}
        >
          {[...new Set([group.color, ...PROFILE_COLORS])].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      {editing ? (
        <form className="inline-form grow" onSubmit={(e) => void save(e)}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.groupNameMax} autoFocus aria-label={t('groups.renameLabel', { name: group.name })} />
          <button type="submit" className="button small primary" disabled={busy || !name.trim()}>{t('common.save')}</button>
          <button type="button" className="button small" onClick={() => { setEditing(false); setName(group.name) }}>{t('common.cancel')}</button>
        </form>
      ) : (
        <>
          <span className="grow">
            <strong>{group.name}</strong> <span className="muted small">{t('groups.profiles', { count: group.profileCount })}</span>
          </span>
          <button type="button" className="icon-button" title={t('common.rename')} aria-label={t('common.rename')} onClick={() => setEditing(true)}>
            <Icon name="edit" />
          </button>
          <button type="button" className="icon-button danger" title={t('common.delete')} aria-label={t('common.delete')} onClick={onDelete}>
            <Icon name="trash" />
          </button>
        </>
      )}
    </li>
  )
}

function TagRow({ tag, busy, run, onDelete }: { tag: ProfileTag; busy: boolean; run: Run; onDelete: () => void }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tag.name)
  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (await run(() => unwrap(window.pob.renameTag(tag.id, name.trim())))) setEditing(false)
  }
  return (
    <li className="manage-row">
      <Icon name="tag" size={16} />
      {editing ? (
        <form className="inline-form grow" onSubmit={(e) => void save(e)}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.tagMax} autoFocus aria-label={t('groups.renameLabel', { name: tag.name })} />
          <button type="submit" className="button small primary" disabled={busy || !name.trim()}>{t('common.save')}</button>
          <button type="button" className="button small" onClick={() => { setEditing(false); setName(tag.name) }}>{t('common.cancel')}</button>
        </form>
      ) : (
        <>
          <span className="grow">
            <strong>{tag.name}</strong> <span className="muted small">{t('groups.profiles', { count: tag.profileCount })}</span>
          </span>
          <button type="button" className="icon-button" title={t('common.rename')} aria-label={t('common.rename')} onClick={() => setEditing(true)}>
            <Icon name="edit" />
          </button>
          <button type="button" className="icon-button danger" title={t('common.delete')} aria-label={t('common.delete')} onClick={onDelete}>
            <Icon name="trash" />
          </button>
        </>
      )}
    </li>
  )
}
