import { expect, type Page, test } from "@playwright/test"
import type { Log, Span, TraceSummary } from "../src/api"
import { control, record, snapshot } from "./live-fixtures"

const traceId = "1234567890abcdef1234567890abcdef"
const span: Span = {
  traceId,
  spanId: "1234567890abcdef",
  parentSpanId: "",
  name: "GET /checkout",
  serviceName: "checkout",
  startTime: "2026-10-23T00:01:00Z",
  durationNs: "12500000",
  statusCode: 2,
  statusMessage: "Inventory unavailable",
  resourceAttributes: { "service.name": "checkout" },
  attributes: { "http.method": "GET" },
}
const trace: TraceSummary = {
  traceId,
  name: span.name,
  serviceName: span.serviceName,
  startTime: span.startTime,
  endTime: "2026-10-23T00:01:01Z",
  durationNs: span.durationNs,
  spanCount: 1,
  errorCount: 1,
}
const log: Log = {
  timestamp: span.startTime,
  traceId,
  spanId: span.spanId,
  serviceName: span.serviceName,
  severityText: "ERROR",
  severityNumber: 17,
  body: "Inventory unavailable",
  resourceAttributes: span.resourceAttributes,
  attributes: { "error.type": "InventoryError" },
}

async function mockTelemetry(page: Page) {
  await page.route("**/api/**", (route) => route.abort())
  await page.route("**/api/traces?**", (route) =>
    route.fulfill({ json: { items: [trace], hasMore: false } }),
  )
  await page.route(`**/api/traces/${traceId}?**`, (route) =>
    route.fulfill({
      json: { traceId, spans: [span], logs: [log], spansTruncated: false, logsTruncated: false },
    }),
  )
  await page.route("**/api/logs?**", (route) =>
    route.fulfill({ json: { items: [log], hasMore: false } }),
  )
  return control(page, snapshot([record(0, { name: "GET /checkout" })]))
}

const routes = [
  { path: "/traces", heading: "Traces", name: "traces", ready: ".trace-table" },
  { path: "/logs", heading: "Logs", name: "logs", ready: ".log-table" },
  { path: `/traces/${traceId}`, heading: "Trace detail", name: "detail", ready: ".span-list" },
  { path: "/live", heading: "Live", name: "live", ready: ".lv-event-row" },
  { path: "/preview", heading: "Live", name: "preview", ready: ".lp-event-message" },
]

for (const theme of ["classic", "studio"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} styles every page at ${width}px`, async ({ page }, testInfo) => {
      await mockTelemetry(page)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("logice.theme", value), theme)
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      for (const route of routes) {
        await page.goto(route.path)
        await expect(page.getByRole("heading", { level: 1 })).toContainText(route.heading)
        await expect(page.locator(route.ready).first()).toBeVisible()
        const selector = page.getByRole("combobox", { name: "Theme", exact: true })
        await expect(selector).toBeVisible()
        await expect(selector).toHaveValue(theme)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        const colors = await page.locator(".application-shell").evaluate((element) => {
          const style = getComputedStyle(element)
          const heading = element.querySelector("h1")
          return {
            background: style.backgroundColor,
            heading: heading ? getComputedStyle(heading).color : "",
          }
        })
        expect(colors.background).toBe(
          theme === "classic" ? "rgb(245, 247, 250)" : "rgb(250, 250, 251)",
        )
        expect(colors.heading).toBe(theme === "classic" ? "rgb(22, 40, 63)" : "rgb(59, 53, 70)")
        await expect(page.getByRole("link", { name: "Logice — Open traces" })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        expect(
          await page
            .locator(".shell-content")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true)
        await page.screenshot({
          path: testInfo.outputPath(`${theme}-${route.name}-${width}.png`),
          animations: "disabled",
        })
        if (route.name === "live" || route.name === "preview") {
          await page.getByRole("button", { name: "Pause live updates" }).click()
          await page
            .getByRole("button", { name: /^Inspect / })
            .first()
            .click()
          await expect(page.getByRole("button", { name: "Close event details" })).toBeVisible()
          await page.screenshot({
            path: testInfo.outputPath(`${theme}-${route.name}-inspector-${width}.png`),
            animations: "disabled",
          })
          await page.keyboard.press("Escape")
          await expect(page.getByRole("button", { name: "Close event details" })).toHaveCount(0)
        }
      }
      expect(errors).toEqual([])
    })
  }
}

test("theme switches with the keyboard, survives reload, and follows navigation", async ({
  page,
}) => {
  await mockTelemetry(page)
  await page.goto("/traces?service=checkout&errorsOnly=true")
  await expect(page.locator(".trace-table")).toBeVisible()
  const selector = page.getByRole("combobox", { name: "Theme", exact: true })
  await expect(selector).toHaveValue("classic")
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("unsaved filter")
  const before = page.url()
  await selector.focus()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(selector).toHaveValue("studio")
  await expect(selector).toBeFocused()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "studio")
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue(
    "unsaved filter",
  )
  await expect(page.getByRole("checkbox", { name: "Errors only" })).toBeChecked()
  expect(page.url()).toBe(before)
  expect(await page.evaluate(() => localStorage.getItem("logice.theme"))).toBe("studio")
  await page.reload()
  await expect(selector).toHaveValue("studio")
  for (const name of ["Logs", "Live", "Design preview", "Traces"]) {
    await page.getByRole("navigation").getByRole("link", { name, exact: true }).click()
    await expect(selector).toHaveValue("studio")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "studio")
  }
  await selector.selectOption("classic")
  await page.reload()
  await expect(selector).toHaveValue("classic")
})

test("changing themes retains expanded log and span details", async ({ page }) => {
  await mockTelemetry(page)
  await page.goto("/logs")
  await page.getByText("Show log details", { exact: true }).click()
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("studio")
  await expect(page.locator(".log-expansion")).toHaveAttribute("open", "")
  await page.goto(`/traces/${traceId}`)
  await page.locator(".span-summary").click()
  const before = page.url()
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("classic")
  await expect(page.locator(".span-summary").locator("..")).toHaveAttribute("open", "")
  expect(page.url()).toBe(before)
})

test("theme changes retain Live pause, draft filters, selection, and inspector tab", async ({
  page,
}) => {
  const state = await mockTelemetry(page)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto("/live")
  await expect(page.locator(".lv-event-row")).toBeVisible()
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.getByRole("button", { name: "Inspect GET /checkout", exact: true }).click()
  await page.getByRole("tab", { name: "Stored record JSON", exact: true }).click()
  await page.getByRole("textbox", { name: "Search live events" }).fill("draft search")
  const before = page.url()
  const calls = state.queries.length
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("studio")
  await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Stored record JSON", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.getByRole("textbox", { name: "Search live events" })).toHaveValue(
    "draft search",
  )
  await expect(page.getByRole("button", { name: "Resume live updates" })).toBeVisible()
  expect(page.url()).toBe(before)
  await page.clock.runFor(5000)
  expect(state.queries).toHaveLength(calls)
})

test("theme changes retain Preview state and make no telemetry requests", async ({ page }) => {
  await mockTelemetry(page)
  const requests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url())
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto("/preview")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.getByRole("button", { name: "Inspect POST /api/chat", exact: true }).first().click()
  await page.getByRole("tab", { name: "Raw data", exact: true }).click()
  const tick = await page.getByTestId("preview-tick").textContent()
  const before = page.url()
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("studio")
  await expect(page.getByRole("tab", { name: "Raw data", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.getByRole("complementary", { name: "Event details" })).toBeVisible()
  await page.clock.runFor(5000)
  await expect(page.getByTestId("preview-tick")).toHaveText(tick ?? "")
  expect(page.url()).toBe(before)
  expect(requests).toEqual([])
})

test("invalid saved themes use Classic and restricted storage does not prevent switching", async ({
  page,
}) => {
  await mockTelemetry(page)
  await page.addInitScript(() => localStorage.setItem("logice.theme", "unknown-theme"))
  await page.goto("/preview")
  const selector = page.getByRole("combobox", { name: "Theme", exact: true })
  await expect(selector).toHaveValue("classic")
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage disabled", "SecurityError")
      },
    })
  })
  await page.reload()
  await expect(selector).toHaveValue("classic")
  await selector.selectOption("studio")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "studio")
  await expect(selector).toHaveValue("studio")
  await page.reload()
  await expect(selector).toHaveValue("classic")
})

test("a storage write failure keeps the current theme usable", async ({ page }) => {
  await mockTelemetry(page)
  await page.addInitScript(() => {
    localStorage.setItem("logice.theme", "studio")
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage full", "QuotaExceededError")
    }
  })
  await page.goto("/traces")
  const selector = page.getByRole("combobox", { name: "Theme", exact: true })
  await expect(selector).toHaveValue("studio")
  await selector.selectOption("classic")
  await expect(selector).toHaveValue("classic")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic")
  expect(await page.evaluate(() => localStorage.getItem("logice.theme"))).toBe("studio")
})

test("invalid routes and API errors retain both themes and navigation", async ({ page }) => {
  await mockTelemetry(page)
  const cases = [
    ["/live?range=2m", "Invalid Live query"],
    ["/traces?limit=invalid", "Invalid query"],
    ["/traces/not-a-trace", "Invalid query"],
    ["/missing", "This page does not exist"],
  ]
  for (const [path, message] of cases) {
    await page.goto(path)
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    for (const theme of ["studio", "classic"]) {
      await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await expect(
        page.getByRole("navigation").getByRole("link", { name: "Traces", exact: true }),
      ).toBeVisible()
    }
  }
  await page.route("**/api/traces?**", (route) => route.fulfill({ status: 503, json: {} }))
  await page.goto("/traces")
  await expect(page.getByRole("alert")).toContainText("Telemetry could not be loaded")
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("studio")
  await expect(page.getByRole("alert")).toContainText("Telemetry storage is unavailable")
})
