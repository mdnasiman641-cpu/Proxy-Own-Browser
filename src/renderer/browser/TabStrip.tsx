import type { TabState } from '@shared/types'
import { Icon } from '../common/Icon'

interface TabStripProps {
  tabs: TabState[]
  activeTabId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export function TabStrip({ tabs, activeTabId, onActivate, onClose, onNew }: TabStripProps) {
  return (
    <div className="tabstrip">
      <div className="tabs" role="tablist" aria-label="Tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              title={tab.url && tab.url !== 'about:blank' ? `${tab.title}\n${tab.url}` : tab.title}
              className={`tab ${active ? 'active' : ''} ${tab.crashed ? 'crashed' : ''}`}
              data-tab-id={tab.id}
              onMouseDown={(e) => {
                if (e.button === 0) onActivate(tab.id)
              }}
              onAuxClick={(e) => {
                // Middle-click closes a tab, as in other browsers.
                if (e.button === 1) onClose(tab.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onActivate(tab.id)
              }}
            >
              <span className="tab-icon" aria-hidden="true">
                {tab.isLoading ? (
                  <span className="spinner" />
                ) : tab.crashed ? (
                  <Icon name="warning" size={14} />
                ) : (
                  <span className="tab-dot" />
                )}
              </span>
              <span className="tab-title">{tab.title}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.title}`}
                title="Close tab (Ctrl+W)"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onClose(tab.id)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" className="new-tab" aria-label="New tab" title="New tab (Ctrl+T)" onClick={onNew}>
        <Icon name="plus" size={18} />
      </button>
    </div>
  )
}
