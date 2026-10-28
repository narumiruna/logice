import { expect, type Locator, type Page, test } from "@playwright/test"
import { record, snapshot } from "./live-fixtures"

// Layout-only fixtures. These tests do not verify authentication or backend behavior.
const project = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Production API",
  ownerId: "reviewer",
  role: "Owner",
}
const path = (page: string) => `/projects/${project.id}/${page}`
const live = snapshot([record(0, { name: "GET /checkout" })])
const query = new URLSearchParams(live.window)
const trace = {
  traceId: "1234567890abcdef1234567890abcdef",
  name: "GET /checkout",
  serviceName: "checkout",
  startTime: live.window.from,
  endTime: live.window.to,
  durationNs: "25000000",
  spanCount: 2,
  errorCount: 1,
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const json =
      url.pathname === "/api/auth/session"
        ? { user: { id: "reviewer", name: "Reviewer", admin: false } }
        : url.pathname === "/api/projects"
          ? { items: [project], hasMore: false }
          : url.pathname === `/api/projects/${project.id}`
            ? project
            : url.pathname === `/api/projects/${project.id}/traces`
              ? { items: [trace], hasMore: false }
              : url.pathname === `/api/projects/${project.id}/logs`
                ? { items: [], hasMore: false }
                : url.pathname === `/api/projects/${project.id}/live`
                  ? live
                  : null
    await route.fulfill({ status: json ? 200 : 404, json: json ?? {} })
  })
})

async function withinViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

async function touchControl(locator: Locator) {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const size = await locator.boundingBox()
  expect(size?.x).toBeGreaterThanOrEqual(0)
  expect((size?.x ?? 0) + (size?.width ?? 0)).toBeLessThanOrEqual(
    await locator.page().evaluate(() => innerWidth),
  )
  // Firefox can report a 44px CSS box as 43.99998px.
  expect(Math.round(size?.height ?? 0)).toBeGreaterThanOrEqual(44)
  expect(Math.round(size?.width ?? 0)).toBeGreaterThanOrEqual(44)
  expect(
    await locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(12)
}

for (const theme of ["classic", "studio"]) {
  for (const width of [320, 390]) {
    test(`${theme} ${width}px navigation has labels, modal focus, and scoped links`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(path(`traces?${query}`))
      await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme)
      const menu = page.getByRole("button", { name: "Application navigation", exact: true })
      await menu.click()
      const navigation = page.getByRole("dialog", { name: "Application navigation" })
      await expect(navigation).toBeVisible()
      for (const [label, destination] of [
        ["Projects", "/projects"],
        ["Dashboard", path("dashboard")],
        ["Live", path("live")],
        ["Project settings", path("settings")],
        ["Connect application", path("setup")],
        ["Alerts", path("alerts")],
        ["Account", "/account"],
      ]) {
        const link = navigation.getByRole("link", { name: label, exact: true })
        await touchControl(link)
        await expect(link).toHaveAttribute("href", destination)
        await expect(link.locator("span")).toBeVisible()
      }
      const traces = navigation.getByRole("link", { name: "Traces", exact: true })
      await expect(traces).toHaveAttribute("aria-current", "page")
      const tracesURL = new URL((await traces.getAttribute("href")) ?? "", page.url())
      expect(tracesURL.pathname).toBe(path("traces"))
      expect(tracesURL.searchParams.get("from")).toBe(live.window.from)
      expect(tracesURL.searchParams.get("to")).toBe(live.window.to)
      const close = navigation.getByRole("button", { name: "Close navigation" })
      await expect(close).toBeFocused()
      const projects = navigation.getByRole("link", { name: "Projects", exact: true })
      await projects.focus()
      await expect(projects).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(navigation).toBeHidden()
      await expect(menu).toBeFocused()
      await menu.click()
      await close.click()
      await expect(menu).toBeFocused()
      await menu.click()
      await navigation.getByRole("link", { name: "Logs", exact: true }).click()
      await expect(page.getByRole("heading", { name: "Logs", exact: true })).toBeVisible()
      await expect(navigation).toBeHidden()
      await menu.click()
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(navigation).toBeHidden()
      await expect(page.getByRole("navigation")).toBeVisible()
      await expect(page.getByRole("form", { name: "Log filters" })).toBeVisible()
      await expect(page.locator(".filter-toggle")).toBeHidden()
      await withinViewport(page)
    })

    for (const view of ["live", "preview"]) {
      test(`${theme} ${width}px ${view} controls have readable text and touch areas`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 })
        await page.goto(view === "live" ? path(`live?mode=paused&${query}`) : "/preview")
        await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme)
        if (view === "live") await expect(page.locator(".lv-event-row")).toHaveCount(1)
        const controls = page.locator(
          ".lp-search input, .lp-querybar select, .lp-querybar button, .lv-service-control input, .lp-feed-toolbar button, .lp-feed-toolbar label, .lp-feed-toolbar select, .lp-feed-footer label",
        )
        expect(await controls.count()).toBeGreaterThan(8)
        for (const control of await controls.all()) await touchControl(control)
        await withinViewport(page)
        const follow = page.getByLabel("Follow latest", { exact: true })
        await follow.uncheck()
        await expect(follow).not.toBeChecked()
        await follow.check()
        await expect(follow).toBeChecked()
      })
    }
  }

  test(`${theme} mobile Traces exposes results and preserves applied filters and exact windows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(path(`traces?${query}`))
    await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme)
    const first = page.getByRole("link", { name: "GET /checkout", exact: true })
    await expect(first).toBeVisible()
    expect((await first.boundingBox())?.y).toBeLessThan(744)
    await expect(page.locator(".filter-form")).toBeHidden()
    const toggle = page.locator(".filter-toggle")
    await expect(toggle).toContainText("Fixed window · All services")
    await toggle.focus()
    await page.keyboard.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("textbox", { name: "Service", exact: true }).fill("checkout")
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("GET")
    await page.getByLabel("Errors only", { exact: true }).check()
    await page.getByRole("button", { name: "Apply filters", exact: true }).click()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(toggle).toContainText("Service: checkout · Search: GET · Errors only")
    const applied = new URL(page.url()).searchParams
    expect(applied.get("from")).toBe(live.window.from)
    expect(applied.get("to")).toBe(live.window.to)
    expect(applied.get("service")).toBe("checkout")
    expect(applied.get("errorsOnly")).toBe("true")
    await toggle.click()
    await page.getByRole("link", { name: "Reset filters", exact: true }).click()
    await expect(toggle).toContainText("Fixed window · All services")
    const reset = new URL(page.url()).searchParams
    expect(reset.get("from")).toBe(live.window.from)
    expect(reset.get("to")).toBe(live.window.to)
    expect(reset.has("service")).toBe(false)
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja")
    await expect(toggle).toContainText("フィルター")
    await page.getByRole("button", { name: "アプリケーションのナビゲーション" }).click()
    await expect(page.getByRole("button", { name: "ナビゲーションを閉じる" })).toBeVisible()
    await withinViewport(page)
  })
}
