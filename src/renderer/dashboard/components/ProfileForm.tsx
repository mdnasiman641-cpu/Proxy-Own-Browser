import { useState, type FormEvent } from 'react'
import { parseProxyString } from '@shared/proxy'
import {
  PROXY_PROTOCOLS,
  type Profile,
  type ProfileUpdate,
  type ProxyInput,
  type ProxyProtocol,
  type ProxyTestResult
} from '@shared/types'
import { LIMITS, PROFILE_COLORS } from '@shared/validation'
import type { ProfileGroup, ProfileTag } from '@shared/types'
import { errorMessage, unwrap } from '../../common/ipc'
import { useI18n } from '../i18n'
import { GroupSelect, TagInput } from './Bits'
import { ProxyTestResultView } from './ProxyTestResultView'

interface ProfileFormProps {
  initial?: Profile
  /** "proxy" shows only the proxy section (used on the Proxy Settings page). */
  mode?: 'full' | 'proxy'
  submitLabel: string
  onSubmit: (input: ProfileUpdate) => Promise<void>
  onCancel: () => void
  groups?: ProfileGroup[]
  tagSuggestions?: ProfileTag[]
  /** Pre-selected group for a new profile (e.g. the group being filtered). */
  defaultGroupId?: string | null
}

export function ProfileForm({
  initial,
  mode = 'full',
  submitLabel,
  onSubmit,
  onCancel,
  groups = [],
  tagSuggestions = [],
  defaultGroupId = null
}: ProfileFormProps) {
  const { t } = useI18n()
  const p = initial?.proxy
  const [groupId, setGroupId] = useState<string | null>(initial ? initial.groupId : defaultGroupId)
  const [tags, setTags] = useState<string[]>(initial?.tags ?? [])
  const [name, setName] = useState(initial?.name ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [color, setColor] = useState(initial?.color ?? PROFILE_COLORS[0])
  const [startUrl, setStartUrl] = useState(initial?.startUrl ?? '')
  const [proxyEnabled, setProxyEnabled] = useState(Boolean(p))
  const [protocol, setProtocol] = useState<ProxyProtocol>(p?.protocol ?? 'http')
  const [host, setHost] = useState(p?.host ?? '')
  const [port, setPort] = useState(p ? String(p.port) : '')
  const [username, setUsername] = useState(p?.username ?? '')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [bypass, setBypass] = useState(p?.bypassRules ?? '')
  const [paste, setPaste] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  /** Result of the last test, tagged with the form values it was run against. */
  const [test, setTest] = useState<{ key: string; result?: ProxyTestResult; error?: string } | null>(
    null
  )

  const isSocks = protocol === 'socks4' || protocol === 'socks5'
  const hasStoredPassword = Boolean(p?.hasPassword) && !clearPassword

  const applyPaste = (): void => {
    const parsed = parseProxyString(paste)
    if (!parsed) {
      setError(t('form.pasteError'))
      return
    }
    setProxyEnabled(true)
    setProtocol(parsed.protocol)
    setHost(parsed.host)
    setPort(String(parsed.port))
    setUsername(parsed.username)
    setPassword(parsed.password)
    setClearPassword(false)
    setPaste('')
    setError(null)
  }

  const buildProxy = (): ProxyInput => {
    if (!proxyEnabled) return { enabled: false }
    if (isSocks) {
      return {
        enabled: true,
        protocol,
        host: host.trim(),
        port: Number(port),
        username: '',
        password: '',
        bypassRules: bypass.trim()
      }
    }
    let nextPassword: string | undefined
    if (password) nextPassword = password
    else if (clearPassword || !p?.hasPassword) nextPassword = ''
    return {
      enabled: true,
      protocol,
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      password: nextPassword,
      bypassRules: bypass.trim()
    }
  }

  const draftKey = JSON.stringify(buildProxy())
  const currentTest = test?.key === draftKey ? test : null

  /** Makes a real request through the proxy as currently entered (saved or not). */
  const runTest = async (): Promise<void> => {
    const key = draftKey
    setTesting(true)
    setTest(null)
    try {
      const result = await unwrap(window.pob.testProxy(initial?.id ?? null, buildProxy()))
      setTest({ key, result })
    } catch (e) {
      setTest({ key, error: errorMessage(e) })
    } finally {
      setTesting(false)
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const proxy = buildProxy()
      await onSubmit(
        mode === 'proxy'
          ? { proxy }
          : { name: name.trim(), notes, color, startUrl: startUrl.trim() || null, proxy, groupId, tags }
      )
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {mode === 'full' && (
        <>
          <label className="field">
            <span>{t('form.name')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={LIMITS.nameMax}
              placeholder={t('form.namePlaceholder')}
              autoFocus
              required
            />
          </label>
          <div className="field">
            <span>{t('form.color')}</span>
            <div className="swatches" role="radiogroup" aria-label={t('form.colorLabel')}>
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
            <GroupSelect groups={groups} value={groupId} onChange={setGroupId} />
            <TagInput label={t('form.tags')} value={tags} onChange={setTags} suggestions={tagSuggestions} />
          </div>
          <label className="field">
            <span>{t('form.startPage')}</span>
            <input
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder={t('form.startPagePlaceholder')}
              maxLength={LIMITS.urlMax}
            />
          </label>
          <label className="field">
            <span>{t('form.notes')}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={LIMITS.notesMax}
              rows={2}
            />
          </label>
        </>
      )}

      <fieldset className="proxy-fieldset">
        <legend>
          <label className="toggle">
            <input
              type="checkbox"
              checked={proxyEnabled}
              onChange={(e) => setProxyEnabled(e.target.checked)}
            />
            <span>{t('form.useProxy')}</span>
          </label>
        </legend>

        {proxyEnabled ? (
          <>
            <div className="paste-row">
              <input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={t('form.pastePlaceholder')}
                aria-label={t('form.pasteLabel')}
                autoComplete="off"
              />
              <button type="button" className="button" onClick={applyPaste} disabled={!paste.trim()}>
                {t('form.fill')}
              </button>
            </div>
            <div className="grid-3">
              <label className="field">
                <span>{t('form.type')}</span>
                <select value={protocol} onChange={(e) => setProtocol(e.target.value as ProxyProtocol)}>
                  {PROXY_PROTOCOLS.map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('form.host')}</span>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="1.2.3.4" />
              </label>
              <label className="field">
                <span>{t('form.port')}</span>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  placeholder="8080"
                />
              </label>
            </div>
            {isSocks ? (
              <p className="hint">{t('form.socksNote')}</p>
            ) : (
              <div className="grid-2">
                <label className="field">
                  <span>{t('form.username')}</span>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  <span>{t('form.password')}</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={hasStoredPassword ? t('form.passwordSaved') : ''}
                    autoComplete="new-password"
                  />
                  {p?.hasPassword && (
                    <label className="toggle small">
                      <input
                        type="checkbox"
                        checked={clearPassword}
                        onChange={(e) => setClearPassword(e.target.checked)}
                      />
                      <span>{t('form.removePassword')}</span>
                    </label>
                  )}
                </label>
              </div>
            )}
            <label className="field">
              <span>{t('form.bypass')}</span>
              <input
                value={bypass}
                onChange={(e) => setBypass(e.target.value)}
                placeholder="localhost, *.example.com"
              />
            </label>
            <div className="test-row">
              <button
                type="button"
                className="button"
                onClick={() => void runTest()}
                disabled={testing || busy}
                data-testid="test-proxy"
              >
                {testing ? t('form.testing') : t('form.testProxy')}
              </button>
              <span className="hint">{t('form.testHint')}</span>
            </div>
            {currentTest?.result && <ProxyTestResultView result={currentTest.result} />}
            {currentTest?.error && <div className="alert error">{currentTest.error}</div>}
          </>
        ) : (
          <p className="hint">{t('form.directNote')}</p>
        )}
      </fieldset>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? t('common.saving') : submitLabel}
        </button>
      </div>
    </form>
  )
}
