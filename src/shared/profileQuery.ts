import type { Profile, ProfileGroup, ProfileRuntimeStatus } from './types'

export const SORT_KEYS = ['name', 'created', 'group', 'status', 'lastOpened'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDirection = 'asc' | 'desc'

/** `all` = no filter; `none` = only ungrouped profiles; otherwise a group id. */
export type GroupFilter = 'all' | 'none' | string
export type StatusFilter = 'all' | 'running' | 'closed'

export interface ProfileQuery {
  search: string
  group: GroupFilter
  /** Profiles must carry every listed tag (case-insensitive). */
  tags: string[]
  status: StatusFilter
  sort: SortKey
  direction: SortDirection
}

export const DEFAULT_QUERY: ProfileQuery = {
  search: '',
  group: 'all',
  tags: [],
  status: 'all',
  sort: 'name',
  direction: 'asc'
}

/** Running first, then starting, crashed, closed. */
const STATUS_ORDER: Record<ProfileRuntimeStatus, number> = { running: 0, starting: 1, crashed: 2, closed: 3 }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function filterAndSortProfiles(
  profiles: Profile[],
  query: ProfileQuery,
  statuses: Record<string, ProfileRuntimeStatus>,
  groups: ProfileGroup[]
): Profile[] {
  const status = (p: Profile): ProfileRuntimeStatus => statuses[p.id] ?? 'closed'
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const search = query.search.trim().toLocaleLowerCase()
  const wantedTags = query.tags.map((t) => t.toLocaleLowerCase())

  const filtered = profiles.filter((p) => {
    if (query.group === 'none' && p.groupId) return false
    if (query.group !== 'all' && query.group !== 'none' && p.groupId !== query.group) return false
    if (wantedTags.length) {
      const own = new Set(p.tags.map((t) => t.toLocaleLowerCase()))
      if (!wantedTags.every((t) => own.has(t))) return false
    }
    if (query.status === 'running' && status(p) === 'closed') return false
    if (query.status === 'closed' && status(p) !== 'closed') return false
    if (search) {
      const haystack = [
        p.name,
        p.notes,
        p.proxy?.host ?? '',
        p.groupId ? (groupName.get(p.groupId) ?? '') : '',
        ...p.tags
      ]
        .join('\n')
        .toLocaleLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })

  const byName = (a: Profile, b: Profile): number => collator.compare(a.name, b.name)
  const compare: Record<SortKey, (a: Profile, b: Profile) => number> = {
    name: byName,
    created: (a, b) => a.createdAt.localeCompare(b.createdAt) || byName(a, b),
    lastOpened: (a, b) => (a.lastOpenedAt ?? '').localeCompare(b.lastOpenedAt ?? '') || byName(a, b),
    // Ungrouped profiles sort after every group.
    group: (a, b) => {
      const ga = a.groupId ? groupName.get(a.groupId) : undefined
      const gb = b.groupId ? groupName.get(b.groupId) : undefined
      if (ga === undefined && gb !== undefined) return 1
      if (gb === undefined && ga !== undefined) return -1
      return collator.compare(ga ?? '', gb ?? '') || byName(a, b)
    },
    status: (a, b) => STATUS_ORDER[status(a)] - STATUS_ORDER[status(b)] || byName(a, b)
  }
  const sign = query.direction === 'desc' ? -1 : 1
  return [...filtered].sort((a, b) => sign * compare[query.sort](a, b))
}
