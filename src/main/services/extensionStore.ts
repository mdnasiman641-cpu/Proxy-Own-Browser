import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProfileExtension } from '@shared/types'
import { ValidationError } from '@shared/validation'
import type { AppDatabase } from './database'

/** Folder (under the app's data folder) holding each profile's copied unpacked extensions. */
export const EXTENSIONS_DIR = 'Extensions'

export const EXTENSION_LIMITS = {
  maxFiles: 3000,
  maxBytes: 64 * 1024 * 1024,
  maxPerProfile: 20,
  manifestMaxBytes: 256 * 1024
} as const

/**
 * Manifest keys Electron documents as supported. Others may be ignored by the runtime; they are
 * reported as warnings, not silently accepted.
 */
const SUPPORTED_KEYS = new Set([
  'name', 'version', 'author', 'permissions', 'content_scripts', 'default_locale', 'devtools_page',
  'short_name', 'manifest_version', 'minimum_chrome_version', 'host_permissions', 'background',
  'description', 'icons', 'key', 'update_url', 'web_accessible_resources', 'content_security_policy'
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ExtensionInfo {
  name: string
  version: string
  manifestVersion: number
  warnings: string[]
}

interface Row {
  id: string
  profile_id: string
  name: string
  version: string
  manifest_version: number
  folder: string
  chrome_id: string | null
  enabled: number
  last_error: string | null
  added_at: string
}

function toExtension(row: Row): ProfileExtension {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    version: row.version,
    manifestVersion: Number(row.manifest_version),
    chromeId: row.chrome_id,
    enabled: Number(row.enabled) === 1,
    lastError: row.last_error,
    addedAt: row.added_at
  }
}

/**
 * Reads and checks an unpacked extension folder: `manifest.json` must exist and be valid with a
 * name, version and manifest_version 2 or 3. Packed `.crx` files are not supported by Electron.
 */
export async function inspectExtension(dir: string): Promise<ExtensionInfo> {
  if (!isAbsolute(dir)) throw new ValidationError('Choose the extension folder.')
  if (/\.crx$/i.test(dir)) {
    throw new ValidationError('Packed .crx files are not supported. Unpack the extension and choose its folder.')
  }
  let stat
  try {
    stat = lstatSync(dir)
  } catch {
    throw new ValidationError('The extension folder does not exist.')
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ValidationError('Choose a real folder that contains manifest.json.')
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new ValidationError('This folder has no manifest.json, so it is not an unpacked extension.')
  }
  if (lstatSync(manifestPath).size > EXTENSION_LIMITS.manifestMaxBytes) throw new ValidationError('manifest.json is too large.')
  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^﻿/, '')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    manifest = parsed as Record<string, unknown>
  } catch {
    throw new ValidationError('manifest.json is not valid JSON.')
  }
  const manifestVersion = manifest.manifest_version
  if (manifestVersion !== 2 && manifestVersion !== 3) {
    throw new ValidationError('manifest.json must have "manifest_version": 2 or 3.')
  }
  const version = typeof manifest.version === 'string' && /^\d+(\.\d+){0,3}$/.test(manifest.version) ? manifest.version : null
  if (!version) throw new ValidationError('manifest.json must have a "version" such as "1.0".')
  let name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  if (/^__MSG_.+__$/.test(name)) name = (await localizedName(dir, manifest, name)) ?? name
  if (!name) throw new ValidationError('manifest.json must have a "name".')
  const warnings: string[] = []
  const unsupported = Object.keys(manifest).filter((k) => !SUPPORTED_KEYS.has(k))
  if (unsupported.length) {
    warnings.push(`Not supported by this browser engine (may be ignored): ${unsupported.slice(0, 8).join(', ')}.`)
  }
  if (manifest.chrome_url_overrides || manifest.action || manifest.browser_action || manifest.page_action) {
    warnings.push('Toolbar buttons and pop-ups of extensions are not shown in this browser.')
  }
  return { name: name.slice(0, 80), version, manifestVersion, warnings }
}

async function localizedName(dir: string, manifest: Record<string, unknown>, raw: string): Promise<string | null> {
  const locale = typeof manifest.default_locale === 'string' && /^[A-Za-z_-]{2,10}$/.test(manifest.default_locale) ? manifest.default_locale : 'en'
  try {
    const messages = JSON.parse(await readFile(join(dir, '_locales', locale, 'messages.json'), 'utf8')) as Record<string, { message?: unknown }>
    const key = raw.slice(6, -2)
    const entry = Object.entries(messages).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]
    return typeof entry?.message === 'string' ? entry.message.trim() : null
  } catch {
    return null
  }
}

/** Lists files to copy; refuses links and anything over the size limits. */
async function collect(dir: string): Promise<{ files: string[]; bytes: number }> {
  const files: string[] = []
  let bytes = 0
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new ValidationError('The extension folder contains links, which are not copied for safety.')
      if (stat.isDirectory()) {
        await walk(path)
      } else if (stat.isFile()) {
        files.push(path)
        bytes += stat.size
        if (files.length > EXTENSION_LIMITS.maxFiles) throw new ValidationError('The extension has too many files.')
        if (bytes > EXTENSION_LIMITS.maxBytes) throw new ValidationError('The extension is too large (over 64 MB).')
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

/**
 * Unpacked extensions installed into a profile. Each is copied into
 * `<userData>/Extensions/<profileId>/<id>/`, so it belongs to that profile alone and keeps working
 * if the original folder moves. Loading into the browser session happens when the profile opens
 * (Electron does not remember extensions between runs).
 */
export class ExtensionStore {
  constructor(
    private readonly deps: { db: AppDatabase; userDataPath: string; now?: () => Date; newId?: () => string }
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** The managed folder of one extension; ids are validated and the path proven to stay inside. */
  folderOf(profileId: string, id: string): string {
    if (!UUID_RE.test(profileId) || !UUID_RE.test(id)) throw new ValidationError('Invalid extension id')
    const base = resolve(this.deps.userDataPath, EXTENSIONS_DIR)
    const dir = resolve(base, profileId, id)
    const rel = relative(base, dir)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).length !== 2) {
      throw new ValidationError('Extension folder is outside the managed data folder')
    }
    return dir
  }

  list(profileId: string): ProfileExtension[] {
    return this.deps.db
      .all<Row>('SELECT * FROM profile_extensions WHERE profile_id = ? ORDER BY added_at', [profileId])
      .map(toExtension)
  }

  get(profileId: string, id: string): ProfileExtension {
    const row = this.deps.db.get<Row>('SELECT * FROM profile_extensions WHERE id = ? AND profile_id = ?', [id, profileId])
    if (!row) throw new ValidationError('This extension is not installed in this profile.')
    return toExtension(row)
  }

  /** Validates and copies an unpacked extension folder into the profile. */
  async add(profileId: string, sourceDir: string): Promise<{ extension: ProfileExtension; warnings: string[] }> {
    const info = await inspectExtension(sourceDir)
    const existing = this.list(profileId)
    if (existing.length >= EXTENSION_LIMITS.maxPerProfile) {
      throw new ValidationError(`A profile can have at most ${EXTENSION_LIMITS.maxPerProfile} extensions.`)
    }
    if (existing.some((e) => e.name === info.name && e.version === info.version)) {
      throw new ValidationError(`"${info.name}" ${info.version} is already installed in this profile.`)
    }
    const { files } = await collect(sourceDir)
    const id = (this.deps.newId ?? randomUUID)()
    const target = this.folderOf(profileId, id)
    try {
      for (const file of files) {
        const rel = relative(sourceDir, file)
        if (rel.startsWith('..') || isAbsolute(rel)) throw new ValidationError('Invalid file path in the extension.')
        const destination = join(target, rel)
        await mkdir(join(destination, '..'), { recursive: true })
        await copyFile(file, destination)
      }
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
    const addedAt = this.now().toISOString()
    this.deps.db.run(
      `INSERT INTO profile_extensions (id, profile_id, name, version, manifest_version, folder, chrome_id, enabled, last_error, added_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?)`,
      [id, profileId, info.name, info.version, info.manifestVersion, id, addedAt]
    )
    return { extension: this.get(profileId, id), warnings: info.warnings }
  }

  setEnabled(profileId: string, id: string, enabled: boolean): ProfileExtension {
    this.get(profileId, id)
    this.deps.db.run('UPDATE profile_extensions SET enabled = ? WHERE id = ? AND profile_id = ?', [enabled ? 1 : 0, id, profileId])
    return this.get(profileId, id)
  }

  /** Result of the latest attempt to load it into the profile's session. */
  recordLoad(profileId: string, id: string, chromeId: string | null, error: string | null): void {
    this.deps.db.run('UPDATE profile_extensions SET chrome_id = coalesce(?, chrome_id), last_error = ? WHERE id = ? AND profile_id = ?', [
      chromeId,
      error ? error.slice(0, 500) : null,
      id,
      profileId
    ])
  }

  /** Removes the extension's record and its copied files (only inside the managed folder). */
  async remove(profileId: string, id: string): Promise<ProfileExtension> {
    const extension = this.get(profileId, id)
    const dir = this.folderOf(profileId, id)
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new ValidationError('Refusing to delete a linked folder')
    await rm(dir, { recursive: true, force: true })
    this.deps.db.run('DELETE FROM profile_extensions WHERE id = ? AND profile_id = ?', [id, profileId])
    return extension
  }

  /** Removes every extension of a deleted profile. */
  async removeAll(profileId: string): Promise<void> {
    for (const extension of this.list(profileId)) await this.remove(profileId, extension.id)
    if (UUID_RE.test(profileId)) {
      await rm(resolve(this.deps.userDataPath, EXTENSIONS_DIR, profileId), { recursive: true, force: true })
    }
  }
}
