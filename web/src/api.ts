export interface TimeWindow {
  from: string
  to: string
}

export interface ListFilters extends TimeWindow {
  service: string
  search: string
  limit: number
  errorsOnly: boolean
  minSeverity: number
  traceId: string
}

export interface TraceSummary {
  traceId: string
  name: string
  serviceName: string
  startTime: string
  endTime: string
  durationNs: string
  spanCount: number
  errorCount: number
}

export interface Span {
  traceId: string
  spanId: string
  parentSpanId: string
  name: string
  serviceName: string
  startTime: string
  durationNs: string
  statusCode: number | string
  statusMessage: string
  resourceAttributes: Record<string, string>
  attributes: Record<string, string>
}

export interface Log {
  timestamp: string
  traceId: string
  spanId: string
  serviceName: string
  severityText: string
  severityNumber: number
  body: string
  resourceAttributes: Record<string, string>
  attributes: Record<string, string>
}

export interface ListResult<T> {
  items: T[]
  hasMore: boolean
}

export interface TraceDetail {
  traceId: string
  spans: Span[]
  logs: Log[]
  spansTruncated: boolean
  logsTruncated: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export function windowParams(window: TimeWindow): URLSearchParams {
  return new URLSearchParams({ from: window.from, to: window.to })
}

export function listParams(kind: "traces" | "logs", filters: ListFilters): URLSearchParams {
  const params = windowParams(filters)
  if (filters.service) params.set("service", filters.service)
  if (filters.search) params.set("search", filters.search)
  params.set("limit", String(filters.limit))
  if (kind === "traces") {
    params.set("errorsOnly", String(filters.errorsOnly))
  } else {
    params.set("minSeverity", String(filters.minSeverity))
    if (filters.traceId) params.set("traceId", filters.traceId)
  }
  return params
}

export async function requestJSON<T>(
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(path, { signal, headers: { Accept: "application/json" } })
  if (response.status === 401) {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("logice:session-expired"))
    throw new ApiError("Your session expired. Sign in again.", 401, "session_expired")
  }
  // Do not expose storage internals, even if an upstream error contains them.
  if (response.status === 503) {
    throw new ApiError(
      "Telemetry storage is unavailable. Try again later.",
      503,
      "storage_unavailable",
    )
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new ApiError(
      "The API returned an unreadable response.",
      response.status,
      "invalid_response",
    )
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error
    throw new ApiError(
      typeof error?.message === "string" ? error.message : `Request failed (${response.status}).`,
      response.status,
      typeof error?.code === "string" ? error.code : "request_failed",
    )
  }
  return data as T
}

export async function fetchList<T>(
  kind: "traces" | "logs",
  filters: ListFilters,
  signal: AbortSignal,
): Promise<ListResult<T>> {
  const result = await requestJSON<ListResult<T>>(
    `/api/${kind}?${listParams(kind, filters)}`,
    signal,
  )
  if (!result || !Array.isArray(result.items) || typeof result.hasMore !== "boolean") {
    throw new ApiError("The API returned an invalid list.", 200, "invalid_response")
  }
  return result
}

export async function fetchTrace(
  traceId: string,
  window: TimeWindow,
  signal: AbortSignal,
): Promise<TraceDetail> {
  const result = await requestJSON<TraceDetail>(
    `/api/traces/${encodeURIComponent(traceId)}?${windowParams(window)}`,
    signal,
  )
  if (
    !result ||
    !Array.isArray(result.spans) ||
    !Array.isArray(result.logs) ||
    typeof result.spansTruncated !== "boolean" ||
    typeof result.logsTruncated !== "boolean"
  ) {
    throw new ApiError("The API returned an invalid trace.", 200, "invalid_response")
  }
  return result
}
