import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchLive,
  LiveApiError,
  type LiveRecord,
  type LiveSnapshot,
  validateLiveSnapshot,
} from "./api"
import { allRecordIds, countNewRecords } from "./model"
import { DEFAULT_LIVE_ROUTE, pinLiveRoute } from "./route"
import { LiveController } from "./use-live"

const base = validateLiveSnapshot(
  JSON.parse(
    readFileSync(new URL("../../../tests/fixtures/live/empty.json", import.meta.url), "utf8"),
  ),
)
const route = { ...DEFAULT_LIVE_ROUTE, range: "1m" as const }
function snapshot(name = "span"): LiveSnapshot {
  return {
    ...structuredClone(base),
    spans: [
      {
        id: name,
        kind: "span",
        traceId: "1234567890abcdef1234567890abcdef",
        spanId: "1234567890abcdef",
        parentSpanId: "",
        name,
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
        scopeName: "",
        scopeVersion: "",
        scopeAttributes: {},
        resourceSchemaUrl: "",
        scopeSchemaUrl: "",
        traceFlags: 0,
        occurrences: "1",
        conflict: false,
        parentConflict: false,
        contextOnly: false,
        stored: {},
      },
    ],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const flush = () => vi.advanceTimersByTimeAsync(0)
const controllers: LiveController[] = []
function track(controller: LiveController): LiveController {
  controllers.push(controller)
  return controller
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-23T00:01:00Z"))
})
afterEach(async () => {
  for (const controller of controllers) controller.stop()
  controllers.length = 0
  await flush()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

describe("completion-owned Live polling", () => {
  it("waits two seconds after completion rather than starting an interval during a slow request", async () => {
    const first = deferred<LiveSnapshot>()
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(snapshot())
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    expect(request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(request).toHaveBeenCalledOnce()
    first.resolve(snapshot())
    await flush()
    expect(owner.getState()).toMatchObject({ status: "live", error: null, lastSuccess: Date.now() })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it("represents healthy empty results without a stale error and resets backoff on recovery", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(base)
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    expect(owner.getState()).toMatchObject({
      status: "retrying",
      snapshot: null,
      lastSuccess: null,
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(owner.getState()).toMatchObject({ status: "empty", snapshot: base, error: null })
    request.mockRejectedValueOnce(new Error("again"))
    await vi.advanceTimersByTimeAsync(2000)
    expect(owner.getState().status).toBe("retrying")
    await vi.advanceTimersByTimeAsync(1999)
    expect(request).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(4)
  })
  it("aborts pause, retains the frozen snapshot, and does not fetch because its fixed bounds were added", async () => {
    const pending = deferred<LiveSnapshot>()
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(pending.promise)
    const callback = vi.fn()
    const owner = track(new LiveController(route, { request, onSnapshot: callback }))
    owner.start()
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    const signal: AbortSignal = request.mock.calls[1][1]
    owner.setRoute(pinLiveRoute(route, base.window))
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(snapshot("stale"))
    await flush()
    expect(owner.getState().snapshot?.spans[0].id).toBe("span")
    expect(owner.getState().status).toBe("paused")
    expect(callback).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it("pauses a pending filter change with the committed query, not stale data under the pending filters", async () => {
    const committed = snapshot()
    committed.filters.search = "Committed A"
    const held = deferred<LiveSnapshot>()
    const request = vi
      .fn()
      .mockResolvedValueOnce(committed)
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(committed)
    const owner = track(new LiveController({ ...route, search: "Committed A" }, { request }))
    owner.start()
    await flush()
    owner.setRoute({ ...route, search: "Pending B" })
    await flush()
    expect(owner.getState().status).toBe("loading")
    owner.pause()
    expect(request.mock.calls[1][1].aborted).toBe(true)
    expect(owner.getState()).toMatchObject({ status: "paused", snapshot: committed })
    held.resolve(snapshot("stale B"))
    await flush()
    expect(owner.getState().snapshot).toBe(committed)
    owner.refresh()
    await flush()
    expect(request.mock.calls[2][0]).toMatchObject({
      live: false,
      search: "Committed A",
      ...committed.window,
    })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not present an old query while resolving different paused filters", async () => {
    const committed = snapshot()
    const held = deferred<LiveSnapshot>()
    const request = vi.fn().mockResolvedValueOnce(committed).mockReturnValueOnce(held.promise)
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    owner.setRoute({ ...pinLiveRoute(route, committed.window), search: "Another query" })
    expect(owner.getState()).toMatchObject({ status: "loading", snapshot: null, lastSuccess: null })
    await flush()
    expect(request.mock.calls[1][0]).toMatchObject({ live: false, search: "Another query" })
    const fresh = snapshot("fresh")
    fresh.filters.search = "Another query"
    held.resolve(fresh)
    await flush()
    expect(owner.getState()).toMatchObject({ status: "paused", snapshot: fresh })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("starts paused unresolved with no invented bounds or background request; Refresh resolves and pins once", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const paused = { ...route, live: false }
    const owner = track(new LiveController(paused, { request }))
    owner.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(request).not.toHaveBeenCalled()
    expect(owner.getState()).toMatchObject({ status: "paused", snapshot: null })
    owner.refresh()
    await flush()
    expect(request.mock.calls[0][0]).toEqual(paused)
    expect(vi.getTimerCount()).toBe(0)
    owner.setRoute(pinLiveRoute(paused, base.window))
    await flush()
    expect(request).toHaveBeenCalledOnce()
    owner.refresh()
    await flush()
    expect(request.mock.calls[1][0]).toEqual(pinLiveRoute(paused, base.window))
    expect(vi.getTimerCount()).toBe(0)
  })
  it("loads fixed paused URLs once, and changes paused filters/time once without polling", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const paused = pinLiveRoute(route, base.window)
    const owner = track(new LiveController(paused, { request }))
    owner.start()
    await flush()
    expect(request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(request).toHaveBeenCalledOnce()
    owner.setRoute({ ...paused, search: "next" })
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    owner.setRoute({ ...paused, from: "2026-10-23T00:00:10Z", to: "2026-10-23T00:00:20Z" })
    await flush()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2][0].from).toBe("2026-10-23T00:00:10Z")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("resolves a changed rolling range once while paused instead of reusing the frozen old window", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const owner = track(new LiveController(pinLiveRoute(route, base.window), { request }))
    owner.start()
    await flush()
    owner.setRoute({ ...route, live: false, range: "15m" })
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0]).toMatchObject({ range: "15m", live: false })
    expect(request.mock.calls[1][0].from).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("treats a different fixed interval selected while live as one paused request", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    owner.setRoute(
      pinLiveRoute(route, { from: "2026-10-23T00:00:10Z", to: "2026-10-23T00:00:20Z" }),
    )
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("resumes with one immediate rolling request and freezes internal pause windows", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    owner.pause()
    owner.refresh()
    await flush()
    expect(request.mock.calls[1][0]).toMatchObject({ live: false, ...base.window })
    owner.resume()
    owner.resume()
    await flush()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2][0]).toMatchObject({
      live: true,
      range: "1m",
      from: undefined,
      to: undefined,
    })
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe("generation and physical request ownership", () => {
  it("never overlaps physical requests when old work ignores abort across rapid filter changes", async () => {
    const old = deferred<LiveSnapshot>()
    const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(snapshot("current"))
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    const oldSignal: AbortSignal = request.mock.calls[0][1]
    owner.setRoute({ ...route, search: "a" })
    owner.setRoute({ ...route, search: "b" })
    owner.refresh()
    expect(oldSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledOnce()
    old.resolve(snapshot("old"))
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0].search).toBe("b")
    expect(owner.getState().snapshot?.spans[0].id).toBe("current")
    expect(vi.getTimerCount()).toBe(1)
  })
  it("timeouts at eight seconds but retains the physical slot until ignored-abort work settles", async () => {
    const hung = deferred<LiveSnapshot>()
    const request = vi
      .fn()
      .mockReturnValueOnce(hung.promise)
      .mockResolvedValue(snapshot("recovered"))
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    await vi.advanceTimersByTimeAsync(7999)
    expect(owner.getState().error).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(owner.getState()).toMatchObject({
      status: "retrying",
      snapshot: null,
      error: { code: "timeout" },
    })
    expect(request.mock.calls[0][1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    hung.resolve(snapshot("must-not-commit"))
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(owner.getState().snapshot?.spans[0].id).toBe("recovered")
  })
  it("uses the same deadline across HTTP headers and a stalled streaming body", async () => {
    const cancel = vi.fn()
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel })))
    const owner = track(
      new LiveController(route, { request: (route, signal) => fetchLive(route, signal, fetcher) }),
    )
    owner.start()
    await flush()
    await vi.advanceTimersByTimeAsync(8000)
    expect(cancel).toHaveBeenCalledOnce()
    expect(owner.getState().error).toMatchObject({ code: "timeout" })
    expect(vi.getTimerCount()).toBe(1)
  })
  it("old rejection/finally cannot restart a stopped scheduler or commit after cleanup", async () => {
    const old = deferred<LiveSnapshot>()
    const request = vi.fn().mockReturnValue(old.promise)
    const listener = vi.fn()
    const owner = track(new LiveController(route, { request }))
    const unsubscribe = owner.subscribe(listener)
    owner.start()
    await flush()
    owner.setRoute({ ...route, search: "new" })
    owner.stop()
    unsubscribe()
    const state = owner.getState()
    old.reject(new Error("ignored abort failed"))
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(owner.getState()).toBe(state)
    expect(request).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("supports StrictMode setup/cleanup/setup using the same owner without overlap or stale commit", async () => {
    const old = deferred<LiveSnapshot>()
    const request = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(snapshot("remounted"))
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    owner.stop()
    owner.start()
    owner.start()
    await flush()
    expect(request).toHaveBeenCalledOnce()
    old.resolve(snapshot("discard"))
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(owner.getState().snapshot?.spans[0].id).toBe("remounted")
    owner.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not even call the request function if setup/cleanup occurs before its microtask", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const owner = track(new LiveController(route, { request }))
    owner.start()
    owner.stop()
    await flush()
    expect(request).not.toHaveBeenCalled()
  })
})

describe("suspension and recovery", () => {
  it.each([
    [false, true],
    [true, false],
  ])(
    "resumes an interrupted fixed-window request after visible=%s online=%s",
    async (visible, online) => {
      const interrupted = deferred<LiveSnapshot>()
      const request = vi
        .fn()
        .mockReturnValueOnce(interrupted.promise)
        .mockResolvedValue(snapshot("recovered fixed"))
      const fixed = pinLiveRoute({ ...route, search: "fixed query" }, base.window)
      const owner = track(new LiveController(fixed, { request }))
      owner.start()
      await flush()
      expect(request).toHaveBeenCalledOnce()
      owner.setEnvironment(visible, online)
      expect(request.mock.calls[0][1].aborted).toBe(true)
      interrupted.resolve(snapshot("obsolete fixed"))
      await flush()
      expect(owner.getState().snapshot).toBeNull()
      owner.setEnvironment(true, true)
      await flush()
      expect(request).toHaveBeenCalledTimes(2)
      expect(request.mock.calls[1][0]).toEqual(fixed)
      expect(owner.getState()).toMatchObject({ status: "paused", error: null })
      expect(owner.getState().snapshot?.spans[0].name).toBe("recovered fixed")
      await vi.advanceTimersByTimeAsync(60_000)
      expect(request).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
  it("queues one resumed fixed request until an ignored-abort request settles", async () => {
    const interrupted = deferred<LiveSnapshot>()
    const request = vi
      .fn()
      .mockReturnValueOnce(interrupted.promise)
      .mockResolvedValue(snapshot("resumed once"))
    const fixed = pinLiveRoute(route, base.window)
    const owner = track(new LiveController(fixed, { request }))
    owner.start()
    await flush()
    owner.setEnvironment(false, true)
    owner.setEnvironment(false, false)
    owner.setEnvironment(true, false)
    owner.setEnvironment(true, true)
    owner.setEnvironment(true, true)
    await flush()
    expect(request).toHaveBeenCalledOnce()
    interrupted.resolve(snapshot("obsolete"))
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0]).toEqual(fixed)
    expect(owner.getState().snapshot?.spans[0].name).toBe("resumed once")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not refresh a completed paused view after hidden or offline transitions", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const owner = track(new LiveController(pinLiveRoute(route, base.window), { request }))
    owner.start()
    await flush()
    const committed = owner.getState()
    owner.setEnvironment(false, true)
    owner.setEnvironment(false, false)
    owner.setEnvironment(true, false)
    owner.setEnvironment(true, true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledOnce()
    expect(owner.getState()).toBe(committed)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    [false, true],
    [true, false],
  ])(
    "loads a fixed URL once when an initially unavailable page becomes ready: %s/%s",
    async (visible, online) => {
      const request = vi.fn().mockResolvedValue(snapshot())
      const fixed = pinLiveRoute(route, base.window)
      const owner = track(new LiveController(fixed, { request }))
      owner.setEnvironment(visible, online)
      owner.start()
      await flush()
      expect(request).not.toHaveBeenCalled()
      expect(owner.getState().status).toBe("suspended")
      owner.setEnvironment(true, true)
      await flush()
      expect(request).toHaveBeenCalledOnce()
      expect(request.mock.calls[0][0]).toEqual(fixed)
      expect(owner.getState().status).toBe("paused")
      await vi.advanceTimersByTimeAsync(60_000)
      expect(request).toHaveBeenCalledOnce()
    },
  )
  it("resumes an explicit paused Refresh without enabling Live", async () => {
    const interrupted = deferred<LiveSnapshot>()
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(interrupted.promise)
      .mockResolvedValue(snapshot("refreshed"))
    const fixed = pinLiveRoute(route, base.window)
    const owner = track(new LiveController(fixed, { request }))
    owner.start()
    await flush()
    owner.refresh()
    await flush()
    owner.setEnvironment(false, true)
    interrupted.reject(new DOMException("Aborted", "AbortError"))
    await flush()
    owner.setEnvironment(true, true)
    await flush()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2][0]).toEqual(fixed)
    expect(owner.getState().snapshot?.spans[0].name).toBe("refreshed")
    expect(owner.getState().status).toBe("paused")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("resumes only the newest paused query if it changes while suspended", async () => {
    const old = deferred<LiveSnapshot>()
    const request = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(snapshot("new query"))
    const fixed = pinLiveRoute(route, base.window)
    const owner = track(new LiveController(fixed, { request }))
    owner.start()
    await flush()
    owner.setEnvironment(false, true)
    const latest = { ...fixed, service: "new-service", search: "new query" }
    owner.setRoute(latest)
    old.resolve(snapshot("discard"))
    await flush()
    owner.setEnvironment(true, true)
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0]).toEqual(latest)
    expect(owner.getState().snapshot?.spans[0].name).toBe("new query")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("drops interrupted one-off intent on stop and cannot restart from an obsolete completion", async () => {
    const old = deferred<LiveSnapshot>()
    const request = vi.fn().mockReturnValueOnce(old.promise)
    const owner = track(new LiveController(pinLiveRoute(route, base.window), { request }))
    owner.start()
    await flush()
    owner.setEnvironment(false, false)
    owner.stop()
    owner.setEnvironment(true, true)
    old.resolve(snapshot("discard"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledOnce()
    expect(owner.getState().snapshot).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("keeps an unresolved paused view idle unless Refresh was explicitly requested offline", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const paused = { ...route, live: false }
    const owner = track(new LiveController(paused, { request }))
    owner.setEnvironment(false, false)
    owner.start()
    owner.setEnvironment(true, true)
    await flush()
    expect(request).not.toHaveBeenCalled()
    owner.setEnvironment(true, false)
    owner.refresh()
    owner.setEnvironment(true, true)
    await flush()
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toEqual(paused)
    expect(owner.getState().status).toBe("paused")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("coalesces hidden/offline resume, retains requested live mode and never replays missed ticks", async () => {
    const old = deferred<LiveSnapshot>()
    const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(snapshot())
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    owner.setEnvironment(false, true)
    owner.setEnvironment(false, false)
    expect(owner.getState().status).toBe("suspended")
    expect(request.mock.calls[0][1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    owner.setEnvironment(true, false)
    owner.setEnvironment(true, true)
    owner.setEnvironment(true, true)
    old.resolve(snapshot("old"))
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })
  it("starts hidden without fetching and does not auto-refresh paused mode on visibility events", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const owner = track(new LiveController(route, { request }))
    owner.setEnvironment(false, true)
    owner.start()
    await flush()
    expect(request).not.toHaveBeenCalled()
    owner.setEnvironment(true, true)
    await flush()
    expect(request).toHaveBeenCalledOnce()
    owner.pause()
    owner.setEnvironment(false, false)
    owner.setEnvironment(true, true)
    await flush()
    expect(request).toHaveBeenCalledOnce()
  })
  it("retains one stale response through 2/4/8/16/30-second exponential backoff", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValue(new Error("secret network details"))
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    const success = owner.getState().lastSuccess
    await vi.advanceTimersByTimeAsync(2000)
    expect(owner.getState()).toMatchObject({ status: "retrying", lastSuccess: success })
    expect(owner.getState().snapshot?.spans[0].id).toBe("span")
    expect(owner.getState().error?.message).not.toContain("secret")
    let calls = 2
    for (const delay of [2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(request).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(request).toHaveBeenCalledTimes(++calls)
      expect(vi.getTimerCount()).toBe(1)
    }
  })
  it("keeps stale retry metadata while the recovery request is unresolved", async () => {
    const recovery = deferred<LiveSnapshot>()
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(recovery.promise)
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    const error = owner.getState().error
    await vi.advanceTimersByTimeAsync(2000)
    expect(owner.getState()).toMatchObject({ status: "retrying", error })
    expect(owner.getState().snapshot?.spans[0].id).toBe("span")
    recovery.resolve(snapshot("recovered"))
    await flush()
    expect(owner.getState()).toMatchObject({ status: "live", error: null })
  })
  it.each([429, 503])("honors clamped Retry-After on transient HTTP %s", async (status) => {
    const request = vi
      .fn()
      .mockRejectedValue(new LiveApiError("unavailable", status, "unavailable", 45_000))
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it.each([
    [400, "invalid_query"],
    [422, "response_too_large"],
    [404, "unsupported_endpoint"],
    [200, "invalid_response"],
    [200, "response_too_large"],
  ])(
    "stops retries for terminal HTTP/code %s %s until explicit refresh or query change",
    async (status, code) => {
      const request = vi
        .fn()
        .mockRejectedValue(new LiveApiError("terminal", Number(status), String(code)))
      const owner = track(new LiveController(route, { request }))
      owner.start()
      await flush()
      expect(owner.getState().status).toBe(
        [400, 422].includes(Number(status)) ? "invalid-query" : "unavailable",
      )
      owner.setEnvironment(false, false)
      owner.setEnvironment(true, true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(request).toHaveBeenCalledOnce()
      owner.refresh()
      await flush()
      expect(request).toHaveBeenCalledTimes(2)
      owner.setRoute({ ...route, search: "changed" })
      await flush()
      expect(request).toHaveBeenCalledTimes(3)
    },
  )
  it.each([401, 403])(
    "clears retained telemetry and last-success time on HTTP %s",
    async (status) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(snapshot())
        .mockRejectedValue(new LiveApiError("denied", status, "access_denied"))
      const owner = track(new LiveController(route, { request }))
      owner.start()
      await flush()
      await vi.advanceTimersByTimeAsync(2000)
      expect(owner.getState()).toMatchObject({
        snapshot: null,
        lastSuccess: null,
        status: "unavailable",
      })
      expect(vi.getTimerCount()).toBe(0)
    },
  )
  it("never retries a failed paused oneoff in the background", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"))
    const owner = track(new LiveController({ ...route, live: false }, { request }))
    owner.start()
    owner.refresh()
    await flush()
    expect(owner.getState().status).toBe("paused")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledOnce()
  })
  it("retains a stale snapshot with loading status during a changed query", async () => {
    const next = deferred<LiveSnapshot>()
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(next.promise)
    const owner = track(new LiveController(route, { request }))
    owner.start()
    await flush()
    owner.setRoute({ ...route, search: "changed" })
    await flush()
    expect(owner.getState()).toMatchObject({ status: "loading" })
    expect(owner.getState().snapshot?.spans[0].id).toBe("span")
    next.resolve(snapshot("new"))
    await flush()
    expect(owner.getState().status).toBe("live")
  })
  it("reports invalid programmatic routes without requesting", async () => {
    const request = vi.fn().mockResolvedValue(snapshot())
    const owner = track(new LiveController({ ...route, minSeverity: 25 }, { request }))
    owner.start()
    await flush()
    expect(owner.getState().status).toBe("invalid-query")
    expect(request).not.toHaveBeenCalled()
    owner.setRoute(route)
    await flush()
    expect(request).toHaveBeenCalledOnce()
  })
})

it("keeps 15 virtual minutes of rotating maximum snapshots bounded to one response, one request and one poll timer", async () => {
  const template = snapshot().spans[0]
  let calls = 0
  let active = 0
  let maximumActive = 0
  const request = vi.fn(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    calls += 1
    const offset = calls * 1500
    const records = Array.from(
      { length: 1500 },
      (_, index): LiveRecord => ({
        ...template,
        id: `rotating:${offset + index}`,
        traceId: BigInt((index % 100) + 1)
          .toString(16)
          .padStart(32, "0"),
        spanId: BigInt(index + 1)
          .toString(16)
          .padStart(16, "0"),
        kind: index >= 500 && index < 1000 ? "log" : "span",
        contextOnly: index >= 1000,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    active -= 1
    return {
      ...base,
      spans: records.slice(0, 500),
      logs: records.slice(500, 1000),
      context: records.slice(1000),
    }
  })
  const owner = track(new LiveController(route, { request }))
  const started = Date.now()
  owner.start()
  await vi.advanceTimersByTimeAsync(1)
  let previous = owner.getState().snapshot
  for (let elapsed = 2001; elapsed < 900_000; elapsed += 2001) {
    await vi.advanceTimersByTimeAsync(2001)
    const current = owner.getState().snapshot
    expect(current).not.toBeNull()
    if (!current) throw new Error("Missing snapshot")
    expect(current.spans.length + current.logs.length + current.context.length).toBe(1500)
    expect(allRecordIds(current).size).toBe(1500)
    expect(countNewRecords(previous, current)).toBe(1000)
    expect(vi.getTimerCount()).toBe(1)
    previous = current
  }
  await vi.advanceTimersByTimeAsync(started + 900_000 - Date.now())
  expect(Date.now() - started).toBe(900_000)
  expect(calls).toBe(450)
  expect(maximumActive).toBe(1)
  expect(active).toBe(0)
  owner.stop()
  expect(vi.getTimerCount()).toBe(0)
}, 30_000)
