import { useState, type FormEvent } from 'react'
import { parseProxyString } from '@shared/proxy'
import {
  PROXY_PROTOCOLS,
  type Profile,
  type ProfileUpdate,
  type ProxyInput,
  type ProxyProtocol
} from '@shared/types'
import { LIMITS, PROFILE_COLORS } from '@shared/validation'
import { errorMessage } from '../../common/ipc'

interface ProfileFormProps {
  initial?: Profile
  /** "proxy" shows only the proxy section (used on the Proxy Settings page). */
  mode?: 'full' | 'proxy'
  submitLabel: string
  onSubmit: (input: ProfileUpdate) => Promise<void>
  onCancel: () => void
}

export function ProfileForm({ initial, mode = 'full', submitLabel, onSubmit, onCancel }: ProfileFormProps) {
  const p = initial?.proxy
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

  const isSocks = protocol === 'socks4' || protocol === 'socks5'
  const hasStoredPassword = Boolean(p?.hasPassword) && !clearPassword

  const applyPaste = (): void => {
    const parsed = parseProxyString(paste)
    if (!parsed) {
      setError('Proxy not recognised. Use host:port, host:port:user:pass or scheme://user:pass@host:port')
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

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const proxy = buildProxy()
      await onSubmit(
        mode === 'proxy'
          ? { proxy }
          : { name: name.trim(), notes, color, startUrl: startUrl.trim() || null, proxy }
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
            <span>Profile name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={LIMITS.nameMax}
              placeholder="e.g. Shop page — Facebook"
              autoFocus
              required
            />
          </label>
          <div className="field">
            <span>Color</span>
            <div className="swatches" role="radiogroup" aria-label="Profile color">
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
          <label className="field">
            <span>Start page (optional)</span>
            <input
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder="https://… — leave empty to use the app homepage"
              maxLength={LIMITS.urlMax}
            />
          </label>
          <label className="field">
            <span>Notes (optional)</span>
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
            <span>Use a proxy for this profile</span>
          </label>
        </legend>

        {proxyEnabled ? (
          <>
            <div className="paste-row">
              <input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder="Paste proxy: host:port:user:pass"
                aria-label="Paste proxy string"
                autoComplete="off"
              />
              <button type="button" className="button" onClick={applyPaste} disabled={!paste.trim()}>
                Fill
              </button>
            </div>
            <div className="grid-3">
              <label className="field">
                <span>Type</span>
                <select value={protocol} onChange={(e) => setProtocol(e.target.value as ProxyProtocol)}>
                  {PROXY_PROTOCOLS.map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Host</span>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="1.2.3.4" />
              </label>
              <label className="field">
                <span>Port</span>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  placeholder="8080"
                />
              </label>
            </div>
            {isSocks ? (
              <p className="hint">
                SOCKS proxies are used without a username/password — Chromium cannot authenticate to
                SOCKS servers.
              </p>
            ) : (
              <div className="grid-2">
                <label className="field">
                  <span>Username (optional)</span>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={hasStoredPassword ? 'Saved — leave empty to keep' : ''}
                    autoComplete="new-password"
                  />
                  {p?.hasPassword && (
                    <label className="toggle small">
                      <input
                        type="checkbox"
                        checked={clearPassword}
                        onChange={(e) => setClearPassword(e.target.checked)}
                      />
                      <span>Remove saved password</span>
                    </label>
                  )}
                </label>
              </div>
            )}
            <label className="field">
              <span>Bypass list (optional)</span>
              <input
                value={bypass}
                onChange={(e) => setBypass(e.target.value)}
                placeholder="localhost, *.example.com"
              />
            </label>
          </>
        ) : (
          <p className="hint">This profile connects directly without a proxy.</p>
        )}
      </fieldset>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
