import type { BackupImportResult, TemplateProxy } from '@shared/types'
import { LIMITS } from '@shared/validation'
import { createBackup, type BackupFile, type ParsedBackup } from './backupService'
import { userMessage } from './bulkRunner'
import type { CatalogService } from './catalogService'
import type { ProfileService } from './profileService'
import type { SettingsService } from './settingsService'
import type { TemplateService } from './templateService'

/**
 * Exports and restores metadata backups.
 *
 * Restoring (v1 or v2) adds to what exists — nothing is overwritten:
 * - groups with the same name are merged, others are created
 * - profiles keep their original id only if it is free and its session partition was never
 *   used on this computer; otherwise they get a new id (and therefore a new, empty session)
 * - name clashes get a number suffix
 * - template references are remapped to the restored group/profile ids
 */
export class MetadataBackupService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly catalog: CatalogService,
    private readonly templates: TemplateService,
    private readonly settings: SettingsService
  ) {}

  /**
   * Builds a metadata backup. With `onlyProfileIds`, only those profiles plus the groups and
   * tags they use are included (no templates). Never includes passwords or browser data.
   */
  buildBackup(appVersion: string, onlyProfileIds?: string[]): BackupFile {
    const selected = onlyProfileIds ? new Set(onlyProfileIds) : null
    const profiles = this.profiles.list().filter((p) => !selected || selected.has(p.id))
    const usedGroups = new Set(profiles.map((p) => p.groupId).filter(Boolean))
    const usedTags = new Set(profiles.flatMap((p) => p.tags.map((t) => t.toLocaleLowerCase())))
    const groups = this.catalog
      .listGroups()
      .filter((g) => !selected || usedGroups.has(g.id))
      .map((g) => ({ id: g.id, name: g.name, color: g.color }))
    const tags = this.catalog
      .listTags()
      .map((t) => t.name)
      .filter((t) => !selected || usedTags.has(t.toLocaleLowerCase()))
    const templates = selected
      ? []
      : this.templates.list().map(({ createdAt: _c, updatedAt: _u, ...t }) => t)
    return createBackup(
      profiles.map((p) => this.profiles.toPortable(p)),
      this.settings.get(),
      appVersion,
      new Date(),
      { groups, tags, templates }
    )
  }

  restore(backup: ParsedBackup): Omit<BackupImportResult, 'cancelled'> {
    if (backup.version === 1) {
      const summary = this.profiles.importProfiles(backup.profiles)
      this.applySettings(backup)
      return { ...summary, version: 1, groupsCreated: 0, groupsMerged: 0, templatesImported: 0, warnings: [] }
    }

    const warnings: string[] = []
    const groupIds = new Map<string, string>()
    let groupsCreated = 0
    let groupsMerged = 0
    for (const group of backup.groups) {
      try {
        const existing = this.catalog.findGroupByName(group.name)
        if (existing) {
          groupIds.set(group.id, existing.id)
          groupsMerged++
        } else {
          groupIds.set(group.id, this.catalog.createGroup({ name: group.name, color: group.color }, { id: group.id }).id)
          groupsCreated++
        }
      } catch (error) {
        warnings.push(`Group "${group.name}": ${userMessage(error)}`)
      }
    }

    const profileIds = new Map<string, string>()
    let imported = 0
    let skipped = 0
    const renamed: string[] = []
    for (const entry of backup.profiles) {
      try {
        const name = this.availableName(entry.name, (n) => this.profiles.isNameTaken(n))
        const groupId = entry.groupId ? (groupIds.get(entry.groupId) ?? null) : null
        if (entry.groupId && !groupId) warnings.push(`"${entry.name}": its group was not in the backup`)
        const profile = this.profiles.create(
          {
            name,
            notes: entry.notes,
            color: entry.color,
            startUrl: entry.startUrl,
            groupId,
            tags: entry.tags ?? [],
            proxy: entry.proxy
              ? {
                  enabled: true,
                  protocol: entry.proxy.protocol,
                  host: entry.proxy.host,
                  port: entry.proxy.port,
                  username: entry.proxy.username ?? '',
                  bypassRules: entry.proxy.bypassRules
                }
              : undefined
          },
          { preferredId: entry.id }
        )
        if (entry.id) profileIds.set(entry.id, profile.id)
        if (name !== entry.name) renamed.push(`${entry.name} → ${name}`)
        imported++
      } catch (error) {
        skipped++
        warnings.push(`"${entry.name}": ${userMessage(error)}`)
      }
    }

    let templatesImported = 0
    for (const template of backup.templates) {
      try {
        const name = this.availableName(template.name, (n) => this.templates.nameTaken(n))
        const groupId = template.groupId ? (groupIds.get(template.groupId) ?? null) : null
        let proxy: TemplateProxy = { mode: 'none' }
        if (template.proxy.mode === 'copy-from-profile') {
          const mapped = profileIds.get(template.proxy.profileId)
          if (mapped && this.profiles.get(mapped).proxy) proxy = { mode: 'copy-from-profile', profileId: mapped }
          else warnings.push(`Template "${template.name}": its proxy source profile was not restored; proxy set to none`)
        }
        this.templates.create(
          { name, notes: template.notes, color: template.color, startUrl: template.startUrl, groupId, tags: template.tags, proxy },
          { preferredId: template.id }
        )
        templatesImported++
      } catch (error) {
        warnings.push(`Template "${template.name}": ${userMessage(error)}`)
      }
    }

    this.applySettings(backup)
    return { imported, renamed, skipped, version: 2, groupsCreated, groupsMerged, templatesImported, warnings }
  }

  private applySettings(backup: ParsedBackup): void {
    if (Object.keys(backup.settings).length) this.settings.update(backup.settings)
  }

  private availableName(name: string, taken: (n: string) => boolean): string {
    if (!taken(name)) return name
    for (let n = 2; n < 1000; n++) {
      const suffix = ` (${n})`
      const candidate = `${name.slice(0, LIMITS.nameMax - suffix.length)}${suffix}`
      if (!taken(candidate)) return candidate
    }
    return name
  }
}
