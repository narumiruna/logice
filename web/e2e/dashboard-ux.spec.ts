import { readFileSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"

const id = "11111111-1111-1111-1111-111111111111"
const dashboard = `/projects/${id}/dashboard`
const traceId = "1234567890abcdef1234567890abcdef"
const stats = {
  traces: "1250",
  logs: "8490",
  errorTraces: "42",
  rootSpans: "1198",
  conflicts: "2",
  p50Ns: "32000000",
  p95Ns: "275000000",
  errorProportion: 42 / 1250,
}
const zero = {
  traces: "0",
  logs: "0",
  errorTraces: "0",
  rootSpans: "0",
  conflicts: "0",
  p50Ns: null,
  p95Ns: null,
  errorProportion: null,
}

// Layout and interaction fixtures only; authentication and backend behavior are not under test.
async function fixture(page: Page) {
  const state = {
    role: "Owner",
    mode: "data",
    requests: [] as URL[],
    hold: null as Promise<void> | null,
  }
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const project = { id, name: "Production API", role: state.role, ownerId: "reviewer" }
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { user: { id: "reviewer", name: "Reviewer", admin: false } } })
      return
    }
    if (url.pathname === "/api/projects") {
      await route.fulfill({ json: { items: [project], hasMore: false } })
      return
    }
    if (url.pathname === `/api/projects/${id}`) {
      await route.fulfill({ json: project })
      return
    }
    state.requests.push(url)
    if (state.hold) await state.hold
    if (state.mode === "error") {
      await route.fulfill({ status: 503, json: {} })
      return
    }
    const from = url.searchParams.get("from") ?? "2026-10-28T10:00:00.000Z"
    const to = url.searchParams.get("to") ?? "2026-10-28T11:00:00.000Z"
    const values =
      state.mode === "empty" ? zero : state.mode === "logs" ? { ...zero, logs: "20" } : stats
    if (url.pathname.endsWith("/overview")) {
      const start = Date.parse(from)
      const width = Date.parse(to) - start
      await route.fulfill({
        json: {
          ...values,
          from,
          to,
          queriedAt: to,
          buckets: Array.from({ length: 60 }, (_, index) => ({
            ...values,
            traces: values.traces === "0" ? "0" : String(12 + (index % 11)),
            errorTraces: values.traces === "0" ? "0" : String(index % 14 ? 0 : 3),
            from: new Date(start + (width * index) / 60).toISOString(),
            to: new Date(start + (width * (index + 1)) / 60).toISOString(),
          })),
        },
      })
      return
    }
    const items =
      state.mode === "empty"
        ? []
        : url.pathname.endsWith("/traces")
          ? state.mode === "logs"
            ? []
            : [
                {
                  traceId,
                  name: "POST /checkout",
                  serviceName: "checkout",
                  startTime: from,
                  endTime: to,
                  durationNs: "125000000",
                  spanCount: 7,
                  errorCount: 1,
                },
              ]
          : [
              {
                timestamp: from,
                traceId,
                spanId: "1234567890abcdef",
                serviceName: "checkout",
                severityText: "ERROR",
                severityNumber: 17,
                body: "Payment gateway timeout",
                resourceAttributes: {},
                attributes: {},
              },
            ]
    await route.fulfill({ json: { items, hasMore: false } })
  })
  return state
}

function overviewRequest(requests: URL[]) {
  const request = requests.filter((url) => url.pathname.endsWith("/overview")).at(-1)
  if (!request) throw new Error("No overview request")
  return request
}

async function ready(page: Page) {
  await expect(page.locator(".dashboard-stats article")).toHaveCount(4)
  await expect(page.locator(".dashboard-stats strong")).toHaveText([
    "1,250",
    "8,490",
    "3.36%",
    "275 ms",
  ])
  await expect(page.getByRole("link", { name: "POST /checkout", exact: true })).toBeVisible()
}

for (const theme of ["classic", "studio"]) {
  for (const width of [320, 390, 1440]) {
    test(`${theme} Dashboard has compact metrics and earlier records at ${width}px`, async ({
      page,
    }) => {
      await fixture(page)
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
      await page.addInitScript((theme) => localStorage.setItem("logice.theme", theme), theme)
      await page.goto(dashboard)
      await ready(page)
      await expect(
        page.getByRole("img", { name: "Stored trace and error counts across 60 UTC buckets" }),
      ).toBeVisible()
      const row = page.getByRole("link", { name: "POST /checkout", exact: true })
      expect((await row.boundingBox())?.y).toBeLessThan(width === 1440 ? 900 : 1200)
      if (width === 1440) await expect(row).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      expect(
        await page.locator(".shell-content").evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true)
      if (width < 700) {
        for (const control of await page
          .locator(".dashboard-query input, .dashboard-query select, .dashboard-query button")
          .all()) {
          expect(Math.round((await control.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44)
        }
      }
      const definitions = page.locator(".dashboard-definitions summary")
      await definitions.focus()
      await page.keyboard.press("Enter")
      await expect(page.locator(".dashboard-definitions")).toContainText("32 ms")
      await expect(page.locator(".dashboard-definitions")).toContainText("not request latency")
      await page.keyboard.press("Enter")
      const buckets = page.locator(".dashboard-buckets summary")
      await buckets.focus()
      await page.keyboard.press("Enter")
      await expect(page.locator(".dashboard-buckets tbody tr")).toHaveCount(60)
      await buckets.focus()
      await page.keyboard.press("Enter")
    })
  }
}

test("Dashboard applies drafts together, refreshes only applied scope, and preserves explorer links", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.goto(dashboard)
  await ready(page)
  const original = overviewRequest(state.requests)
  await page.getByLabel("Dashboard service", { exact: true }).fill("checkout / payments")
  await page.getByLabel("Dashboard time range", { exact: true }).selectOption("15m")
  await expect(page.getByRole("status")).toContainText("Unapplied filter changes")
  expect(overviewRequest(state.requests)).toBe(original)
  await page.getByRole("button", { name: "Refresh dashboard", exact: true }).click()
  await ready(page)
  await expect
    .poll(() => overviewRequest(state.requests).searchParams.get("to"))
    .not.toBe(original.searchParams.get("to"))
  const refreshed = overviewRequest(state.requests).searchParams
  expect(refreshed.has("service")).toBe(false)
  expect(Date.parse(refreshed.get("to") ?? "") - Date.parse(refreshed.get("from") ?? "")).toBe(
    3600000,
  )
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  await ready(page)
  await expect(page.locator(".dashboard-pending")).toHaveCount(0)
  const applied = overviewRequest(state.requests).searchParams
  expect(applied.get("service")).toBe("checkout / payments")
  expect(Date.parse(applied.get("to") ?? "") - Date.parse(applied.get("from") ?? "")).toBe(900000)
  for (const link of await page.locator(".dashboard-stats a, .dashboard-panel-heading a").all()) {
    const url = new URL((await link.getAttribute("href")) ?? "", page.url())
    expect(url.pathname).toMatch(new RegExp(`^/projects/${id}/(traces|logs)$`))
    for (const key of ["from", "to", "service"])
      expect(url.searchParams.get(key)).toBe(applied.get(key))
  }
  const errors = new URL(
    (await page.locator(".dashboard-stats .has-errors a").getAttribute("href")) ?? "",
    page.url(),
  )
  expect(errors.searchParams.get("errorsOnly")).toBe("true")
  await page.locator(".dashboard-buckets summary").click()
  const bucketURL = new URL(
    (await page.locator(".dashboard-buckets tbody a").first().getAttribute("href")) ?? "",
    page.url(),
  )
  expect(bucketURL.searchParams.get("service")).toBe("checkout / payments")
  expect(bucketURL.searchParams.get("from")).toBe(applied.get("from"))
  expect(
    Date.parse(bucketURL.searchParams.get("to") ?? "") -
      Date.parse(bucketURL.searchParams.get("from") ?? ""),
  ).toBe(15000)
  await page.getByLabel("Dashboard service", { exact: true }).fill("discard this")
  await page.getByRole("button", { name: "Discard changes", exact: true }).click()
  await expect(page.getByLabel("Dashboard service", { exact: true })).toHaveValue(
    "checkout / payments",
  )
  await expect(page.getByLabel("Dashboard service", { exact: true })).toBeFocused()
})

for (const role of ["Owner", "Developer", "Viewer"]) {
  test(`Dashboard empty state is actionable for ${role} without inventing healthy metrics`, async ({
    page,
  }) => {
    const state = await fixture(page)
    state.role = role
    state.mode = "empty"
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(dashboard)
    const onboarding = page.locator(".dashboard-onboarding")
    await expect(onboarding).toContainText("No stored telemetry in this window")
    await expect(
      onboarding.getByRole("link", { name: "Connect application", exact: true }),
    ).toBeInViewport()
    await expect(page.locator(".dashboard-stats strong")).toHaveText(["0", "0", "—", "—"])
    await expect(page.locator(".dashboard-activity")).toHaveCount(0)
    expect(
      await page.getByRole("link", { name: "Manage ingestion tokens", exact: true }).count(),
    ).toBe(role === "Viewer" ? 0 : 2)
    if (role === "Viewer") await expect(onboarding).toContainText("Ask an Owner or Developer")
  })
}

test("Dashboard distinguishes filtered emptiness and log-only data from an unconnected project", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.goto(dashboard)
  await ready(page)
  state.mode = "empty"
  await page.getByLabel("Dashboard service", { exact: true }).fill("missing-service")
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  await expect(page.locator(".dashboard-onboarding")).toContainText(
    "No telemetry matches this service",
  )
  await expect(page.locator(".dashboard-onboarding")).toContainText("Try another service")
  await expect(
    page.locator(".dashboard-onboarding").getByRole("link", { name: "Manage ingestion tokens" }),
  ).toHaveCount(0)
  state.mode = "logs"
  await page.getByRole("button", { name: "Refresh dashboard", exact: true }).click()
  await expect(page.locator(".dashboard-stats strong")).toHaveText(["0", "20", "—", "—"])
  await expect(page.locator(".dashboard-onboarding")).toHaveCount(0)
})

test("Dashboard keeps loading and failure distinct from empty statistics, then retries the same window", async ({
  page,
}) => {
  const state = await fixture(page)
  let release = () => {}
  state.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.goto(dashboard)
  await expect(page.locator(".dashboard-overview")).toContainText("Loading full-window statistics")
  await expect(page.locator(".dashboard-stats")).toHaveCount(0)
  await expect(page.locator(".dashboard-onboarding")).toHaveCount(0)
  state.mode = "error"
  release()
  await expect(page.getByRole("alert")).toHaveCount(2)
  await expect(page.locator(".dashboard-overview")).toContainText(
    "No sample or partial count is substituted",
  )
  const original = overviewRequest(state.requests).searchParams.toString()
  state.mode = "data"
  state.hold = null
  await page.getByRole("button", { name: "Retry statistics", exact: true }).click()
  await page.getByRole("button", { name: "Retry dashboard", exact: true }).click()
  await ready(page)
  expect(overviewRequest(state.requests).searchParams.toString()).toBe(original)
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("Dashboard clears old metrics and records while a new query loads", async ({ page }) => {
  const state = await fixture(page)
  await page.goto(dashboard)
  await ready(page)
  let release = () => {}
  state.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.getByLabel("Dashboard service", { exact: true }).fill("new-service")
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  await expect(page.locator(".dashboard-stats")).toHaveCount(0)
  await expect(page.locator(".dashboard-records")).toHaveCount(0)
  await expect(page.locator(".dashboard-onboarding")).toHaveCount(0)
  release()
  await ready(page)
})

test("Dashboard translated filters and metrics fit a narrow viewport", async ({ page }) => {
  await fixture(page)
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto(dashboard)
  await ready(page)
  for (const locale of ["de", "ja", "fr"] as const) {
    await page.getByRole("combobox", { name: /Language|Sprache|言語/ }).selectOption(locale)
    await expect(
      page.getByRole("form", {
        name: JSON.parse(
          readFileSync(new URL(`../src/locales/${locale}.json`, import.meta.url), "utf8"),
        )["Dashboard filters"],
      }),
    ).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(
      await page.locator(".shell-content").evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true)
  }
})
