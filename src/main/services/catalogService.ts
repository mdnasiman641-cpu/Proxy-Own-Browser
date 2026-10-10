import { randomUUID } from 'node:crypto'
import type { ProfileGroup, ProfileTag } from '@shared/types'
import {
  LIMITS,
  PROFILE_COLORS,
  ValidationError,
  groupIdSchema,
  groupInputSchema,
  parseOrThrow,
  tagIdSchema,
  tagListSchema,
  tagNameSchema
} from '@shared/validation'
import type { AppDatabase } from './database'
import { NotFoundError } from './errors'

interface GroupRow {
  id: string
  name: string
  color: string
  created_at: string
  profile_count: number
}

interface TagRow {
  id: string
  name: string
  profile_count: number
}

const key = (name: string): string => name.trim().toLocaleLowerCase()

/**
 * Profile groups and tags.
 * - Names are unique case-insensitively.
 * - Deleting a group only ungroups its profiles; deleting a tag only removes the label.
 * - Profiles can reference only groups and tags that exist.
 */
export class CatalogService {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(
    private readonly db: AppDatabase,
    options: { now?: () => Date; newId?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
  }

  // ---------- groups ----------

  listGroups(): ProfileGroup[] {
    return this.db
      .all<GroupRow>(
        `SELECT g.id, g.name, g.color, g.created_at,
                (SELECT COUNT(*) FROM profiles p WHERE p.group_id = g.id) AS profile_count
         FROM groups g ORDER BY g.name_key`
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        createdAt: r.created_at,
        profileCount: Number(r.profile_count)
      }))
  }

  getGroup(id: string): ProfileGroup {
    const group = this.listGroups().find((g) => g.id === parseOrThrow(groupIdSchema, id))
    if (!group) throw new NotFoundError('Group not found')
    return group
  }

  groupExists(id: string): boolean {
    return this.db.get('SELECT 1 AS hit FROM groups WHERE id = ?', [id]) !== undefined
  }

  findGroupByName(name: string): ProfileGroup | undefined {
    const row = this.db.get<{ id: string }>('SELECT id FROM groups WHERE name_key = ?', [key(name)])
    return row ? this.getGroup(row.id) : undefined
  }

  createGroup(input: { name: string; color?: string }, options: { id?: string } = {}): ProfileGroup {
    const data = parseOrThrow(groupInputSchema, input)
    const count = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM groups')?.n ?? 0)
    if (count >= LIMITS.maxGroups) throw new ValidationError(`You can have at most ${LIMITS.maxGroups} groups`)
    this.assertGroupNameFree(data.name)
    const id = options.id && !this.groupExists(options.id) ? options.id : this.newId()
    const timestamp = this.now().toISOString()
    this.db.run(
      'INSERT INTO groups (id, name, name_key, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, data.name, key(data.name), data.color ?? PROFILE_COLORS[count % PROFILE_COLORS.length]!, timestamp, timestamp]
    )
    return this.getGroup(id)
  }

  updateGroup(id: string, input: { name?: string; color?: string }): ProfileGroup {
    const current = this.getGroup(id)
    const data = parseOrThrow(groupInputSchema, { name: input.name ?? current.name, color: input.color ?? current.color })
    if (key(data.name) !== key(current.name)) this.assertGroupNameFree(data.name)
    this.db.run('UPDATE groups SET name = ?, name_key = ?, color = ?, updated_at = ? WHERE id = ?', [
      data.name,
      key(data.name),
      data.color ?? current.color,
      this.now().toISOString(),
      current.id
    ])
    return this.getGroup(current.id)
  }

  /** Deletes a group. Its profiles are kept and become ungrouped. Returns how many were ungrouped. */
  deleteGroup(id: string): number {
    const group = this.getGroup(id)
    return this.db.transaction(() => {
      const ungrouped = this.db.run('UPDATE profiles SET group_id = NULL WHERE group_id = ?', [group.id])
      this.db.run('DELETE FROM groups WHERE id = ?', [group.id])
      return ungrouped
    })
  }

  /** Throws unless `groupId` is null or an existing group. */
  assertGroupReference(groupId: string | null | undefined): void {
    if (groupId && !this.groupExists(groupId)) {
      throw new ValidationError('The selected group no longer exists')
    }
  }

  private assertGroupNameFree(name: string): void {
    if (this.db.get('SELECT 1 AS hit FROM groups WHERE name_key = ?', [key(name)])) {
      throw new ValidationError(`A group named "${name.trim()}" already exists`)
    }
  }

  // ---------- tags ----------

  listTags(): ProfileTag[] {
    return this.db
      .all<TagRow>(
        `SELECT t.id, t.name,
                (SELECT COUNT(*) FROM profile_tags pt WHERE pt.tag_id = t.id) AS profile_count
         FROM tags t ORDER BY t.name_key`
      )
      .map((r) => ({ id: r.id, name: r.name, profileCount: Number(r.profile_count) }))
  }

  createTag(name: string): ProfileTag {
    const value = parseOrThrow(tagNameSchema, name)
    if (this.db.get('SELECT 1 AS hit FROM tags WHERE name_key = ?', [key(value)])) {
      throw new ValidationError(`The tag "${value}" already exists`)
    }
    const [id] = this.ensureTags([value])
    return this.listTags().find((t) => t.id === id)!
  }

  renameTag(id: string, name: string): ProfileTag {
    const tagId = parseOrThrow(tagIdSchema, id)
    const value = parseOrThrow(tagNameSchema, name)
    const current = this.db.get<{ name_key: string }>('SELECT name_key FROM tags WHERE id = ?', [tagId])
    if (!current) throw new NotFoundError('Tag not found')
    if (current.name_key !== key(value) && this.db.get('SELECT 1 AS hit FROM tags WHERE name_key = ?', [key(value)])) {
      throw new ValidationError(`The tag "${value}" already exists`)
    }
    this.db.run('UPDATE tags SET name = ?, name_key = ? WHERE id = ?', [value, key(value), tagId])
    return this.listTags().find((t) => t.id === tagId)!
  }

  /** Deletes a tag and removes it from all profiles. Profiles themselves are kept. */
  deleteTag(id: string): number {
    const tagId = parseOrThrow(tagIdSchema, id)
    if (!this.db.get('SELECT 1 AS hit FROM tags WHERE id = ?', [tagId])) throw new NotFoundError('Tag not found')
    return this.db.transaction(() => {
      const removed = this.db.run('DELETE FROM profile_tags WHERE tag_id = ?', [tagId])
      this.db.run('DELETE FROM tags WHERE id = ?', [tagId])
      return removed
    })
  }

  /** Returns tag ids for the names, creating missing tags. Matching is case-insensitive. */
  ensureTags(names: string[]): string[] {
    const seen = new Set<string>()
    const tags = names
      .map((n) => parseOrThrow(tagNameSchema, n))
      .filter((n) => (seen.has(key(n)) ? false : (seen.add(key(n)), true)))
    return this.db.transaction(() =>
      tags.map((name) => {
        const existing = this.db.get<{ id: string }>('SELECT id FROM tags WHERE name_key = ?', [key(name)])
        if (existing) return existing.id
        const total = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tags')?.n ?? 0)
        if (total >= LIMITS.maxTags) throw new ValidationError(`You can have at most ${LIMITS.maxTags} tags`)
        const id = this.newId()
        this.db.run('INSERT INTO tags (id, name, name_key, created_at) VALUES (?, ?, ?, ?)', [
          id,
          name.trim(),
          key(name),
          this.now().toISOString()
        ])
        return id
      })
    )
  }

  /** Replaces a profile's tags. */
  setProfileTags(profileId: string, names: string[]): void {
    this.db.transaction(() => {
      const ids = this.ensureTags(names)
      this.db.run('DELETE FROM profile_tags WHERE profile_id = ?', [profileId])
      for (const tagId of ids) {
        this.db.run('INSERT OR IGNORE INTO profile_tags (profile_id, tag_id) VALUES (?, ?)', [profileId, tagId])
      }
    })
  }

  /** Adds and removes tags on one profile, keeping its other tags. */
  changeProfileTags(profileId: string, add: string[], remove: string[]): string[] {
    const removeKeys = new Set(remove.map(key))
    const current = this.tagsForProfile(profileId).filter((t) => !removeKeys.has(key(t)))
    const merged = [...current, ...add.filter((t) => !removeKeys.has(key(t)))]
    const unique = parseOrThrow(tagListSchema, merged)
    this.setProfileTags(profileId, unique)
    return this.tagsForProfile(profileId)
  }

  tagsForProfile(profileId: string): string[] {
    return this.db
      .all<{ name: string }>(
        `SELECT t.name FROM profile_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.profile_id = ? ORDER BY t.name_key`,
        [profileId]
      )
      .map((r) => r.name)
  }

  /** Tag names for every profile, in one query. */
  tagsByProfile(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const row of this.db.all<{ profile_id: string; name: string }>(
      `SELECT pt.profile_id, t.name FROM profile_tags pt JOIN tags t ON t.id = pt.tag_id ORDER BY t.name_key`
    )) {
      const list = map.get(row.profile_id) ?? []
      list.push(row.name)
      map.set(row.profile_id, list)
    }
    return map
  }
}
