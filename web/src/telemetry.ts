import type { ListFilters, Span, TimeWindow } from "./api"
import { listParams, windowParams } from "./api"
import { localProjectPath, projectPath } from "./project-path"

export const ranges = {
  "15m": { label: "Last 15 minutes", ms: 15 * 60_000 },
  "1h": { label: "Last hour", ms: 60 * 60_000 },
  "6h": { label: "Last 6 hours", ms: 6 * 60 * 60_000 },
  "24h": { label: "Last 24 hours", ms: 24 * 60 * 60_000 },
} as const
export type Range = keyof typeof ranges | "fixed"
export type Page = "traces" | "logs" | "detail" | "not-found"
export interface Route {
  page: Page
  traceId: string
  filters: ListFilters
  range: Range
  error: string
}

export function isTraceId(value: string): boolean {
  return /^[a-f\d]{32}$/i.test(value) && !/^0{32}$/.test(value)
}

export function relativeWindow(range: Exclude<Range, "fixed">, now = Date.now()): TimeWindow {
  return { from: new Date(now - ranges[range].ms).toISOString(), to: new Date(now).toISOString() }
}

export function timestampNs(value: string): bigint | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    )
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    return null
  const ms = Date.parse(value)
  return Number.isFinite(ms)
    ? BigInt(ms) * 1_000_000n + BigInt(fraction.slice(3).padEnd(6, "0"))
    : null
}

export function parseRoute(href: string, now = Date.now()): Route {
  const url = new URL(href, "http://local")
  const path = localProjectPath(href).replace(/\/$/, "") || "/"
  const detail = /^\/traces\/([^/]+)$/.exec(path)
  const page: Page =
    path === "/" || path === "/traces"
      ? "traces"
      : path === "/logs"
        ? "logs"
        : detail
          ? "detail"
          : "not-found"
  const params = url.searchParams
  const requestedRange = params.get("range") ?? ""
  const range: Range = Object.hasOwn(ranges, requestedRange)
    ? (requestedRange as Exclude<Range, "fixed">)
    : params.has("from") || params.has("to")
      ? "fixed"
      : "1h"
  const fallback = relativeWindow(range === "fixed" ? "1h" : range, now)
  const from = params.get("from") ?? fallback.from
  const to = params.get("to") ?? fallback.to
  let error = ""
  if (params.has("from") !== params.has("to")) {
    error = "Set both from and to timestamps, or remove both to use the last hour."
  } else if (params.has("from")) {
    const start = timestampNs(from)
    const end = timestampNs(to)
    if (start === null || end === null || start >= end) {
      error = "Use valid RFC3339 timestamps with from earlier than to."
    }
  }
  const integer = (key: string, fallbackValue: number, min: number, max: number) => {
    const value = params.get(key)
    if (value === null) return fallbackValue
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      error ||= `${key} must be an integer from ${min} to ${max}.`
      return fallbackValue
    }
    return Number(value)
  }
  const limit = integer("limit", 50, 1, 100)
  const minSeverity = page === "logs" ? integer("minSeverity", 0, 0, 24) : 0
  const traceId = page === "logs" ? (params.get("traceId") ?? "") : ""
  if (traceId && !isTraceId(traceId))
    error ||= "Trace ID must be 32 hexadecimal digits and nonzero."
  if (
    page === "traces" &&
    params.has("errorsOnly") &&
    !["true", "false"].includes(params.get("errorsOnly") ?? "")
  ) {
    error ||= "errorsOnly must be true or false."
  }
  if (detail && !isTraceId(detail[1]))
    error ||= "Trace ID must be 32 hexadecimal digits and nonzero."
  return {
    page,
    traceId: detail?.[1] ?? "",
    range,
    error,
    filters: {
      from,
      to,
      service: params.get("service") ?? "",
      search: params.get("search") ?? "",
      limit,
      errorsOnly: params.get("errorsOnly") === "true",
      minSeverity,
      traceId,
    },
  }
}

export function traceHref(traceId: string, window: TimeWindow): string {
  return `${projectPath(`/traces/${encodeURIComponent(traceId)}`)}?${windowParams(window)}`
}

export function listHref(page: "traces" | "logs", window: TimeWindow): string {
  return `${projectPath(`/${page}`)}?${windowParams(window)}`
}

export function routeHref(route: Route, refresh = false, now = Date.now()): string {
  const filters = {
    ...route.filters,
    ...(refresh && route.page !== "detail" && route.range !== "fixed"
      ? relativeWindow(route.range, now)
      : {}),
  }
  if (route.page === "detail") return traceHref(route.traceId, filters)
  const params = listParams(route.page === "logs" ? "logs" : "traces", filters)
  if (route.range !== "fixed") params.set("range", route.range)
  return `${projectPath(`/${route.page === "logs" ? "logs" : "traces"}`)}?${params}`
}

export function filterResetHref(route: Route): string | undefined {
  const filters = route.filters
  const filtered =
    filters.service ||
    filters.search ||
    (route.page === "logs" ? filters.minSeverity || filters.traceId : filters.errorsOnly)
  if (!filtered) return undefined
  return routeHref({
    ...route,
    filters: {
      ...filters,
      service: "",
      search: "",
      errorsOnly: false,
      minSeverity: 0,
      traceId: "",
    },
  })
}

export function durationValue(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n
}

export function formatDuration(value: string): string {
  if (!/^\d+$/.test(value)) return "—"
  const ns = BigInt(value)
  for (const [unit, scale] of [
    ["s", 1_000_000_000n],
    ["ms", 1_000_000n],
    ["µs", 1_000n],
  ] as const) {
    if (ns >= scale) {
      const fraction = (((ns % scale) * 100n) / scale)
        .toString()
        .padStart(2, "0")
        .replace(/0+$/, "")
      return `${ns / scale}${fraction ? `.${fraction}` : ""} ${unit}`
    }
  }
  return `${ns} ns`
}

export function spanStatus(code: Span["statusCode"]): { label: string; tone: string } {
  const value = String(code).toUpperCase()
  if (["2", "ERROR", "STATUS_CODE_ERROR"].includes(value)) return { label: "Error", tone: "error" }
  if (["1", "OK", "STATUS_CODE_OK"].includes(value)) return { label: "OK", tone: "success" }
  if (["0", "UNSET", "STATUS_CODE_UNSET", ""].includes(value))
    return { label: "Unset", tone: "neutral" }
  return { label: String(code), tone: "neutral" }
}

export function severity(log: { severityNumber: number; severityText: string }): {
  label: string
  tone: string
} {
  const value = log.severityNumber
  return {
    label:
      log.severityText ||
      (value >= 21
        ? "FATAL"
        : value >= 17
          ? "ERROR"
          : value >= 13
            ? "WARN"
            : value >= 9
              ? "INFO"
              : value >= 5
                ? "DEBUG"
                : value >= 1
                  ? "TRACE"
                  : "UNSPECIFIED"),
    tone: value >= 17 ? "error" : value >= 13 ? "warning" : value >= 9 ? "info" : "neutral",
  }
}

export function spanDepth(span: Span, byId: Map<string, Span>): number {
  const seen = new Set([span.spanId])
  let parent = span.parentSpanId
  let depth = 0
  while (parent && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent)
    depth += 1
    parent = byId.get(parent)?.parentSpanId ?? ""
  }
  return Math.min(depth, 6)
}

export function spanTimeline(spans: Span[]): Map<Span, { left: number; width: number }> {
  const values = spans.map((span) => ({ span, start: timestampNs(span.startTime) }))
  let start: bigint | null = null
  let end: bigint | null = null
  for (const item of values) {
    if (item.start === null) continue
    const stop = item.start + durationValue(item.span.durationNs)
    if (start === null || item.start < start) start = item.start
    if (end === null || stop > end) end = stop
  }
  const result = new Map<Span, { left: number; width: number }>()
  if (start === null || end === null) return result
  const scale = end > start ? end - start : 1n
  for (const item of values) {
    if (item.start === null) continue
    result.set(item.span, {
      left: Number(((item.start - start) * 10_000n) / scale) / 100,
      width: Number((durationValue(item.span.durationNs) * 10_000n) / scale) / 100,
    })
  }
  return result
}
