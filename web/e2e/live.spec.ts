import { randomBytes } from "node:crypto"
import type { LiveSnapshot } from "../src/live/api"
import { expect, test } from "./auth-fixtures"
import { assertBuckets, testTarget } from "./live-fixtures"

test("Live automatically shows real post-open Collector exports, freezes while paused, and discovers late context", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(110_000)
  testTarget(process.env.LOGICE_E2E_URL)
  const collector = testTarget(process.env.LOGICE_E2E_OTLP_URL)
  const token = process.env.LOGICE_E2E_TOKEN
  if (!token) throw new Error("The disposable Collector token is required")
  const service = `logice-live-e2e-${randomBytes(8).toString("hex")}`
  const traceId = randomBytes(16).toString("hex")
  const parentId = randomBytes(8).toString("hex")
  const childId = randomBytes(8).toString("hex")
  const start = BigInt(Date.now() - 2000) * 1_000_000n
  const resource = { attributes: [{ key: "service.name", value: { stringValue: service } }] }
  const resourceEnvelope = (kind: "Spans" | "Logs", records: unknown[]) => ({
    [`resource${kind}`]: [
      {
        resource,
        [`scope${kind}`]: [
          {
            scope: { name: "live-browser-real", version: "1.0" },
            [kind === "Spans" ? "spans" : "logRecords"]: records,
          },
        ],
      },
    ],
  })
  const span = (spanId: string, parentSpanId: string, name: string, failed = false) => ({
    traceId,
    spanId,
    parentSpanId,
    name,
    kind: 2,
    startTimeUnixNano: (spanId === parentId ? start - 1_000_000n : start).toString(),
    endTimeUnixNano: (start + 25_000_000n).toString(),
    status: { code: failed ? 2 : 1, message: failed ? "Stored failure" : "" },
    attributes: [{ key: "fixture.kind", value: { stringValue: "real-live" } }],
  })
  const errorLog = {
    traceId,
    spanId: childId,
    timeUnixNano: (start + 1n).toString(),
    severityNumber: 17,
    severityText: "ERROR",
    body: { stringValue: "Live real error <script>unsafe()</script>" },
    attributes: [{ key: "error.type", value: { stringValue: "LiveFixtureFailure" } }],
  }
  // Native Node fetch keeps the environment-only token out of Playwright request
  // traces and assertion output. Do not attach headers, payloads, or raw exceptions.
  async function ingest(path: string, payload: unknown): Promise<void> {
    let accepted = false
    try {
      const result = await fetch(`${collector}/v1/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      })
      accepted = result.status === 200
      await result.body?.cancel()
    } catch {
      /* Only the sanitized Boolean is reported. */
    }
    expect(accepted, "Disposable Collector accepted the completed export").toBe(true)
  }
  let stored: LiveSnapshot | null = null
  async function storageContains(names: string[], expectedLogs: number): Promise<void> {
    await expect
      .poll(
        async () => {
          const response = await request.get(
            `/api/live?range=5m&service=${encodeURIComponent(service)}`,
            { timeout: 6000 },
          )
          if (!response.ok()) return false
          const value = (await response.json()) as LiveSnapshot
          stored = value
          return (
            names.every((name) => value.spans.some((item) => item.name === name)) &&
            value.logs.length === expectedLogs
          )
        },
        {
          timeout: 30_000,
          intervals: [250, 500, 1000],
          message: "Exports reached disposable ClickHouse within 30 seconds",
        },
      )
      .toBe(true)
  }
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`/live?service=${encodeURIComponent(service)}`)
  await expect(
    page.locator(".lp-empty").getByText("No matching events", { exact: true }),
  ).toBeVisible()
  // Telemetry is sent only after the real Live page is open. There are no API mocks.
  await ingest(
    "traces",
    resourceEnvelope("Spans", [span(childId, parentId, "Live child failed", true)]),
  )
  await ingest(
    "logs",
    resourceEnvelope("Logs", [
      errorLog,
      errorLog,
      {
        timeUnixNano: (start + 2n).toString(),
        severityNumber: 9,
        severityText: "INFO",
        body: { stringValue: "Live uncorrelated stored log" },
      },
    ]),
  )
  await storageContains(["Live child failed"], 2)
  await Promise.all([
    expect(
      page.getByRole("button", { name: "Inspect Live child failed", exact: true }),
    ).toBeVisible({ timeout: 20_000 }),
    expect(
      page.getByRole("button", { name: "Inspect Live uncorrelated stored log", exact: true }),
    ).toBeVisible({ timeout: 20_000 }),
  ])
  const childRow = page
    .locator("[data-event-id]")
    .filter({ has: page.getByRole("button", { name: "Inspect Live child failed", exact: true }) })
  await expect(childRow).toContainText("Missing parent")
  if (!stored) throw new Error("Storage confirmation did not return a snapshot")
  const initial = stored as LiveSnapshot
  assertBuckets(initial)
  expect(initial.spans).toHaveLength(1)
  expect(initial.logs.find((item) => item.body === errorLog.body.stringValue)?.occurrences).toBe(
    "2",
  )
  expect(initial.histogram.reduce((sum, b) => sum + BigInt(b.spans) + BigInt(b.logs), 0n)).toBe(4n)
  await expect(page.getByRole("region", { name: "Stored event histogram" })).toContainText(
    "4 matching rows",
  )
  await page.getByRole("button", { name: "Pause live updates" }).click()
  const pausedURL = page.url()
  const pauseRequests: string[] = []
  page.on("request", (value) => {
    if (new URL(value.url()).pathname === "/api/live") pauseRequests.push(value.url())
  })
  await ingest(
    "traces",
    resourceEnvelope("Spans", [
      span(parentId, "", "Live late healthy parent"),
      {
        ...span(childId, parentId, "Live child failed", true),
        attributes: [{ key: "fixture.kind", value: { stringValue: "conflicting-real-live" } }],
      },
    ]),
  )
  await ingest(
    "logs",
    resourceEnvelope("Logs", [
      {
        timeUnixNano: (start + 3n).toString(),
        severityNumber: 9,
        severityText: "INFO",
        body: { stringValue: "Live arrived while paused" },
      },
    ]),
  )
  await storageContains(["Live child failed", "Live late healthy parent"], 3)
  await expect(
    page.getByRole("button", { name: "Inspect Live late healthy parent", exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Inspect Live arrived while paused", exact: true }),
  ).toHaveCount(0)
  expect(page.url()).toBe(pausedURL)
  expect(pauseRequests).toHaveLength(0)
  await page.getByRole("button", { name: "Resume live updates" }).click()
  await Promise.all([
    expect(
      page.getByRole("button", { name: "Inspect Live late healthy parent", exact: true }),
    ).toBeVisible({ timeout: 20_000 }),
    expect(
      page.getByRole("button", { name: "Inspect Live arrived while paused", exact: true }),
    ).toBeVisible({ timeout: 20_000 }),
  ])
  await expect(childRow).not.toContainText("Missing parent")
  await expect(childRow).toContainText("Conflict")
  await page.getByRole("button", { name: "Inspect Live child failed", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Event details" })).toContainText(
    "Conflicting exports",
  )
  await page.getByRole("button", { name: "Close event details" }).click()
  await page.getByLabel("Errors only", { exact: true }).check()
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  const parentRow = page.locator("[data-event-id]").filter({
    has: page.getByRole("button", { name: "Inspect Live late healthy parent", exact: true }),
  })
  await expect(parentRow).toContainText("Context")
  await expect(
    page.getByRole("button", { name: "Inspect Live uncorrelated stored log", exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Stored event histogram" })).toContainText(
    "4 matching rows",
  )
  await page
    .getByRole("button", { name: `Inspect ${errorLog.body.stringValue}`, exact: true })
    .click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await expect(inspector).toContainText("2 stored occurrences")
  await expect(inspector).toContainText("identical emissions and retries cannot be distinguished")
  await expect(inspector).toContainText("LiveFixtureFailure")
  await expect(inspector).toContainText("live-browser-real")
  await inspector.getByRole("tab", { name: "Stored record JSON", exact: true }).click()
  await expect(page.getByRole("tabpanel")).toContainText("Live real error")
  expect(await page.locator("script").filter({ hasText: "unsafe()" }).count()).toBe(0)
  await page.screenshot({ path: testInfo.outputPath("live-real-collector.png"), fullPage: true })
})
