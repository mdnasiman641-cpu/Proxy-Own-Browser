import { useEffect, type ReactNode } from 'react'
import { Icon } from '../../common/Icon'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}

export function Modal({ title, onClose, children, width = 560 }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

interface ConfirmProps {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
}

export function ConfirmDialog(props: ConfirmProps) {
  return (
    <Modal title={props.title} onClose={props.onCancel} width={440}>
      <div className="confirm-message">{props.message}</div>
      {props.children}
      <div className="form-actions">
        <button type="button" className="button" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
        <button
          type="button"
          className={`button ${props.danger ? 'danger' : 'primary'}`}
          onClick={props.onConfirm}
          disabled={props.busy}
          autoFocus
        >
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
