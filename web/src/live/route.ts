import type { TimeWindow } from "../api"
import { timestampNs } from "../telemetry"

export type LiveRange = "1m" | "5m" | "15m"
export interface LiveFilters {
  service: string
  search: string
  errorsOnly: boolean
  minSeverity: number
}
export interface LiveRoute extends LiveFilters {
  range: LiveRange
  live: boolean
  from?: string
  to?: string
}

export class LiveRouteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiveRouteError"
  }
}

export const DEFAULT_LIVE_ROUTE: LiveRoute = {
  range: "5m",
  live: true,
  service: "",
  search: "",
  errorsOnly: false,
  minSeverity: 0,
}

export function validateWindow(window: TimeWindow): void {
  const from = timestampNs(window.from)
  const to = timestampNs(window.to)
  if (
    from === null ||
    to === null ||
    from < -9_223_372_036_854_775_808n ||
    to > 9_223_372_036_854_775_807n ||
    to - from < 1_000_000_000n ||
    to - from > 900_000_000_000n
  )
    throw new LiveRouteError(
      "Use RFC3339 timestamps with an interval from one second to fifteen minutes.",
    )
}

export function validateLiveRoute(route: LiveRoute): void {
  if (!["1m", "5m", "15m"].includes(route.range) || typeof route.live !== "boolean")
    throw new LiveRouteError("Select a supported Live range and mode.")
  if ((route.from === undefined) !== (route.to === undefined))
    throw new LiveRouteError("Set both from and to timestamps.")
  if (route.from !== undefined && route.to !== undefined) {
    if (route.live) throw new LiveRouteError("Live mode requires a rolling range.")
    validateWindow({ from: route.from, to: route.to })
  }
  for (const value of [route.service, route.search]) {
    if (typeof value !== "string" || new TextEncoder().encode(value).length > 200)
      throw new LiveRouteError("Service and search must each contain at most 200 UTF-8 bytes.")
  }
  if (
    typeof route.errorsOnly !== "boolean" ||
    !Number.isInteger(route.minSeverity) ||
    route.minSeverity < 0 ||
    route.minSeverity > 24
  )
    throw new LiveRouteError("Use a minimum severity from 0 to 24 and a boolean errorsOnly value.")
}

export function parseLiveRoute(href: string): LiveRoute {
  const url = new URL(href, "http://local")
  if (url.pathname !== "/live" && url.pathname !== "/live/")
    throw new LiveRouteError("This is not a Live URL.")
  try {
    for (const part of url.search.slice(1).split("&")) decodeURIComponent(part.replace(/\+/g, " "))
  } catch {
    throw new LiveRouteError("The URL has invalid query encoding.")
  }
  const allowed = new Set([
    "mode",
    "range",
    "from",
    "to",
    "service",
    "search",
    "errorsOnly",
    "minSeverity",
  ])
  const params = url.searchParams
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new LiveRouteError("The URL has an unknown or repeated parameter.")
  }
  let range = params.get("range") ?? "5m"
  if (range !== "1m" && range !== "5m" && range !== "15m")
    throw new LiveRouteError("Select a one-, five-, or fifteen-minute range.")
  const mode = params.get("mode") ?? (params.has("from") || params.has("to") ? "paused" : "live")
  if (mode !== "live" && mode !== "paused") throw new LiveRouteError("Select live or paused mode.")
  if (params.has("range") && (params.has("from") || params.has("to")))
    throw new LiveRouteError("Do not mix rolling and fixed time bounds.")
  const errors = params.get("errorsOnly") ?? "false"
  const severity = params.get("minSeverity") ?? "0"
  if (errors !== "true" && errors !== "false")
    throw new LiveRouteError("errorsOnly must be true or false.")
  if (!/^(0|[1-9]\d*)$/.test(severity))
    throw new LiveRouteError("minSeverity must be an integer from 0 to 24.")
  if (params.has("from") && params.has("to")) {
    const from = timestampNs(params.get("from") ?? "")
    const to = timestampNs(params.get("to") ?? "")
    if (from !== null && to !== null) {
      const width = to - from
      range = width <= 60_000_000_000n ? "1m" : width <= 300_000_000_000n ? "5m" : "15m"
    }
  }
  // The supported values were checked before fixed-window range inference.
  const selectedRange: LiveRange = range === "1m" ? "1m" : range === "15m" ? "15m" : "5m"
  const route: LiveRoute = {
    range: selectedRange,
    live: mode === "live",
    service: params.get("service") ?? "",
    search: params.get("search") ?? "",
    errorsOnly: errors === "true",
    minSeverity: Number(severity),
    ...(params.has("from") ? { from: params.get("from") ?? "" } : {}),
    ...(params.has("to") ? { to: params.get("to") ?? "" } : {}),
  }
  validateLiveRoute(route)
  return route
}

export function liveQuery(route: LiveRoute): URLSearchParams {
  validateLiveRoute(route)
  const params =
    route.from !== undefined && route.to !== undefined
      ? new URLSearchParams({ from: route.from, to: route.to })
      : new URLSearchParams({ range: route.range })
  if (route.service) params.set("service", route.service)
  if (route.search) params.set("search", route.search)
  if (route.errorsOnly) params.set("errorsOnly", "true")
  if (route.minSeverity) params.set("minSeverity", String(route.minSeverity))
  return params
}

export function liveHref(route: LiveRoute): string {
  const params = liveQuery(route)
  params.set("mode", route.live ? "live" : "paused")
  return `/live?${params}`
}

export function pinLiveRoute(route: LiveRoute, window: TimeWindow): LiveRoute {
  validateWindow(window)
  return { ...route, live: false, from: window.from, to: window.to }
}

export function formatTimestampNs(ns: bigint): string {
  let seconds = ns / 1_000_000_000n
  let fraction = ns % 1_000_000_000n
  if (fraction < 0n) {
    seconds -= 1n
    fraction += 1_000_000_000n
  }
  return new Date(Number(seconds * 1000n))
    .toISOString()
    .replace(/\.\d{3}Z$/, `.${fraction.toString().padStart(9, "0")}Z`)
}

export function selectInterval(window: TimeWindow, from: string, to: string): TimeWindow {
  validateWindow(window)
  const lower = timestampNs(window.from)
  const upper = timestampNs(window.to)
  const start = timestampNs(from)
  const end = timestampNs(to)
  if (
    lower === null ||
    upper === null ||
    start === null ||
    end === null ||
    start >= end ||
    start < lower ||
    end > upper
  )
    throw new LiveRouteError("Select an interval inside the displayed window.")
  if (end - start >= 1_000_000_000n) return { from, to }
  let left = (start + end - 1_000_000_000n) / 2n
  if (left < lower) left = lower
  if (left + 1_000_000_000n > upper) left = upper - 1_000_000_000n
  return { from: formatTimestampNs(left), to: formatTimestampNs(left + 1_000_000_000n) }
}
