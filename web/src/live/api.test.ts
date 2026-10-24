import { readFileSync } from "node:fs"

vi.mock("../project-path", async (original) => ({
  ...(await original<typeof import("../project-path")>()),
  projectApi: (path: string) => `/api/projects/11111111-1111-1111-1111-111111111111${path}`,
}))

import { describe, expect, it, vi } from "vitest"
import { timestampNs } from "../telemetry"
import {
  fetchLive,
  type LiveRecord,
  MAX_LIVE_BYTES,
  retryAfterMs,
  validateLiveSnapshot,
} from "./api"
import { DEFAULT_LIVE_ROUTE, formatTimestampNs } from "./route"

// The shared contract fixtures live outside web/.
const empty = () =>
  validateLiveSnapshot(
    JSON.parse(
      readFileSync(new URL("../../../tests/fixtures/live/empty.json", import.meta.url), "utf8"),
    ),
  )
const route = { ...DEFAULT_LIVE_ROUTE, range: "1m" as const }
const signal = new AbortController().signal
const record = (overrides: Partial<LiveRecord> = {}): LiveRecord => ({
  id: "span:validation:1234567890abcdef1234567890abcdef:1234567890abcdef",
  kind: "span",
  traceId: "1234567890abcdef1234567890abcdef",
  spanId: "1234567890abcdef",
  parentSpanId: "",
  name: "request",
  serviceName: "api",
  startTime: "2026-10-23T00:00:00.000000001Z",
  durationNs: "1",
  statusCode: "Unset",
  statusMessage: "",
  severityText: "",
  severityNumber: 0,
  body: "",
  resourceAttributes: {},
  attributes: {},
  scopeName: "sdk",
  scopeVersion: "1",
  scopeAttributes: {},
  resourceSchemaUrl: "",
  scopeSchemaUrl: "",
  traceFlags: 1,
  occurrences: "1",
  conflict: false,
  parentConflict: false,
  contextOnly: false,
  stored: { nested: [null, true, 1, "x", { key: "value" }] },
  ...overrides,
})

describe("Live DTO validation", () => {
  it("accepts the shared 60-bucket empty fixture and rejects invalid shared fixtures", () => {
    expect(empty().histogram).toHaveLength(60)
    for (const name of ["invalid-numeric-count.json", "invalid-bucket-count.json"]) {
      const value: unknown = JSON.parse(
        readFileSync(new URL(`../../../tests/fixtures/live/${name}`, import.meta.url), "utf8"),
      )
      expect(() => validateLiveSnapshot(value)).toThrow()
    }
  })
  it("preserves full stored metadata, unknown status/severity, malformed recorded IDs, and uint64 values", () => {
    const data = empty()
    data.spans = [
      record({
        statusCode: "future",
        severityNumber: 255,
        durationNs: "18446744073709551615",
        occurrences: "18446744073709551615",
        traceId: "malformed",
        traceFlags: 0xffff_ffff,
        attributes: { html: "<script>" },
      }),
    ]
    expect(validateLiveSnapshot(data)).toEqual(data)
    expect(data.spans[0].startTime).toBe("2026-10-23T00:00:00.000000001Z")
  })
  it.each([null, [], {}, { window: {} }])("rejects incomplete envelopes %j", (value) => {
    expect(() => validateLiveSnapshot(value)).toThrow()
  })
  it.each([
    { id: "" },
    { id: "space id" },
    { id: "x".repeat(513) },
    { kind: "event" },
    { durationNs: "-1" },
    { durationNs: "01" },
    { durationNs: "18446744073709551616" },
    { occurrences: "0" },
    { occurrences: 1 },
    { severityNumber: 256 },
    { severityNumber: -1 },
    { severityNumber: 1.5 },
    { traceFlags: 0x1_0000_0000 },
    { startTime: "2026-10-23T00:01:00Z" },
    { startTime: "2026-10-22T23:59:59Z" },
    { startTime: "2026-02-30T00:00:00Z" },
    { startTime: "2026-10-23T00:00:00+00:00" },
    { attributes: { key: 1 } },
    { resourceAttributes: null },
    { scopeAttributes: [] },
    { stored: [] },
    { conflict: "false" },
    { parentConflict: 0 },
    { contextOnly: true },
    { statusCode: 0 },
  ])("rejects invalid record fields %j", (patch) => {
    const data = empty()
    expect(() => validateLiveSnapshot({ ...data, spans: [{ ...record(), ...patch }] })).toThrow()
  })
  it("requires every record key, including stored metadata", () => {
    for (const key of Object.keys(record())) {
      const item: Record<string, unknown> = { ...record() }
      delete item[key]
      expect(() => validateLiveSnapshot({ ...empty(), spans: [item] }), key).toThrow()
    }
  })
  it("checks per-array caps, unique identities, context role, and 100 valid trace groups", () => {
    const data = empty()
    expect(() =>
      validateLiveSnapshot({
        ...data,
        spans: Array.from({ length: 501 }, (_, index) => record({ id: `r:${index}` })),
      }),
    ).toThrow()
    expect(() => validateLiveSnapshot({ ...data, spans: [record(), record()] })).toThrow()
    expect(() => validateLiveSnapshot({ ...data, logs: [record()] })).toThrow()
    expect(() => validateLiveSnapshot({ ...data, context: [record()] })).toThrow()
    expect(() =>
      validateLiveSnapshot({
        ...data,
        spans: Array.from({ length: 101 }, (_, index) =>
          record({
            id: `r:${index}`,
            traceId: BigInt(index + 1)
              .toString(16)
              .padStart(32, "0"),
          }),
        ),
      }),
    ).toThrow()
    data.context = [record({ contextOnly: true })]
    expect(validateLiveSnapshot(data).context).toHaveLength(1)
  })
  it("does not charge malformed content-identified spans to the trace context cap, but still charges logs", () => {
    const malformed = Array.from({ length: 101 }, (_, index) =>
      record({
        id: `span-content:v1:${BigInt(index + 1)
          .toString(16)
          .padStart(64, "0")}`,
        traceId: BigInt(index + 1)
          .toString(16)
          .padStart(32, "0"),
        spanId: index % 2 ? "" : "0000000000000000",
      }),
    )
    expect(validateLiveSnapshot({ ...empty(), spans: malformed }).spans).toHaveLength(101)
    expect(() =>
      validateLiveSnapshot({
        ...empty(),
        logs: malformed.map((item, index) => ({
          ...item,
          kind: "log",
          id: `log:v1:${BigInt(index + 1)
            .toString(16)
            .padStart(64, "0")}`,
        })),
      }),
    ).toThrow()
  })
  it("validates interval limits, every integer-nanosecond bucket boundary and component error counts", () => {
    const data = empty()
    const from = timestampNs(data.window.from) ?? 0n
    const width = 1_000_000_001n
    data.window.to = formatTimestampNs(from + width)
    data.histogram = data.histogram.map((bucket, index) => ({
      ...bucket,
      from: formatTimestampNs(from + (BigInt(index) * width) / 60n),
      to: formatTimestampNs(from + (BigInt(index + 1) * width) / 60n),
    }))
    expect(validateLiveSnapshot(data).window).toEqual(data.window)
    data.histogram[3].to = data.histogram[4].to
    expect(() => validateLiveSnapshot(data)).toThrow()
    const wrongCount = empty()
    wrongCount.histogram[0].errorLogs = "1"
    expect(() => validateLiveSnapshot(wrongCount)).toThrow()
    expect(() =>
      validateLiveSnapshot({
        ...empty(),
        limits: { spans: 501, logs: 500, context: 500, traceGroups: 100 },
      }),
    ).toThrow()
    expect(() => validateLiveSnapshot({ ...empty(), completeness: "complete" })).toThrow()
    expect(() => validateLiveSnapshot({ ...empty(), queriedAt: "no" })).toThrow()
    expect(() =>
      validateLiveSnapshot({
        ...empty(),
        filters: { service: "α".repeat(101), search: "", errorsOnly: false, minSeverity: 0 },
      }),
    ).toThrow()
  })
})

describe("bounded Live HTTP client", () => {
  it("sends encoded filters, cancellation and no-store, and validates before returning", async () => {
    const data = empty()
    data.filters.search = "[a.*] & α"
    const fetcher = vi.fn().mockResolvedValue(Response.json(data))
    expect(await fetchLive({ ...route, search: data.filters.search }, signal, fetcher)).toEqual(
      data,
    )
    const [url, options] = fetcher.mock.calls[0]
    expect(new URL(url, "http://local").searchParams.get("search")).toBe(data.filters.search)
    expect(options).toMatchObject({ signal, cache: "no-store" })
  })
  it("rejects mismatched applied filters and resolved windows", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(empty())))
    await expect(fetchLive({ ...route, search: "other" }, signal, fetcher)).rejects.toMatchObject({
      code: "invalid_response",
    })
    await expect(fetchLive(DEFAULT_LIVE_ROUTE, signal, fetcher)).rejects.toMatchObject({
      code: "invalid_response",
    })
    await expect(
      fetchLive(
        { ...route, live: false, from: "2026-10-23T00:00:01Z", to: "2026-10-23T00:01:01Z" },
        signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" })
  })
  it.each(["<html>not JSON</html>", "null", "{}", "\ufffd"])(
    "rejects unreadable or invalid data %s",
    async (body) => {
      await expect(
        fetchLive(route, signal, vi.fn().mockResolvedValue(new Response(body))),
      ).rejects.toMatchObject({ code: "invalid_response" })
    },
  )
  it("enforces Content-Length before reading and counts streamed bytes without trusting headers", async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(MAX_LIVE_BYTES + 1) },
    })
    await expect(
      fetchLive(route, signal, vi.fn().mockResolvedValue(response)),
    ).rejects.toMatchObject({ code: "response_too_large" })
    expect(cancel).toHaveBeenCalledOnce()
    for (const length of [undefined, "1"]) {
      const cancel = vi.fn()
      let chunk = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(chunk++ === 0 ? MAX_LIVE_BYTES : 1).fill(32))
        },
        cancel,
      })
      const response = new Response(stream, { headers: length ? { "content-length": length } : {} })
      await expect(
        fetchLive(route, signal, vi.fn().mockResolvedValue(response)),
      ).rejects.toMatchObject({ code: "response_too_large" })
      expect(cancel).toHaveBeenCalledOnce()
    }
  })
  it("accepts exactly 4 MiB, handles split multibyte UTF-8, and rejects invalid UTF-8", async () => {
    const body = JSON.stringify(empty())
    const exact = body + " ".repeat(MAX_LIVE_BYTES - new TextEncoder().encode(body).length)
    expect(await fetchLive(route, signal, vi.fn().mockResolvedValue(new Response(exact)))).toEqual(
      empty(),
    )
    const data = empty()
    data.filters.search = "α"
    const bytes = new TextEncoder().encode(JSON.stringify(data))
    let position = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position === bytes.length) controller.close()
        else controller.enqueue(bytes.subarray(position, ++position))
      },
    })
    expect(
      await fetchLive(
        { ...route, search: "α" },
        signal,
        vi.fn().mockResolvedValue(new Response(stream)),
      ),
    ).toEqual(data)
    await expect(
      fetchLive(route, signal, vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff])))),
    ).rejects.toMatchObject({ code: "invalid_response" })
  })
  it("preserves stream transport failures for transient retry instead of calling them invalid JSON", async () => {
    const network = new TypeError("connection closed")
    const stream = new ReadableStream({
      start(controller) {
        controller.error(network)
      },
    })
    await expect(
      fetchLive(route, signal, vi.fn().mockResolvedValue(new Response(stream))),
    ).rejects.toBe(network)
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn()
    await expect(fetchLive(route, controller.signal, fetcher)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("cancels a stalled stream when aborted", async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    const pending = fetchLive(route, controller.signal, vi.fn().mockResolvedValue(response))
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each([400, 401, 403, 404, 422, 429, 503])(
    "sanitizes HTTP %s without reading secret-bearing error bodies",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response("secret SQL credentials", { status, headers: { "retry-after": "300" } }),
        )
      await expect(fetchLive(route, signal, fetcher)).rejects.toMatchObject({
        status,
        retryAfterMs: 30_000,
      })
      try {
        await fetchLive(
          route,
          signal,
          vi.fn().mockResolvedValue(new Response("secret", { status })),
        )
      } catch (error) {
        expect(String(error)).not.toContain("secret")
      }
    },
  )
  it("parses and clamps Retry-After without accepting invalid values", () => {
    const now = Date.parse("2026-10-23T00:00:00Z")
    expect(retryAfterMs("0", now)).toBe(2000)
    expect(retryAfterMs("12", now)).toBe(12_000)
    expect(retryAfterMs("999", now)).toBe(30_000)
    expect(retryAfterMs("Fri, 23 Oct 2026 00:00:10 GMT", now)).toBe(10_000)
    expect(retryAfterMs("Fri, 22 Oct 2026 00:00:00 GMT", now)).toBe(2000)
    expect(retryAfterMs("not a date", now)).toBeNull()
    expect(retryAfterMs("-1", now)).toBeNull()
    expect(retryAfterMs("1.5", now)).toBeNull()
    expect(retryAfterMs("9".repeat(500), now)).toBe(30_000)
    expect(retryAfterMs(null, now)).toBeNull()
  })
})
