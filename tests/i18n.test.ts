import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DICTIONARIES, translate, type TKey } from '../src/renderer/dashboard/strings'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('dashboard translations', () => {
  const en = DICTIONARIES.en
  const bn = DICTIONARIES.bn

  it('has a Bangla string for every English string', () => {
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as TKey[]) {
      expect(bn[key].trim().length > 0).toBe(true)
    }
  })

  it('keeps the same {placeholders} in both languages', () => {
    const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(en) as TKey[]) {
      expect(placeholders(bn[key])).toEqual(placeholders(en[key]))
    }
  })

  it('every literal key used in the dashboard exists', () => {
    const missing: string[] = []
    for (const file of sourceFiles(fileURLToPath(new URL('../src/renderer/dashboard', import.meta.url)))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z0-9.-]+)'/g)) {
        if (!(match[1]! in en)) missing.push(`${file}: ${match[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every dynamic key family used by the dashboard is complete', () => {
    const families: Record<string, string[]> = {
      'outcome.': ['opened', 'joined', 'focused', 'closed', 'not-open', 'moved', 'ungrouped', 'updated', 'deleted', 'deleted-with-data', 'deleted-data-partially-removed', 'created', 'exists'],
      'bulk.action.': ['open', 'close', 'assign-group', 'change-tags', 'delete'],
      'wizard.issue.': ['exists', 'duplicate-in-batch', 'invalid-name'],
      'wizard.step.': ['setup', 'preview', 'create']
    }
    for (const [prefix, names] of Object.entries(families)) {
      for (const name of names) expect(`${prefix}${name}` in en).toBe(true)
    }
  })

  it('fills placeholders and leaves unknown ones alone', () => {
    expect(translate('en', 'profiles.count', { shown: 3, total: 10 })).toBe('3 of 10 profiles')
    expect(translate('bn', 'bulk.selected', { count: 5 })).toBe('5টি নির্বাচিত')
    expect(translate('en', 'wizard.nameTemplateHint')).toContain('{number}')
  })

  it('uses the singular form for exactly one', () => {
    expect(translate('en', 'wizard.create', { count: 1 })).toBe('Create 1 profile')
    expect(translate('en', 'wizard.create', { count: 3 })).toBe('Create 3 profiles')
    expect(translate('en', 'groups.profiles', { count: 0 })).toBe('0 profiles')
  })
})
