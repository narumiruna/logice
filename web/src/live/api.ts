import { ApiError, type TimeWindow } from "../api"
import { isTraceId, timestampNs } from "../telemetry"
import { type LiveRoute, liveQuery, validateWindow } from "./route"

export type { LiveFilters } from "./route"
export type LiveWindow = TimeWindow
export const MAX_LIVE_BYTES = 4 * 1024 * 1024
export const LIVE_TIMEOUT_MS = 8000
export const LIVE_LIMITS = { spans: 500, logs: 500, context: 500, traceGroups: 100 } as const

export interface LiveRecord {
  id: string
  kind: "span" | "log"
  traceId: string
  spanId: string
  parentSpanId: string
  name: string
  serviceName: string
  startTime: string
  durationNs: string
  statusCode: string
  statusMessage: string
  severityText: string
  severityNumber: number
  body: string
  resourceAttributes: Record<string, string>
  attributes: Record<string, string>
  scopeName: string
  scopeVersion: string
  scopeAttributes: Record<string, string>
  resourceSchemaUrl: string
  scopeSchemaUrl: string
  traceFlags: number
  occurrences: string
  conflict: boolean
  parentConflict: boolean
  contextOnly: boolean
  stored: Record<string, unknown>
}
export interface LiveBucket extends TimeWindow {
  spans: string
  logs: string
  errorSpans: string
  errorLogs: string
}
export type Bucket = LiveBucket
export interface LiveSnapshot {
  window: LiveWindow
  queriedAt: string
  filters: { service: string; search: string; errorsOnly: boolean; minSeverity: number }
  spans: LiveRecord[]
  logs: LiveRecord[]
  context: LiveRecord[]
  histogram: LiveBucket[]
  spansTruncated: boolean
  logsTruncated: boolean
  contextTruncated: boolean
  traceGroupsTruncated: boolean
  limits: typeof LIVE_LIMITS
  completeness: "unknown"
}

export class LiveApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    code: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message, status, code)
    this.name = "LiveApiError"
  }
}
function invalid(): never {
  throw new LiveApiError("The Live API returned an invalid response.", 200, "invalid_response")
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return invalid()
  return value
}
function string(value: unknown): string {
  if (typeof value !== "string") return invalid()
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid()
  return value
}
function integer(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    return invalid()
  return value
}
function decimal(value: unknown, positive = false): string {
  const text = string(value)
  if (
    !/^(0|[1-9]\d{0,19})$/.test(text) ||
    BigInt(text) > 18_446_744_073_709_551_615n ||
    (positive && text === "0")
  )
    return invalid()
  return text
}
function time(value: unknown): string {
  const text = string(value)
  if (!text.endsWith("Z") || timestampNs(text) === null) return invalid()
  return text
}
function map(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).map(([key, item]) => [key, string(item)]))
}
function storedObject(value: unknown): Record<string, unknown> {
  const result = object(value)
  const stack: unknown[] = [result]
  const seen = new Set<object>()
  while (stack.length) {
    const item = stack.pop()
    if (item === null || typeof item === "string" || typeof item === "boolean") continue
    if (typeof item === "number" && Number.isFinite(item)) continue
    if (typeof item !== "object" || item === null || seen.has(item)) return invalid()
    seen.add(item)
    for (const value of Object.values(item)) stack.push(value)
  }
  return result
}
function record(
  value: unknown,
  kind: "span" | "log",
  contextOnly: boolean,
  from: bigint,
  to: bigint,
): LiveRecord {
  const item = object(value)
  const id = string(item.id)
  if (
    !id ||
    id.length > 512 ||
    /[^!-~]/.test(id) ||
    item.kind !== kind ||
    item.contextOnly !== contextOnly
  )
    return invalid()
  const startTime = time(item.startTime)
  const start = timestampNs(startTime)
  if (start === null || start < from || start >= to) return invalid()
  return {
    id,
    kind,
    contextOnly,
    traceId: string(item.traceId),
    spanId: string(item.spanId),
    parentSpanId: string(item.parentSpanId),
    name: string(item.name),
    serviceName: string(item.serviceName),
    startTime,
    durationNs: decimal(item.durationNs),
    statusCode: string(item.statusCode),
    statusMessage: string(item.statusMessage),
    severityText: string(item.severityText),
    severityNumber: integer(item.severityNumber, 255),
    body: string(item.body),
    resourceAttributes: map(item.resourceAttributes),
    attributes: map(item.attributes),
    scopeName: string(item.scopeName),
    scopeVersion: string(item.scopeVersion),
    scopeAttributes: map(item.scopeAttributes),
    resourceSchemaUrl: string(item.resourceSchemaUrl),
    scopeSchemaUrl: string(item.scopeSchemaUrl),
    traceFlags: integer(item.traceFlags, 0xffff_ffff),
    occurrences: decimal(item.occurrences, true),
    conflict: boolean(item.conflict),
    parentConflict: boolean(item.parentConflict),
    stored: storedObject(item.stored),
  }
}

export function validateLiveSnapshot(value: unknown): LiveSnapshot {
  const data = object(value)
  const bounds = object(data.window)
  const window = { from: time(bounds.from), to: time(bounds.to) }
  try {
    validateWindow(window)
  } catch {
    return invalid()
  }
  const from = timestampNs(window.from)
  const to = timestampNs(window.to)
  if (from === null || to === null) return invalid()
  const filters = object(data.filters)
  const service = string(filters.service)
  const search = string(filters.search)
  if ([service, search].some((value) => new TextEncoder().encode(value).length > 200))
    return invalid()
  const limits = object(data.limits)
  for (const [key, limit] of Object.entries(LIVE_LIMITS))
    if (limits[key] !== limit) return invalid()
  const rows = (value: unknown, kind: "span" | "log", context: boolean): LiveRecord[] => {
    if (!Array.isArray(value) || value.length > 500) return invalid()
    return value.map((item) => record(item, kind, context, from, to))
  }
  const spans = rows(data.spans, "span", false)
  const logs = rows(data.logs, "log", false)
  const context = rows(data.context, "span", true)
  const ids = new Set<string>()
  const traceIds = new Set<string>()
  for (const item of [...spans, ...logs, ...context]) {
    if (ids.has(item.id)) return invalid()
    ids.add(item.id)
    // Content-identified malformed spans are not trace groups and never
    // request context. Logs with a valid trace still consume a group slot.
    const validSpan = /^[a-f\d]{16}$/i.test(item.spanId) && !/^0{16}$/.test(item.spanId)
    if (isTraceId(item.traceId) && (item.kind === "log" || validSpan))
      traceIds.add(item.traceId.toLowerCase())
  }
  if (traceIds.size > 100) return invalid()
  if (!Array.isArray(data.histogram) || data.histogram.length !== 60) return invalid()
  const histogram = data.histogram.map((value, index): LiveBucket => {
    const item = object(value)
    const start = time(item.from)
    const end = time(item.to)
    if (
      timestampNs(start) !== from + (BigInt(index) * (to - from)) / 60n ||
      timestampNs(end) !== from + (BigInt(index + 1) * (to - from)) / 60n
    )
      return invalid()
    const spans = decimal(item.spans)
    const logs = decimal(item.logs)
    const errorSpans = decimal(item.errorSpans)
    const errorLogs = decimal(item.errorLogs)
    if (BigInt(errorSpans) > BigInt(spans) || BigInt(errorLogs) > BigInt(logs)) return invalid()
    return { from: start, to: end, spans, logs, errorSpans, errorLogs }
  })
  if (data.completeness !== "unknown") return invalid()
  return {
    window,
    queriedAt: time(data.queriedAt),
    filters: {
      service,
      search,
      errorsOnly: boolean(filters.errorsOnly),
      minSeverity: integer(filters.minSeverity, 24),
    },
    spans,
    logs,
    context,
    histogram,
    spansTruncated: boolean(data.spansTruncated),
    logsTruncated: boolean(data.logsTruncated),
    contextTruncated: boolean(data.contextTruncated),
    traceGroupsTruncated: boolean(data.traceGroupsTruncated),
    limits: { ...LIVE_LIMITS },
    completeness: "unknown",
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) return null
  if (/^\d+$/.test(value)) return Math.min(30_000, Math.max(2000, Number(value) * 1000))
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    return null
  const delay = Date.parse(value) - now
  return Number.isFinite(delay) ? Math.min(30_000, Math.max(2000, delay)) : null
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length")
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_LIVE_BYTES) {
    void response.body?.cancel().catch(() => {})
    throw new LiveApiError(
      "The Live API response is too large.",
      response.status,
      "response_too_large",
    )
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const chunks: string[] = []
  const decode = (value?: Uint8Array): string => {
    try {
      return decoder.decode(value, { stream: value !== undefined })
    } catch {
      throw new LiveApiError(
        "The Live API returned invalid UTF-8.",
        response.status,
        "invalid_response",
      )
    }
  }
  let size = 0
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    while (true) {
      const { value, done } = await reader.read()
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      if (done) break
      size += value.byteLength
      if (size > MAX_LIVE_BYTES)
        throw new LiveApiError(
          "The Live API response is too large.",
          response.status,
          "response_too_large",
        )
      chunks.push(decode(value))
    }
    chunks.push(decode())
    return chunks.join("")
  } finally {
    signal.removeEventListener("abort", abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** The polling owner supplies the eight-second deadline and cancellation signal. */
export async function fetchLive(
  route: LiveRoute,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LiveSnapshot> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError")
  const response = await fetcher(`/api/live?${liveQuery(route)}`, {
    signal,
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {})
    throw new DOMException("Aborted", "AbortError")
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    const status = response.status
    if (status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("logice:session-expired"))
    }
    const code =
      status === 400
        ? "invalid_query"
        : status === 422
          ? "response_too_large"
          : status === 404
            ? "unsupported_endpoint"
            : status === 401 || status === 403
              ? "access_denied"
              : status === 429
                ? "overloaded"
                : "unavailable"
    throw new LiveApiError(
      status === 404
        ? "This API does not support Live. Update the API and web application together."
        : `Live request failed (${status}).`,
      status,
      code,
      retryAfterMs(response.headers.get("retry-after")),
    )
  }
  const body = await readBounded(response, signal)
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new LiveApiError(
      "The Live API returned unreadable JSON.",
      response.status,
      "invalid_response",
    )
  }
  const snapshot = validateLiveSnapshot(value)
  if (
    snapshot.filters.service !== route.service ||
    snapshot.filters.search !== route.search ||
    snapshot.filters.errorsOnly !== route.errorsOnly ||
    snapshot.filters.minSeverity !== route.minSeverity
  )
    return invalid()
  if (
    route.from !== undefined &&
    route.to !== undefined &&
    (timestampNs(snapshot.window.from) !== timestampNs(route.from) ||
      timestampNs(snapshot.window.to) !== timestampNs(route.to))
  )
    return invalid()
  if (route.from === undefined) {
    const duration = route.range === "1m" ? 60n : route.range === "5m" ? 300n : 900n
    if (
      timestampNs(snapshot.window.to) !==
      (timestampNs(snapshot.window.from) ?? 0n) + duration * 1_000_000_000n
    )
      return invalid()
  }
  return snapshot
}
