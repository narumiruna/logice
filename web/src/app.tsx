import { useEffect, useState } from "react"
import type { ListResult, Log, TraceDetail as TraceDetailData, TraceSummary } from "./api"
import { ApiError, fetchList, fetchTrace } from "./api"
import { LinkedMessage, Notice, WindowLabel } from "./components"
import { FilterForm } from "./filters"
import { useI18n } from "./i18n"
import { LogList, TraceList } from "./lists"
import { projectPath } from "./project-path"
import { SaveViewButton } from "./save-view-button"
import { AppShell } from "./shell"
import { filterResetHref, listHref, parseRoute, routeHref } from "./telemetry"
import { TraceDetail } from "./trace-detail"

type Result =
  | { kind: "loading" }
  | { kind: "error"; error: Error }
  | { kind: "traces"; result: ListResult<TraceSummary> }
  | { kind: "logs"; result: ListResult<Log> }
  | { kind: "detail"; result: TraceDetailData }

export function App() {
  const { t } = useI18n()
  // A browser is not required for the initial render or component tests.
  const [route] = useState(() =>
    parseRoute(typeof window === "undefined" ? "/traces" : window.location.href),
  )
  const [state, setState] = useState<Result>({ kind: "loading" })
  const detail = route.page === "detail"
  const logs = route.page === "logs"
  const valid = route.page !== "not-found" && !route.error
  const canonical = routeHref(route)
  const resetHref = filterResetHref(route)

  useEffect(() => {
    if (!valid) return
    // Pin the initial relative range so reloads and copied URLs retain the exact window.
    window.history.replaceState(null, "", canonical)
    const controller = new AbortController()
    let active = true
    setState({ kind: "loading" })
    async function load() {
      try {
        let result: Result
        if (route.page === "detail") {
          result = {
            kind: "detail",
            result: await fetchTrace(route.traceId, route.filters, controller.signal),
          }
        } else if (route.page === "logs") {
          result = {
            kind: "logs",
            result: await fetchList<Log>("logs", route.filters, controller.signal),
          }
        } else {
          result = {
            kind: "traces",
            result: await fetchList<TraceSummary>("traces", route.filters, controller.signal),
          }
        }
        if (active) setState(result)
      } catch (error) {
        if (active && !controller.signal.aborted) {
          setState({
            kind: "error",
            error: error instanceof Error ? error : new Error("Request failed."),
          })
        }
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [canonical, route, valid])

  function refresh() {
    // Full navigation also works with fixed windows, where this is a data-only refresh.
    window.location.assign(routeHref(route, true))
  }

  const title = detail
    ? "Trace detail"
    : logs
      ? "Logs"
      : route.page === "not-found"
        ? "Page not found"
        : "Traces"
  return (
    <AppShell
      page={route.page === "not-found" ? undefined : logs ? "logs" : "traces"}
      tracesHref={listHref("traces", route.filters)}
      logsHref={listHref("logs", route.filters)}
    >
      <main id="main" tabIndex={-1}>
        {detail && (
          <a className="back-link" href={listHref("traces", route.filters)}>
            {t("← Back to traces")}
          </a>
        )}
        <div className="page-heading">
          <div>
            <span className="eyebrow">{t("Telemetry explorer")}</span>
            <h1>{t(title)}</h1>
            <p>
              {detail
                ? t("Inspect span relationships and correlated log records.")
                : logs
                  ? t("Search application logs and inspect the records behind each message.")
                  : t("Find requests, inspect errors, and follow work across services.")}
            </p>
          </div>
          {valid && (
            <button
              className="button button-secondary refresh-button"
              type="button"
              onClick={refresh}
            >
              <span aria-hidden="true">↻</span> {t("Refresh")}
            </button>
          )}
        </div>
        {valid && !detail && <SaveViewButton />}
        {route.page === "not-found" ? (
          <Notice title={t("This page does not exist")} tone="error">
            <LinkedMessage
              message="{traces} or {logs}."
              links={{
                traces: <a href={listHref("traces", route.filters)}>{t("Open traces")}</a>,
                logs: <a href={listHref("logs", route.filters)}>{t("open logs")}</a>,
              }}
            />
          </Notice>
        ) : route.error ? (
          <Notice title={t("Invalid query")} tone="error">
            <p>{t(route.error)}</p>
            <a href={projectPath(logs ? "/logs" : "/traces")}>{t("Reset to the last hour")}</a>
          </Notice>
        ) : (
          <>
            {!detail && <FilterForm route={route} />}
            <WindowLabel window={route.filters} />
            {state.kind === "loading" && (
              <div className="loading-state" role="status" aria-live="polite">
                <span className="loading-dot" aria-hidden="true" />
                <strong>
                  {detail
                    ? t("Loading trace detail…")
                    : logs
                      ? t("Loading logs…")
                      : t("Loading traces…")}
                </strong>
                <span>{t("Reading the selected time window.")}</span>
              </div>
            )}
            {state.kind === "error" && (
              <Notice
                title={
                  state.error instanceof ApiError && state.error.status === 404
                    ? t("Trace not found in this window")
                    : t("Telemetry could not be loaded")
                }
                tone="error"
              >
                <p>
                  {state.error instanceof ApiError
                    ? state.error.message === `Request failed (${state.error.status}).`
                      ? t("Request failed ({status}).", { status: state.error.status })
                      : t(state.error.message)
                    : t(
                        "Check your connection and try again. If the problem continues, contact your Logice operator.",
                      )}
                </p>
                {state.error instanceof ApiError && state.error.status === 404 && (
                  <p>
                    {t(
                      "No spans or correlated logs were found. This trace can exist outside the selected window.",
                    )}
                  </p>
                )}
                <button className="button button-secondary" type="button" onClick={refresh}>
                  {t("Try again")}
                </button>
              </Notice>
            )}
            {state.kind === "traces" && (
              <TraceList result={state.result} window={route.filters} resetHref={resetHref} />
            )}
            {state.kind === "logs" && (
              <LogList result={state.result} window={route.filters} resetHref={resetHref} />
            )}
            {state.kind === "detail" && (
              <TraceDetail detail={state.result} window={route.filters} />
            )}
          </>
        )}
        <footer className="page-footer">
          <span>{t("Project-scoped telemetry")}</span>
          <span>{t("UTC timestamps · No automatic refresh")}</span>
        </footer>
      </main>
    </AppShell>
  )
}
