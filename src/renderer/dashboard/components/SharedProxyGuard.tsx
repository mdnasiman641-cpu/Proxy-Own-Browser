import { useCallback, useState } from 'react'
import type { SaveProfileOptions } from '@shared/types'
import { errorMessage } from '../../common/ipc'
import { useI18n } from '../i18n'
import { ConfirmDialog } from './Modal'

/** Main-process message when "Require unique proxy assignment" blocks a save. */
const SHARED_PROXY = /Unique proxy assignment is on/

interface Pending {
  message: string
  retry: () => Promise<void>
}

/**
 * Wraps a save so that, when the unique-proxy rule blocks it, the user is asked to confirm the
 * shared proxy explicitly; the save is then repeated with `allowSharedProxy`.
 */
export function useSharedProxyGuard() {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)

  const guard = useCallback(
    async (save: (options: SaveProfileOptions) => Promise<void>): Promise<void> => {
      try {
        await save({})
      } catch (error) {
        const message = errorMessage(error)
        if (!SHARED_PROXY.test(message)) throw error
        setPending({ message, retry: () => save({ allowSharedProxy: true }) })
      }
    },
    []
  )

  const dialog = pending ? (
    <SharedProxyConfirm
      message={pending.message}
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        setBusy(true)
        try {
          await pending.retry()
          setPending(null)
        } finally {
          setBusy(false)
        }
      }}
    />
  ) : null

  return { guard, dialog }
}

function SharedProxyConfirm(props: { message: string; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  return (
    <ConfirmDialog
      title={t('shared.title')}
      message={
        <>
          <p>{props.message}</p>
          <p className="small muted">{t('shared.note')}</p>
        </>
      }
      confirmLabel={t('shared.confirm')}
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
