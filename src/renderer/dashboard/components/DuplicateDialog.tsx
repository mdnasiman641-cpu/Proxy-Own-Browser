import { useState, type FormEvent } from 'react'
import type { DuplicateMode, DuplicateResult, Profile } from '@shared/types'
import { LIMITS } from '@shared/validation'
import { errorMessage, unwrap } from '../../common/ipc'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import { useSharedProxyGuard } from './SharedProxyGuard'

interface Props {
  profile: Profile
  onClose: () => void
  onDone: (result: DuplicateResult) => void
}

/**
 * Duplicating always creates a new profile with its own new session. Copying browser data
 * (cookies, logins, site storage) is a separate, explicit choice.
 */
export function DuplicateDialog({ profile, onClose, onDone }: Props) {
  const { t } = useI18n()
  const suggested = `${profile.name} copy`.slice(0, LIMITS.nameMax)
  const [name, setName] = useState(suggested)
  const [mode, setMode] = useState<DuplicateMode>('settings')
  const [copyProxy, setCopyProxy] = useState(Boolean(profile.proxy))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { guard, dialog } = useSharedProxyGuard()

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await guard(async (options) => {
        const result = await unwrap(window.pob.duplicateProfile(profile.id, { name: name.trim(), mode, copyProxy }, options))
        onDone(result)
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('dup.title', { name: profile.name })} onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="field">
          <span>{t('dup.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.nameMax} autoFocus required />
        </label>
        <fieldset className="choice-list">
          <legend>{t('dup.what')}</legend>
          <label className={`choice ${mode === 'settings' ? 'chosen' : ''}`}>
            <input type="radio" name="dup-mode" checked={mode === 'settings'} onChange={() => setMode('settings')} />
            <span>
              <strong>{t('dup.settings')}</strong>
              <small>{t('dup.settingsHint')}</small>
            </span>
          </label>
          <label className={`choice ${mode === 'settings-and-data' ? 'chosen' : ''}`}>
            <input type="radio" name="dup-mode" checked={mode === 'settings-and-data'} onChange={() => setMode('settings-and-data')} />
            <span>
              <strong>{t('dup.data')}</strong>
              <small>{t('dup.dataHint')}</small>
            </span>
          </label>
        </fieldset>
        {profile.proxy && (
          <label className="toggle">
            <input type="checkbox" checked={copyProxy} onChange={(e) => setCopyProxy(e.target.checked)} />
            <span>{t('dup.copyProxy')}</span>
          </label>
        )}
        <p className="small muted">{t('dup.separate')}</p>
        {error && <div className="alert error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button primary" disabled={busy || !name.trim()}>
            {busy ? t('common.working') : t('dup.create')}
          </button>
        </div>
      </form>
      {dialog}
    </Modal>
  )
}
