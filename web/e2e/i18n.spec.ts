import de from "../src/locales/de.json" with { type: "json" }
import es from "../src/locales/es.json" with { type: "json" }
import fr from "../src/locales/fr.json" with { type: "json" }
import it from "../src/locales/it.json" with { type: "json" }
import ja from "../src/locales/ja.json" with { type: "json" }
import ko from "../src/locales/ko.json" with { type: "json" }
import pt from "../src/locales/pt.json" with { type: "json" }
import zhTW from "../src/locales/zh-TW.json" with { type: "json" }
import { expect, projectHref, test } from "./auth-fixtures"
import { control, record, snapshot } from "./live-fixtures"

const translations = { "zh-TW": zhTW, ja, ko, es, fr, de, pt, it }
const locales = Object.keys(translations) as (keyof typeof translations)[]

async function mockTraces(page: import("@playwright/test").Page) {
  let calls = 0
  await page.route("**/api/projects/*/traces?**", (route) => {
    calls++
    return route.fulfill({ json: { items: [], hasMore: false } })
  })
  await page.route("**/api/projects/*/logs?**", (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  )
  return () => calls
}

test("all selected languages preserve drafts, URLs, theme, and loaded results", async ({
  page,
}) => {
  const calls = await mockTraces(page)
  await page.goto(projectHref("/traces?service=checkout&errorsOnly=true"))
  await expect(page.locator(".empty-state")).toBeVisible()
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("studio")
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("unsaved filter")
  const before = page.url()
  const count = calls()
  const selector = page.locator(".language-select select")
  await expect(selector.locator("option")).toHaveCount(9)
  await expect(
    selector.locator('option[value="zh-CN"], option[value="ar"], option[value="pt-BR"]'),
  ).toHaveCount(0)
  for (const locale of locales) {
    await selector.selectOption(locale)
    await expect(page.locator("html")).toHaveAttribute("lang", locale)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(translations[locale].Traces)
    await expect(page.locator('input[name="search"]')).toHaveValue("unsaved filter")
    await expect(page.locator('input[name="errorsOnly"]')).toBeChecked()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "studio")
    expect(page.url()).toBe(before)
    expect(calls()).toBe(count)
  }
})

test("language selection supports the keyboard and persists across reload and navigation", async ({
  page,
}) => {
  await mockTraces(page)
  await page.goto(projectHref("/traces"))
  await expect(page.locator(".empty-state")).toBeVisible()
  const selector = page.locator(".language-select select")
  await selector.focus()
  await page.keyboard.press("i")
  await page.keyboard.press("Enter")
  await expect(selector).toHaveValue("it")
  await expect(selector).toBeFocused()
  expect(await page.evaluate(() => localStorage.getItem("logice.locale"))).toBe("it")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("lang", "it")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(it.Traces)
  await page.getByRole("navigation").getByRole("link", { name: it.Logs, exact: true }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(it.Logs)
  await expect(selector).toHaveValue("it")
})

test("existing query errors change language without changing the query", async ({ page }) => {
  await page.goto(projectHref("/traces?limit=101"))
  const before = page.url()
  await expect(page.locator(".notice")).toContainText("limit must be an integer from 1 to 100.")
  await page.locator(".language-select select").selectOption("it")
  await expect(page.locator(".notice")).toContainText(it["limit must be an integer from 1 to 100."])
  expect(page.url()).toBe(before)
})

test("existing API errors change language without retrying the request", async ({ page }) => {
  let calls = 0
  await page.route("**/api/projects/*/traces?**", (route) => {
    calls++
    return route.fulfill({ status: 503, json: {} })
  })
  await page.goto(projectHref("/traces"))
  await expect(page.locator(".notice")).toContainText("Telemetry storage is unavailable.")
  const count = calls
  await page.locator(".language-select select").selectOption("it")
  await expect(page.locator(".notice")).toContainText(
    it["Telemetry storage is unavailable. Try again later."],
  )
  expect(calls).toBe(count)
})

test("project search matches translated and original roles", async ({ page }) => {
  await page.route("**/api/projects?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "First application",
            ownerId: "owner",
            role: "Developer",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Second application",
            ownerId: "owner",
            role: "Viewer",
          },
        ],
        hasMore: false,
      },
    }),
  )
  await page.goto("/projects")
  await expect(page.locator(".project-card")).toHaveCount(2)
  await page.locator(".language-select select").selectOption("de")
  const search = page.locator(".project-list-toolbar input")
  await search.fill(de.Developer)
  await expect(page.locator(".project-card")).toHaveCount(1)
  await expect(page.locator(".project-card")).toContainText("First application")
  await search.fill("Developer")
  await expect(page.locator(".project-card")).toHaveCount(1)
  await page.locator(".language-select select").selectOption("it")
  await search.fill(it.Viewer)
  await expect(page.locator(".project-card")).toHaveCount(1)
  await expect(page.locator(".project-card")).toContainText("Second application")
})

test("account language controls stay synchronized without resetting profile edits", async ({
  page,
}) => {
  await page.goto("/account")
  await page.locator('input[autocomplete="nickname"]').fill("Uncommitted name")
  const selectors = page.locator(".language-select select")
  await expect(selectors).toHaveCount(2)
  await selectors.last().selectOption("pt")
  await expect(selectors.first()).toHaveValue("pt")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(pt["Account settings"])
  await expect(page.locator('input[autocomplete="nickname"]')).toHaveValue("Uncommitted name")
  await selectors.first().selectOption("it")
  await expect(selectors.last()).toHaveValue("it")
})

test("switching languages retains paused Live selection, inspector tab, and draft filters", async ({
  page,
}) => {
  const state = await control(page, snapshot([record(0, { name: "GET /checkout" })]))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(projectHref("/live"))
  await expect(page.locator(".lv-event-row")).toBeVisible()
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.getByRole("button", { name: "Inspect GET /checkout", exact: true }).click()
  await page.getByRole("tab", { name: "Stored record JSON", exact: true }).click()
  await page.getByRole("textbox", { name: "Search live events" }).fill("draft search")
  const before = page.url()
  const calls = state.queries.length
  await page.locator(".language-select select").selectOption("it")
  await expect(page.getByRole("dialog", { name: it["Event details"] })).toBeVisible()
  await expect(
    page.getByRole("tab", { name: it["Stored record JSON"], exact: true }),
  ).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("textbox", { name: it["Search live events"] })).toHaveValue(
    "draft search",
  )
  await expect(page.getByRole("button", { name: it["Resume live updates"] })).toBeVisible()
  expect(page.url()).toBe(before)
  await page.waitForTimeout(2500)
  expect(state.queries.length).toBe(calls)
})

for (const theme of ["classic", "studio"]) {
  for (const width of [390, 1440]) {
    test(`language controls fit the ${theme} shell at ${width}px`, async ({ page }) => {
      await mockTraces(page)
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript((value) => localStorage.setItem("logice.theme", value), theme)
      await page.goto(projectHref("/traces"))
      await expect(page.locator(".empty-state")).toBeVisible()
      const selector = page.locator(".language-select select")
      for (const locale of locales) {
        await selector.selectOption(locale)
        await expect(selector).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        expect(
          await page
            .locator(".shell-content")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true)
        expect(
          await selector.evaluate((element) => element.getBoundingClientRect().right <= innerWidth),
        ).toBe(true)
      }
    })
  }
}

for (const invalid of ["zh-CN", "ar", "pt-BR", "unknown"]) {
  test(`saved unsupported language ${invalid} falls back to English`, async ({ page }) => {
    await mockTraces(page)
    await page.addInitScript((value) => localStorage.setItem("logice.locale", value), invalid)
    await page.goto(projectHref("/traces"))
    await expect(page.locator(".language-select select")).toHaveValue("en")
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Traces")
  })
}

test("failed preference writes do not prevent switching on the current page", async ({ page }) => {
  await mockTraces(page)
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage denied", "SecurityError")
    }
  })
  await page.goto(projectHref("/traces"))
  await page.locator(".language-select select").selectOption("it")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(it.Traces)
  await expect(page.locator("html")).toHaveAttribute("lang", "it")
  await page.reload()
  await expect(page.locator(".language-select select")).toHaveValue("en")
})

test.describe("sign-in language selection", () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  for (const width of [320, 390, 1440]) {
    test(`translates sign-in and retains invitation text at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto("/")
      await page.getByText("Accept an invitation", { exact: true }).click()
      await page.getByLabel("Invitation token", { exact: true }).fill("unsent invitation")
      const selector = page.locator(".language-select select")
      for (const locale of locales) {
        await selector.selectOption(locale)
        await expect(
          page.getByRole("heading", { name: translations[locale]["Sign in to Logice"] }),
        ).toBeVisible()
        await expect(page.locator("#invitation-token")).toHaveValue("unsent invitation")
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
      }
    })
  }

  test("unavailable browser storage defaults to English and still allows switching", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Denied", "SecurityError")
        },
      })
    })
    await page.goto("/")
    await expect(page.locator(".language-select select")).toHaveValue("en")
    await page.locator(".language-select select").selectOption("it")
    await expect(page.getByRole("heading", { name: it["Sign in to Logice"] })).toBeVisible()
  })
})
