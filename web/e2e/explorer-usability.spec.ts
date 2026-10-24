import type { Page } from "@playwright/test"
import type { Log, TraceSummary } from "../src/api"
import { expect, projectHref, test, workspace } from "./auth-fixtures"
import { control, record, row, snapshot, testTarget } from "./live-fixtures"

const window = {
  from: "2026-10-23T00:00:00.000000001Z",
  to: "2026-10-23T00:05:00.000000001Z",
}
const trace: TraceSummary = {
  traceId: "1234567890abcdef1234567890abcdef",
  name: `POST /${"checkout/".repeat(20)}`,
  serviceName: `checkout-${"service".repeat(20)}`,
  startTime: window.from,
  endTime: window.to,
  durationNs: "25000000",
  spanCount: 3,
  errorCount: 1,
}
const log: Log = {
  timestamp: window.from,
  traceId: trace.traceId,
  spanId: "1234567890abcdef",
  serviceName: trace.serviceName,
  severityText: "ERROR",
  severityNumber: 17,
  body: `Inventory unavailable <script>alert(1)</script> ${"message".repeat(100)}`,
  resourceAttributes: { "service.name": trace.serviceName },
  attributes: { ["attribute".repeat(20)]: "value".repeat(100) },
}

async function mockLists(page: Page) {
  for (const [kind, item] of [
    ["traces", trace],
    ["logs", log],
  ] as const) {
    await page.route(`**/api/projects/*/${kind}?**`, (route) => {
      const empty = new URL(route.request().url()).searchParams.get("service") === "missing"
      return route.fulfill({ json: { items: empty ? [] : [item], hasMore: false } })
    })
  }
}

async function expectNoHorizontalScroll(page: Page) {
  for (const selector of ["html", ".shell-content", ".panel > .table-scroll"]) {
    expect(
      await page
        .locator(selector)
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      selector,
    ).toBe(true)
  }
}

test.beforeEach(() => {
  testTarget(process.env.LOGICE_E2E_URL)
})

for (const kind of ["traces", "logs"]) {
  test(`${kind} resets filters from empty results without moving the exact query window`, async ({
    page,
  }) => {
    await mockLists(page)
    for (const range of ["", "&range=6h"]) {
      await page.goto(
        projectHref(
          `/${kind}?from=${window.from}&to=${window.to}&limit=100&service=missing&search=inventory&errorsOnly=true&minSeverity=17&traceId=${trace.traceId}${range}`,
        ),
      )
      await expect(page.getByRole("heading", { name: `No ${kind} in this window` })).toBeVisible()
      const reset = page.getByRole("link", { name: "Reset filters", exact: true })
      await expect(reset).toHaveCount(2)
      expect(await reset.first().getAttribute("href")).toBe(await reset.last().getAttribute("href"))
      await page.locator(".empty-state").getByRole("link", { name: "Reset filters" }).click()
      await expect(page.locator(`.${kind === "traces" ? "trace" : "log"}-table`)).toBeVisible()
      const query = new URL(page.url()).searchParams
      expect(query.get("from")).toBe(window.from)
      expect(query.get("to")).toBe(window.to)
      expect(query.get("limit")).toBe("100")
      expect(query.get("range")).toBe(range ? "6h" : null)
      expect(query.has("service")).toBe(false)
      expect(query.has("search")).toBe(false)
      expect(query.has("traceId")).toBe(false)
      expect(query.get(kind === "logs" ? "minSeverity" : "errorsOnly")).toBe(
        kind === "logs" ? "0" : "false",
      )
      await expect(reset).toHaveCount(0)
    }
  })
}

for (const theme of ["classic", "studio"]) {
  for (const width of [390, 760, 1440]) {
    test(`${theme} keeps trace links, log messages and details readable at ${width}px`, async ({
      page,
    }, testInfo) => {
      await mockLists(page)
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript((value) => localStorage.setItem("logice.theme", value), theme)
      await page.goto(projectHref("/traces"))
      const traceLink = page.getByRole("link", { name: trace.name, exact: true })
      await expect(traceLink).toBeVisible()
      await expect(
        page.getByRole("table", { name: "Traces in the selected time window" }),
      ).toBeVisible()
      await traceLink.scrollIntoViewIfNeeded()
      await expect(traceLink).toBeInViewport({ ratio: 1 })
      if (width <= 760) {
        await expectNoHorizontalScroll(page)
        await expect(page.locator(".trace-identity")).toHaveCSS("grid-column", "1 / -1")
      } else {
        await expect(page.locator(".trace-table")).toHaveCSS("display", "table")
      }
      await page.screenshot({ path: testInfo.outputPath(`${theme}-traces-${width}.png`) })
      await page.goto(projectHref("/logs"))
      const body = page.locator(".body-preview")
      await expect(body).toHaveText(log.body)
      await body.scrollIntoViewIfNeeded()
      await expect(body).toBeInViewport({ ratio: 1 })
      await expect(
        page.getByRole("table", { name: "Logs in the selected time window" }),
      ).toBeVisible()
      await page.getByText("Show log details", { exact: true }).click()
      await expect(page.getByText("Hide log details", { exact: true })).toBeVisible()
      await expect(page.locator(".log-body")).toHaveText(log.body)
      await page
        .locator(".log-body")
        .evaluate((element) => element.scrollIntoView({ block: "center" }))
      await expect(page.locator(".log-body")).toBeInViewport({ ratio: 1 })
      const correlation = page.locator(
        `a[href^="/projects/${workspace().project.id}/traces/${trace.traceId}?"]`,
      )
      await expect(correlation).toBeVisible()
      const href = new URL((await correlation.getAttribute("href")) ?? "", page.url())
      expect(href.searchParams.get("from")).toBe(new URL(page.url()).searchParams.get("from"))
      expect(href.searchParams.get("to")).toBe(new URL(page.url()).searchParams.get("to"))
      await expectNoHorizontalScroll(page)
      if (width <= 760) {
        expect(
          await page.locator(".log-content").evaluate((element) => {
            const row = element.parentElement
            return row !== null && element.clientWidth >= row.clientWidth - 32
          }),
        ).toBe(true)
      }
      expect(await page.locator("script").filter({ hasText: "alert(1)" }).count()).toBe(0)
      await page.screenshot({ path: testInfo.outputPath(`${theme}-logs-${width}.png`) })
      await page.getByText("Hide log details", { exact: true }).click()
      await expect(page.locator(".log-expansion")).not.toHaveAttribute("open")
    })
  }

  test(`${theme} makes pending Live filters explicit and resets filters without resuming updates`, async ({
    page,
  }, testInfo) => {
    const first = record(0, { statusCode: "Error" })
    const state = await control(page, snapshot([first]))
    await page.setViewportSize({ width: 390, height: 1000 })
    await page.addInitScript((value) => localStorage.setItem("logice.theme", value), theme)
    await page.goto(
      projectHref(
        `/live?mode=paused&from=${window.from}&to=${window.to}&service=controlled-live&search=Exported&errorsOnly=true&minSeverity=17`,
      ),
    )
    await expect(row(page, first.id)).toBeVisible()
    const before = page.url()
    const calls = state.queries.length
    await page.getByLabel("Errors only", { exact: true }).uncheck()
    await page.getByLabel("Minimum log severity", { exact: true }).selectOption("0")
    await expect(
      page.getByRole("status").filter({ hasText: "Unapplied filter changes" }),
    ).toBeVisible()
    expect(state.queries).toHaveLength(calls)
    expect(page.url()).toBe(before)
    await page.screenshot({ path: testInfo.outputPath(`${theme}-live-pending-390.png`) })
    await page.getByRole("button", { name: "Discard changes", exact: true }).click()
    await expect(page.getByLabel("Errors only", { exact: true })).toBeChecked()
    await expect(page.getByLabel("Minimum log severity", { exact: true })).toHaveValue("17")
    await expect(page.locator(".lv-query-pending")).toHaveCount(0)
    expect(state.queries).toHaveLength(calls)
    await page.getByLabel("Errors only", { exact: true }).uncheck()
    await page.getByRole("button", { name: "Apply changes", exact: true }).click()
    await expect.poll(() => state.queries.length).toBe(calls + 1)
    await expect(page.locator(".lv-query-pending")).toHaveCount(0)
    expect(state.queries.at(-1)?.get("errorsOnly")).toBeNull()
    await page.getByRole("button", { name: "Reset filters", exact: true }).click()
    await expect.poll(() => state.queries.length).toBe(calls + 2)
    await expect(page.getByRole("button", { name: "Resume live updates" })).toBeVisible()
    await expect(page.getByLabel("Service filter", { exact: true })).toHaveValue("")
    await expect(page.getByLabel("Search live events", { exact: true })).toHaveValue("")
    await expect(page.getByLabel("Minimum log severity", { exact: true })).toHaveValue("0")
    const query = state.queries.at(-1)
    expect(query?.get("from")).toBe(window.from)
    expect(query?.get("to")).toBe(window.to)
    expect(query?.get("service")).toBeNull()
    expect(query?.get("search")).toBeNull()
    await page.clock.fastForward(10_000)
    expect(state.queries).toHaveLength(calls + 2)
    expect(
      await page
        .locator(".shell-content")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
  })
}
