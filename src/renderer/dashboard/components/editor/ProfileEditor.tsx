import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Profile, RuntimeInfo } from '@shared/types'
import { Icon, type IconName } from '../../../common/Icon'
import { errorMessage, unwrap } from '../../../common/ipc'
import { useI18n } from '../../i18n'
import type { TKey } from '../../strings'
import type { AppData } from '../../useAppData'
import { StatusBadge } from '../Bits'
import { ConfirmDialog } from '../Modal'
import { ProfileAvatar } from '../ProfileBadge'
import { useSharedProxyGuard } from '../SharedProxyGuard'
import { draftFromProfile, draftKey, draftToUpdate, validateDraft, type EditorDraft } from './draft'
import { DiagnosticsSection, ExtensionsCookiesSection, SummaryPanel } from './live'
import { AdvancedSection, BrowserSection, GeneralSection, HardwareSection, PrivacySection, ProxySection, type SectionProps } from './sections'

export type EditorTab = 'general' | 'proxy' | 'privacy' | 'browser' | 'hardware' | 'extensions' | 'advanced' | 'diagnostics'

const TABS: { id: EditorTab; label: TKey; icon: IconName; live?: boolean }[] = [
  { id: 'general', label: 'ed.tab.general', icon: 'profiles' },
  { id: 'proxy', label: 'ed.tab.proxy', icon: 'proxy' },
  { id: 'privacy', label: 'ed.tab.privacy', icon: 'shield' },
  { id: 'browser', label: 'ed.tab.browser', icon: 'globe' },
  { id: 'hardware', label: 'ed.tab.hardware', icon: 'layers' },
  { id: 'extensions', label: 'ed.tab.extensions', icon: 'grid', live: true },
  { id: 'advanced', label: 'ed.tab.advanced', icon: 'settings' },
  { id: 'diagnostics', label: 'ed.tab.diagnostics', icon: 'info', live: true }
]

/** Which tab each validation error belongs to, so the editor can jump there. */
const ERROR_TAB: Record<string, EditorTab> = {
  name: 'general',
  notes: 'general',
  proxyHost: 'proxy',
  proxyPort: 'proxy',
  proxyUser: 'proxy',
  timezone: 'privacy',
  latitude: 'privacy',
  longitude: 'privacy',
  language: 'browser',
  acceptLanguage: 'browser',
  userAgent: 'browser',
  startUrl: 'advanced',
  startupUrls: 'advanced',
  downloadFolder: 'advanced'
}

interface EditorProps {
  data: AppData
  profile: Profile
  initialTab: EditorTab
  onClose: () => void
}

/**
 * Full-screen profile editor: categories on the left, the selected category's settings in the
 * middle (scrolling on its own), the effective configuration on the right, and Save / Cancel
 * always visible. Settings are saved together; extensions, site data and diagnostics act
 * immediately and say so.
 */
export function ProfileEditor({ data, profile, initialTab, onClose }: EditorProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<EditorTab>(initialTab)
  const [base, setBase] = useState<EditorDraft>(() => draftFromProfile(profile))
  const [draft, setDraft] = useState<EditorDraft>(base)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [needsReopen, setNeedsReopen] = useState(false)
  const { guard, dialog: guardDialog } = useSharedProxyGuard()
  const contentRef = useRef<HTMLDivElement>(null)

  const dirty = draftKey(draft) !== draftKey(base)
  const errors = useMemo(() => validateDraft(draft), [draft])
  const errorCount = Object.keys(errors).length
  const running = (data.statuses[profile.id] ?? 'closed') !== 'closed'

  useEffect(() => {
    unwrap(window.pob.runtimeInfo())
      .then(setRuntime)
      .catch(() => setRuntime(null))
  }, [])
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const requestClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }, [dirty, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Nested dialogs handle their own Escape.
      if (e.key === 'Escape' && !confirmDiscard && !guardDialog && !document.querySelector('.modal-backdrop')) requestClose()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        document.querySelector<HTMLButtonElement>('[data-testid="editor-save"]')?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose, confirmDiscard, guardDialog])

  const save = async (): Promise<void> => {
    setShowErrors(true)
    if (errorCount > 0) {
      const first = Object.keys(errors)[0]!
      setTab(ERROR_TAB[first] ?? tab)
      setSaveError(t('ed.fixErrors', { count: errorCount }))
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await guard(async (options) => {
        const before = profile
        const saved = await data.updateProfile(profile.id, draftToUpdate(draft, profile), options)
        const next = draftFromProfile(saved)
        setBase(next)
        setDraft(next)
        setSavedAt(Date.now())
        setShowErrors(false)
        // Settings that only apply when the window opens.
        if (running) {
          const startOnly =
            before.browser.windowWidth !== saved.browser.windowWidth ||
            before.browser.windowHeight !== saved.browser.windowHeight ||
            JSON.stringify(before.options.startupUrls) !== JSON.stringify(saved.options.startupUrls) ||
            before.options.startupMode !== saved.options.startupMode ||
            before.options.windowMode !== saved.options.windowMode
          if (startOnly) setNeedsReopen(true)
        }
        data.notify('success', t('profiles.saved', { name: saved.name }))
      })
    } catch (e) {
      setSaveError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const reopen = async (): Promise<void> => {
    try {
      await unwrap(window.pob.reopenProfile(profile.id))
      setNeedsReopen(false)
    } catch (e) {
      setSaveError(errorMessage(e))
    }
  }

  const sectionProps: SectionProps = {
    draft,
    update: (fn) => setDraft((d) => fn(d)),
    errors: showErrors ? errors : {},
    profile,
    data,
    runtime
  }
  const tabErrors = (id: EditorTab): number => (showErrors ? Object.keys(errors).filter((k) => ERROR_TAB[k] === id).length : 0)
  const current = TABS.find((x) => x.id === tab)!

  return (
    <div className="editor-backdrop">
      <div className="editor" role="dialog" aria-modal="true" aria-label={t('ed.title', { name: profile.name })} data-testid="profile-editor">
        <header className="editor-header">
          <ProfileAvatar profile={profile} size={36} />
          <div className="editor-title">
            <h2>{t('ed.title', { name: profile.name })}</h2>
            <span className="small muted">
              <StatusBadge status={data.statuses[profile.id] ?? 'closed'} /> · <span className="mono">{profile.id}</span>
            </span>
          </div>
          <button type="button" className="icon-button" onClick={requestClose} aria-label={t('common.close')}>
            <Icon name="close" />
          </button>
        </header>

        <div className="editor-body">
          <nav className="editor-nav" aria-label={t('ed.categories')}>
            {TABS.map((x) => (
              <button
                key={x.id}
                type="button"
                className={`editor-nav-item ${tab === x.id ? 'active' : ''}`}
                aria-current={tab === x.id ? 'page' : undefined}
                onClick={() => setTab(x.id)}
                data-editor-tab={x.id}
              >
                <Icon name={x.icon} size={16} />
                <span>{t(x.label)}</span>
                {tabErrors(x.id) > 0 && <span className="editor-error-dot" aria-label={t('ed.tabHasErrors')}>{tabErrors(x.id)}</span>}
              </button>
            ))}
          </nav>

          <div className="editor-content" ref={contentRef} data-testid={`editor-tab-${tab}`}>
            <h2 className="editor-tab-title">{t(current.label)}</h2>
            {current.live && <div className="alert info small">{t('ed.liveNote')}</div>}
            {needsReopen && (
              <div className="alert warning small" data-testid="reopen-notice">
                {t('ed.reopenNeeded')}{' '}
                <button type="button" className="button small" onClick={() => void reopen()}>
                  {t('ed.reopen')}
                </button>
              </div>
            )}
            {tab === 'general' && <GeneralSection {...sectionProps} />}
            {tab === 'proxy' && <ProxySection {...sectionProps} />}
            {tab === 'privacy' && <PrivacySection {...sectionProps} />}
            {tab === 'browser' && <BrowserSection {...sectionProps} />}
            {tab === 'hardware' && <HardwareSection {...sectionProps} />}
            {tab === 'extensions' && <ExtensionsCookiesSection profile={profile} data={data} />}
            {tab === 'advanced' && <AdvancedSection {...sectionProps} />}
            {tab === 'diagnostics' && <DiagnosticsSection profile={profile} data={data} />}
          </div>

          <SummaryPanel profile={profile} data={data} dirty={dirty} refreshKey={`${profile.updatedAt}|${savedAt}`} />
        </div>

        <footer className="editor-footer">
          <span className={`small ${dirty ? 'warn' : 'muted'}`} data-testid="editor-dirty">
            {saving ? t('common.saving') : dirty ? t('ed.unsaved') : t('ed.allSaved')}
          </span>
          {saveError && <span className="field-error" role="alert">{saveError}</span>}
          <div className="editor-footer-actions">
            <button type="button" className="button" disabled={saving || !dirty} onClick={() => setDraft(base)}>
              {t('ed.revert')}
            </button>
            <button type="button" className="button" onClick={requestClose} disabled={saving}>
              {dirty ? t('common.cancel') : t('common.close')}
            </button>
            <button type="button" className="button primary" disabled={saving || !dirty} onClick={() => void save()} data-testid="editor-save">
              {saving ? t('common.saving') : t('ed.save')}
            </button>
          </div>
        </footer>
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title={t('ed.discardTitle')}
          message={<p>{t('ed.discardBody')}</p>}
          confirmLabel={t('ed.discard')}
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false)
            onClose()
          }}
        />
      )}
      {guardDialog}
    </div>
  )
}

// ---------------------------------------------------------------- host

interface EditorContextValue {
  openEditor: (profileId: string, tab?: EditorTab) => void
}

const EditorContext = createContext<EditorContextValue>({ openEditor: () => {} })

export function useProfileEditor(): EditorContextValue {
  return useContext(EditorContext)
}

/** Holds the one open editor for the whole dashboard. */
export function ProfileEditorHost({ data, children }: { data: AppData; children: ReactNode }) {
  const [open, setOpen] = useState<{ id: string; tab: EditorTab } | null>(null)
  const openEditor = useCallback((id: string, tab: EditorTab = 'general') => setOpen({ id, tab }), [])
  const value = useMemo(() => ({ openEditor }), [openEditor])
  const profile = open ? data.profiles.find((p) => p.id === open.id) : undefined
  useEffect(() => {
    // The profile was deleted while its editor was open.
    if (open && !data.loading && !profile) setOpen(null)
  }, [open, profile, data.loading])
  return (
    <EditorContext.Provider value={value}>
      {children}
      {open && profile && <ProfileEditor key={open.id} data={data} profile={profile} initialTab={open.tab} onClose={() => setOpen(null)} />}
    </EditorContext.Provider>
  )
}
