import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import type { UiLanguage } from '@shared/types'
import { translate, type Translate } from './strings'

export type { TKey, Translate } from './strings'

interface I18nValue {
  language: UiLanguage
  locale: string
  t: Translate
  formatDate: (iso: string | null) => string
  formatNumber: (n: number) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ language, children }: { language: UiLanguage; children: ReactNode }) {
  const t = useCallback<Translate>((key, vars) => translate(language, key, vars), [language])
  const value = useMemo<I18nValue>(() => {
    const locale = language === 'bn' ? 'bn-BD' : 'en-US'
    return {
      language,
      locale,
      t,
      formatDate: (iso) =>
        iso
          ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
          : translate(language, 'common.never'),
      formatNumber: (n) => n.toLocaleString(locale)
    }
  }, [language, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside I18nProvider')
  return value
}
