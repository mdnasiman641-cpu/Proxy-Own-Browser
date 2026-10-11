import { describeProxy } from '@shared/proxy'
import type { BulkCreatePlan, BulkCreateSpec, BulkItemResult, BulkPlanItem } from '@shared/types'
import {
  ValidationError,
  bulkCreateSpecSchema,
  bulkNamesSchema,
  parseOrThrow,
  profileInputSchema,
  type ParsedBulkCreateSpec
} from '@shared/validation'
import type { CatalogService } from './catalogService'
import { userMessage } from './bulkRunner'
import type { ProfileService } from './profileService'
import type { TemplateService } from './templateService'

export const NUMBER_PLACEHOLDER = '{number}'

/**
 * Expands a name template: `Shop-{number}` with start 7, padding 3 → Shop-007, Shop-008, …
 * Every `{number}` occurrence is replaced. More than one profile requires the placeholder,
 * otherwise every name would be identical.
 */
export function generateNames(template: string, count: number, startNumber = 1, padding = 0): string[] {
  const value = template.trim()
  if (count > 1 && !value.includes(NUMBER_PLACEHOLDER)) {
    throw new ValidationError(`The name template must contain ${NUMBER_PLACEHOLDER} to create more than one profile`)
  }
  return Array.from({ length: count }, (_, i) =>
    value.split(NUMBER_PLACEHOLDER).join(String(startNumber + i).padStart(padding, '0'))
  )
}

interface ResolvedDefaults {
  notes: string
  color: string | undefined
  startUrl: string | null
  groupId: string | null
  tags: string[]
  proxySourceProfileId: string | null
  templateName: string | null
}

/** Plans and performs bulk profile creation. Never opens the created profiles. */
export class BulkCreator {
  constructor(
    private readonly profiles: ProfileService,
    private readonly catalog: CatalogService,
    private readonly templates: TemplateService
  ) {}

  /** Previews names and checks every setting without creating anything. */
  plan(input: BulkCreateSpec): BulkCreatePlan {
    const spec = parseOrThrow(bulkCreateSpecSchema, input)
    const errors: string[] = []
    let names: string[] = []
    try {
      names = generateNames(spec.nameTemplate, spec.count, spec.startNumber, spec.padding)
    } catch (error) {
      errors.push(userMessage(error))
    }
    const { defaults, problems } = this.resolve(spec)
    errors.push(...problems)

    const capacity = this.profiles.maxProfileCount - this.profiles.count()
    if (names.length > capacity) {
      errors.push(`Only ${Math.max(0, capacity)} more profile(s) can be saved (limit ${this.profiles.maxProfileCount})`)
    }

    const seen = new Set<string>()
    const items: BulkPlanItem[] = names.map((name) => {
      const parsed = profileInputSchema.shape.name.safeParse(name)
      if (!parsed.success) {
        return { name, issue: 'invalid-name', message: parsed.error.issues[0]?.message ?? 'Invalid name' }
      }
      const k = parsed.data.toLocaleLowerCase()
      if (seen.has(k)) return { name: parsed.data, issue: 'duplicate-in-batch', message: 'Repeated in this batch' }
      seen.add(k)
      if (this.profiles.isNameTaken(parsed.data)) {
        return { name: parsed.data, issue: 'exists', message: 'A profile with this name already exists' }
      }
      return { name: parsed.data, issue: null, message: null }
    })

    const group = defaults.groupId ? this.catalog.listGroups().find((g) => g.id === defaults.groupId) : undefined
    const proxyLabel = defaults.proxySourceProfileId && this.profiles.exists(defaults.proxySourceProfileId)
      ? describeProxy(this.profiles.get(defaults.proxySourceProfileId).proxy)
      : null
    return {
      items,
      errors,
      ready: errors.length === 0 && items.length > 0 && items.every((i) => i.issue === null),
      resolved: {
        groupName: group?.name ?? null,
        tags: defaults.tags,
        startUrl: defaults.startUrl,
        proxyLabel,
        templateName: defaults.templateName
      }
    }
  }

  /**
   * Creates the given names (all planned names, or only previously failed ones on retry).
   * Each profile is saved in its own transaction with its own new id and session partition,
   * so one failure never affects the others. A name that already exists is reported, not
   * duplicated — which makes retrying safe.
   */
  create(input: BulkCreateSpec, namesInput: string[]): BulkItemResult[] {
    const spec = parseOrThrow(bulkCreateSpecSchema, input)
    const names = parseOrThrow(bulkNamesSchema, namesInput)
    const planned = new Set(
      generateNames(spec.nameTemplate, spec.count, spec.startNumber, spec.padding).map((n) => n.trim().toLocaleLowerCase())
    )
    const outside = names.find((n) => !planned.has(n.toLocaleLowerCase()))
    if (outside) throw new ValidationError(`"${outside}" is not part of this batch`)

    const { defaults, problems } = this.resolve(spec)
    if (problems.length) throw new ValidationError(problems.join('; '))

    return names.map((name): BulkItemResult => {
      if (this.profiles.isNameTaken(name)) {
        return { id: '', name, ok: false, outcome: 'exists', error: 'A profile with this name already exists' }
      }
      try {
        const profile = this.profiles.create(
          {
            name,
            notes: defaults.notes,
            ...(defaults.color ? { color: defaults.color } : {}),
            startUrl: defaults.startUrl,
            groupId: defaults.groupId,
            tags: defaults.tags
          },
          { proxySourceProfileId: defaults.proxySourceProfileId, allowSharedProxy: spec.allowSharedProxy === true }
        )
        return { id: profile.id, name: profile.name, ok: true, outcome: 'created', error: null }
      } catch (error) {
        return { id: '', name, ok: false, outcome: null, error: userMessage(error) }
      }
    })
  }

  /** Combines template values with explicit choices (explicit choices win; tags are merged). */
  private resolve(spec: ParsedBulkCreateSpec): { defaults: ResolvedDefaults; problems: string[] } {
    const problems: string[] = []
    let template = null
    if (spec.templateId) {
      try {
        template = this.templates.get(spec.templateId)
        problems.push(...this.templates.problems(template).map((p) => `Template: ${p}`))
      } catch (error) {
        problems.push(userMessage(error))
      }
    }

    const groupId = spec.groupId !== undefined ? spec.groupId : (template?.groupId ?? null)
    if (groupId && !this.catalog.groupExists(groupId)) problems.push('The selected group no longer exists')

    const proxySourceProfileId =
      spec.proxySourceProfileId !== undefined
        ? spec.proxySourceProfileId
        : template?.proxy.mode === 'copy-from-profile'
          ? template.proxy.profileId
          : null
    if (proxySourceProfileId) {
      if (!this.profiles.exists(proxySourceProfileId)) {
        problems.push('The profile chosen for proxy settings no longer exists')
      } else if (!this.profiles.get(proxySourceProfileId).proxy) {
        problems.push('The profile chosen for proxy settings has no proxy')
      }
    }

    const seen = new Set<string>()
    const tags = [...(template?.tags ?? []), ...spec.tags].filter((t) => {
      const k = t.toLocaleLowerCase()
      return seen.has(k) ? false : (seen.add(k), true)
    })

    return {
      defaults: {
        notes: template?.notes ?? '',
        color: template?.color ?? undefined,
        startUrl: spec.startUrl !== undefined ? spec.startUrl : (template?.startUrl ?? null),
        groupId,
        tags,
        proxySourceProfileId,
        templateName: template?.name ?? null
      },
      problems: [...new Set(problems)]
    }
  }
}
