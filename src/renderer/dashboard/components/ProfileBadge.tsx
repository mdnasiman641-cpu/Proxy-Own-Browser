import type { Profile } from '@shared/types'

export function ProfileAvatar({ profile, size = 34 }: { profile: Profile; size?: number }) {
  const initials = profile.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span
      className="avatar"
      style={{ background: profile.color, width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initials || '?'}
    </span>
  )
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
