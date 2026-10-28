import { useEffect, useRef, useState } from "react"
import { fetchList, type ListResult, type Log, type TraceSummary } from "./api"
import { useI18n } from "./i18n"
import { canManageTokens, type Project } from "./project-api"
import { ProjectOverview } from "./project-overview"
import { AppShell } from "./shell"
import { formatDuration, isTraceId, listHref, relativeWindow, traceHref } from "./telemetry"
import "./dashboard.css"

type DashboardRange = "15m" | "1h" | "24h"

export function ProjectDashboard({ project }: { project: Project }) {
  const { t, number } = useI18n()
  const [query, setQuery] = useState(() => ({
    service: "",
    range: "1h" as DashboardRange,
    window: relativeWindow("1h"),
  }))
  const [draftService, setDraftService] = useState("")
  const serviceInput = useRef<HTMLInputElement>(null)
  const [draftRange, setDraftRange] = useState<DashboardRange>("1h")
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<{
    traces: ListResult<TraceSummary>
    logs: ListResult<Log>
  } | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(true)
  const { service, window } = query
  const dirty = draftService.trim() !== service || draftRange !== query.range
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the same applied query.
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setData(null)
    setError("")
    const filters = {
      ...window,
      service,
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
  }, [window, service, revision])

  function load(nextService: string, range: DashboardRange) {
    setData(null)
    setError("")
    setBusy(true)
    setQuery({ service: nextService, range, window: relativeWindow(range) })
  }

  const base = `/projects/${project.id}`
  const listLink = (kind: "traces" | "logs") =>
    `${listHref(kind, window)}${service ? `&service=${encodeURIComponent(service)}` : ""}`
  return (
    <AppShell page="dashboard">
      <main id="main" tabIndex={-1} className="workspace-page dashboard-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">{t("{project} / Overview", { project: project.name })}</span>
            <h1>{t("Dashboard")}</h1>
            <p>{t("Investigate stored traces and logs for this project.")}</p>
          </div>
        </div>
        <form
          className="dashboard-query"
          aria-label={t("Dashboard filters")}
          onSubmit={(event) => {
            event.preventDefault()
            const nextService = draftService.trim()
            setDraftService(nextService)
            load(nextService, draftRange)
          }}
        >
          <label>
            {t("Service")}
            <input
              ref={serviceInput}
              aria-label={t("Dashboard service")}
              placeholder={t("All services (exact match)")}
              value={draftService}
              onChange={(e) => setDraftService(e.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            {t("Time range")}
            <select
              aria-label={t("Dashboard time range")}
              value={draftRange}
              onChange={(e) => setDraftRange(e.target.value as DashboardRange)}
            >
              <option value="15m">{t("Last 15 minutes")}</option>
              <option value="1h">{t("Last hour")}</option>
              <option value="24h">{t("Last 24 hours")}</option>
            </select>
          </label>
          <button className="button button-primary" type="submit">
            {t("Apply filters")}
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => load(service, query.range)}
          >
            {t("Refresh dashboard")}
          </button>
          {dirty && (
            <div className="dashboard-pending">
              <span role="status">{t("Unapplied filter changes")}</span>
              <button
                type="button"
                onClick={() => {
                  setDraftService(service)
                  setDraftRange(query.range)
                  serviceInput.current?.focus()
                }}
              >
                {t("Discard changes")}
              </button>
            </div>
          )}
        </form>
        <div className="dashboard-scope">
          <strong>{service ? `${t("Service")}: ${service}` : t("All services")}</strong>
          <span>{t("UTC window: {from} – {to}", { from: window.from, to: window.to })}</span>
        </div>
        <ProjectOverview
          key={`${window.from}:${window.to}:${service}`}
          window={window}
          service={service}
          project={project}
        />
        <p className="dashboard-sample-note">
          {t(
            "Up to 5 most recent matching records are shown below. Sample counts are not a project-wide error rate.",
          )}
        </p>
        {busy && (
          <p className="workspace-loading" role="status">
            {t("Loading dashboard…")}
          </p>
        )}
        {error && (
          <div className="workspace-error" role="alert">
            <h2>{t("Dashboard unavailable")}</h2>
            <p>{t(error)}</p>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              {t("Retry dashboard")}
            </button>
          </div>
        )}
        {data && (
          <section className="dashboard-grid" aria-label={t("Recent telemetry sample")}>
            <section className="dashboard-panel">
              <div className="dashboard-panel-heading">
                <div>
                  <h2>{t("Recent traces")}</h2>
                  <small>
                    {t("{count} sampled traces", {
                      count: `${number(data.traces.items.length)}${data.traces.hasMore ? "+" : ""}`,
                    })}
                  </small>
                </div>
                <a href={listLink("traces")}>
                  {t("View all traces")} <span aria-hidden="true">→</span>
                </a>
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
                        {trace.errorCount ? t("Error") : t("No recorded errors")}
                      </span>
                      <code>{formatDuration(trace.durationNs)}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dashboard-empty-records">
                  {t("No traces in this window. Send telemetry or select a wider time range.")}
                </p>
              )}
            </section>
            <section className="dashboard-panel">
              <div className="dashboard-panel-heading">
                <h2>{t("Recent logs")}</h2>
                <a href={listLink("logs")}>
                  {t("View all logs")} <span aria-hidden="true">→</span>
                </a>
              </div>
              {data.logs.items.length ? (
                <ul className="dashboard-records">
                  {data.logs.items.map((log, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: duplicate exported logs have no unique ID; these read-only rows have no local state.
                    <li key={`${log.timestamp}:${i}`}>
                      <div>
                        <p className="dashboard-message">{log.body}</p>
                        <small>
                          {log.serviceName} · {log.severityText || t("Unspecified severity")}
                        </small>
                      </div>
                      {isTraceId(log.traceId) && (
                        <a href={traceHref(log.traceId, window)}>{t("Open trace")}</a>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dashboard-empty-records">
                  {t("No logs in this window. Logs with trace IDs can link to their traces.")}
                </p>
              )}
            </section>
          </section>
        )}
        <aside className="dashboard-connect" aria-label={t("Connect application")}>
          <strong>{t("Send telemetry to this project")}</strong>
          <div>
            <a href={`${base}/setup`}>
              {t("Start project setup")} <span aria-hidden="true">→</span>
            </a>
            {canManageTokens(project.role) ? (
              <a href={`${base}/settings#tokens`}>{t("Manage ingestion tokens")}</a>
            ) : (
              <span>{t("Ask an Owner or Developer for an ingestion token.")}</span>
            )}
          </div>
        </aside>
      </main>
    </AppShell>
  )
}
