import { readdirSync, readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Log } from "./api"
import { App } from "./app"
import { SignIn } from "./auth"
import { LinkedMessage, Timestamp } from "./components"
import {
  catalogs,
  initializeLocale,
  isLocale,
  LanguageSelect,
  LocaleProvider,
  languages,
  localeStorageKey,
  readLocale,
  translate,
  useI18n,
} from "./i18n"
import { LogRecord } from "./lists"
import { ThemeProvider } from "./theme"

afterEach(() => vi.unstubAllGlobals())

function variables(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
}

describe("language preference", () => {
  it("offers only English and the eight selected languages", () => {
    expect(languages.map(({ locale }) => locale)).toEqual([
      "en",
      "zh-TW",
      "ja",
      "ko",
      "es",
      "fr",
      "de",
      "pt",
      "it",
    ])
    for (const { locale } of languages) expect(isLocale(locale)).toBe(true)
  })

  it.each([null, "", "zh-CN", "ar", "pt-BR", "EN", "<script>", "toString"])(
    "defaults invalid or excluded preference %s to English",
    (value) => {
      vi.stubGlobal("window", { localStorage: { getItem: () => value } })
      expect(isLocale(value)).toBe(false)
      expect(readLocale()).toBe("en")
    },
  )

  it.each(languages)("reads the saved $locale preference", ({ locale }) => {
    const getItem = vi.fn(() => locale)
    vi.stubGlobal("window", { localStorage: { getItem } })
    expect(readLocale()).toBe(locale)
    expect(getItem).toHaveBeenCalledWith(localeStorageKey)
  })

  it("defaults to English without browser APIs or when storage access fails", () => {
    expect(readLocale()).toBe("en")
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("Storage denied")
      },
    })
    expect(readLocale()).toBe("en")
  })

  it("sets the document language before rendering", () => {
    const documentElement = { lang: "en" }
    vi.stubGlobal("window", { localStorage: { getItem: () => "it" } })
    vi.stubGlobal("document", { documentElement })
    expect(initializeLocale()).toBe("it")
    expect(documentElement.lang).toBe("it")
  })

  it("renders a native selector with language names without browser APIs", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="it">
        <LanguageSelect />
      </LocaleProvider>,
    )
    expect(html).toContain('<option value="it" lang="it" selected="">Italiano</option>')
    expect(html.match(/<option /g)).toHaveLength(9)
    expect(html).not.toContain('value="zh-CN"')
    expect(html).not.toContain('value="ar"')
    expect(html).not.toContain('value="pt-BR"')
  })
})

describe("message catalogs", () => {
  const englishKeys = Object.keys(catalogs.en).sort()

  it("contains an English source message for every literal translation call", () => {
    expect(englishKeys.length).toBeGreaterThan(100)
    const files = readdirSync(new URL(".", import.meta.url), {
      recursive: true,
      encoding: "utf8",
    }).filter((path) => /\.(ts|tsx)$/.test(path) && !path.includes(".test."))
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8")
      for (const match of source.matchAll(/\bt\(\s*("(?:\\.|[^"\\])*")/g)) {
        const key: string = JSON.parse(match[1])
        expect(Object.hasOwn(catalogs.en, key), `${file}: ${key}`).toBe(true)
      }
    }
  })

  it.each(languages)(
    "has complete messages and interpolation variables for $locale",
    ({ locale }) => {
      expect(Object.keys(catalogs[locale]).sort()).toEqual(englishKeys)
      for (const key of englishKeys) {
        const message = catalogs[locale][key]
        expect(message.trim(), `${locale}: ${key}`).not.toBe("")
        expect(variables(message), `${locale}: ${key}`).toEqual(variables(key))
        if (locale === "en") expect(message).toBe(key)
      }
    },
  )

  it("uses English when a translation is missing and ignores prototype properties", () => {
    expect(translate("it", "An unknown message {count}", { count: 2 })).toBe("An unknown message 2")
    expect(translate("ja", "toString")).toBe("toString")
    expect(translate("ja", "__proto__")).toBe("__proto__")
    expect(translate("en", "Missing {value}")).toBe("Missing {value}")
    expect(translate("en", "Unknown {toString}", {})).toBe("Unknown {toString}")
  })

  it("interpolates values without interpreting HTML or replacement syntax", () => {
    const value = "<script>$&{other}</script>"
    expect(translate("en", "Value: {value}", { value })).toBe(`Value: ${value}`)
    const html = renderToStaticMarkup(<span>{translate("it", "Value: {value}", { value })}</span>)
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(translate("en", "{count}", { count: 9_007_199_254_740_993n })).toBe("9007199254740993")
  })
})

describe("localized UI rendering", () => {
  it.each(languages)("renders the shell and sign-in page in $locale", ({ locale }) => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <LocaleProvider initialLocale={locale}>
          <App />
          <SignIn busy={false} onAuthenticate={() => {}} />
        </LocaleProvider>
      </ThemeProvider>,
    )
    expect(html).toContain(translate(locale, "Traces"))
    expect(html).toContain(translate(locale, "Sign in to Logice"))
    expect(html).toContain(translate(locale, "Project settings"))
    if (locale !== "en") {
      expect(translate(locale, "Sign in to Logice")).not.toBe("Sign in to Logice")
      expect(translate(locale, "Language")).not.toBe("Language")
    }
  })

  it("preserves telemetry text and exact UTC timestamps even when they match message keys", () => {
    const timestamp = "2026-10-27T12:34:56.123456789Z"
    const log: Log = {
      timestamp,
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      serviceName: "Dashboard",
      severityText: "Error",
      severityNumber: 17,
      body: "Projects",
      attributes: { Language: "Account" },
      resourceAttributes: {},
    }
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="it">
        <LogRecord log={log} window={{ from: timestamp, to: "2026-10-27T13:00:00Z" }} />
        <Timestamp value={timestamp} />
      </LocaleProvider>,
    )
    expect(html).toContain("Projects")
    expect(html).toContain("Dashboard")
    expect(html).toContain("Language")
    expect(html).toContain("Account")
    expect(html).toContain("Error")
    expect(html).toContain("2026-10-27 12:34:56.123456789 UTC")
    expect(html).toContain(`dateTime="${timestamp}"`)
  })

  it("keeps links in sentence order without rendering message text as HTML", () => {
    const html = renderToStaticMarkup(
      <LinkedMessage
        message="{second} before {first}; <script>text</script>."
        links={{ first: <a href="/first">First</a>, second: <a href="/second">Second</a> }}
      />,
    )
    expect(html).toBe(
      '<a href="/second">Second</a> before <a href="/first">First</a>; &lt;script&gt;text&lt;/script&gt;.',
    )
  })

  it("formats large numbers with the selected locale without losing precision", () => {
    function Counter() {
      const { number } = useI18n()
      return <span>{number(9_007_199_254_740_993n)}</span>
    }
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="de">
        <Counter />
      </LocaleProvider>,
    )
    expect(html).toContain("9.007.199.254.740.993")
  })
})
