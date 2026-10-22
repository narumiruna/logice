import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  initializeTheme,
  isTheme,
  readTheme,
  ThemeProvider,
  ThemeSelect,
  themeStorageKey,
} from "./theme"

afterEach(() => vi.unstubAllGlobals())

const stylesheet = readFileSync(new URL("./themes.css", import.meta.url), "utf8")

function luminance(hex: string): number {
  const digits = hex.slice(1)
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits
  const [red, green, blue] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(full.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

for (const theme of ["classic", "studio"]) {
  describe(`${theme} text contrast`, () => {
    const block = stylesheet.split(`html[data-theme="${theme}"] {`)[1]?.split("}")[0] ?? ""
    const colors = Object.fromEntries(
      [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]+);/g)].map((match) => [match[1], match[2]]),
    )
    it.each([
      ["--color-text", "--color-background"],
      ["--color-heading", "--color-background"],
      ["--color-muted", "--color-background"],
      ["--color-accent", "--color-accent-soft"],
      ["--color-on-accent", "--color-accent"],
      ["--color-error", "--color-error-soft"],
      ["--color-warning", "--color-warning-soft"],
      ["--color-success", "--color-success-soft"],
      ["--color-info", "--color-info-soft"],
      ["--color-service-worker", "--color-service-worker-soft"],
    ])("%s on %s meets 4.5:1 for small text", (foreground, background) => {
      expect(colors[foreground]).toMatch(/^#[0-9a-f]{3,6}$/)
      expect(colors[background]).toMatch(/^#[0-9a-f]{3,6}$/)
      const first = luminance(colors[foreground])
      const second = luminance(colors[background])
      expect(
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
      ).toBeGreaterThanOrEqual(4.5)
    })
  })
}

describe("theme preference", () => {
  it.each(["classic", "studio"])("accepts %s", (theme) => {
    expect(isTheme(theme)).toBe(true)
    const getItem = vi.fn(() => theme)
    vi.stubGlobal("window", { localStorage: { getItem } })
    expect(readTheme()).toBe(theme)
    expect(getItem).toHaveBeenCalledWith(themeStorageKey)
  })

  it.each([null, "", "dark", "STUDIO", "<script>"])(
    "defaults invalid preference %s to Classic",
    (value) => {
      vi.stubGlobal("window", { localStorage: { getItem: () => value } })
      expect(isTheme(value)).toBe(false)
      expect(readTheme()).toBe("classic")
    },
  )

  it("defaults to Classic without browser APIs", () => {
    expect(readTheme()).toBe("classic")
  })

  it("defaults to Classic if accessing storage fails", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("Storage denied")
      },
    })
    expect(readTheme()).toBe("classic")
  })

  it("applies the saved theme before rendering", () => {
    const dataset = { theme: "" }
    vi.stubGlobal("document", { documentElement: { dataset } })
    vi.stubGlobal("window", { localStorage: { getItem: () => "studio" } })
    expect(initializeTheme()).toBe("studio")
    expect(dataset.theme).toBe("studio")
  })

  it("renders a labeled native selector with both themes without browser APIs", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider initialTheme="studio">
        <ThemeSelect />
      </ThemeProvider>,
    )
    expect(html).toContain("<span>Theme</span>")
    expect(html).toContain('<option value="classic">Classic</option>')
    expect(html).toContain('<option value="studio" selected="">Studio</option>')
  })
})
