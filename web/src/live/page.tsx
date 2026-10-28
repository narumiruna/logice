import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TimeWindow } from "../api"
import { useI18n } from "../i18n"
import { Glyph } from "../preview/icons"
import { projectPath } from "../project-path"
import { SaveViewButton } from "../save-view-button"
import { AppShell } from "../shell"
import { captureView, liveDisplay } from "../view-definition"
import { LiveApiError, type LiveRecord, type LiveSnapshot } from "./api"
import { Histogram } from "./histogram"
import { Inspector } from "./inspector"
import { allRecordIds, buildTree, countNewRecords, flatten, matchingAncestorIds } from "./model"
import { DEFAULT_LIVE_ROUTE, type LiveRoute, liveHref, parseLiveRoute } from "./route"
import { LiveTree, type TreeHandle } from "./tree"
import { useLive } from "./use-live"
import "../preview/preview.css"
import "./live.css"

function readLocation(): { route: LiveRoute | null; error: string } {
  try {
    return { route: parseLiveRoute(window.location.href), error: "" }
  } catch (error) {
    return { route: null, error: error instanceof Error ? error.message : "Invalid Live URL" }
  }
}

export function LivePage() {
  const { t } = useI18n()
  const [location, setLocation] = useState(readLocation)
  useEffect(() => {
    const onPop = () => setLocation(readLocation())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  const navigate = useCallback((route: LiveRoute, replace = false) => {
    const href = `${liveHref(route)}${window.location.hash}`
    const validated = parseLiveRoute(new URL(href, window.location.origin).href)
    if (replace) window.history.replaceState(null, "", href)
    else window.history.pushState(null, "", href)
    setLocation({ route: validated, error: "" })
  }, [])
  return (
    <AppShell page="live" contentId="live-content">
      <div className="lp-root lv-root">
        {location.route ? (
          <LiveWorkspace route={location.route} navigate={navigate} />
        ) : (
          <main id="live-content" className="lv-invalid" tabIndex={-1}>
            <h1>{t("Invalid Live query")}</h1>
            <p>{t(location.error)}</p>
            <a href={projectPath("/live")}>{t("Reset Live view")}</a> ·{" "}
            <a href={projectPath("/traces")}>{t("Open traces")}</a>
          </main>
        )}
      </div>
    </AppShell>
  )
}

function LiveWorkspace({
  route,
  navigate,
}: {
  route: LiveRoute
  navigate: (route: LiveRoute, replace?: boolean) => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(route)
  const [formError, setFormError] = useState("")
  const [fixedFrom, setFixedFrom] = useState(route.from ?? "")
  const [fixedTo, setFixedTo] = useState(route.to ?? "")
  const fixedDirty = useRef(false)
  const [expanded, setExpanded] = useState(new Set<string>())
  const [autoExpand, setAutoExpand] = useState(() => liveDisplay().autoExpand)
  const [follow, setFollow] = useState(() => liveDisplay().follow)
  const [headers, setHeaders] = useState(() => liveDisplay().headers)
  const [arrivals, setArrivals] = useState(new Set<string>())
  const [pending, setPending] = useState(0)
  const [selected, setSelected] = useState<LiveRecord | null>(null)
  const selectionWindow = useRef<TimeWindow | null>(null)
  const treeHandle = useRef<TreeHandle>(null)
  const search = useRef<HTMLInputElement>(null)
  const previous = useRef<LiveSnapshot | null>(null)
  const onSnapshot = useCallback(
    (snapshot: LiveSnapshot) => {
      if (!route.live && (!route.from || !route.to))
        navigate({ ...route, from: snapshot.window.from, to: snapshot.window.to }, true)
    },
    [route, navigate],
  )
  const state = useLive(route, onSnapshot)
  const snapshot = state.snapshot
  const records = useMemo(
    () => (snapshot ? [...snapshot.spans, ...snapshot.logs, ...snapshot.context] : []),
    [snapshot],
  )
  const services = useMemo(
    () =>
      [...new Set([route.service, ...records.map((record) => record.serviceName)])]
        .filter(Boolean)
        .sort(),
    [records, route.service],
  )
  const model = useMemo(() => (snapshot ? buildTree(snapshot) : null), [snapshot])
  const forced = Boolean(route.service || route.search || route.errorsOnly || route.minSeverity)
  const forcedOpen = useMemo(
    () => (model && forced ? matchingAncestorIds(model) : new Set<string>()),
    [model, forced],
  )
  // Open new ancestors in the same render as their records. A passive-only
  // expansion update would temporarily hide an existing orphan and lose focus.
  const effectiveExpanded = useMemo(() => {
    const next = new Set(expanded)
    if (autoExpand && snapshot && previous.current !== snapshot) {
      const old = previous.current ? allRecordIds(previous.current) : new Set<string>()
      for (const record of [...snapshot.spans, ...snapshot.context])
        if (!old.has(record.id)) next.add(record.id)
    }
    return next
  }, [expanded, autoExpand, snapshot])
  const rows = useMemo(
    () => (model ? flatten(model, effectiveExpanded, forcedOpen) : []),
    [model, effectiveExpanded, forcedOpen],
  )
  useEffect(() => {
    setDraft(route)
    setFormError("")
  }, [route])
  useEffect(() => {
    if (!snapshot) return
    const ids = allRecordIds(snapshot)
    const before = previous.current
    const old = before ? allRecordIds(before) : new Set<string>()
    if (before !== snapshot) {
      setArrivals(new Set(before ? [...ids].filter((id) => !old.has(id)) : []))
      if (!follow && before)
        setPending((value) => Math.min(9999, value + countNewRecords(before, snapshot)))
    }
    setExpanded((value) => {
      const next = new Set([...value].filter((id) => ids.has(id)))
      if (autoExpand)
        for (const record of [...snapshot.spans, ...snapshot.context])
          if (!old.has(record.id)) next.add(record.id)
      return next
    })
    previous.current = snapshot
  }, [snapshot, follow, autoExpand])
  useEffect(() => {
    if (!arrivals.size) return
    const timer = window.setTimeout(() => setArrivals(new Set()), 1200)
    return () => window.clearTimeout(timer)
  }, [arrivals])
  useEffect(() => {
    if (snapshot && !fixedDirty.current) {
      setFixedFrom(snapshot.window.from)
      setFixedTo(snapshot.window.to)
    }
  }, [snapshot])
  useEffect(() => {
    if (selected && model?.byId.has(selected.id)) {
      const latest = model.byId.get(selected.id)
      if (latest && latest !== selected) setSelected(latest)
      if (snapshot) selectionWindow.current = snapshot.window
    }
  }, [model, selected, snapshot])
  useEffect(() => {
    if (
      state.error instanceof LiveApiError &&
      (state.error.status === 401 || state.error.status === 403 || state.error.status === 404)
    ) {
      setSelected(null)
      setExpanded(new Set())
      previous.current = null
      setPending(0)
    }
  }, [state.error])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        event.target instanceof HTMLElement &&
        !event.target.closest("input, textarea, select, dialog, [contenteditable]")
      ) {
        event.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [])
  function apply(next: LiveRoute) {
    try {
      const validated = parseLiveRoute(new URL(liveHref(next), window.location.origin).href)
      navigate(validated)
      setFormError("")
      return true
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Invalid query")
      return false
    }
  }
  function interval(window: TimeWindow) {
    apply({ ...route, live: false, from: window.from, to: window.to })
  }
  function toggleLive() {
    if (route.live)
      apply({
        ...route,
        ...snapshot?.filters,
        live: false,
        from: snapshot?.window.from,
        to: snapshot?.window.to,
      })
    else apply({ ...route, live: true, from: undefined, to: undefined })
  }
  function toggle(id: string) {
    setExpanded((value) => {
      const next = new Set(value)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function closeInspector() {
    const id = selected?.id
    setSelected(null)
    if (id) treeHandle.current?.focusRecord(id)
  }
  function resetView() {
    setExpanded(
      new Set(records.filter((record) => record.kind === "span").map((record) => record.id)),
    )
    setAutoExpand(true)
    setFollow(true)
    setHeaders(true)
    setPending(0)
    setSelected(null)
    fixedDirty.current = false
    apply({ ...DEFAULT_LIVE_ROUTE })
  }
  const queryDirty =
    draft.search !== route.search ||
    draft.service !== route.service ||
    draft.range !== route.range ||
    draft.minSeverity !== route.minSeverity ||
    draft.errorsOnly !== route.errorsOnly
  const receiving = route.live && (state.status === "live" || state.status === "empty")
  const truncated =
    snapshot &&
    (snapshot.spansTruncated ||
      snapshot.logsTruncated ||
      snapshot.contextTruncated ||
      snapshot.traceGroupsTruncated)
  const statusText =
    state.status === "retrying"
      ? "Retrying · stale data"
      : state.status === "suspended"
        ? "Suspended · tab hidden or offline"
        : state.status === "paused"
          ? snapshot
            ? "Paused"
            : "Paused before first result"
          : state.status === "loading"
            ? "Loading"
            : state.status === "empty"
              ? "Live · no stored matches"
              : state.status === "live"
                ? "Live · polling after each response"
                : "Updates stopped"
  return (
    <div
      className={selected ? "lv-workspace lv-with-inspector" : "lv-workspace"}
      data-live={receiving}
    >
      <main id="live-content" className="lp-main lv-main" tabIndex={-1}>
        <div className="lp-page-title">
          <div>
            <span className="lp-breadcrumb">
              {t("Explore")} <span>/</span> {t("Live")}
            </span>
            <h1>
              {t("Live")}{" "}
              <span className="lp-heading-caption">{t("Every event. In context.")}</span>
            </h1>
            <SaveViewButton
              definition={captureView(window.location.href, { headers, follow, autoExpand })}
            />
          </div>
          <div
            className="lp-live-meta lv-status"
            role="status"
            title={
              state.lastSuccess
                ? t("Last successful update {timestamp}", {
                    timestamp: new Date(state.lastSuccess).toISOString(),
                  })
                : t("No successful response yet")
            }
          >
            <strong>{t(statusText)}</strong>
            <span className={receiving ? "lp-connection-dot" : "lp-connection-dot paused"} />
          </div>
        </div>
        <form
          id="live-query"
          aria-label={t("Live filters")}
          className="lv-query lp-querybar"
          onSubmit={(event) => {
            event.preventDefault()
            const rangeChanged = draft.range !== route.range
            apply({
              ...draft,
              from: rangeChanged ? undefined : route.from,
              to: rangeChanged ? undefined : route.to,
            })
          }}
        >
          <label className="lv-search lp-search">
            <Glyph name="search" />
            <input
              ref={search}
              aria-label={t("Search live events")}
              placeholder={t("Search messages, trace or span IDs…")}
              value={draft.search}
              onChange={(event) => setDraft({ ...draft, search: event.target.value })}
            />
            <kbd>/</kbd>
            <button
              type="submit"
              className={queryDirty ? "lv-apply dirty" : "lv-apply"}
              aria-label={t("Apply filters")}
              title={t("Apply filters (Enter)")}
            >
              {t("Apply")}
            </button>
          </label>
          <label className="lv-service-control">
            <input
              aria-label={t("Service filter")}
              placeholder={t("All services")}
              list="live-services"
              value={draft.service}
              onChange={(event) => setDraft({ ...draft, service: event.target.value })}
              title={t("Exact service name. Suggestions come from the current results.")}
            />
            <datalist id="live-services">
              {services.map((service) => (
                <option key={service} value={service} />
              ))}
            </datalist>
          </label>
          <div className="lp-time-control">
            <Glyph name="clock" size={14} />
            <select
              aria-label={t("Time window")}
              value={draft.range}
              onChange={(event) =>
                setDraft({ ...draft, range: event.target.value as LiveRoute["range"] })
              }
            >
              <option value="1m">{t("Last 1 minute")}</option>
              <option value="5m">{t("Last 5 minutes")}</option>
              <option value="15m">{t("Last 15 minutes")}</option>
            </select>
          </div>
          <button
            type="button"
            className={receiving ? "lp-live-button active" : "lp-live-button"}
            aria-label={route.live ? t("Pause live updates") : t("Resume live updates")}
            aria-pressed={route.live}
            onClick={toggleLive}
          >
            <Glyph name={route.live ? "pause" : "play"} size={13} />
            <span className="lp-live-dot" />
            {route.live ? t("Live") : t("Paused")}
          </button>
        </form>
        <details className="lv-fixed">
          <summary>{t("Fixed UTC interval")}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (apply({ ...route, live: false, from: fixedFrom, to: fixedTo }))
                fixedDirty.current = false
            }}
          >
            <label>
              {t("From UTC")}
              <input
                aria-label={t("From UTC")}
                value={fixedFrom}
                onChange={(event) => {
                  fixedDirty.current = true
                  setFixedFrom(event.target.value)
                }}
              />
            </label>
            <label>
              {t("To UTC")}
              <input
                aria-label={t("To UTC")}
                value={fixedTo}
                onChange={(event) => {
                  fixedDirty.current = true
                  setFixedTo(event.target.value)
                }}
              />
            </label>
            <button type="submit">{t("Apply fixed interval")}</button>
            <span>{t("1 second–15 minutes · from inclusive, to exclusive")}</span>
          </form>
        </details>
        {formError && (
          <p role="alert" className="lv-warning">
            {t(formError)}
          </p>
        )}
        {snapshot && state.status === "loading" && (
          <p className="lv-warning">
            {t("Updating query · showing the previous response until the new request succeeds.")}
          </p>
        )}
        {state.error && (
          <div role="alert" className="lv-warning">
            <strong>{t("Telemetry could not be updated.")}</strong>{" "}
            {state.error instanceof LiveApiError &&
            /^Live request failed \(\d+\)\.$/.test(state.error.message)
              ? t("Live request failed ({status}).", { status: state.error.status })
              : t(state.error.message)}{" "}
            {snapshot && t("Showing the last successful response; it can be stale.")}{" "}
            <button type="button" onClick={state.refresh}>
              {t("Try again")}
            </button>
          </div>
        )}
        {snapshot && (
          <Histogram
            buckets={snapshot.histogram}
            window={snapshot.window}
            onSelect={interval}
            live={receiving}
          />
        )}
        {truncated && (
          <p className="lv-warning" role="status">
            {t(
              "Partial results: {limits}narrow the window or filters. Histogram counts are not limited by these row caps.",
              {
                limits: [
                  snapshot.spansTruncated ? t("span limit; ") : "",
                  snapshot.logsTruncated ? t("log limit; ") : "",
                  snapshot.contextTruncated ? t("context limit; ") : "",
                  snapshot.traceGroupsTruncated ? t("trace-group limit; ") : "",
                ].join(""),
              },
            )}
          </p>
        )}
        <div className="lp-feed-toolbar">
          <div className="lp-feed-actions">
            <button
              type="button"
              disabled={forced}
              onClick={() => {
                setExpanded(new Set())
                setAutoExpand(false)
              }}
            >
              <Glyph name="collapse" size={14} /> {t("Collapse all")}
            </button>
            <button
              type="button"
              disabled={forced}
              onClick={() =>
                setExpanded(
                  new Set(
                    records.filter((record) => record.kind === "span").map((record) => record.id),
                  ),
                )
              }
            >
              <Glyph name="expand" size={14} /> {t("Expand all")}
            </button>
            <span className="lp-toolbar-divider" />
            <label>
              <input
                type="checkbox"
                checked={draft.errorsOnly}
                onChange={(event) => setDraft({ ...draft, errorsOnly: event.target.checked })}
              />
              <span className="lp-error-dot" /> {t("Errors only")}
            </label>
            <select
              aria-label={t("Minimum log severity")}
              className="lv-severity"
              value={draft.minSeverity}
              onChange={(event) => setDraft({ ...draft, minSeverity: Number(event.target.value) })}
            >
              <option value={0}>{t("All severities")}</option>
              <option value={1}>{t("Trace+")}</option>
              <option value={5}>{t("Debug+")}</option>
              <option value={9}>{t("Info+")}</option>
              <option value={13}>{t("Warn+")}</option>
              <option value={17}>{t("Error+")}</option>
              <option value={21}>{t("Fatal+")}</option>
              {![0, 1, 5, 9, 13, 17, 21].includes(draft.minSeverity) && (
                <option value={draft.minSeverity}>
                  {t("Severity {severity}+", { severity: draft.minSeverity })}
                </option>
              )}
            </select>
          </div>
          <div className="lp-feed-options">
            <label>
              <input
                type="checkbox"
                checked={autoExpand}
                disabled={forced}
                onChange={(event) => setAutoExpand(event.target.checked)}
              />
              {t("Auto-expand")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={headers}
                onChange={(event) => setHeaders(event.target.checked)}
              />
              {t("Column headers")}
            </label>
            <button
              type="button"
              className="lp-icon-button"
              aria-label={t("Refresh")}
              title={t("Refresh stored events")}
              onClick={state.refresh}
            >
              <Glyph name="reset" size={14} />
            </button>
            <button
              type="button"
              className="lp-icon-button"
              aria-label={t("Reset view")}
              title={t("Reset filters and view. Stored telemetry is not deleted.")}
              onClick={resetView}
            >
              <Glyph name="layers" size={14} />
            </button>
          </div>
        </div>
        {queryDirty && (
          <div className="lv-query-pending">
            <span role="status">{t("Unapplied filter changes")}</span>
            <button className="lv-pending-apply" type="submit" form="live-query">
              {t("Apply changes")}
            </button>
            <button type="button" onClick={() => setDraft(route)}>
              {t("Discard changes")}
            </button>
          </div>
        )}
        {forced && (
          <div className="lv-filter-context">
            <span>
              {t("Filters keep matching paths open. Context ancestors do not count as matches.")}
            </span>
            <button
              type="button"
              onClick={() =>
                apply({ ...route, search: "", service: "", errorsOnly: false, minSeverity: 0 })
              }
            >
              {t("Reset filters")}
            </button>
          </div>
        )}
        <LiveTree
          ref={treeHandle}
          rows={rows}
          selected={selected?.id ?? null}
          expanded={effectiveExpanded}
          forcedOpen={forcedOpen}
          follow={follow}
          headers={headers}
          window={snapshot?.window ?? null}
          scaleNs={model?.scaleNs ?? 0n}
          arrivals={arrivals}
          empty={
            <div className="lp-empty">
              <Glyph name={state.status === "loading" ? "activity" : "search"} size={24} />
              <strong>
                {snapshot
                  ? t("No matching events")
                  : state.status === "loading"
                    ? t("Loading stored events")
                    : t("No stored results yet")}
              </strong>
              <p>
                {snapshot
                  ? t("Change the filters or send telemetry through your Collector.")
                  : t("Refresh or resume Live to read stored telemetry.")}
              </p>
            </div>
          }
          footer={
            <div className="lv-feed-footer lp-feed-footer">
              <span
                title={
                  state.lastSuccess
                    ? t("Last successful update {timestamp}", {
                        timestamp: new Date(state.lastSuccess).toISOString(),
                      })
                    : t("No successful response yet")
                }
              >
                <span className={receiving ? "lp-footer-dot" : "lp-footer-dot paused"} />
                {receiving
                  ? t("Polling stored events")
                  : !route.live
                    ? t("Updates paused")
                    : state.status === "suspended"
                      ? t("Updates suspended")
                      : state.status === "retrying"
                        ? t("Retry scheduled")
                        : state.status === "loading"
                          ? t("Reading stored events")
                          : t("Updates stopped")}
                {state.lastSuccess && (
                  <>
                    <span className="lp-footer-separator">·</span>
                    <time className="lp-mono" dateTime={new Date(state.lastSuccess).toISOString()}>
                      {new Date(state.lastSuccess).toISOString().slice(11, 19)} UTC
                    </time>
                  </>
                )}
              </span>
              <span>
                {t("{count} rows shown", { count: rows.length })}{" "}
                <span className="lp-footer-separator">·</span>
                <label>
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(event) => {
                      setFollow(event.target.checked)
                      if (event.target.checked) setPending(0)
                    }}
                  />
                  {t("Follow latest")}
                </label>
              </span>
            </div>
          }
          onFollow={(value) => {
            setFollow(value)
            if (value) setPending(0)
          }}
          onToggle={toggle}
          onSelect={(record) => {
            selectionWindow.current = snapshot?.window ?? null
            setSelected(record)
          }}
        />
        {!follow && pending > 0 && (
          <button
            type="button"
            className="lv-new-events"
            onClick={() => {
              setFollow(true)
              setPending(0)
            }}
          >
            <Glyph name="arrow-down" size={14} />{" "}
            {t("{count} newly visible records · Jump to latest", {
              count: `${pending}${pending === 9999 ? "+" : ""}`,
            })}
          </button>
        )}
        <footer className="lv-note lp-bottom-note">
          <span className="lp-keyboard-hint">
            <kbd>/</kbd> {t("search")} <span>·</span> <kbd>{t("esc")}</kbd> {t("close details")}{" "}
            <span>·</span> {t("↑ ↓ navigate")}
          </span>
          <span
            title={t(
              "Bounded window polling. Identical stored content is grouped. No delivery or trace completeness guarantee.",
            )}
          >
            {t("Real telemetry")} <span>·</span> {t("Stored records")} <span>·</span>{" "}
            {t("Completeness unknown")}
          </span>
        </footer>
      </main>
      {selected && snapshot && (
        <Inspector
          record={selected}
          window={selectionWindow.current ?? snapshot.window}
          outside={!model?.byId.has(selected.id)}
          onClose={closeInspector}
        />
      )}
    </div>
  )
}
