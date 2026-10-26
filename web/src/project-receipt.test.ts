import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./project-path", async (original) => ({
  ...(await original<typeof import("./project-path")>()),
  projectApi: (path: string) => `/api/projects/11111111-1111-4111-8111-111111111111${path}`,
}))

import { observeReceipt, queryReceipt } from "./project-receipt"
import { setupInstructions } from "./project-setup"

const window = { from: "2026-10-24T00:00:00Z", to: "2026-10-24T00:02:00Z" }
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mockReceipt(traces: Response | Error, logs: Response | Error) {
  const fetcher = vi.fn(async (path: string, _options?: RequestInit) => {
    const result = path.includes("/traces?") ? traces : logs
    if (result instanceof Error) throw result
    return result
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}

describe("project receipt queries", () => {
  it.each([
    { kind: "traces", otherStatus: 200 },
    { kind: "logs", otherStatus: 200 },
    { kind: "traces", otherStatus: 503 },
    { kind: "logs", otherStatus: 503 },
  ])("observes $kind when the other signal returns $otherStatus", async ({ kind, otherStatus }) => {
    const received = Response.json({ items: [{ traceId: "1".repeat(32) }], hasMore: false })
    const other = Response.json({ items: [], hasMore: false }, { status: otherStatus })
    const fetcher = mockReceipt(
      kind === "traces" ? received : other,
      kind === "logs" ? received : other,
    )
    const signal = new AbortController().signal
    await expect(queryReceipt(window, signal)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [path, options] of fetcher.mock.calls) {
      const url = new URL(path, "http://local")
      expect(url.pathname).toMatch(
        /^\/api\/projects\/11111111-1111-4111-8111-111111111111\/(traces|logs)$/,
      )
      expect(url.searchParams.get("from")).toBe(window.from)
      expect(url.searchParams.get("to")).toBe(window.to)
      expect(url.searchParams.get("limit")).toBe("1")
      expect(options?.signal).toBe(signal)
    }
  })
  it("observes a stored log despite a trace network failure", async () => {
    mockReceipt(
      new Error("Network unavailable"),
      Response.json({ items: [{ body: "Received" }], hasMore: false }),
    )
    await expect(queryReceipt(window, new AbortController().signal)).resolves.toBe(true)
  })
  it("returns empty only when both signals are available and empty", async () => {
    mockReceipt(
      Response.json({ items: [], hasMore: false }),
      Response.json({ items: [], hasMore: false }),
    )
    await expect(queryReceipt(window, new AbortController().signal)).resolves.toBe(false)
  })
  it.each(["traces", "logs"])(
    "preserves a failed %s read when no telemetry is observed",
    async (kind) => {
      const empty = Response.json({ items: [], hasMore: false })
      const unavailable = new Response(null, { status: 503 })
      mockReceipt(kind === "traces" ? unavailable : empty, kind === "logs" ? unavailable : empty)
      await expect(queryReceipt(window, new AbortController().signal)).rejects.toMatchObject({
        status: 503,
        code: "storage_unavailable",
      })
    },
  )
  it("preserves failures when neither signal is available", async () => {
    mockReceipt(new Response(null, { status: 503 }), new Response(null, { status: 503 }))
    await expect(queryReceipt(window, new AbortController().signal)).rejects.toMatchObject({
      status: 503,
      code: "storage_unavailable",
    })
  })
  it("does not confirm a receipt after cancellation even if a request ignores abort", async () => {
    mockReceipt(
      Response.json({ items: [{ traceId: "1".repeat(32) }], hasMore: false }),
      Response.json({ items: [], hasMore: false }),
    )
    const controller = new AbortController()
    const pending = queryReceipt(window, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("project receipt observation", () => {
  it("checks at most once every five seconds in a frozen window and stops at two minutes", async () => {
    vi.useFakeTimers()
    const query = vi.fn().mockResolvedValue(false)
    const report = vi.fn()
    const done = observeReceipt(new AbortController().signal, window, report, query)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(query).toHaveBeenCalledTimes(24)
    expect(query.mock.calls.every(([value]) => value === window)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(report).toHaveBeenLastCalledWith("timeout")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not attribute stored data to a token and stops on success", async () => {
    vi.useFakeTimers()
    const report = vi.fn()
    await observeReceipt(
      new AbortController().signal,
      window,
      report,
      vi.fn().mockResolvedValue(true),
    )
    expect(report).toHaveBeenLastCalledWith("observed")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("cancels pending delays without another request", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const query = vi.fn().mockResolvedValue(false)
    const report = vi.fn()
    const done = observeReceipt(controller.signal, window, report, query)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await done
    await vi.advanceTimersByTimeAsync(120_000)
    expect(query).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenLastCalledWith("stopped")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("reports storage errors instead of an empty or healthy result", async () => {
    vi.useFakeTimers()
    const report = vi.fn()
    await observeReceipt(
      new AbortController().signal,
      window,
      report,
      vi.fn().mockRejectedValue(new Error("unavailable")),
    )
    expect(report).toHaveBeenLastCalledWith("error")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("ignores late success from an abort-ignoring request", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const report = vi.fn()
    let resolve: (value: boolean) => void = () => {}
    const done = observeReceipt(
      controller.signal,
      window,
      report,
      () =>
        new Promise<boolean>((r) => {
          resolve = r
        }),
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(report).toHaveBeenLastCalledWith("timeout")
    resolve(true)
    await done
    expect(report.mock.calls.some(([value]) => value === "observed")).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("generates only placeholder configuration, not a token", () => {
    const text = setupInstructions("https://logice.example")
    expect(text).toContain("http/protobuf")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The shell placeholder must remain literal.
    expect(text).toContain("${LOGICE_PROJECT_TOKEN}")
    expect(text).not.toContain("OTLP_TOKEN=")
    expect(text).not.toContain("/v1/traces")
  })
})
