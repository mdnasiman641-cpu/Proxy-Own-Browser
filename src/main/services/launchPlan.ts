import { acceptLanguageFor, type BrowserConfig } from '@shared/browserConfig'
import { languageForCountry } from '@shared/countryLanguage'
import type { IpGeolocation } from '@shared/types'

export interface GeolocationOverride {
  latitude: number
  longitude: number
  /** Metres. IP-based coordinates are only city-level, which the accuracy says honestly. */
  accuracy: number
}

/** What a profile window applies to its pages. */
export interface LaunchPlan {
  timezone: string | null
  timezoneSource: 'off' | 'manual' | 'auto'
  /** Locale for Intl and navigator.language; null keeps the app's language. */
  locale: string | null
  languageSource: 'default' | 'manual' | 'auto'
  /** Accept-Language list (and navigator.languages); null keeps the app's default list. */
  acceptLanguage: string | null
  geolocation: GeolocationOverride | null
  geolocationSource: 'off' | 'manual' | 'auto'
  /** Shown to the user (e.g. "using the time zone detected 2 days ago"). */
  warnings: string[]
}

export const IP_GEOLOCATION_ACCURACY_M = 25_000
export const MANUAL_GEOLOCATION_ACCURACY_M = 100

/**
 * Resolves language and geolocation for a launch. `geo` is the location of the proxy's current
 * exit IP (or the last valid one for this proxy), `geoNote` why it is missing. Automatic values
 * are only used when they come from that location; otherwise nothing is overridden and the
 * reason is returned as a warning.
 */
export function resolveLanguageAndGeolocation(
  browser: BrowserConfig,
  geo: IpGeolocation | null,
  geoNote: string | null
): Pick<LaunchPlan, 'locale' | 'languageSource' | 'acceptLanguage' | 'geolocation' | 'geolocationSource' | 'warnings'> {
  const warnings: string[] = []
  let locale: string | null = null
  let languageSource: LaunchPlan['languageSource'] = 'default'
  if (browser.languageMode === 'manual' && browser.language) {
    locale = browser.language
    languageSource = 'manual'
  } else if (browser.languageMode === 'auto') {
    const fromCountry = languageForCountry(geo?.countryCode)
    if (fromCountry) {
      locale = fromCountry
      languageSource = 'auto'
    } else if (geo?.countryCode) {
      warnings.push(`Automatic language: no language is defined for country ${geo.countryCode}; the app's language is used.`)
    } else {
      warnings.push(`Automatic language: the proxy's country is not known${geoNote ? ` (${geoNote})` : ''}; the app's language is used.`)
    }
  }
  const acceptLanguage = browser.acceptLanguage ?? (locale ? acceptLanguageFor(locale) : null)

  let geolocation: GeolocationOverride | null = null
  let geolocationSource: LaunchPlan['geolocationSource'] = 'off'
  if (browser.geolocationMode === 'manual' && browser.geoLatitude !== null && browser.geoLongitude !== null) {
    geolocation = { latitude: browser.geoLatitude, longitude: browser.geoLongitude, accuracy: MANUAL_GEOLOCATION_ACCURACY_M }
    geolocationSource = 'manual'
  } else if (browser.geolocationMode === 'auto') {
    if (geo && geo.latitude !== null && geo.longitude !== null) {
      geolocation = { latitude: geo.latitude, longitude: geo.longitude, accuracy: IP_GEOLOCATION_ACCURACY_M }
      geolocationSource = 'auto'
    } else {
      warnings.push(
        `Automatic geolocation: no coordinates are known for the proxy's IP${geoNote ? ` (${geoNote})` : ''}; pages get no location.`
      )
    }
  }
  return { locale, languageSource, acceptLanguage, geolocation, geolocationSource, warnings }
}
