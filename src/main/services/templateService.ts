import { randomUUID } from 'node:crypto'
import type { ProfileTemplate, TemplateInput, TemplateProxy } from '@shared/types'
import {
  LIMITS,
  ValidationError,
  parseOrThrow,
  templateIdSchema,
  templateInputSchema,
  type ParsedTemplateInput
} from '@shared/validation'
import type { CatalogService } from './catalogService'
import type { AppDatabase } from './database'
import { NotFoundError } from './errors'
import type { ProfileService } from './profileService'

interface TemplateRow {
  id: string
  name: string
  data: string
  created_at: string
  updated_at: string
}

/** The JSON stored in `templates.data`. Contains settings only — never cookies or passwords. */
type StoredTemplate = Omit<ParsedTemplateInput, 'name'>

const key = (name: string): string => name.trim().toLocaleLowerCase()

/**
 * Reusable profile settings: notes, color, start page, group, tags, and proxy selection.
 * A template refers to proxy settings by *profile* ("copy from profile X"), so proxy
 * passwords are never stored in or exported with a template.
 */
export class TemplateService {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly profiles: ProfileService,
    options: { now?: () => Date; newId?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
  }

  list(): ProfileTemplate[] {
    return this.db
      .all<TemplateRow>('SELECT id, name, data, created_at, updated_at FROM templates ORDER BY name_key')
      .map(fromRow)
  }

  get(id: string): ProfileTemplate {
    const row = this.db.get<TemplateRow>(
      'SELECT id, name, data, created_at, updated_at FROM templates WHERE id = ?',
      [parseOrThrow(templateIdSchema, id)]
    )
    if (!row) throw new NotFoundError('Template not found')
    return fromRow(row)
  }

  create(input: TemplateInput, options: { preferredId?: string } = {}): ProfileTemplate {
    const data = this.validate(input)
    const count = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM templates')?.n ?? 0)
    if (count >= LIMITS.maxTemplates) {
      throw new ValidationError(`You can have at most ${LIMITS.maxTemplates} templates`)
    }
    this.assertNameFree(data.name)
    const id =
      options.preferredId && templateIdSchema.safeParse(options.preferredId).success && !this.exists(options.preferredId)
        ? options.preferredId
        : this.newId()
    const timestamp = this.now().toISOString()
    this.db.run(
      'INSERT INTO templates (id, name, name_key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, data.name, key(data.name), JSON.stringify(stored(data)), timestamp, timestamp]
    )
    return this.get(id)
  }

  update(id: string, input: TemplateInput): ProfileTemplate {
    const current = this.get(id)
    const data = this.validate(input)
    if (key(data.name) !== key(current.name)) this.assertNameFree(data.name)
    this.db.run('UPDATE templates SET name = ?, name_key = ?, data = ?, updated_at = ? WHERE id = ?', [
      data.name,
      key(data.name),
      JSON.stringify(stored(data)),
      this.now().toISOString(),
      current.id
    ])
    return this.get(current.id)
  }

  duplicate(id: string): ProfileTemplate {
    const source = this.get(id)
    let name = `${source.name} (copy)`.slice(0, LIMITS.nameMax)
    for (let n = 2; this.nameTaken(name) && n < 100; n++) {
      const suffix = ` (copy ${n})`
      name = `${source.name.slice(0, LIMITS.nameMax - suffix.length)}${suffix}`
    }
    return this.create({ ...toInput(source), name })
  }

  delete(id: string): void {
    const template = this.get(id)
    this.db.run('DELETE FROM templates WHERE id = ?', [template.id])
  }

  exists(id: string): boolean {
    return this.db.get('SELECT 1 AS hit FROM templates WHERE id = ?', [id]) !== undefined
  }

  nameTaken(name: string): boolean {
    return this.db.get('SELECT 1 AS hit FROM templates WHERE name_key = ?', [key(name)]) !== undefined
  }

  /**
   * Checks that a template can still be applied (its group and proxy source still exist).
   * Returns readable problems; an empty list means the template is usable.
   */
  problems(template: ProfileTemplate): string[] {
    const problems: string[] = []
    if (template.groupId && !this.catalog.groupExists(template.groupId)) {
      problems.push('Its group no longer exists')
    }
    if (template.proxy.mode === 'copy-from-profile') {
      if (!this.profiles.exists(template.proxy.profileId)) {
        problems.push('The profile it copies proxy settings from no longer exists')
      } else if (!this.profiles.get(template.proxy.profileId).proxy) {
        problems.push('The profile it copies proxy settings from has no proxy')
      }
    }
    return problems
  }

  private validate(input: TemplateInput): ParsedTemplateInput {
    const data = parseOrThrow(templateInputSchema, input)
    this.catalog.assertGroupReference(data.groupId)
    if (data.proxy.mode === 'copy-from-profile') {
      if (!this.profiles.exists(data.proxy.profileId)) {
        throw new ValidationError('The profile chosen for proxy settings no longer exists')
      }
      if (!this.profiles.get(data.proxy.profileId).proxy) {
        throw new ValidationError('The profile chosen for proxy settings has no proxy')
      }
    }
    return data
  }

  private assertNameFree(name: string): void {
    if (this.nameTaken(name)) throw new ValidationError(`A template named "${name.trim()}" already exists`)
  }
}

function stored(data: ParsedTemplateInput): StoredTemplate {
  return {
    notes: data.notes,
    color: data.color,
    startUrl: data.startUrl,
    groupId: data.groupId,
    tags: data.tags,
    proxy: data.proxy
  }
}

function fromRow(row: TemplateRow): ProfileTemplate {
  let data: Partial<StoredTemplate> = {}
  try {
    data = JSON.parse(row.data) as Partial<StoredTemplate>
  } catch {
    /* fall back to defaults below */
  }
  const proxy: TemplateProxy =
    data.proxy?.mode === 'copy-from-profile' && typeof data.proxy.profileId === 'string'
      ? { mode: 'copy-from-profile', profileId: data.proxy.profileId }
      : { mode: 'none' }
  return {
    id: row.id,
    name: row.name,
    notes: typeof data.notes === 'string' ? data.notes : '',
    color: typeof data.color === 'string' ? data.color : null,
    startUrl: typeof data.startUrl === 'string' ? data.startUrl : null,
    groupId: typeof data.groupId === 'string' ? data.groupId : null,
    tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [],
    proxy,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function toInput(template: ProfileTemplate): TemplateInput {
  return {
    name: template.name,
    notes: template.notes,
    color: template.color,
    startUrl: template.startUrl,
    groupId: template.groupId,
    tags: template.tags,
    proxy: template.proxy
  }
}
