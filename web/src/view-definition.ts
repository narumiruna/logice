import { type LiveRoute, liveHref, parseLiveRoute } from "./live/route"
import { localProjectPath } from "./project-path"
import { parseRoute, ranges, relativeWindow, routeHref, timestampNs } from "./telemetry"

export interface ViewDisplay {
  headers: boolean
  follow: boolean
  autoExpand: boolean
}
export interface ViewDefinition {
  version: 1
  kind: "traces" | "logs" | "live"
  live: boolean
  time: { mode: "relative" | "fixed"; range: string; from: string; to: string }
  filters: {
    service: string
    search: string
    errorsOnly: boolean
    minSeverity: number
    traceId: string
    limit: number
  }
  display: ViewDisplay
}
export function liveDisplay(
  hash = typeof location === "undefined" ? "" : location.hash,
): ViewDisplay {
  const q = new URLSearchParams(hash.replace(/^#/, ""))
  return {
    headers: q.get("headers") !== "0",
    follow: q.get("follow") !== "0",
    autoExpand: q.get("autoExpand") !== "0",
  }
}
export function captureView(href: string, display = liveDisplay()): ViewDefinition {
  const live = localProjectPath(href).replace(/\/$/, "") === "/live"
  if (live) {
    const r = parseLiveRoute(href)
    return {
      version: 1,
      kind: "live",
      live: r.live,
      time: {
        mode: r.from ? "fixed" : "relative",
        range: r.from ? "" : r.range,
        from: r.from ?? "",
        to: r.to ?? "",
      },
      filters: {
        service: r.service,
        search: r.search,
        errorsOnly: r.errorsOnly,
        minSeverity: r.minSeverity,
        traceId: "",
        limit: 50,
      },
      display,
    }
  }
  const r = parseRoute(href)
  if (r.error || (r.page !== "traces" && r.page !== "logs"))
    throw new Error("Only valid Traces, Logs, or Live queries can be saved.")
  return {
    version: 1,
    kind: r.page,
    live: false,
    time: {
      mode: r.range === "fixed" ? "fixed" : "relative",
      range: r.range === "fixed" ? "" : r.range,
      from: r.range === "fixed" ? r.filters.from : "",
      to: r.range === "fixed" ? r.filters.to : "",
    },
    filters: {
      service: r.filters.service,
      search: r.filters.search,
      errorsOnly: r.page === "traces" && r.filters.errorsOnly,
      minSeverity: r.page === "logs" ? r.filters.minSeverity : 0,
      traceId: r.filters.traceId,
      limit: r.filters.limit,
    },
    display: { headers: false, follow: false, autoExpand: false },
  }
}
export function viewHref(value: unknown, projectId: string, now = Date.now()): string {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(projectId))
    throw new Error("Invalid project.")
  const d = value as ViewDefinition
  if (
    d?.version !== 1 ||
    !["traces", "logs", "live"].includes(d.kind) ||
    typeof d.live !== "boolean" ||
    !d.time ||
    !d.filters ||
    !d.display
  )
    throw new Error("Unsupported saved view definition.")
  const keys = (v: object, allowed: string[]) =>
    Object.keys(v).every((key) => allowed.includes(key))
  if (
    !keys(d, ["version", "kind", "live", "time", "filters", "display"]) ||
    !keys(d.time, ["mode", "range", "from", "to"]) ||
    !keys(d.filters, ["service", "search", "errorsOnly", "minSeverity", "traceId", "limit"]) ||
    !keys(d.display, ["headers", "follow", "autoExpand"])
  )
    throw new Error("Unknown saved view fields.")
  if ([d.time, d.filters, d.display].some((v) => typeof v !== "object" || Array.isArray(v)))
    throw new Error("Invalid view objects.")
  const f = d.filters
  if (
    typeof f.service !== "string" ||
    typeof f.search !== "string" ||
    new TextEncoder().encode(f.service).length > 200 ||
    new TextEncoder().encode(f.search).length > 200 ||
    typeof f.errorsOnly !== "boolean" ||
    !Number.isInteger(f.limit) ||
    f.limit < 1 ||
    f.limit > 100 ||
    !Number.isInteger(f.minSeverity) ||
    f.minSeverity < 0 ||
    f.minSeverity > 24 ||
    typeof f.traceId !== "string" ||
    Object.values(d.display).some((v) => typeof v !== "boolean")
  )
    throw new Error("Invalid saved filters.")
  if (
    (d.kind === "traces" && (f.minSeverity || f.traceId)) ||
    (d.kind === "logs" && f.errorsOnly) ||
    (d.kind === "live" && f.traceId) ||
    (d.kind !== "live" && (d.live || Object.values(d.display).some(Boolean)))
  )
    throw new Error("Filters do not match this view.")
  if (d.time.mode === "fixed") {
    const from = timestampNs(d.time.from)
    const to = timestampNs(d.time.to)
    if (
      d.time.range ||
      from === null ||
      to === null ||
      to <= from ||
      to - from > 86_400_000_000_000n
    )
      throw new Error("Invalid fixed view window.")
  } else if (d.time.mode !== "relative" || d.time.from || d.time.to)
    throw new Error("Invalid view time mode.")
  let href: string
  if (d.kind === "live") {
    const route: LiveRoute = {
      service: f.service,
      search: f.search,
      errorsOnly: f.errorsOnly,
      minSeverity: f.minSeverity,
      live: d.live,
      range: d.time.mode === "relative" ? (d.time.range as LiveRoute["range"]) : "5m",
      ...(d.time.mode === "fixed" ? { from: d.time.from, to: d.time.to } : {}),
    }
    href = liveHref(route)
    href += `#${new URLSearchParams({ headers: d.display.headers ? "1" : "0", follow: d.display.follow ? "1" : "0", autoExpand: d.display.autoExpand ? "1" : "0" })}`
  } else {
    if (d.time.mode === "relative" && !Object.hasOwn(ranges, d.time.range))
      throw new Error("Unsupported view range.")
    const range = d.time.mode === "fixed" ? "fixed" : (d.time.range as keyof typeof ranges)
    href = routeHref({
      page: d.kind,
      traceId: "",
      error: "",
      range,
      filters: {
        ...f,
        ...(range === "fixed" ? { from: d.time.from, to: d.time.to } : relativeWindow(range, now)),
      },
    })
  }
  const url = new URL(href, "http://local")
  return `/projects/${projectId}/${d.kind}${url.search}${url.hash}`
}
