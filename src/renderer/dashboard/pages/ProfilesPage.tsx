import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DEFAULT_QUERY, SORT_KEYS, filterAndSortProfiles, type ProfileQuery, type SortKey } from '@shared/profileQuery'
import { describeProxy } from '@shared/proxy'
import type { BulkSummary, Profile, ProfileInput } from '@shared/types'
import { Icon } from '../../common/Icon'
import { errorMessage, unwrap } from '../../common/ipc'
import { BackupChoiceDialog, FullBackupDialog } from '../components/BackupDialogs'
import { BulkCreateWizard } from '../components/BulkCreateWizard'
import { DuplicateDialog } from '../components/DuplicateDialog'
import { BackupStatusLine } from '../components/BackupStatusLine'
import { NetworkBadge } from '../components/NetworkStatusView'
import { useProfileEditor } from '../components/editor/ProfileEditor'
import { useSharedProxyGuard } from '../components/SharedProxyGuard'
import { BulkResultDialog, GroupChip, GroupSelect, StatusBadge, TagInput, TagList } from '../components/Bits'
import { ConfirmDialog, Modal } from '../components/Modal'
import { ProfileAvatar } from '../components/ProfileBadge'
import { ProfileForm } from '../components/ProfileForm'
import { useI18n } from '../i18n'
import type { TKey } from '../strings'
import type { AppData } from '../useAppData'

interface Props {
  data: AppData
  createRequested: boolean
  onCreateHandled: () => void
  /** Template to start the bulk wizard with (from the Templates page). */
  wizardTemplateId: string | null
  onWizardHandled: () => void
  /** Opens the profile details page (network, time zone, browser settings, backups). */
  onOpenDetails: (profileId: string) => void
}

type View = 'table' | 'cards'
type Dialog =
  | { kind: 'create' }
  | { kind: 'delete-one'; profile: Profile }
  | { kind: 'bulk-delete' }
  | { kind: 'bulk-move' }
  | { kind: 'bulk-tags' }
  | { kind: 'wizard'; templateId: string | null }
  | { kind: 'result'; summary: BulkSummary }
  | { kind: 'duplicate'; profile: Profile }
  | { kind: 'backup-choice' }
  | { kind: 'full-backup'; profiles: Profile[] }
  | null

const SORT_LABEL: Record<SortKey, TKey> = {
  name: 'profiles.sort.name',
  created: 'profiles.sort.created',
  group: 'profiles.sort.group',
  status: 'profiles.sort.status',
  lastOpened: 'profiles.sort.lastOpened'
}

const VIEW_KEY = 'pob.profiles.view'

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'table'
  } catch {
    return 'table'
  }
}

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function ProfilesPage({ data, createRequested, onCreateHandled, wizardTemplateId, onWizardHandled, onOpenDetails }: Props) {
  const { t, formatDate } = useI18n()
  const [query, setQuery] = useState<ProfileQuery>(DEFAULT_QUERY)
  const [view, setView] = useState<View>(storedView)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const { guard, dialog: sharedProxyDialog } = useSharedProxyGuard()
  const listRef = useRef<HTMLDivElement>(null)
  const { openEditor } = useProfileEditor()

  const groupById = useMemo(() => new Map(data.groups.map((g) => [g.id, g])), [data.groups])
  const visible = useMemo(
    () => filterAndSortProfiles(data.profiles, query, data.statuses, data.groups),
    [data.profiles, query, data.statuses, data.groups]
  )
  // Selection only ever contains profiles that still exist.
  const existing = useMemo(() => new Set(data.profiles.map((p) => p.id)), [data.profiles])
  const selection = useMemo(() => [...selected].filter((id) => existing.has(id)), [selected, existing])
  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id))
  const ungroupedCount = data.profiles.filter((p) => !p.groupId).length
  const status = (p: Profile) => data.statuses[p.id] ?? 'closed'
  const filtersActive = query.search !== '' || query.group !== 'all' || query.tags.length > 0 || query.status !== 'all'

  useEffect(() => {
    if (createRequested) {
      setDialog({ kind: 'create' })
      onCreateHandled()
    }
  }, [createRequested, onCreateHandled])

  useEffect(() => {
    if (wizardTemplateId !== null) {
      setDialog({ kind: 'wizard', templateId: wizardTemplateId === '' ? null : wizardTemplateId })
      onWizardHandled()
    }
  }, [wizardTemplateId, onWizardHandled])

  const changeView = (next: View): void => {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      /* preference only */
    }
  }

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAllVisible = useCallback(() => {
    setSelected((s) => new Set([...s, ...visible.map((p) => p.id)]))
  }, [visible])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  /** Runs a bulk IPC action and reports the outcome for every profile. */
  const runBulkAction = async (call: () => Promise<BulkSummary>): Promise<void> => {
    setBusy(true)
    try {
      const summary = await call()
      if (summary.failed > 0) setDialog({ kind: 'result', summary })
      else {
        setDialog(null)
        data.notify(
          'success',
          t('bulk.resultTitle', { action: t(`bulk.action.${summary.action}` as TKey), ok: summary.succeeded, failed: 0 })
        )
      }
      await data.refresh()
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const bulkOpen = () =>
    void data.confirmOpening(
      data.profiles.filter((p) => selection.includes(p.id)),
      () => runBulkAction(() => unwrap(window.pob.bulkOpen(selection)))
    )
  const bulkClose = () => void runBulkAction(() => unwrap(window.pob.bulkClose(selection)))
  const bulkExport = async (): Promise<void> => {
    try {
      const result = await unwrap(window.pob.bulkExport(selection))
      if (result.saved) data.notify('success', t('bulk.exported', { count: result.profileCount }))
    } catch (error) {
      data.notify('error', errorMessage(error))
    }
  }

  const deleteOne = async (profile: Profile, clearData: boolean): Promise<void> => {
    setBusy(true)
    try {
      await data.deleteProfile(profile, clearData)
      data.notify('success', t('profiles.deleted', { name: profile.name }))
      setDialog(null)
    } catch (error) {
      data.notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const askDeleteOne = (profile: Profile): void => {
    if (data.settings?.confirmBeforeDelete === false) void deleteOne(profile, true)
    else setDialog({ kind: 'delete-one', profile })
  }

  // Page-level keyboard shortcuts (ignored while typing or while a dialog is open).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (dialog || isTyping(e.target)) return
      const ctrl = e.ctrlKey || e.metaKey
      if (e.key === '/' || (ctrl && e.key.toLowerCase() === 'f')) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        selectAllVisible()
      } else if (ctrl && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setDialog({ kind: 'create' })
      } else if (e.key === 'Escape' && selection.length) {
        clearSelection()
      } else if (e.key === 'Delete' && selection.length) {
        setDialog({ kind: 'bulk-delete' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, selection.length, selectAllVisible, clearSelection])

  /** Row keys: Enter opens, Space selects, arrows move between rows. */
  const onRowKey = (e: KeyboardEvent<HTMLElement>, profile: Profile): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void data.openProfile(profile)
    } else if (e.key === ' ') {
      e.preventDefault()
      toggle(profile.id)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
      const index = rows.indexOf(e.currentTarget)
      rows[index + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
    }
  }

  const proxyCell = (p: Profile) => (
    <>
      {describeProxy(p.proxy) ?? <span className="muted">{t('common.direct')}</span>}
      {p.proxy?.username && !p.proxy.hasPassword && <div className="warn small">{t('profiles.passwordMissing')}</div>}
      <NetworkBadge status={data.network[p.id]} />
    </>
  )

  /** `inTable` leaves out Duplicate (available in card view and on the details page) to keep rows compact. */
  const rowActions = (p: Profile, inTable = false) => {
    const running = status(p) !== 'closed'
    return (
      <div className="row-actions">
        <button
          type="button"
          className="button primary small"
          onClick={() => void data.openProfile(p)}
          aria-label={`${running ? t('common.focus') : t('common.open')}: ${p.name}`}
        >
          <Icon name="open" size={16} /> <span className="btn-text">{running ? t('common.focus') : t('common.open')}</span>
        </button>
        {running && (
          <button type="button" className="button small" onClick={() => void data.closeProfile(p)}>
            {t('common.close')}
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title={t('details.open')}
          aria-label={t('details.openFor', { name: p.name })}
          onClick={() => onOpenDetails(p.id)}
          data-testid="details-button"
        >
          <Icon name="info" />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t('common.edit')}
          aria-label={t('profiles.edit', { name: p.name })}
          onClick={() => openEditor(p.id)}
          data-testid="edit-button"
        >
          <Icon name="edit" />
        </button>
        {!inTable && (
          <button
            type="button"
            className="icon-button"
            title={t('dup.action')}
            aria-label={t('dup.title', { name: p.name })}
            onClick={() => setDialog({ kind: 'duplicate', profile: p })}
          >
            <Icon name="copy" />
          </button>
        )}
        <button
          type="button"
          className="icon-button danger"
          title={running ? t('profiles.closeFirst') : t('common.delete')}
          aria-label={t('profiles.delete', { name: p.name })}
          disabled={running}
          onClick={() => askDeleteOne(p)}
        >
          <Icon name="trash" />
        </button>
      </div>
    )
  }

  const checkbox = (p: Profile) => (
    <input
      type="checkbox"
      className="row-check"
      checked={selected.has(p.id)}
      onChange={() => toggle(p.id)}
      aria-label={t('profiles.select', { name: p.name })}
    />
  )

  const selectedOpen = selection.filter((id) => (data.statuses[id] ?? 'closed') !== 'closed').length

  return (
    <section className="page wide" data-testid="profile-manager">
      <header className="page-header">
        <div>
          <h1>{t('nav.profiles')}</h1>
          <p className="subtitle">
            {t('profiles.subtitle')}{' '}
            <span className="running-count" data-testid="running-count">
              {t('profiles.runningCount', { count: data.runningCount })}
            </span>
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="button" onClick={() => setDialog({ kind: 'wizard', templateId: null })}>
            <Icon name="layers" /> {t('profiles.createSeveral')}
          </button>
          <button type="button" className="button primary" onClick={() => setDialog({ kind: 'create' })}>
            <Icon name="plus" /> {t('profiles.new')}
          </button>
        </div>
      </header>

      <div className="query-bar">
        <div className="search-box">
          <Icon name="search" />
          <input
            ref={searchRef}
            type="search"
            value={query.search}
            onChange={(e) => setQuery((q) => ({ ...q, search: e.target.value }))}
            placeholder={t('profiles.searchPlaceholder')}
            aria-label={t('profiles.searchLabel')}
            maxLength={200}
          />
        </div>
        <label className="inline-field">
          <span>{t('profiles.statusFilter')}</span>
          <select
            value={query.status}
            onChange={(e) => setQuery((q) => ({ ...q, status: e.target.value as ProfileQuery['status'] }))}
          >
            <option value="all">{t('profiles.status.all')}</option>
            <option value="running">{t('profiles.status.running')}</option>
            <option value="closed">{t('profiles.status.closed')}</option>
          </select>
        </label>
        <label className="inline-field">
          <span>{t('profiles.sortBy')}</span>
          <select value={query.sort} onChange={(e) => setQuery((q) => ({ ...q, sort: e.target.value as SortKey }))}>
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(SORT_LABEL[key])}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="icon-button bordered"
          onClick={() => setQuery((q) => ({ ...q, direction: q.direction === 'asc' ? 'desc' : 'asc' }))}
          aria-label={query.direction === 'asc' ? t('profiles.sortAsc') : t('profiles.sortDesc')}
          title={query.direction === 'asc' ? t('profiles.sortAsc') : t('profiles.sortDesc')}
        >
          <Icon name={query.direction === 'asc' ? 'arrowUp' : 'arrowDown'} />
        </button>
        <div className="segmented" role="group" aria-label={t('profiles.view')}>
          <button type="button" aria-pressed={view === 'table'} onClick={() => changeView('table')} title={t('profiles.viewTable')}>
            <Icon name="rows" size={16} /> <span>{t('profiles.viewTable')}</span>
          </button>
          <button type="button" aria-pressed={view === 'cards'} onClick={() => changeView('cards')} title={t('profiles.viewCards')}>
            <Icon name="grid" size={16} /> <span>{t('profiles.viewCards')}</span>
          </button>
        </div>
      </div>

      <div className="manager">
        <aside className="filter-rail" aria-label={t('profiles.filters')}>
          <div className="rail-section">
            <button
              type="button"
              className={`rail-item ${query.group === 'all' ? 'active' : ''}`}
              onClick={() => setQuery((q) => ({ ...q, group: 'all' }))}
            >
              <span>{t('profiles.allProfiles')}</span>
              <span className="rail-count">{data.profiles.length}</span>
            </button>
            <button
              type="button"
              className={`rail-item ${query.group === 'none' ? 'active' : ''}`}
              onClick={() => setQuery((q) => ({ ...q, group: 'none' }))}
            >
              <span>{t('common.ungrouped')}</span>
              <span className="rail-count">{ungroupedCount}</span>
            </button>
          </div>
          {data.groups.length > 0 && (
            <div className="rail-section">
              <h2 className="rail-heading">{t('profiles.groupsHeading')}</h2>
              {data.groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`rail-item ${query.group === g.id ? 'active' : ''}`}
                  onClick={() => setQuery((q) => ({ ...q, group: g.id }))}
                >
                  <span className="rail-label">
                    <span className="group-swatch" style={{ background: g.color }} aria-hidden="true" />
                    {g.name}
                  </span>
                  <span className="rail-count">{g.profileCount}</span>
                </button>
              ))}
            </div>
          )}
          <div className="rail-section">
            <h2 className="rail-heading">{t('profiles.tagsHeading')}</h2>
            {data.tags.length === 0 ? (
              <p className="muted small">{t('profiles.noTags')}</p>
            ) : (
              <div className="tag-filter">
                {data.tags.map((tag) => {
                  const on = query.tags.some((x) => x.toLocaleLowerCase() === tag.name.toLocaleLowerCase())
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`tag toggle-tag ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      onClick={() =>
                        setQuery((q) => ({
                          ...q,
                          tags: on ? q.tags.filter((x) => x.toLocaleLowerCase() !== tag.name.toLocaleLowerCase()) : [...q.tags, tag.name]
                        }))
                      }
                    >
                      {tag.name} <span className="tag-count">{tag.profileCount}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {filtersActive && (
            <button type="button" className="button small" onClick={() => setQuery((q) => ({ ...DEFAULT_QUERY, sort: q.sort, direction: q.direction }))}>
              {t('profiles.clearFilters')}
            </button>
          )}
          <details className="shortcuts">
            <summary>{t('shortcuts.title')}</summary>
            <dl>
              <dt><kbd>/</kbd></dt><dd>{t('shortcuts.search')}</dd>
              <dt><kbd>Ctrl</kbd>+<kbd>N</kbd></dt><dd>{t('shortcuts.new')}</dd>
              <dt><kbd>Ctrl</kbd>+<kbd>A</kbd></dt><dd>{t('shortcuts.selectAll')}</dd>
              <dt><kbd>Del</kbd></dt><dd>{t('shortcuts.delete')}</dd>
              <dt><kbd>Esc</kbd></dt><dd>{t('shortcuts.clear')}</dd>
              <dt><kbd>Enter</kbd></dt><dd>{t('shortcuts.openRow')}</dd>
              <dt><kbd>Space</kbd></dt><dd>{t('shortcuts.toggleRow')}</dd>
            </dl>
          </details>
        </aside>

        <div className="manager-main" ref={listRef}>
          <div className="list-head">
            <label className="select-all">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={visible.length === 0}
                onChange={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
                aria-label={t('profiles.selectAll')}
                data-testid="select-all"
              />
              <span>{t('profiles.count', { shown: visible.length, total: data.profiles.length })}</span>
            </label>
          </div>

          {data.profiles.length === 0 ? (
            <div className="empty">
              <p>{t('profiles.empty')}</p>
              <button type="button" className="button primary" onClick={() => setDialog({ kind: 'create' })}>
                {t('profiles.emptyCta')}
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">{t('profiles.noMatch')}</div>
          ) : view === 'table' ? (
            <div className="table-wrap">
              <table className="table profiles-table">
                <thead>
                  <tr>
                    <th className="check-col" aria-hidden="true" />
                    <th>{t('profiles.col.profile')}</th>
                    <th>{t('profiles.col.group')}</th>
                    <th>{t('profiles.col.tags')}</th>
                    <th>{t('profiles.col.proxy')}</th>
                    <th>{t('profiles.col.lastOpened')}</th>
                    <th className="actions-col">{t('profiles.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <tr
                      key={p.id}
                      data-row
                      tabIndex={0}
                      className={selected.has(p.id) ? 'selected' : ''}
                      onKeyDown={(e) => onRowKey(e, p)}
                      style={{ ['--spine' as string]: p.color }}
                    >
                      <td className="check-col spine">{checkbox(p)}</td>
                      <td>
                        <div className="profile-cell">
                          <ProfileAvatar profile={p} size={30} />
                          <div className="profile-text">
                            <button type="button" className="profile-name link-button" title={p.name} onClick={() => onOpenDetails(p.id)}>
                              {p.name}
                            </button>
                            <StatusBadge status={status(p)} />
                            {p.notes && <div className="muted small clamp">{p.notes}</div>}
                          </div>
                        </div>
                      </td>
                      <td><GroupChip group={p.groupId ? groupById.get(p.groupId) : undefined} /></td>
                      <td><TagList tags={p.tags} /></td>
                      <td className="proxy-cell">{proxyCell(p)}</td>
                      <td className="nowrap">
                        <div className="muted">{formatDate(p.lastOpenedAt)}</div>
                        <BackupStatusLine status={data.backups[p.id]} />
                      </td>
                      <td className="actions-col">{rowActions(p, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="profile-cards">
              {visible.map((p) => (
                <article
                  key={p.id}
                  data-row
                  tabIndex={0}
                  className={`profile-card ${selected.has(p.id) ? 'selected' : ''}`}
                  onKeyDown={(e) => onRowKey(e, p)}
                  style={{ ['--spine' as string]: p.color }}
                >
                  <div className="card-top">
                    {checkbox(p)}
                    <ProfileAvatar profile={p} size={36} />
                    <div className="card-title">
                      <strong>{p.name}</strong>
                      <StatusBadge status={status(p)} />
                    </div>
                  </div>
                  <dl className="card-facts">
                    <dt>{t('profiles.col.group')}</dt>
                    <dd><GroupChip group={p.groupId ? groupById.get(p.groupId) : undefined} /></dd>
                    <dt>{t('profiles.col.tags')}</dt>
                    <dd><TagList tags={p.tags} /></dd>
                    <dt>{t('profiles.col.proxy')}</dt>
                    <dd>{proxyCell(p)}</dd>
                    <dt>{t('profiles.col.lastOpened')}</dt>
                    <dd>{formatDate(p.lastOpenedAt)}</dd>
                    <dt>{t('details.backups')}</dt>
                    <dd><BackupStatusLine status={data.backups[p.id]} /></dd>
                  </dl>
                  {rowActions(p)}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      {selection.length > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label={t('bulk.selected', { count: selection.length })} data-testid="bulk-bar">
          <strong>{t('bulk.selected', { count: selection.length })}</strong>
          <button type="button" className="button small" disabled={busy} onClick={bulkOpen} title={t('bulk.openLimit', { max: data.settings?.maxOpenProfiles ?? 2 })}>
            <Icon name="open" size={16} /> {t('bulk.open')}
          </button>
          <button type="button" className="button small" disabled={busy || selectedOpen === 0} onClick={bulkClose}>
            {t('bulk.close')}
          </button>
          <button type="button" className="button small" disabled={busy} onClick={() => setDialog({ kind: 'bulk-move' })}>
            <Icon name="folder" size={16} /> {t('bulk.moveToGroup')}
          </button>
          <button type="button" className="button small" disabled={busy} onClick={() => setDialog({ kind: 'bulk-tags' })}>
            <Icon name="tag" size={16} /> {t('bulk.tags')}
          </button>
          <button type="button" className="button small" disabled={busy} onClick={() => void bulkExport()}>
            <Icon name="download" size={16} /> {t('bulk.export')}
          </button>
          <button type="button" className="button small" disabled={busy} onClick={() => setDialog({ kind: 'backup-choice' })}>
            <Icon name="shield" size={16} /> {t('bulk.backup')}
          </button>
          <button type="button" className="button small danger-outline" disabled={busy} onClick={() => setDialog({ kind: 'bulk-delete' })}>
            <Icon name="trash" size={16} /> {t('bulk.delete')}
          </button>
          <button type="button" className="icon-button" onClick={clearSelection} aria-label={t('bulk.clear')} title={t('bulk.clear')}>
            <Icon name="close" />
          </button>
        </div>
      )}

      {dialog?.kind === 'create' && (
        <Modal title={t('profiles.new')} onClose={() => setDialog(null)}>
          <ProfileForm
            submitLabel={t('form.create')}
            groups={data.groups}
            tagSuggestions={data.tags}
            defaultGroupId={query.group !== 'all' && query.group !== 'none' ? query.group : null}
            onCancel={() => setDialog(null)}
            onSubmit={(input) =>
              guard(async (options) => {
                const profile = await data.createProfile(input as ProfileInput, options)
                data.notify('success', t('profiles.created', { name: profile.name }))
                setDialog(null)
              })
            }
          />
        </Modal>
      )}

      {dialog?.kind === 'delete-one' && (
        <DeleteDialog
          title={t('deleteOne.title')}
          intro={t('deleteOne.body', { name: dialog.profile.name })}
          confirmLabel={t('common.delete')}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={(clearData) => void deleteOne(dialog.profile, clearData)}
        />
      )}

      {dialog?.kind === 'bulk-delete' && (
        <DeleteDialog
          title={t('bulk.deleteTitle', { count: selection.length })}
          intro={t('bulk.deleteIntro')}
          warning={selectedOpen > 0 ? t('bulk.deleteOpenWarning', { count: selectedOpen }) : undefined}
          confirmLabel={t('bulk.deleteConfirm', { count: selection.length })}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={(clearData) =>
            void runBulkAction(async () => {
              const summary = await unwrap(window.pob.bulkDelete(selection, { clearData }))
              setSelected(new Set())
              return summary
            })
          }
        />
      )}

      {dialog?.kind === 'bulk-move' && (
        <BulkMoveDialog
          count={selection.length}
          data={data}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={(groupId) => void runBulkAction(() => unwrap(window.pob.bulkAssignGroup(selection, groupId)))}
        />
      )}

      {dialog?.kind === 'bulk-tags' && (
        <BulkTagsDialog
          count={selection.length}
          data={data}
          existingTags={[...new Set(data.profiles.filter((p) => selected.has(p.id)).flatMap((p) => p.tags))]}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={(add, remove) => void runBulkAction(() => unwrap(window.pob.bulkChangeTags(selection, { add, remove })))}
        />
      )}

      {dialog?.kind === 'wizard' && (
        <BulkCreateWizard data={data} initialTemplateId={dialog.templateId} onClose={() => setDialog(null)} />
      )}

      {dialog?.kind === 'result' && <BulkResultDialog summary={dialog.summary} onClose={() => setDialog(null)} />}

      {dialog?.kind === 'duplicate' && (
        <DuplicateDialog
          profile={dialog.profile}
          onClose={() => setDialog(null)}
          onDone={(result) => {
            setDialog(null)
            data.notify(
              result.data === 'scheduled' ? 'info' : 'success',
              [t('dup.done', { name: result.profile.name }), ...result.details.slice(0, 1)].join(' ')
            )
            void data.refresh()
          }}
        />
      )}

      {dialog?.kind === 'backup-choice' && (
        <BackupChoiceDialog
          count={selection.length}
          onClose={() => setDialog(null)}
          onMetadata={() => {
            setDialog(null)
            void unwrap(window.pob.backupMetadata(selection))
              .then((entry) => data.notify('success', t('backup.metaDone', { file: entry.fileName ?? '' })))
              .catch((error) => data.notify('error', errorMessage(error)))
          }}
          onFull={() => setDialog({ kind: 'full-backup', profiles: data.profiles.filter((p) => selection.includes(p.id)) })}
        />
      )}

      {dialog?.kind === 'full-backup' && (
        <FullBackupDialog
          profiles={dialog.profiles}
          backupFolder={data.settings?.backupFolder ?? null}
          onClose={() => setDialog(null)}
          onFinished={() => {}}
        />
      )}

      {sharedProxyDialog}
    </section>
  )
}

/**
 * Delete confirmation that makes the user choose explicitly between removing only the profile
 * records and also removing the local browser data (which signs them out of those accounts).
 */
function DeleteDialog(props: {
  title: string
  intro: string
  warning?: string
  confirmLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: (clearData: boolean) => void
}) {
  const { t } = useI18n()
  const [scope, setScope] = useState<'metadata' | 'data' | null>(null)
  return (
    <ConfirmDialog
      title={props.title}
      message={props.intro}
      confirmLabel={props.confirmLabel}
      danger
      busy={props.busy}
      confirmDisabled={scope === null}
      onCancel={props.onCancel}
      onConfirm={() => scope && props.onConfirm(scope === 'data')}
    >
      {props.warning && <div className="alert warn-box">{props.warning}</div>}
      <fieldset className="choice-list" data-testid="delete-scope">
        <label className={`choice ${scope === 'metadata' ? 'chosen' : ''}`}>
          <input type="radio" name="delete-scope" checked={scope === 'metadata'} onChange={() => setScope('metadata')} />
          <span>
            <strong>{t('bulk.deleteMetadataOnly')}</strong>
            <small>{t('bulk.deleteMetadataOnlyHint')}</small>
          </span>
        </label>
        <label className={`choice ${scope === 'data' ? 'chosen' : ''}`}>
          <input type="radio" name="delete-scope" checked={scope === 'data'} onChange={() => setScope('data')} />
          <span>
            <strong>{t('bulk.deleteWithData')}</strong>
            <small>{t('bulk.deleteWithDataHint')}</small>
          </span>
        </label>
      </fieldset>
    </ConfirmDialog>
  )
}

function BulkMoveDialog(props: {
  count: number
  data: AppData
  busy: boolean
  onCancel: () => void
  onConfirm: (groupId: string | null) => void
}) {
  const { t } = useI18n()
  const [groupId, setGroupId] = useState<string | null>(props.data.groups[0]?.id ?? null)
  return (
    <Modal title={t('bulk.moveTitle', { count: props.count })} onClose={props.onCancel} width={440}>
      <GroupSelect groups={props.data.groups} value={groupId} onChange={setGroupId} label={t('form.group')} />
      {groupId === null && <p className="hint">{t('bulk.ungroup')}</p>}
      <div className="form-actions">
        <button type="button" className="button" onClick={props.onCancel} disabled={props.busy}>
          {t('common.cancel')}
        </button>
        <button type="button" className="button primary" onClick={() => props.onConfirm(groupId)} disabled={props.busy}>
          {t('bulk.moveAction')}
        </button>
      </div>
    </Modal>
  )
}

function BulkTagsDialog(props: {
  count: number
  data: AppData
  existingTags: string[]
  busy: boolean
  onCancel: () => void
  onConfirm: (add: string[], remove: string[]) => void
}) {
  const { t } = useI18n()
  const [add, setAdd] = useState<string[]>([])
  const [remove, setRemove] = useState<string[]>([])
  const removable = props.data.tags.filter((tag) => props.existingTags.includes(tag.name))
  return (
    <Modal title={t('bulk.tagsTitle', { count: props.count })} onClose={props.onCancel} width={480}>
      <TagInput label={t('bulk.addTags')} value={add} onChange={setAdd} suggestions={props.data.tags} />
      <TagInput label={t('bulk.removeTags')} value={remove} onChange={setRemove} suggestions={removable} />
      <div className="form-actions">
        <button type="button" className="button" onClick={props.onCancel} disabled={props.busy}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => props.onConfirm(add, remove)}
          disabled={props.busy || (add.length === 0 && remove.length === 0)}
        >
          {t('bulk.applyTags')}
        </button>
      </div>
    </Modal>
  )
}
