import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { CONFIGURABLE_PERMISSIONS, type ConfigurablePermission } from '@shared/browserConfig'

/**
 * The profile settings an Electron permission request needs. `media` is split into camera and
 * microphone by the requested media types; a request for both needs both.
 */
export function permissionKeys(permission: string, mediaTypes: readonly string[] = []): ConfigurablePermission[] | null {
  if (permission === 'media') {
    const keys: ConfigurablePermission[] = []
    if (mediaTypes.includes('video')) keys.push('camera')
    if (mediaTypes.includes('audio')) keys.push('microphone')
    return keys.length ? keys : ['camera', 'microphone']
  }
  if (permission === 'midiSysex') return ['midi']
  return (CONFIGURABLE_PERMISSIONS as readonly string[]).includes(permission) ? [permission as ConfigurablePermission] : null
}

/**
 * A free file path in `folder` for a downloaded file. The name is reduced to its last path
 * component and stripped of characters Windows does not allow, so a site cannot choose where
 * the file goes.
 */
export function uniqueDownloadPath(folder: string, suggested: string): string {
  const cleaned = basename(suggested.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180) || 'download'
  const ext = extname(cleaned)
  const stem = cleaned.slice(0, cleaned.length - ext.length) || 'download'
  let candidate = join(folder, cleaned)
  for (let n = 1; existsSync(candidate) && n < 1000; n++) candidate = join(folder, `${stem} (${n})${ext}`)
  return candidate
}
