import { useCallback, useState } from 'react'
import { RUNNING_PROXY_CHANGE_MESSAGE } from '@shared/proxy'
import type { SaveProfileOptions } from '@shared/types'
import { errorMessage } from '../../common/ipc'
import { useI18n } from '../i18n'
import { ConfirmDialog } from './Modal'

/** Main-process message when "Require unique proxy assignment" blocks a save. */
const SHARED_PROXY = /Unique proxy assignment is on/

type Reason = 'shared' | 'running'

interface Pending {
  reason: Reason
  message: string
  retry: () => Promise<void>
}

/**
 * Wraps a profile save so the main process can ask for explicit confirmation:
 * - the unique-proxy rule blocks a proxy another profile uses (`allowSharedProxy`);
 * - the profile is open and its proxy would change (`confirmRunningProxyChange`).
 * Each confirmation is added to the options and the save is repeated; nothing is saved
 * before the user confirms.
 */
export function useSharedProxyGuard() {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)

  const guard = useCallback(async (save: (options: SaveProfileOptions) => Promise<void>): Promise<void> => {
    const attempt = async (options: SaveProfileOptions): Promise<void> => {
      try {
        await save(options)
      } catch (error) {
        const message = errorMessage(error)
        if (SHARED_PROXY.test(message) && !options.allowSharedProxy) {
          setPending({ reason: 'shared', message, retry: () => attempt({ ...options, allowSharedProxy: true }) })
        } else if (message.includes(RUNNING_PROXY_CHANGE_MESSAGE.slice(0, 40)) && !options.confirmRunningProxyChange) {
          setPending({ reason: 'running', message, retry: () => attempt({ ...options, confirmRunningProxyChange: true }) })
        } else {
          throw error
        }
      }
    }
    await attempt({})
  }, [])

  const dialog = pending ? (
    <GuardConfirm
      key={pending.reason}
      reason={pending.reason}
      message={pending.message}
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        setBusy(true)
        const current = pending
        try {
          await current.retry()
          // Close this dialog unless the retry asked for the other confirmation.
          setPending((p) => (p === current ? null : p))
        } finally {
          setBusy(false)
        }
      }}
    />
  ) : null

  return { guard, dialog }
}

function GuardConfirm(props: { reason: Reason; message: string; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const running = props.reason === 'running'
  return (
    <ConfirmDialog
      title={running ? t('running.title') : t('shared.title')}
      message={
        running ? (
          <>
            <p>{t('running.body')}</p>
            <p className="small muted">{t('running.note')}</p>
          </>
        ) : (
          <>
            <p>{props.message}</p>
            <p className="small muted">{t('shared.note')}</p>
          </>
        )
      }
      confirmLabel={running ? t('running.confirm') : t('shared.confirm')}
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={() => {
        setError(null)
        props.onConfirm().catch((e) => setError(errorMessage(e)))
      }}
    >
      {error && <div className="alert error">{error}</div>}
    </ConfirmDialog>
  )
}
