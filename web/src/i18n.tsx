import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"
import de from "./locales/de.json"
import en from "./locales/en.json"
import es from "./locales/es.json"
import fr from "./locales/fr.json"
import it from "./locales/it.json"
import ja from "./locales/ja.json"
import ko from "./locales/ko.json"
import pt from "./locales/pt.json"
import zhTW from "./locales/zh-TW.json"

export const languages = [
  { locale: "en", name: "English" },
  { locale: "zh-TW", name: "繁體中文" },
  { locale: "ja", name: "日本語" },
  { locale: "ko", name: "한국어" },
  { locale: "es", name: "Español" },
  { locale: "fr", name: "Français" },
  { locale: "de", name: "Deutsch" },
  { locale: "pt", name: "Português" },
  { locale: "it", name: "Italiano" },
] as const

export type Locale = (typeof languages)[number]["locale"]
export type MessageValues = Record<string, string | number | bigint | null | undefined>
export type Translate = (message: string, values?: MessageValues) => string
export const localeStorageKey = "logice.locale"
export const catalogs: Record<Locale, Record<string, string>> = {
  en,
  "zh-TW": zhTW,
  ja,
  ko,
  es,
  fr,
  de,
  pt,
  it,
}

export function isLocale(value: unknown): value is Locale {
  return languages.some(({ locale }) => locale === value)
}

export function readLocale(): Locale {
  try {
    const value = window.localStorage.getItem(localeStorageKey)
    return isLocale(value) ? value : "en"
  } catch {
    return "en"
  }
}

export function initializeLocale(): Locale {
  const locale = readLocale()
  document.documentElement.lang = locale
  return locale
}

export function translate(locale: Locale, message: string, values?: MessageValues): string {
  const catalog = catalogs[locale]
  const text = Object.hasOwn(catalog, message) ? catalog[message] : message
  return text.replace(/\{(\w+)\}/g, (token, name: string) =>
    values && Object.hasOwn(values, name) ? String(values[name] ?? "") : token,
  )
}

interface I18n {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translate
  number: (value: number | bigint, options?: Intl.NumberFormatOptions) => string
}

const LocaleContext = createContext<I18n>({
  locale: "en",
  setLocale: () => {},
  t: (message, values) => translate("en", message, values),
  number: (value, options) => new Intl.NumberFormat("en", options).format(value),
})

export function LocaleProvider({
  initialLocale = "en",
  children,
}: {
  initialLocale?: Locale
  children: ReactNode
}) {
  const [locale, setCurrentLocale] = useState(initialLocale)
  const setLocale = useCallback((value: Locale) => {
    document.documentElement.lang = value
    setCurrentLocale(value)
    try {
      window.localStorage.setItem(localeStorageKey, value)
    } catch {
      // The language still changes when the preference cannot be saved.
    }
  }, [])
  const context = useMemo(
    () => ({
      locale,
      setLocale,
      t: (message: string, values?: MessageValues) => translate(locale, message, values),
      number: (value: number | bigint, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat(locale, options).format(value),
    }),
    [locale, setLocale],
  )
  return <LocaleContext value={context}>{children}</LocaleContext>
}

export function useI18n(): I18n {
  return useContext(LocaleContext)
}

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n()
  return (
    <label className="language-select">
      <span>{t("Language")}</span>
      <select
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) setLocale(event.target.value)
        }}
      >
        {languages.map((language) => (
          <option key={language.locale} value={language.locale} lang={language.locale}>
            {language.name}
          </option>
        ))}
      </select>
    </label>
  )
}
