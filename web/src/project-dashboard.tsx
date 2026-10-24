import { useEffect, useState } from "react"
import { fetchList, type ListResult, type Log, type TraceSummary } from "./api"
import { canManageTokens, type Project } from "./project-api"
import { AppShell } from "./shell"
import { formatDuration, isTraceId, listHref, relativeWindow, traceHref } from "./telemetry"

export function ProjectDashboard({ project }: { project: Project }) {
  const [range, setRange] = useState<"15m" | "1h" | "24h">("1h")
  const [window, setWindow] = useState(() => relativeWindow("1h"))
  const [data, setData] = useState<{
    traces: ListResult<TraceSummary>
    logs: ListResult<Log>
  } | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setData(null)
    setError("")
    const filters = {
      ...window,
      service: "",
      search: "",
      limit: 5,
      errorsOnly: false,
      minSeverity: 0,
      traceId: "",
    }
    void Promise.all([
      fetchList<TraceSummary>("traces", filters, controller.signal),
      fetchList<Log>("logs", filters, controller.signal),
    ])
      .then(([traces, logs]) => {
        if (!controller.signal.aborted) setData({ traces, logs })
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Dashboard data could not be loaded. Check project access or try again.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [window])
  const base = `/projects/${project.id}`
  return (
    <AppShell page="dashboard">
      <main id="main" tabIndex={-1} className="workspace-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">{project.name} / Overview</span>
            <h1>Dashboard</h1>
            <p>A recent sample of your project's stored traces and logs.</p>
          </div>
          <div className="dashboard-actions">
            <label>
              Time range
              <select
                aria-label="Dashboard time range"
                value={range}
                onChange={(e) => {
                  const next = e.target.value as typeof range
                  setRange(next)
                  setData(null)
                  setWindow(relativeWindow(next))
                }}
              >
                <option value="15m">Last 15 minutes</option>
                <option value="1h">Last hour</option>
                <option value="24h">Last 24 hours</option>
              </select>
            </label>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setData(null)
                setWindow(relativeWindow(range))
              }}
            >
              Refresh dashboard
            </button>
          </div>
        </div>
        <p className="dashboard-window">
          UTC window: <time>{window.from}</time> – <time>{window.to}</time>
        </p>
        <section className="dashboard-stats" aria-label="Recent telemetry sample">
          <article>
            <span>Traces in sample</span>
            <strong>
              {data ? `${data.traces.items.length}${data.traces.hasMore ? "+" : ""}` : "—"}
            </strong>
            <small>Up to 5 most recent matching traces</small>
          </article>
          <article>
            <span>Logs in sample</span>
            <strong>
              {data ? `${data.logs.items.length}${data.logs.hasMore ? "+" : ""}` : "—"}
            </strong>
            <small>Up to 5 most recent matching logs</small>
          </article>
          <article>
            <span>Error traces in sample</span>
            <strong>
              {data ? data.traces.items.filter((trace) => trace.errorCount > 0).length : "—"}
            </strong>
            <small>Not a project-wide error rate</small>
          </article>
        </section>
        {busy && (
          <p className="workspace-loading" role="status">
            Loading dashboard…
          </p>
        )}
        {error && (
          <div className="workspace-error" role="alert">
            <h2>Dashboard unavailable</h2>
            <p>{error}</p>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setWindow(relativeWindow(range))}
            >
              Retry dashboard
            </button>
          </div>
        )}
        {data && (
          <div className="dashboard-grid">
            <section className="settings-card">
              <div className="settings-card-heading">
                <h2>Recent traces</h2>
                <a href={listHref("traces", window)}>View all traces</a>
              </div>
              {data.traces.items.length ? (
                <ul className="dashboard-records">
                  {data.traces.items.map((trace) => (
                    <li key={trace.traceId}>
                      <div>
                        <a href={traceHref(trace.traceId, window)}>{trace.name || trace.traceId}</a>
                        <small>{trace.serviceName}</small>
                      </div>
                      <span
                        className={trace.errorCount ? "record-status is-error" : "record-status"}
                      >
                        {trace.errorCount ? "Error" : "No recorded errors"}
                      </span>
                      <code>{formatDuration(trace.durationNs)}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="workspace-empty">
                  No traces in this window. Send telemetry or select a wider time range.
                </p>
              )}
            </section>
            <section className="settings-card">
              <div className="settings-card-heading">
                <h2>Recent logs</h2>
                <a href={listHref("logs", window)}>View all logs</a>
              </div>
              {data.logs.items.length ? (
                <ul className="dashboard-records">
                  {data.logs.items.map((log, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: duplicate exported logs have no unique ID; these read-only rows have no local state.
                    <li key={`${log.timestamp}:${i}`}>
                      <div>
                        <p className="dashboard-message">{log.body}</p>
                        <small>
                          {log.serviceName} · {log.severityText || "Unspecified severity"}
                        </small>
                      </div>
                      {isTraceId(log.traceId) && (
                        <a href={traceHref(log.traceId, window)}>Open trace</a>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="workspace-empty">
                  No logs in this window. Logs with trace IDs can link to their traces.
                </p>
              )}
            </section>
          </div>
        )}
        <section className="settings-card ingestion-guide">
          <div>
            <span className="eyebrow">Connect your application</span>
            <h2>Send telemetry to this project</h2>
            <p>
              Use OTLP HTTP protobuf at the application origin. Project tokens allow writes only;
              browser sessions do not authorize ingestion.
            </p>
            <code>
              {typeof location === "undefined" ? "Logice application origin" : location.origin}
            </code>
          </div>
          <div>
            <a
              className="button button-primary"
              href={
                canManageTokens(project.role)
                  ? `${base}/settings#tokens`
                  : `${base}/settings#members`
              }
            >
              {canManageTokens(project.role) ? "Manage ingestion tokens" : "View project members"}
            </a>
            <a className="button button-secondary" href={`${base}/live`}>
              Open Live
            </a>
            {!canManageTokens(project.role) && (
              <p className="settings-hint">Ask an Owner or Developer for an ingestion token.</p>
            )}
          </div>
        </section>
      </main>
    </AppShell>
  )
}
