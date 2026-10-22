import { describe, expect, it } from "vitest"
import { timestampNs } from "../telemetry"
import {
  DEFAULT_LIVE_ROUTE,
  formatTimestampNs,
  liveHref,
  liveQuery,
  parseLiveRoute,
  pinLiveRoute,
  selectInterval,
  validateWindow,
} from "./route"

const window = { from: "2026-10-23T00:00:00.000000001Z", to: "2026-10-23T00:05:00.000000001Z" }

describe("Live URL modes", () => {
  it("uses an unresolved five-minute server window by default", () => {
    expect(parseLiveRoute("/live")).toEqual(DEFAULT_LIVE_ROUTE)
    expect(liveQuery(DEFAULT_LIVE_ROUTE).toString()).toBe("range=5m")
    expect(parseLiveRoute("/live?mode=paused&range=5m")).toEqual({
      ...DEFAULT_LIVE_ROUTE,
      live: false,
    })
  })
  it("round-trips applied filters and exact fixed nanoseconds without API mode", () => {
    const route = pinLiveRoute(
      {
        ...DEFAULT_LIVE_ROUTE,
        service: "checkout / α",
        search: "[a.*]&?",
        errorsOnly: true,
        minSeverity: 17,
      },
      window,
    )
    expect(parseLiveRoute(liveHref(route))).toEqual(route)
    const params = liveQuery(route)
    expect(params.get("from")).toBe(window.from)
    expect(params.has("mode")).toBe(false)
    expect(params.has("range")).toBe(false)
    expect(params.get("search")).toBe("[a.*]&?")
    expect(parseLiveRoute(`/live?from=${window.from}&to=${window.to}`).live).toBe(false)
  })
  it.each(["1m", "5m", "15m"])("preserves live range %s without inventing bounds", (range) => {
    const route = parseLiveRoute(`/live?range=${range}`)
    expect(route.from).toBeUndefined()
    expect(parseLiveRoute(liveHref(route))).toEqual(route)
  })
  it.each([
    "range=2m",
    "range=5m&range=5m",
    "mode=bad",
    "project=other",
    "search=%ZZ",
    "search=%FF",
    "service=a&%73ervice=b",
    "errorsOnly=1",
    "minSeverity=25",
    "minSeverity=-1",
    "minSeverity=1.5",
    "from=2026-10-23T00:00:00Z",
    "to=2026-10-23T00:01:00Z",
    "from=&to=",
    "range=5m&from=2026-10-23T00:00:00Z&to=2026-10-23T00:01:00Z",
    "mode=live&from=2026-10-23T00:00:00Z&to=2026-10-23T00:01:00Z",
    "from=2026-02-30T00:00:00Z&to=2026-02-30T00:01:00Z",
    "from=2026-10-23T00:00:00Z&to=2026-10-23T00:00:00.999999999Z",
    "from=2026-10-23T00:00:00Z&to=2026-10-23T00:15:00.000000001Z",
  ])("rejects invalid, repeated, or mixed query %s", (query) => {
    expect(() => parseLiveRoute(`/live?${query}`)).toThrow()
  })
  it("enforces UTF-8 byte limits on text, not character counts", () => {
    expect(parseLiveRoute(`/live?search=${"α".repeat(100)}`).search).toHaveLength(100)
    expect(() => parseLiveRoute(`/live?service=${"α".repeat(101)}`)).toThrow()
    expect(() => parseLiveRoute("/logs")).toThrow()
    expect(() =>
      validateWindow({ from: "1600-01-01T00:00:00Z", to: "1600-01-01T00:01:00Z" }),
    ).toThrow()
    expect(() =>
      validateWindow({ from: "2300-01-01T00:00:00Z", to: "2300-01-01T00:01:00Z" }),
    ).toThrow()
  })
  it("restores the rolling range after a fixed paused URL reload", () => {
    const fixed = pinLiveRoute(
      { ...DEFAULT_LIVE_ROUTE, range: "15m" },
      { from: window.from, to: "2026-10-23T00:15:00.000000001Z" },
    )
    const restored = parseLiveRoute(liveHref(fixed))
    expect(restored.range).toBe("15m")
    expect(
      liveQuery({ ...restored, live: true, from: undefined, to: undefined }).get("range"),
    ).toBe("15m")
  })
  it("accepts exact offset input bounds and keeps them in the URL", () => {
    const route = pinLiveRoute(DEFAULT_LIVE_ROUTE, {
      from: "2026-10-23T02:00:00.123456789+02:00",
      to: "2026-10-23T02:01:00.123456789+02:00",
    })
    expect(parseLiveRoute(liveHref(route))).toEqual({ ...route, range: "1m" })
    expect(() => validateWindow({ from: window.to, to: window.from })).toThrow()
  })
})

describe("minimum histogram interval", () => {
  it("expands around the midpoint and shifts inside each edge", () => {
    expect(
      selectInterval(window, "2026-10-23T00:00:00.000000001Z", "2026-10-23T00:00:00.100000001Z"),
    ).toEqual({ from: window.from, to: "2026-10-23T00:00:01.000000001Z" })
    expect(selectInterval(window, "2026-10-23T00:04:59.900000001Z", window.to)).toEqual({
      from: "2026-10-23T00:04:59.000000001Z",
      to: window.to,
    })
    expect(
      selectInterval(window, "2026-10-23T00:02:00Z", "2026-10-23T00:02:00.200000000Z"),
    ).toEqual({ from: "2026-10-23T00:01:59.600000000Z", to: "2026-10-23T00:02:00.600000000Z" })
  })
  it("repeated zoom retains a one-second window exactly", () => {
    let current = { from: window.from, to: "2026-10-23T00:00:01.000000001Z" }
    for (let index = 0; index < 100; index += 1) {
      current = selectInterval(
        current,
        "2026-10-23T00:00:00.100000001Z",
        "2026-10-23T00:00:00.200000001Z",
      )
      expect((timestampNs(current.to) ?? 0n) - (timestampNs(current.from) ?? 0n)).toBe(
        1_000_000_000n,
      )
      expect(current.from).toBe(window.from)
    }
  })
  it("rejects reversed, invalid, or outside intervals and preserves wide selections", () => {
    expect(selectInterval(window, window.from, window.to)).toEqual(window)
    expect(() => selectInterval(window, window.to, window.from)).toThrow()
    expect(() => selectInterval(window, "invalid", window.to)).toThrow()
    expect(() => selectInterval(window, "2026-10-22T23:59:59Z", window.to)).toThrow()
    expect(formatTimestampNs(-1n)).toBe("1969-12-31T23:59:59.999999999Z")
  })
})
