/**
 * Most widely used browser language per country (ISO 3166-1 alpha-2), for the "Automatic"
 * language mode. This is a convenience default, not a fact about the user: a country can have
 * several languages. Countries not listed get no automatic language (the app's language is used
 * and the launch report says so) — nothing is guessed.
 */
export const COUNTRY_LANGUAGE: Readonly<Record<string, string>> = {
  AE: 'ar-AE', AR: 'es-AR', AT: 'de-AT', AU: 'en-AU', BD: 'bn-BD', BE: 'nl-BE', BG: 'bg-BG',
  BR: 'pt-BR', CA: 'en-CA', CH: 'de-CH', CL: 'es-CL', CN: 'zh-CN', CO: 'es-CO', CZ: 'cs-CZ',
  DE: 'de-DE', DK: 'da-DK', EG: 'ar-EG', ES: 'es-ES', FI: 'fi-FI', FR: 'fr-FR', GB: 'en-GB',
  GR: 'el-GR', HK: 'zh-HK', HR: 'hr-HR', HU: 'hu-HU', ID: 'id-ID', IE: 'en-IE', IL: 'he-IL',
  IN: 'en-IN', IQ: 'ar-IQ', IR: 'fa-IR', IT: 'it-IT', JP: 'ja-JP', KE: 'en-KE', KR: 'ko-KR',
  KW: 'ar-KW', KZ: 'ru-KZ', LK: 'si-LK', MA: 'ar-MA', MX: 'es-MX', MY: 'ms-MY', NG: 'en-NG',
  NL: 'nl-NL', NO: 'nb-NO', NP: 'ne-NP', NZ: 'en-NZ', PE: 'es-PE', PH: 'en-PH', PK: 'ur-PK',
  PL: 'pl-PL', PT: 'pt-PT', QA: 'ar-QA', RO: 'ro-RO', RS: 'sr-RS', RU: 'ru-RU', SA: 'ar-SA',
  SE: 'sv-SE', SG: 'en-SG', SK: 'sk-SK', TH: 'th-TH', TR: 'tr-TR', TW: 'zh-TW', UA: 'uk-UA',
  US: 'en-US', VN: 'vi-VN', ZA: 'en-ZA'
}

/** Language for a country code, or null when there is no mapping. */
export function languageForCountry(countryCode: string | null | undefined): string | null {
  if (!countryCode) return null
  return COUNTRY_LANGUAGE[countryCode.toUpperCase()] ?? null
}
