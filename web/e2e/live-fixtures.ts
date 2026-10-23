import { readFileSync } from "node:fs"
import { expect, type Page } from "@playwright/test"
import type { LiveRecord, LiveSnapshot } from "../src/live/api"

export const now = new Date("2026-10-23T00:05:00Z")
export const empty = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/live/empty.json", import.meta.url), "utf8"),
) as LiveSnapshot

// Date is used only for whole seconds. All fractional arithmetic is exact.
export function ns(value: string): bigint {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!match) throw new Error("Expected a UTC nanosecond timestamp")
  return BigInt(Date.parse(`${match[1]}Z`)) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))
}

export function iso(value: bigint): string {
  const seconds = value / 1_000_000_000n
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0")
  return new Date(Number(seconds * 1000n)).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`)
}

export function assertBuckets(snapshot: LiveSnapshot): void {
  expect(snapshot.histogram).toHaveLength(60)
  const from = ns(snapshot.window.from)
  const width = ns(snapshot.window.to) - from
  snapshot.histogram.forEach((bucket, index) => {
    expect(ns(bucket.from)).toBe(from + (BigInt(index) * width) / 60n)
    expect(ns(bucket.to)).toBe(from + (BigInt(index + 1) * width) / 60n)
    for (const field of ["spans", "logs", "errorSpans", "errorLogs"] as const) {
      expect(bucket[field]).toMatch(/^(0|[1-9]\d*)$/)
    }
    expect(BigInt(bucket.errorSpans) <= BigInt(bucket.spans)).toBe(true)
    expect(BigInt(bucket.errorLogs) <= BigInt(bucket.logs)).toBe(true)
  })
}

export function record(index: number, patch: Partial<LiveRecord> = {}): LiveRecord {
  const traceId = (1 + Math.floor(index / 100)).toString(16).padStart(32, "0")
  const spanId = (index + 1).toString(16).padStart(16, "0")
  return {
    id: `span:validation:${traceId}:${spanId}`,
    kind: "span",
    traceId,
    spanId,
    parentSpanId: "",
    name: `Exported span ${index}`,
    serviceName: "controlled-live",
    startTime: iso(ns("2026-10-23T00:00:00Z") + BigInt(index + 1) * 100_000_000n),
    durationNs: "25000000",
    statusCode: "Unset",
    statusMessage: "",
    severityText: "",
    severityNumber: 0,
    body: "",
    resourceAttributes: { "service.name": "controlled-live" },
    attributes: { "fixture.index": String(index) },
    scopeName: "live-e2e",
    scopeVersion: "1.0",
    scopeAttributes: { suite: "browser" },
    resourceSchemaUrl: "https://opentelemetry.io/schemas/1.26.0",
    scopeSchemaUrl: "https://opentelemetry.io/schemas/1.26.0",
    traceFlags: 1,
    occurrences: "1",
    conflict: false,
    parentConflict: false,
    contextOnly: false,
    stored: {
      Name: `Exported span ${index}`,
      SpanId: spanId,
      TraceId: traceId,
      fixture: "stored projection",
    },
    ...patch,
  }
}

export function snapshot(records: LiveRecord[] = []): LiveSnapshot {
  const result = structuredClone(empty)
  result.window = { from: "2026-10-23T00:00:00.000000001Z", to: "2026-10-23T00:05:00.000000001Z" }
  result.queriedAt = result.window.to
  result.spans = records.filter((item) => item.kind === "span" && !item.contextOnly)
  result.logs = records.filter((item) => item.kind === "log")
  result.context = records.filter((item) => item.contextOnly)
  return rebucket(result)
}

export function rebucket(result: LiveSnapshot): LiveSnapshot {
  const lo = ns(result.window.from)
  const width = ns(result.window.to) - lo
  result.histogram = Array.from({ length: 60 }, (_, i) => ({
    from: iso(lo + (BigInt(i) * width) / 60n),
    to: iso(lo + (BigInt(i + 1) * width) / 60n),
    spans: "0",
    logs: "0",
    errorSpans: "0",
    errorLogs: "0",
  }))
  for (const item of [...result.spans, ...result.logs]) {
    const bucket = result.histogram.find(
      (b) => ns(item.startTime) >= ns(b.from) && ns(item.startTime) < ns(b.to),
    )
    if (!bucket) continue
    const count = item.kind === "span" ? "spans" : "logs"
    bucket[count] = (BigInt(bucket[count]) + BigInt(item.occurrences)).toString()
    if (item.statusCode === "Error" || (item.kind === "log" && item.severityNumber >= 17)) {
      const error = item.kind === "span" ? "errorSpans" : "errorLogs"
      bucket[error] = (BigInt(bucket[error]) + BigInt(item.occurrences)).toString()
    }
  }
  return result
}

export function maximumSnapshot(): LiveSnapshot {
  const rows: LiveRecord[] = []
  for (let group = 0; group < 100; group++) {
    const traceId = (group + 1).toString(16).padStart(32, "0")
    let parentSpanId = ""
    for (let index = 0; index < 10; index++) {
      const span = record(group * 10 + index, { traceId, parentSpanId, contextOnly: index < 5 })
      span.id = `span:validation:${traceId}:${span.spanId}`
      rows.push(span)
      parentSpanId = span.spanId
      if (index >= 5)
        rows.push(
          record(group * 10 + index, {
            id: `log:${(group * 10 + index + 1).toString(16).padStart(64, "0")}`,
            kind: "log",
            traceId,
            spanId: span.spanId,
            parentSpanId: "",
            name: "",
            durationNs: "0",
            statusCode: "",
            severityText: "INFO",
            severityNumber: 9,
            body: `Stored log ${group * 10 + index}`,
            startTime: iso(ns(span.startTime) + 1n),
          }),
        )
    }
  }
  const result = snapshot(rows)
  result.spansTruncated =
    result.logsTruncated =
    result.contextTruncated =
    result.traceGroupsTruncated =
      true
  expect([result.spans.length, result.logs.length, result.context.length]).toEqual([500, 500, 500])
  expect(new Set(rows.map((item) => item.traceId)).size).toBe(100)
  assertBuckets(result)
  return result
}

export interface ControlledLive {
  data: LiveSnapshot
  status: number
  malformed: string | null
  queries: URLSearchParams[]
}

export async function control(page: Page, data = snapshot([record(0)])): Promise<ControlledLive> {
  const state: ControlledLive = { data, status: 200, malformed: null, queries: [] }
  await page.clock.install({ time: now })
  await page.clock.pauseAt(now)
  await page.route("**/api/live?**", async (route) => {
    const query = new URL(route.request().url()).searchParams
    state.queries.push(query)
    if (state.status !== 200) {
      await route.fulfill({
        status: state.status,
        json: { error: { code: "controlled_failure", message: "Telemetry unavailable." } },
      })
      return
    }
    if (state.malformed !== null) {
      await route.fulfill({ status: 200, contentType: "application/json", body: state.malformed })
      return
    }
    const result = structuredClone(state.data)
    if (query.has("from"))
      result.window = { from: query.get("from") ?? "", to: query.get("to") ?? "" }
    else {
      const seconds = query.get("range") === "1m" ? 60n : query.get("range") === "15m" ? 900n : 300n
      result.window.to = iso(ns(result.window.from) + seconds * 1_000_000_000n)
    }
    result.filters = {
      service: query.get("service") ?? "",
      search: query.get("search") ?? "",
      errorsOnly: query.get("errorsOnly") === "true",
      minSeverity: Number(query.get("minSeverity") ?? 0),
    }
    for (const field of ["spans", "logs", "context"] as const) {
      result[field] = result[field].filter(
        (item) =>
          ns(item.startTime) >= ns(result.window.from) && ns(item.startTime) < ns(result.window.to),
      )
    }
    await route.fulfill({ json: rebucket(result) })
  })
  return state
}

export async function advance(page: Page, state: ControlledLive, delay = 2100): Promise<void> {
  const before = state.queries.length
  await page.clock.fastForward(delay)
  await expect.poll(() => state.queries.length).toBe(before + 1)
  // Flush promise completion and the next scheduled animation frame.
  await page.clock.runFor(50)
}

export function row(page: Page, id: string) {
  return page.locator(`[data-event-id="${id}"]`)
}

export function testTarget(value: string | undefined): string {
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
  if (!/^logice-web-check-[a-f0-9]{16}$/.test(process.env.LOGICE_E2E_PROJECT ?? "")) {
    throw new Error("Browser tests require a disposable Compose project")
  }
  return value
}
