import type { FormEvent } from "react"
import { useState } from "react"
import { type Range, type Route, ranges, relativeWindow, routeHref } from "./telemetry"

export function FilterForm({ route }: { route: Route }) {
  const [range, setRange] = useState<Range>(route.range)
  const logs = route.page === "logs"
  const filters = route.filters
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const next = {
      ...route,
      range,
      filters: {
        ...filters,
        ...(range !== route.range && range !== "fixed" ? relativeWindow(range) : {}),
        service: String(data.get("service") ?? "").trim(),
        search: String(data.get("search") ?? ""),
        errorsOnly: data.get("errorsOnly") === "true",
        minSeverity: Number(data.get("minSeverity") ?? 0),
        traceId: String(data.get("traceId") ?? "").trim(),
      },
    }
    window.location.assign(routeHref(next))
  }
  return (
    <form
      className="filter-form"
      action={logs ? "/logs" : "/traces"}
      method="get"
      onSubmit={submit}
    >
      <input type="hidden" name="from" value={filters.from} />
      <input type="hidden" name="to" value={filters.to} />
      <input type="hidden" name="limit" value={filters.limit} />
      <div className="filter-fields">
        <label>
          Time range
          <select
            name="range"
            value={range}
            onChange={(event) => setRange(event.target.value as Range)}
          >
            {route.range === "fixed" && <option value="fixed">Fixed window</option>}
            {Object.entries(ranges).map(([value, item]) => (
              <option key={value} value={value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Service
          <input
            name="service"
            defaultValue={filters.service}
            placeholder="All services (exact match)"
            autoComplete="off"
          />
        </label>
        <label className="search-field">
          Search
          <input
            type="search"
            name="search"
            defaultValue={filters.search}
            placeholder={logs ? "Log body text" : "Span name or trace ID"}
          />
        </label>
        {logs ? (
          <label>
            Minimum severity
            <select name="minSeverity" defaultValue={filters.minSeverity}>
              {[
                [0, "All severities"],
                [1, "Trace"],
                [5, "Debug"],
                [9, "Info"],
                [13, "Warn"],
                [17, "Error"],
                [21, "Fatal"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              {![0, 1, 5, 9, 13, 17, 21].includes(filters.minSeverity) && (
                <option value={filters.minSeverity}>Severity ≥ {filters.minSeverity}</option>
              )}
            </select>
          </label>
        ) : (
          <label className="checkbox-field">
            <input
              type="checkbox"
              name="errorsOnly"
              value="true"
              defaultChecked={filters.errorsOnly}
            />
            Errors only
          </label>
        )}
        <button className="button button-primary" type="submit">
          Apply filters
        </button>
      </div>
      {logs && (
        <label className="trace-filter">
          Trace ID{" "}
          <input
            name="traceId"
            defaultValue={filters.traceId}
            placeholder="Optional · 32 hexadecimal digits"
            pattern="[a-fA-F0-9]{32}"
            maxLength={32}
            autoComplete="off"
          />
        </label>
      )}
      <div className="filter-note">
        Filters keep the current window. Refresh moves a relative window forward. No live polling.
      </div>
    </form>
  )
}
