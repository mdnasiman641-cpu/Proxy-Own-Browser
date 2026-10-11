import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { NavigationState } from '@shared/types'
import { Icon } from '../common/Icon'
import { TabStrip } from './TabStrip'

const EMPTY: NavigationState = {
  url: '',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  profileName: '',
  profileColor: '#2563eb',
  proxyLabel: null,
  timezoneLabel: null,
  notice: null,
  tabs: [],
  activeTabId: null
}

export function Toolbar() {
  const api = window.pobBrowser
  const [state, setState] = useState<NavigationState>(EMPTY)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void api.getState().then((r) => r.ok && setState(r.data))
    const offState = api.onState(setState)
    const offFocus = api.onFocusAddressBar(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => {
      offState()
      offFocus()
    }
  }, [api])

  // Keep the address bar in sync with the page unless the user is typing.
  useEffect(() => {
    if (!editing) setAddress(state.url === 'about:blank' ? '' : state.url)
  }, [state.url, editing])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!address.trim()) return
    void api.navigate(address)
    setEditing(false)
    inputRef.current?.blur()
  }

  const secure = state.url.startsWith('https://')

  return (
    <div className="chrome" style={{ ['--profile-color' as string]: state.profileColor }}>
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivate={(id) => void api.activateTab(id)}
        onClose={(id) => void api.closeTab(id)}
        onNew={() => void api.newTab()}
      />
    <div className="toolbar">
      <div className="nav-buttons">
        <button type="button" title="Back (Alt+←)" aria-label="Back" disabled={!state.canGoBack} onClick={() => void api.back()}>
          <Icon name="back" />
        </button>
        <button
          type="button"
          title="Forward (Alt+→)"
          aria-label="Forward"
          disabled={!state.canGoForward}
          onClick={() => void api.forward()}
        >
          <Icon name="forward" />
        </button>
        {state.isLoading ? (
          <button type="button" title="Stop" aria-label="Stop loading" onClick={() => void api.stop()}>
            <Icon name="close" />
          </button>
        ) : (
          <button type="button" title="Reload (F5)" aria-label="Reload" onClick={() => void api.reload()}>
            <Icon name="reload" />
          </button>
        )}
        <button type="button" title="Home" aria-label="Home" onClick={() => void api.home()}>
          <Icon name="home" />
        </button>
      </div>

      <form className="address" onSubmit={submit}>
        <span className={`scheme ${secure ? 'secure' : ''}`} title={secure ? 'Secure connection' : 'Not secure'}>
          {secure ? <Icon name="lock" size={15} /> : <Icon name="search" size={15} />}
        </span>
        <input
          ref={inputRef}
          value={address}
          onChange={(e) => {
            setEditing(true)
            setAddress(e.target.value)
          }}
          onFocus={(e) => e.target.select()}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setEditing(false)
              setAddress(state.url)
              e.currentTarget.blur()
            }
          }}
          placeholder="Search or type a web address"
          aria-label="Address bar"
          spellCheck={false}
          maxLength={2048}
        />
      </form>

      {state.notice && !state.error && (
        <div className="error-chip notice" role="status" title={state.notice}>
          <Icon name="warning" size={15} />
          <span>{state.notice}</span>
        </div>
      )}

      {state.error && (
        <div className="error-chip" role="alert" title={state.error}>
          <Icon name="warning" size={15} />
          <span>{state.error}</span>
        </div>
      )}

      <div
        className="profile-info"
        title={[
          state.proxyLabel ? `Proxy: ${state.proxyLabel}` : 'Direct connection (no proxy)',
          `Time zone: ${state.timezoneLabel ?? "this PC's time zone"}`
        ].join('\n')}
      >
        <span className="dot" />
        <span className="labels">
          <span className="name">{state.profileName}</span>
          <span className="proxy">
            {state.proxyLabel ?? 'Direct connection'}
            {state.timezoneLabel ? ` · ${state.timezoneLabel.replace(/ \(.*\)$/, '')}` : ''}
          </span>
        </span>
      </div>

      <div className={`progress ${state.isLoading ? 'active' : ''}`} aria-hidden="true" />
    </div>
    </div>
  )
}
