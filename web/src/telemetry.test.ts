import { describe, expect, it } from "vitest"
import type { Span } from "./api"
import {
  formatDuration,
  isTraceId,
  listHref,
  parseRoute,
  relativeWindow,
  routeHref,
  severity,
  spanDepth,
  spanStatus,
  spanTimeline,
  timestampNs,
  traceHref,
} from "./telemetry"

const now = Date.parse("2026-10-22T12:00:00Z")
const traceId = "1234567890abcdef1234567890abcdef"
const from = "2026-10-22T10:00:00.123456789Z"
const to = "2026-10-22T11:00:00.987654321Z"
function span(spanId: string, parentSpanId = ""): Span {
  return {
    traceId,
    spanId,
    parentSpanId,
    name: "request",
    serviceName: "api",
    startTime: from,
    durationNs: "1000000000",
    statusCode: 0,
    statusMessage: "",
    attributes: {},
    resourceAttributes: {},
  }
}

describe("URL state", () => {
  it("defaults to an absolute last-hour window and supports all presets", () => {
    const route = parseRoute("/", now)
    expect(route.page).toBe("traces")
    expect(route.range).toBe("1h")
    expect(route.filters).toMatchObject({
      from: "2026-10-22T11:00:00.000Z",
      to: "2026-10-22T12:00:00.000Z",
      limit: 50,
    })
    expect(relativeWindow("15m", now).from).toBe("2026-10-22T11:45:00.000Z")
    expect(relativeWindow("6h", now).from).toBe("2026-10-22T06:00:00.000Z")
    expect(relativeWindow("24h", now).from).toBe("2026-10-21T12:00:00.000Z")
  })

  it("preserves nanoseconds through detail, return, and reload links", () => {
    const window = { from, to }
    const detail = parseRoute(traceHref(traceId, window), now)
    expect(detail.page).toBe("detail")
    expect(detail.filters).toMatchObject(window)
    expect(detail.range).toBe("fixed")
    expect(parseRoute(listHref("logs", detail.filters), now).filters).toMatchObject(window)
    const linked = parseRoute(
      `/traces?from=${from}&to=${to}&range=6h&service=a%2Fb&search=x%26y&errorsOnly=true&limit=100`,
      now,
    )
    const reloaded = parseRoute(routeHref(linked), now + 60_000)
    expect(reloaded).toEqual(linked)
  })

  it("only explicit refresh advances a relative list window, not fixed/detail windows", () => {
    const route = parseRoute("/traces?range=15m&service=api&errorsOnly=true", now)
    expect(parseRoute(routeHref(route), now + 60_000).filters.to).toBe(route.filters.to)
    const refreshed = parseRoute(routeHref(route, true, now + 60_000), now)
    expect(refreshed.filters.to).toBe("2026-10-22T12:01:00.000Z")
    expect(refreshed.filters.service).toBe("api")
    expect(refreshed.filters.errorsOnly).toBe(true)
    const detail = parseRoute(traceHref(traceId, { from, to }), now)
    expect(parseRoute(routeHref(detail, true, now), now).filters).toEqual(detail.filters)
    const fixed = parseRoute(listHref("logs", { from, to }), now)
    expect(routeHref(fixed, true, now)).toBe(routeHref(fixed))
  })

  it.each([
    "/traces?from=2026-10-22T10:00:00Z",
    "/logs?to=2026-10-22T10:00:00Z",
    "/traces?from=bad&to=bad",
    `/traces?from=${to}&to=${from}`,
    `/traces?from=${from}&to=${from}`,
    "/traces?limit=101",
    "/traces?limit=0",
    "/logs?minSeverity=25",
    "/logs?minSeverity=1.5",
    "/logs?traceId=123",
    `/traces/${"0".repeat(32)}`,
    "/traces?errorsOnly=yes",
  ])("rejects invalid query %s", (href) => {
    expect(parseRoute(href, now).error).not.toBe("")
  })

  it("uses only relevant list fields and handles unknown routes", () => {
    const logs = parseRoute(`/logs?traceId=${traceId}&minSeverity=17&errorsOnly=true`, now)
    expect(logs.filters).toMatchObject({ traceId, minSeverity: 17 })
    expect(new URL(routeHref(logs), "http://local").searchParams.has("errorsOnly")).toBe(false)
    expect(parseRoute("/unknown", now).page).toBe("not-found")
  })
})

describe("telemetry formatting", () => {
  it("formats nanoseconds without floating-point loss", () => {
    expect(formatDuration("0")).toBe("0 ns")
    expect(formatDuration("999")).toBe("999 ns")
    expect(formatDuration("1234")).toBe("1.23 µs")
    expect(formatDuration("1000000")).toBe("1 ms")
    expect(formatDuration("1234567890")).toBe("1.23 s")
    expect(formatDuration("9007199254740993123456789")).toBe("9007199254740993.12 s")
    expect(formatDuration("-1")).toBe("—")
  })

  it("compares sub-millisecond windows and timezone offsets exactly", () => {
    expect(timestampNs("2026-10-22T10:00:00.000000002Z")).toBe(
      (timestampNs("2026-10-22T10:00:00.000000001Z") ?? 0n) + 1n,
    )
    expect(timestampNs("2026-10-22T12:00:00.123456789+02:00")).toBe(timestampNs(from))
    expect(timestampNs("2026-02-30T00:00:00Z")).toBeNull()
    expect(timestampNs("2026-10-22T24:00:00Z")).toBeNull()
    expect(timestampNs("2026-10-22T10:00:00.1234567890Z")).toBeNull()
  })

  it("handles OTLP status/severity and nonzero trace IDs", () => {
    expect(spanStatus(2)).toEqual({ label: "Error", tone: "error" })
    expect(spanStatus("ERROR").tone).toBe("error")
    expect(spanStatus(1).label).toBe("OK")
    expect(spanStatus(0).label).toBe("Unset")
    expect(severity({ severityNumber: 17, severityText: "" })).toEqual({
      label: "ERROR",
      tone: "error",
    })
    expect(severity({ severityNumber: 13, severityText: "Warning" }).label).toBe("Warning")
    expect(isTraceId(traceId.toUpperCase())).toBe(true)
    expect(isTraceId("0".repeat(32))).toBe(false)
    expect(isTraceId("<script>")).toBe(false)
  })

  it("bounds parent traversal for missing parents, cycles, and deep chains", () => {
    const a = span("a", "b")
    const b = span("b", "a")
    expect(
      spanDepth(
        a,
        new Map([
          ["a", a],
          ["b", b],
        ]),
      ),
    ).toBe(1)
    expect(spanDepth(span("c", "missing"), new Map())).toBe(0)
    expect(spanDepth(span("a", "a"), new Map([["a", a]]))).toBe(0)
    const chain = Array.from({ length: 20 }, (_, index) => span(String(index), String(index - 1)))
    expect(spanDepth(chain[19], new Map(chain.map((item) => [item.spanId, item])))).toBe(6)
  })

  it("uses one timing scale and handles zero/invalid spans", () => {
    const first = span("a")
    const second = {
      ...span("b"),
      startTime: "2026-10-22T10:00:00.623456789Z",
      durationNs: "500000000",
    }
    const timing = spanTimeline([first, second])
    expect(timing.get(first)).toEqual({ left: 0, width: 100 })
    expect(timing.get(second)).toEqual({ left: 50, width: 50 })
    expect(spanTimeline([]).size).toBe(0)
    const zero = { ...first, durationNs: "0" }
    expect(spanTimeline([zero]).get(zero)).toEqual({ left: 0, width: 0 })
    expect(spanTimeline([{ ...first, startTime: "bad" }]).size).toBe(0)
  })
})
