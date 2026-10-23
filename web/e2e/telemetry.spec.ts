import { randomBytes } from "node:crypto"
import { expect, test } from "./auth-fixtures"

const traceId = randomBytes(16).toString("hex")
const rootId = "1111111111111111"
const childId = "2222222222222222"
const healthyId = randomBytes(16).toString("hex")
const body = "Inventory unavailable <script>alert(1)</script>"
const service = "logice-ui-test"

// One disposable fixture is shared by this serial workflow; failures stop the group.
test.describe.configure({ mode: "serial" })

function testTarget(value: string | undefined): string {
  if (!value) throw new Error("Run this suite through scripts/validate-compose-web.sh")
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    url.port === "5173"
  ) {
    throw new Error("Browser tests require an isolated random loopback port")
  }
  return value
}

test.beforeAll(async ({ request }) => {
  testTarget(process.env.LOGICE_E2E_URL)
  const collector = testTarget(process.env.LOGICE_E2E_OTLP_URL)
  if (!/^logice-web-check-[a-f0-9]{16}$/.test(process.env.LOGICE_E2E_PROJECT ?? "")) {
    throw new Error("Browser tests require a disposable Compose project")
  }
  const token = process.env.LOGICE_E2E_TOKEN
  if (!token) throw new Error("The disposable Collector token is required")
  const start = BigInt(Date.now() - 5_000) * 1_000_000n
  const resource = {
    attributes: [
      { key: "service.name", value: { stringValue: service } },
      { key: "deployment.environment", value: { stringValue: "test" } },
    ],
  }
  const span = (id: string, parentSpanId: string, name: string, failed = false) => ({
    traceId,
    spanId: id,
    parentSpanId,
    name,
    kind: 2,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 250_000_000n).toString(),
    status: { code: failed ? 2 : 1, message: failed ? "Inventory query failed" : "" },
    attributes: [{ key: "http.route", value: { stringValue: "/checkout" } }],
  })
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  const traces = {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            spans: [
              span(rootId, "", "GET /checkout"),
              span(childId, rootId, "SELECT inventory", true),
              { ...span("3333333333333333", "", "GET /health"), traceId: healthyId },
            ],
          },
        ],
      },
    ],
  }
  // Compose --wait does not establish Collector receiver readiness.
  await expect
    .poll(async () => {
      try {
        return (await request.post(`${collector}/v1/traces`, { headers, data: traces })).status()
      } catch {
        return 0
      }
    })
    .toBe(200)
  const result = await request.post(`${collector}/v1/logs`, {
    headers,
    data: {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: (start + 100_000_000n).toString(),
                  traceId,
                  spanId: childId,
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: body },
                  attributes: [{ key: "error.type", value: { stringValue: "InventoryError" } }],
                },
                {
                  timeUnixNano: (start + 200_000_000n).toString(),
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "Worker ready" },
                },
              ],
            },
          ],
        },
      ],
    },
  })
  expect(result.status()).toBe(200)
  await expect
    .poll(async () => {
      const response = await request.get(`/api/traces?service=${service}`)
      if (!response.ok()) return 0
      return (await response.json()).items.length
    })
    .toBe(2)
  await expect
    .poll(async () => {
      const response = await request.get(`/api/logs?service=${service}`)
      if (!response.ok()) return 0
      return (await response.json()).items.length
    })
    .toBe(2)
})

test("search traces, open spans and correlated logs, and reload the deep link", async ({
  page,
}, testInfo) => {
  await page.goto("/traces")
  await expect(page.getByRole("link", { name: "GET /checkout", exact: true })).toBeVisible()
  await page.getByLabel("Service", { exact: true }).fill(service)
  await page.getByLabel("Errors only").check()
  await page.getByRole("button", { name: "Apply filters" }).click()
  await expect(page.getByRole("link", { name: "GET /checkout", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "GET /health", exact: true })).toHaveCount(0)
  await page.getByRole("link", { name: "GET /checkout", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/traces/${traceId}\\?`))
  await expect(page.getByText("SELECT inventory", { exact: true })).toBeVisible()
  await expect(page.getByText(body, { exact: true }).first()).toBeVisible()
  await page.locator("summary.span-summary").filter({ hasText: "GET /checkout" }).click()
  await expect(
    page.locator(`#span-${rootId}`).getByText("http.route", { exact: true }),
  ).toBeVisible()
  await page.getByText("Show log details", { exact: true }).first().click()
  await expect(page.getByText("InventoryError", { exact: true })).toBeVisible()
  const query = new URL(page.url()).search
  await page.reload()
  await expect(page.getByText("SELECT inventory", { exact: true })).toBeVisible()
  expect(new URL(page.url()).search).toBe(query)
  expect(await page.locator("script").filter({ hasText: "alert(1)" }).count()).toBe(0)
  await page.screenshot({ path: testInfo.outputPath("trace-detail.png"), fullPage: true })
})

test("filter logs, inspect attributes, and follow the correlated trace", async ({ page }) => {
  await page.goto("/logs")
  await expect(page.getByText("Worker ready", { exact: true }).first()).toBeVisible()
  await page.getByLabel("Minimum severity").selectOption("17")
  await page.getByLabel("Search", { exact: true }).fill("Inventory unavailable")
  await page.getByRole("button", { name: "Apply filters" }).click()
  await expect(page.getByText(body, { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Worker ready", { exact: true })).toHaveCount(0)
  await page.getByText("Show log details", { exact: true }).first().click()
  await expect(page.getByText("error.type", { exact: true })).toBeVisible()
  await expect(page.getByText("InventoryError", { exact: true })).toBeVisible()
  const traceLink = page.locator(`a[href^="/traces/${traceId}?"]`).first()
  await expect(traceLink).toBeVisible()
  await traceLink.click()
  await expect(page.getByText("SELECT inventory", { exact: true })).toBeVisible()
})

test("show an empty result, a storage error, and a bounded-result warning", async ({ page }) => {
  await page.goto("/traces?service=not-an-ingested-service")
  await expect(page.getByRole("heading", { name: "No traces in this window" })).toBeVisible()
  await page.goto("/traces?limit=1")
  await expect(page.getByText("More records are available", { exact: true })).toBeVisible()
  await page.route("**/api/traces?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "storage_unavailable", message: "Telemetry storage is unavailable." },
      }),
    }),
  )
  await page.goto("/traces")
  await expect(page.getByRole("alert")).toContainText("Telemetry storage is unavailable.")
})

test("retain usable filters on a narrow screen and show an unknown trace error", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/logs")
  await expect(page.getByLabel("Search", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Apply filters" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.goto(`/traces/${"f".repeat(32)}`)
  await expect(page.getByRole("alert")).toBeVisible()
})
