import { afterEach, describe, expect, it, vi } from "vitest"
import type { ListFilters } from "./api"
import { ApiError, fetchList, fetchTrace, listParams, requestJSON } from "./api"

const filters: ListFilters = {
  from: "2026-10-22T10:00:00.123456789+02:00",
  to: "2026-10-22T12:00:00.000000001Z",
  service: "checkout / α",
  search: "failure & timeout?",
  errorsOnly: true,
  minSeverity: 17,
  traceId: "1234567890abcdef1234567890abcdef",
  limit: 50,
}
const signal = new AbortController().signal

afterEach(() => vi.unstubAllGlobals())

describe("API query encoding", () => {
  it("encodes text and exact timestamps, with trace-only fields", () => {
    const params = new URLSearchParams(listParams("traces", filters).toString())
    expect(params.get("from")).toBe(filters.from)
    expect(params.get("search")).toBe(filters.search)
    expect(params.get("service")).toBe(filters.service)
    expect(params.get("errorsOnly")).toBe("true")
    expect(params.has("traceId")).toBe(false)
    expect(params.has("minSeverity")).toBe(false)
  })

  it("encodes log-only fields and omits empty filters", () => {
    const params = listParams("logs", filters)
    expect(params.get("traceId")).toBe(filters.traceId)
    expect(params.get("minSeverity")).toBe("17")
    expect(params.has("errorsOnly")).toBe(false)
    const empty = listParams("logs", {
      ...filters,
      service: "",
      search: "",
      traceId: "",
      minSeverity: 0,
    })
    expect(empty.has("search")).toBe(false)
    expect(empty.has("service")).toBe(false)
    expect(empty.has("traceId")).toBe(false)
    expect(empty.get("minSeverity")).toBe("0")
  })

  it("sends the abort signal and only window parameters for trace details", async () => {
    const data = {
      traceId: filters.traceId,
      spans: [],
      logs: [],
      spansTruncated: false,
      logsTruncated: false,
    }
    const fetcher = vi.fn().mockResolvedValue(Response.json(data))
    vi.stubGlobal("fetch", fetcher)
    expect(await fetchTrace(filters.traceId, filters, signal)).toEqual(data)
    const [path, options] = fetcher.mock.calls[0]
    const url = new URL(path, "http://local")
    expect(url.pathname).toBe(`/api/traces/${filters.traceId}`)
    expect([...url.searchParams.keys()]).toEqual(["from", "to"])
    expect(options.signal).toBe(signal)
    expect(options.headers).toEqual({ Accept: "application/json" })
  })
})

describe("API responses", () => {
  it("accepts list envelopes without inventing totals", async () => {
    const data = { items: [], hasMore: true }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)))
    expect(await fetchList("logs", filters, signal)).toEqual(data)
  })

  it.each([400, 404])("exposes structured %s errors", async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: "invalid_query", message: "Invalid time window" } },
          { status },
        ),
      )
    await expect(requestJSON("/api/logs", signal, fetcher)).rejects.toMatchObject({
      name: "ApiError",
      status,
      code: "invalid_query",
      message: "Invalid time window",
    })
  })

  it("uses a generic storage error for 503 and never exposes upstream details", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("secret storage credentials", { status: 503 }))
    await expect(requestJSON("/api/logs", signal, fetcher)).rejects.toMatchObject({
      status: 503,
      code: "storage_unavailable",
      message: "Telemetry storage is unavailable. Try again later.",
    })
  })

  it("handles malformed or missing error envelopes", async () => {
    await expect(
      requestJSON(
        "/api/logs",
        signal,
        vi.fn().mockResolvedValue(new Response("<html>proxy error</html>")),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" })
    await expect(
      requestJSON(
        "/api/logs",
        signal,
        vi.fn().mockResolvedValue(Response.json({}, { status: 500 })),
      ),
    ).rejects.toMatchObject({ message: "Request failed (500)." })
  })

  it("rejects malformed successful envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: null })))
    await expect(fetchList("traces", filters, signal)).rejects.toBeInstanceOf(ApiError)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ spans: [], logs: [] })))
    await expect(fetchTrace(filters.traceId, filters, signal)).rejects.toMatchObject({
      code: "invalid_response",
    })
  })

  it("preserves network and abort errors for request lifecycle handling", async () => {
    const aborted = new DOMException("Aborted", "AbortError")
    await expect(requestJSON("/api/logs", signal, vi.fn().mockRejectedValue(aborted))).rejects.toBe(
      aborted,
    )
    const network = new TypeError("Failed to fetch")
    await expect(requestJSON("/api/logs", signal, vi.fn().mockRejectedValue(network))).rejects.toBe(
      network,
    )
  })
})
