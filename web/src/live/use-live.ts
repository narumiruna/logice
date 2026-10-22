import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ApiError, type TimeWindow } from "../api"
import { timestampNs } from "../telemetry"
import { fetchLive, LIVE_TIMEOUT_MS, LiveApiError, type LiveSnapshot } from "./api"
import {
  type LiveFilters,
  type LiveRoute,
  liveHref,
  pinLiveRoute,
  validateLiveRoute,
} from "./route"

export type LiveStatus =
  | "loading"
  | "live"
  | "paused"
  | "suspended"
  | "retrying"
  | "empty"
  | "invalid-query"
  | "unavailable"
export interface LiveState {
  snapshot: LiveSnapshot | null
  status: LiveStatus
  error: Error | null
  lastSuccess: number | null
}
export type LiveRequest = (route: LiveRoute, signal: AbortSignal) => Promise<LiveSnapshot>
export interface LiveControllerOptions {
  request?: LiveRequest
  now?: () => number
  onSnapshot?: (snapshot: LiveSnapshot) => void
}
interface ActiveRequest {
  controller: AbortController
  generation: number
  deadline: ReturnType<typeof setTimeout> | null
  oneOff: boolean
}
function sameWindow(left: TimeWindow | null, right: TimeWindow | null): boolean {
  return (
    left !== null &&
    right !== null &&
    timestampNs(left.from) === timestampNs(right.from) &&
    timestampNs(left.to) === timestampNs(right.to)
  )
}
function routeWindow(route: LiveRoute): TimeWindow | null {
  return route.from !== undefined && route.to !== undefined
    ? { from: route.from, to: route.to }
    : null
}
function sameFilters(left: LiveFilters, right: LiveFilters): boolean {
  return (
    left.service === right.service &&
    left.search === right.search &&
    left.errorsOnly === right.errorsOnly &&
    left.minSeverity === right.minSeverity
  )
}

/** One physical request slot survives cancellation until its promise settles. */
export class LiveController {
  private route: LiveRoute
  private state: LiveState = { snapshot: null, status: "loading", error: null, lastSuccess: null }
  private readonly listeners = new Set<() => void>()
  private readonly request: LiveRequest
  private readonly now: () => number
  private readonly onSnapshot?: (snapshot: LiveSnapshot) => void
  private running = false
  private visible = true
  private online = true
  private generation = 0
  private failures = 0
  private blocked = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private active: ActiveRequest | null = null
  private pending: { generation: number; oneOff: boolean } | null = null
  private frozenWindow: TimeWindow | null = null
  private interruptedOneOff = false

  constructor(route: LiveRoute, options: LiveControllerOptions = {}) {
    this.route = { ...route }
    this.request = options.request ?? fetchLive
    this.now = options.now ?? Date.now
    this.onSnapshot = options.onSnapshot
  }
  getState = (): LiveState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private ready(): boolean {
    return this.running && this.visible && this.online
  }
  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
  private invalidate(): void {
    this.generation += 1
    this.clearTimer()
    this.pending = null
    this.interruptedOneOff = false
    if (this.active) {
      if (this.active.deadline !== null) clearTimeout(this.active.deadline)
      this.active.deadline = null
      this.active.controller.abort()
    }
  }
  private validRoute(): boolean {
    try {
      validateLiveRoute(this.route)
      return true
    } catch (error) {
      this.blocked = true
      this.update({
        status: "invalid-query",
        error: error instanceof Error ? error : new Error("Invalid Live query."),
      })
      return false
    }
  }
  start(): void {
    if (this.running) return
    this.running = true
    if (!this.validRoute()) return
    if (!this.ready()) {
      this.interruptedOneOff = !this.route.live && routeWindow(this.route) !== null
      this.update({ status: this.route.live || this.interruptedOneOff ? "suspended" : "paused" })
      return
    }
    if (this.route.live || routeWindow(this.route)) this.begin(!this.route.live)
    else this.update({ status: "paused" })
  }
  stop(): void {
    this.running = false
    this.invalidate()
  }
  setRoute(route: LiveRoute): void {
    let equal = false
    try {
      equal = liveHref(route) === liveHref(this.route)
    } catch {
      /* Validate below. */
    }
    if (equal) return
    const previous = this.route
    const requestedWindow = routeWindow(route)
    const unresolvedRangeChanged = !route.live && !requestedWindow && route.range !== previous.range
    const pinAcknowledged =
      !previous.live &&
      !route.live &&
      sameFilters(previous, route) &&
      previous.range === route.range &&
      sameWindow(this.frozenWindow, requestedWindow)
    this.route = { ...route }
    if (pinAcknowledged) return
    this.invalidate()
    this.failures = 0
    this.blocked = false
    if (!this.validRoute()) return
    if (route.live || unresolvedRangeChanged) this.frozenWindow = null
    else
      this.frozenWindow =
        requestedWindow ??
        (previous.live ? (this.state.snapshot?.window ?? null) : this.frozenWindow)
    const pausedMismatch =
      !route.live &&
      previous.live &&
      this.state.snapshot &&
      !sameFilters(route, this.state.snapshot.filters)
    this.update({
      error: null,
      status: route.live ? "loading" : "paused",
      ...(pausedMismatch ? { snapshot: null, lastSuccess: null } : {}),
    })
    const requestOneOff =
      !route.live &&
      Boolean(
        (!previous.live &&
          (requestedWindow ||
            this.frozenWindow ||
            (unresolvedRangeChanged && this.state.snapshot))) ||
          (previous.live &&
            requestedWindow &&
            !sameWindow(requestedWindow, this.state.snapshot?.window ?? null)),
      )
    if (!this.ready()) {
      this.interruptedOneOff = this.running && requestOneOff
      if (this.running && (route.live || requestOneOff)) this.update({ status: "suspended" })
      return
    }
    if (route.live || requestOneOff) this.begin(requestOneOff)
  }
  setEnvironment(visible: boolean, online: boolean): void {
    const wasAvailable = this.visible && this.online
    const available = visible && online
    this.visible = visible
    this.online = online
    if (wasAvailable === available || !this.running) return
    if (!available) {
      // Preserve only unfinished work for the current query. A completed paused
      // response must not become a new request when visibility returns.
      const oneOff =
        !this.route.live &&
        ((this.active?.generation === this.generation && this.active.oneOff) ||
          (this.pending?.generation === this.generation && this.pending.oneOff))
      this.invalidate()
      this.interruptedOneOff = Boolean(oneOff)
      if (this.route.live || oneOff) this.update({ status: "suspended" })
    } else if (!this.blocked && (this.route.live || this.interruptedOneOff)) {
      this.begin(!this.route.live)
    }
  }
  refresh = (): void => {
    if (!this.running) return
    this.invalidate()
    this.blocked = false
    this.failures = 0
    if (!this.validRoute()) return
    if (this.ready()) this.begin(!this.route.live)
    else {
      this.interruptedOneOff = !this.route.live
      this.update({ status: "suspended" })
    }
  }
  pause(): void {
    this.setRoute(
      this.state.snapshot
        ? pinLiveRoute(
            { ...this.route, ...this.state.snapshot.filters },
            this.state.snapshot.window,
          )
        : { ...this.route, live: false },
    )
  }
  resume(): void {
    this.setRoute({ ...this.route, live: true, from: undefined, to: undefined })
  }
  private schedule(delay: number): void {
    this.clearTimer()
    if (!this.ready() || !this.route.live || this.blocked) return
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = null
      if (generation === this.generation) this.begin(false)
    }, delay)
  }
  private failure(error: unknown, oneOff: boolean): void {
    const safeError =
      error instanceof ApiError
        ? error
        : new LiveApiError("Cannot reach the Live API. Try again.", 0, "network_error")
    const status = safeError.status
    if (status === 401 || status === 403) {
      this.blocked = true
      this.frozenWindow = null
      this.update({ snapshot: null, lastSuccess: null, error: safeError, status: "unavailable" })
      return
    }
    const terminal =
      [400, 404, 422].includes(status) ||
      ["invalid_response", "response_too_large"].includes(safeError.code)
    if (terminal) {
      this.blocked = true
      this.update({
        error: safeError,
        status: status === 400 || status === 422 ? "invalid-query" : "unavailable",
      })
      return
    }
    this.failures += 1
    this.update({ error: safeError, status: oneOff ? "paused" : "retrying" })
    if (!oneOff) {
      const backoff = Math.min(30_000, 2000 * 2 ** Math.min(this.failures - 1, 4))
      const retry = safeError instanceof LiveApiError ? safeError.retryAfterMs : null
      this.schedule(retry === null ? backoff : Math.min(30_000, Math.max(2000, retry)))
    }
  }
  private begin(oneOff: boolean): void {
    if (!this.ready() || this.blocked || (!this.route.live && !oneOff)) return
    this.interruptedOneOff = false
    if (this.active) {
      this.pending = { generation: this.generation, oneOff }
      return
    }
    this.clearTimer()
    const generation = this.generation
    const active: ActiveRequest = {
      controller: new AbortController(),
      generation,
      deadline: null,
      oneOff,
    }
    this.active = active
    const query =
      !this.route.live && this.frozenWindow
        ? pinLiveRoute(this.route, this.frozenWindow)
        : { ...this.route }
    this.update({
      status: !this.route.live
        ? !this.state.snapshot ||
          !sameFilters(query, this.state.snapshot.filters) ||
          (routeWindow(query) && !sameWindow(routeWindow(query), this.state.snapshot.window))
          ? "loading"
          : "paused"
        : this.state.error
          ? "retrying"
          : this.state.status === "loading" || !this.state.snapshot
            ? "loading"
            : this.state.status === "empty"
              ? "empty"
              : "live",
    })
    active.deadline = setTimeout(() => {
      active.deadline = null
      if (generation !== this.generation || !this.running) return
      this.generation += 1
      this.pending = null
      active.controller.abort()
      this.failure(
        new LiveApiError("The Live request timed out after eight seconds.", 0, "timeout"),
        oneOff,
      )
    }, LIVE_TIMEOUT_MS)
    // Promise.resolve also turns a synchronous request exception into a handled failure.
    void Promise.resolve()
      .then(() => {
        if (generation !== this.generation || !this.running)
          throw new DOMException("Aborted", "AbortError")
        return this.request(query, active.controller.signal)
      })
      .then(
        (snapshot) => {
          active.oneOff = false
          if (generation !== this.generation || !this.running) return
          if (!this.route.live) this.frozenWindow = snapshot.window
          this.failures = 0
          this.update({
            snapshot,
            error: null,
            lastSuccess: this.now(),
            status: !this.route.live
              ? "paused"
              : snapshot.spans.length + snapshot.logs.length === 0
                ? "empty"
                : "live",
          })
          // A presentation callback cannot change request ownership or cause a retry.
          try {
            this.onSnapshot?.(snapshot)
          } catch {
            /* Keep the committed response. */
          }
          if (generation === this.generation && !oneOff) this.schedule(2000)
        },
        (error) => {
          active.oneOff = false
          if (generation === this.generation && this.running) this.failure(error, oneOff)
        },
      )
      .finally(() => {
        if (active.deadline !== null) clearTimeout(active.deadline)
        if (this.active !== active) return
        this.active = null
        const pending = this.pending
        this.pending = null
        // Only an explicit action from the current generation can drain this slot.
        if (pending && pending.generation === this.generation && this.ready() && !this.blocked)
          this.begin(pending.oneOff)
      })
  }
}

export function useLive(
  route: LiveRoute,
  onSnapshot?: (snapshot: LiveSnapshot) => void,
): LiveState & { refresh: () => void } {
  const callback = useRef(onSnapshot)
  callback.current = onSnapshot
  const [controller] = useState(
    () => new LiveController(route, { onSnapshot: (snapshot) => callback.current?.(snapshot) }),
  )
  useEffect(() => {
    controller.setRoute(route)
  }, [controller, route])
  useEffect(() => {
    const environment = () =>
      controller.setEnvironment(document.visibilityState !== "hidden", navigator.onLine)
    environment()
    document.addEventListener("visibilitychange", environment)
    window.addEventListener("online", environment)
    window.addEventListener("offline", environment)
    controller.start()
    return () => {
      controller.stop()
      document.removeEventListener("visibilitychange", environment)
      window.removeEventListener("online", environment)
      window.removeEventListener("offline", environment)
    }
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  return { ...state, refresh: controller.refresh }
}
