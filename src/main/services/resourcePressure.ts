import type { ResourcePressure } from '@shared/types'

/**
 * Memory warnings for the resource panel. Advisory only: nothing is ever closed or deleted
 * because of them.
 */
export function assessPressure(input: {
  totalMemoryMb: number
  freeMemoryMb: number
  appMemoryMb: number
  openWindows: number
  maxOpenProfiles: number
}): ResourcePressure {
  const messages: string[] = []
  let level: ResourcePressure['level'] = 'ok'
  const raise = (to: ResourcePressure['level']): void => {
    if (to === 'high' || (to === 'warning' && level === 'ok')) level = to
  }
  const { totalMemoryMb: total, freeMemoryMb: free, appMemoryMb: app } = input

  if (total > 0) {
    const freeShare = free / total
    if (freeShare < 0.1 || free < 800) {
      raise('high')
      messages.push(
        `This PC has only ${Math.round(free)} MB of free memory. Close some profile windows or other programs before opening more.`
      )
    } else if (freeShare < 0.2) {
      raise('warning')
      messages.push(`Free memory is getting low (${Math.round(free)} MB). Opening more profiles may slow the PC down.`)
    }
    if (app > total * 0.5) {
      raise('warning')
      messages.push(`Proxy Own Browser is using about ${Math.round(app)} MB — more than half of this PC's memory.`)
    }
  }
  if (input.openWindows >= input.maxOpenProfiles && level !== 'ok') {
    messages.push('The open-window limit is reached; consider keeping it at this level.')
  }
  return { level, messages }
}
