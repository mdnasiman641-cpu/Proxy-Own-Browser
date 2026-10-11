import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

/** Current time, refreshed every 30 seconds while shown (a local clock — no network). */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Time and UTC offset right now in an IANA time zone, e.g. "3:09 PM · Sun, Oct 11 · GMT+6". */
export function formatInZone(date: Date, timeZone: string, locale: string): string | null {
  try {
    const time = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(date)
    const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(date)
    const offset =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
    return [time, day, offset].filter(Boolean).join(' · ')
  } catch {
    return null
  }
}

/** Live local time in a time zone, or "Unknown" without one. */
export function LocalTime({ timeZone }: { timeZone: string | null | undefined }) {
  const { t, locale } = useI18n()
  const now = useNow()
  const text = timeZone ? formatInZone(now, timeZone, locale) : null
  if (!text) return <span className="muted">{t('net.unknown')}</span>
  return (
    <span className="local-time" title={timeZone ?? undefined} data-testid="local-time">
      {text}
    </span>
  )
}
