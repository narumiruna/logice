import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Log, Span, TraceSummary } from "./api"
import { App } from "./app"
import { Attributes, Notice } from "./components"
import { FilterForm } from "./filters"
import { LogList, LogRecord, TraceList } from "./lists"
import { filterResetHref, parseRoute } from "./telemetry"
import { ThemeProvider } from "./theme"
import { TraceDetail } from "./trace-detail"

const window = { from: "2026-10-22T10:00:00.123456789Z", to: "2026-10-22T11:00:00.987654321Z" }
const traceId = "1234567890abcdef1234567890abcdef"
const log: Log = {
  timestamp: window.from,
  traceId,
  spanId: "1234567890abcdef",
  serviceName: "checkout",
  severityText: "ERROR",
  severityNumber: 17,
  body: "Inventory unavailable <script>alert(1)</script>",
  resourceAttributes: { "service.name": "checkout" },
  attributes: { "error.message": "<img src=x onerror=alert(1)>" },
}
const span: Span = {
  traceId,
  spanId: "1234567890abcdef",
  parentSpanId: "",
  name: "GET /checkout",
  serviceName: "checkout",
  startTime: window.from,
  durationNs: "12500000",
  statusCode: 2,
  statusMessage: "Inventory unavailable",
  resourceAttributes: log.resourceAttributes,
  attributes: { "http.method": "GET" },
}
const trace: TraceSummary = {
  traceId,
  name: span.name,
  serviceName: span.serviceName,
  startTime: window.from,
  endTime: window.to,
  durationNs: span.durationNs,
  spanCount: 2,
  errorCount: 1,
}

describe("application shell", () => {
  it("renders without browser APIs or fetching on the server", () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
    try {
      const html = renderToStaticMarkup(
        <ThemeProvider>
          <App />
        </ThemeProvider>,
      )
      expect(html).toContain("Logice")
      expect(html).toContain("Local validation")
      expect(html).toContain("Validation project only")
      expect(html).toContain("Skip to content")
      expect(html).toContain("Loading traces")
      expect(html).toContain("No live polling")
      expect(html).not.toContain("not available yet")
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })

  it("renders accessible filter forms with relevant controls only", () => {
    const traces = renderToStaticMarkup(
      <FilterForm route={parseRoute("/traces?errorsOnly=true")} />,
    )
    expect(traces).toContain("Time range")
    expect(traces).toContain("Last 15 minutes")
    expect(traces).toContain("Last 24 hours")
    expect(traces).toContain("Errors only")
    expect(traces).toContain('name="errorsOnly"')
    expect(traces).not.toContain("Minimum severity")
    const logs = renderToStaticMarkup(
      <FilterForm route={parseRoute(`/logs?minSeverity=18&from=${window.from}&to=${window.to}`)} />,
    )
    expect(logs).toContain("Minimum severity")
    expect(logs).toContain("Severity ≥ 18")
    expect(logs).toContain("Fixed window")
    expect(logs).toContain("Trace ID")
    expect(logs).not.toContain("Errors only")
  })
})

describe("telemetry views", () => {
  it("renders trace-name links with the exact window and bounded statistics", () => {
    const html = renderToStaticMarkup(
      <TraceList result={{ items: [trace], hasMore: true }} window={window} />,
    )
    expect(html).toContain(">GET /checkout</a>")
    expect(html).toContain(
      `/traces/${traceId}?from=2026-10-22T10%3A00%3A00.123456789Z&amp;to=2026-10-22T11%3A00%3A00.987654321Z`,
    )
    expect(html).toContain("12.5 ms")
    expect(html).toContain("1 error")
    expect(html).toContain("Traces returned")
    expect(html).toContain("More records are available")
    expect(html).toContain("No total count is available")
    expect(html).toContain("Traces can be partial")
  })

  it("offers the same filter reset in the form and empty results only when filtered", () => {
    for (const page of ["traces", "logs"]) {
      const route = parseRoute(`/${page}?from=${window.from}&to=${window.to}&service=missing`)
      const resetHref = filterResetHref(route)
      const form = renderToStaticMarkup(<FilterForm route={route} />)
      const props = { result: { items: [], hasMore: false }, window, resetHref }
      const results = renderToStaticMarkup(
        page === "traces" ? <TraceList {...props} /> : <LogList {...props} />,
      )
      for (const html of [form, results]) {
        expect(html).toContain("Reset filters")
        expect(html).toContain(resetHref?.replaceAll("&", "&amp;"))
      }
      expect(renderToStaticMarkup(<FilterForm route={parseRoute(`/${page}`)} />)).not.toContain(
        "Reset filters",
      )
    }
  })

  it("renders empty states with Collector guidance, not fake records", () => {
    const traces = renderToStaticMarkup(
      <TraceList result={{ items: [], hasMore: false }} window={window} />,
    )
    const logs = renderToStaticMarkup(
      <LogList result={{ items: [], hasMore: false }} window={window} />,
    )
    expect(traces).toContain("No traces in this window")
    expect(logs).toContain("No logs in this window")
    for (const html of [traces, logs]) {
      expect(html).toContain("send OTLP traces and logs")
      expect(html).toContain("Collector")
      expect(html).not.toContain("More records are available")
      expect(html).not.toContain("GET /checkout")
    }
  })

  it("uses the returned log record for expandable details and escapes telemetry", () => {
    const html = renderToStaticMarkup(
      <LogList
        result={{ items: [log, { ...log, body: "Worker ready", traceId: "" }], hasMore: true }}
        window={window}
      />,
    )
    expect(html.match(/<details/g)).toHaveLength(2)
    expect(html).toContain("Show log details")
    expect(html).toContain("Hide log details")
    expect(html).toContain('data-label="Timestamp (UTC)"')
    expect(html).toContain('data-label="Severity"')
    expect(html).toContain("Worker ready")
    expect(html).toContain("Inventory unavailable &lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("Resource attributes")
    expect(html).toContain("Log attributes")
    expect(html).toContain("More records are available")
    expect(html).toContain(`/traces/${traceId}?from=`)
  })

  it("does not link absent, zero, or malformed trace IDs", () => {
    for (const invalid of ["", "0".repeat(32), "not-a-trace"]) {
      const html = renderToStaticMarkup(
        <LogRecord log={{ ...log, traceId: invalid }} window={window} />,
      )
      expect(html).not.toContain('href="/traces/')
    }
  })

  it("renders safe span expansion, parent relationships, and separate truncation notices", () => {
    const html = renderToStaticMarkup(
      <TraceDetail
        detail={{
          traceId,
          spans: [
            span,
            {
              ...span,
              spanId: "2222222222222222",
              parentSpanId: span.spanId,
              name: "SELECT inventory",
            },
          ],
          logs: [log],
          spansTruncated: true,
          logsTruncated: true,
        }}
        window={window}
      />,
    )
    expect(html).toContain("Window-bounded trace · possibly partial")
    expect(html).toContain("Span limit reached")
    expect(html).toContain("500 spans")
    expect(html).toContain("Correlated log limit reached")
    expect(html).toContain("200 correlated logs")
    expect(html).toContain("Parent span ID")
    expect(html).toContain('href="#span-1234567890abcdef"')
    expect(html).toContain("Resource attributes")
    expect(html).toContain("Span attributes")
    expect(html).toContain("Inventory unavailable")
    expect(html).toContain("SELECT inventory")
    expect(html).toContain("Relative timing")
    expect(html).not.toContain("<script>")
  })

  it("supports details containing only correlated logs", () => {
    const html = renderToStaticMarkup(
      <TraceDetail
        detail={{ traceId, spans: [], logs: [log], spansTruncated: false, logsTruncated: false }}
        window={window}
      />,
    )
    expect(html).toContain("No spans in this window")
    expect(html).toContain("Trace with correlated logs")
    expect(html).toContain("Correlated logs")
  })

  it("renders attribute values as text and supports missing attributes", () => {
    const html = renderToStaticMarkup(
      <Attributes title="Span attributes" values={{ "<script>": "<b>text</b>" }} />,
    )
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&lt;b&gt;text&lt;/b&gt;")
    expect(renderToStaticMarkup(<Attributes title="Resource attributes" values={{}} />)).toContain(
      "No attributes recorded",
    )
    expect(renderToStaticMarkup(<Notice title="Storage unavailable" tone="error" />)).toContain(
      'role="alert"',
    )
  })
})
