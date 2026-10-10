import { ValidationError } from '@shared/validation'

export const MAX_TABS_PER_WINDOW = 20

export type TabPosition = 'end' | 'after-active'

export interface AddTabOptions {
  /** Make the new tab the active one (default true). */
  activate?: boolean
  /** `end` for Ctrl+T / the + button, `after-active` for links opened in a new tab. */
  position?: TabPosition
}

export interface RemoveResult<T> {
  removed: T
  /** The tab that is now active (unchanged if a background tab was closed), or null if none remain. */
  activeId: string | null
}

/**
 * Ordered set of tabs with one active tab — the browser rules without any Electron objects:
 * - closing the active tab activates its right neighbour, or the left one if it was last
 * - tabs opened from a link are placed right after the active tab
 * - the number of tabs per window is limited
 */
export class TabList<T> {
  private readonly order: string[] = []
  private readonly items = new Map<string, T>()
  private activeId: string | null = null
  /** Which tab each link-opened tab came from, to keep sibling links in order. */
  private readonly openedFrom = new Map<string, string | null>()

  constructor(private readonly maxTabs: number = MAX_TABS_PER_WINDOW) {}

  get size(): number {
    return this.order.length
  }

  get active(): string | null {
    return this.activeId
  }

  ids(): string[] {
    return [...this.order]
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  activeItem(): T | undefined {
    return this.activeId ? this.items.get(this.activeId) : undefined
  }

  values(): T[] {
    return this.order.map((id) => this.items.get(id)!)
  }

  canAdd(): boolean {
    return this.order.length < this.maxTabs
  }

  add(id: string, item: T, options: AddTabOptions = {}): void {
    if (this.items.has(id)) throw new Error(`Duplicate tab id ${id}`)
    if (!this.canAdd()) {
      throw new ValidationError(`A window can have at most ${this.maxTabs} tabs. Close a tab first.`)
    }
    const { activate = true, position = 'end' } = options
    const activeIndex = this.activeId ? this.order.indexOf(this.activeId) : -1
    if (position === 'after-active' && activeIndex !== -1) {
      // Keep consecutive background links in the order they were opened.
      let insertAt = activeIndex + 1
      while (insertAt < this.order.length && this.openedFrom.get(this.order[insertAt]!) === this.activeId) {
        insertAt++
      }
      this.order.splice(insertAt, 0, id)
      this.openedFrom.set(id, this.activeId)
    } else {
      this.order.push(id)
    }
    this.items.set(id, item)
    if (activate || this.activeId === null) this.activeId = id
  }

  remove(id: string): RemoveResult<T> {
    const index = this.order.indexOf(id)
    if (index === -1) throw new Error(`Unknown tab id ${id}`)
    const removed = this.items.get(id)!
    this.order.splice(index, 1)
    this.items.delete(id)
    this.openedFrom.delete(id)
    if (this.activeId === id) {
      this.activeId = this.order[index] ?? this.order[index - 1] ?? null
    }
    return { removed, activeId: this.activeId }
  }

  activate(id: string): boolean {
    if (!this.items.has(id)) return false
    this.activeId = id
    // Once the user moves around, new links no longer group behind the old opener.
    this.openedFrom.clear()
    return true
  }

  /** Activates the next (+1) or previous (-1) tab, wrapping around. */
  cycle(direction: 1 | -1): string | null {
    if (this.order.length === 0 || !this.activeId) return null
    const index = this.order.indexOf(this.activeId)
    const next = this.order[(index + direction + this.order.length) % this.order.length]!
    this.activate(next)
    return next
  }

  /** Activates the tab at a 0-based position; `-1` selects the last tab (like Ctrl+9). */
  activateIndex(index: number): string | null {
    const id = index === -1 ? this.order[this.order.length - 1] : this.order[index]
    if (!id) return null
    this.activate(id)
    return id
  }
}
