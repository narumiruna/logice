import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TimeWindow } from "../api"
import { Glyph } from "../preview/icons"
import { LiveApiError, type LiveRecord, type LiveSnapshot } from "./api"
import { Histogram } from "./histogram"
import { Inspector } from "./inspector"
import { allRecordIds, buildTree, countNewRecords, flatten } from "./model"
import { type LiveRoute, liveHref, parseLiveRoute } from "./route"
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
  const [location, setLocation] = useState(readLocation)
  useEffect(() => {
    const onPop = () => setLocation(readLocation())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  const navigate = useCallback((route: LiveRoute, replace = false) => {
    const href = liveHref(route)
    const validated = parseLiveRoute(new URL(href, window.location.origin).href)
    if (replace) window.history.replaceState(null, "", href)
    else window.history.pushState(null, "", href)
    setLocation({ route: validated, error: "" })
  }, [])
  if (!location.route)
    return (
      <main className="lv-invalid">
        <h1>Invalid Live query</h1>
        <p>{location.error}</p>
        <a href="/live">Reset Live view</a> · <a href="/traces">Open traces</a>
      </main>
    )
  return <LiveWorkspace route={location.route} navigate={navigate} />
}

function LiveWorkspace({
  route,
  navigate,
}: {
  route: LiveRoute
  navigate: (route: LiveRoute, replace?: boolean) => void
}) {
  const [draft, setDraft] = useState(route)
  const [formError, setFormError] = useState("")
  const [fixedFrom, setFixedFrom] = useState(route.from ?? "")
  const [fixedTo, setFixedTo] = useState(route.to ?? "")
  const fixedDirty = useRef(false)
  const [expanded, setExpanded] = useState(new Set<string>())
  const [autoExpand, setAutoExpand] = useState(true)
  const [follow, setFollow] = useState(true)
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
  const model = useMemo(() => (snapshot ? buildTree(snapshot) : null), [snapshot])
  const forced = Boolean(route.service || route.search || route.errorsOnly || route.minSeverity)
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
    () => (model ? flatten(model, effectiveExpanded, forced) : []),
    [model, effectiveExpanded, forced],
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
    if (!follow && before)
      setPending((value) => Math.min(9999, value + countNewRecords(before, snapshot)))
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
      (state.error.status === 401 || state.error.status === 403)
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
    <div className="lp-root lv-root">
      <a href="#live-content" className="lp-skip">
        Skip to live events
      </a>
      <header className="lp-topbar">
        <a className="lp-brand" href="/live">
          <span className="lp-brand-symbol">L</span>Logice
        </a>
        <span className="lp-workspace-name">Local validation / Live</span>
        <span className="lp-topbar-spacer" />
        <span className="lp-preview-badge">REAL TELEMETRY · LOCAL ONLY</span>
      </header>
      <div className="lp-shell">
        <aside className="lp-sidebar" aria-label="Application navigation">
          <div className="lp-project-selector">
            <Glyph name="box" />
            <div>
              <span className="lp-section-label">PROJECT</span>
              <strong>Local validation</strong>
              <span className="lp-environment">Fixed trusted project</span>
            </div>
          </div>
          <nav>
            <a href="/live" className="lp-nav-item lp-nav-active" aria-current="page">
              <Glyph name="activity" />
              Live
            </a>
            <a href="/traces" className="lp-nav-item">
              <Glyph name="layers" />
              Traces
            </a>
            <a href="/logs" className="lp-nav-item">
              <Glyph name="code" />
              Logs
            </a>
            <a href="/preview" className="lp-nav-item">
              Design preview · simulated
            </a>
          </nav>
          <div className="lp-sidebar-bottom">
            <strong>Stored OpenTelemetry data</strong>
            <p>Completed exports, not running-span streaming. Keep this stack on loopback.</p>
          </div>
        </aside>
        <div className="lv-workspace">
          <main id="live-content" className="lp-main lv-main" tabIndex={-1}>
            <div className="lp-page-title">
              <div>
                <span className="lp-breadcrumb">Explore / Live</span>
                <h1>
                  Live <span className="lp-heading-caption">Traces and logs. In context.</span>
                </h1>
              </div>
              <button
                type="button"
                className={route.live ? "lp-live-button active" : "lp-live-button"}
                aria-label={route.live ? "Pause live updates" : "Resume live updates"}
                aria-pressed={route.live}
                onClick={toggleLive}
              >
                <Glyph name={route.live ? "pause" : "play"} />
                {route.live ? "Live" : "Paused"}
              </button>
            </div>
            <form
              className="lv-query"
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
              <label className="lv-search">
                <Glyph name="search" />
                <input
                  ref={search}
                  aria-label="Search live events"
                  placeholder="Messages, trace or span IDs…"
                  value={draft.search}
                  onChange={(event) => setDraft({ ...draft, search: event.target.value })}
                />
              </label>
              <label>
                Service
                <input
                  aria-label="Service filter"
                  placeholder="Exact service name"
                  value={draft.service}
                  onChange={(event) => setDraft({ ...draft, service: event.target.value })}
                />
              </label>
              <label>
                Window
                <select
                  aria-label="Time window"
                  value={draft.range}
                  onChange={(event) =>
                    setDraft({ ...draft, range: event.target.value as LiveRoute["range"] })
                  }
                >
                  <option value="1m">Last 1 minute</option>
                  <option value="5m">Last 5 minutes</option>
                  <option value="15m">Last 15 minutes</option>
                </select>
              </label>
              <label>
                Log severity
                <select
                  aria-label="Minimum log severity"
                  value={draft.minSeverity}
                  onChange={(event) =>
                    setDraft({ ...draft, minSeverity: Number(event.target.value) })
                  }
                >
                  <option value={0}>All severities</option>
                  <option value={5}>Debug+</option>
                  <option value={9}>Info+</option>
                  <option value={13}>Warn+</option>
                  <option value={17}>Error+</option>
                  <option value={21}>Fatal+</option>
                </select>
              </label>
              <label className="lv-checkbox">
                <input
                  type="checkbox"
                  checked={draft.errorsOnly}
                  onChange={(event) => setDraft({ ...draft, errorsOnly: event.target.checked })}
                />
                Errors only
              </label>
              <button type="submit" className="lv-apply">
                Apply filters
              </button>
              <button type="button" onClick={state.refresh}>
                Refresh
              </button>
            </form>
            <details className="lv-fixed">
              <summary>Fixed UTC interval</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (apply({ ...route, live: false, from: fixedFrom, to: fixedTo }))
                    fixedDirty.current = false
                }}
              >
                <label>
                  From UTC
                  <input
                    aria-label="From UTC"
                    value={fixedFrom}
                    onChange={(event) => {
                      fixedDirty.current = true
                      setFixedFrom(event.target.value)
                    }}
                  />
                </label>
                <label>
                  To UTC
                  <input
                    aria-label="To UTC"
                    value={fixedTo}
                    onChange={(event) => {
                      fixedDirty.current = true
                      setFixedTo(event.target.value)
                    }}
                  />
                </label>
                <button type="submit">Apply fixed interval</button>
                <span>1 second–15 minutes · from inclusive, to exclusive</span>
              </form>
            </details>
            {formError && (
              <p role="alert" className="lv-warning">
                {formError}
              </p>
            )}
            <div className="lv-status" role="status">
              <strong>{statusText}</strong>
              <span>
                {state.lastSuccess
                  ? `Last successful update ${new Date(state.lastSuccess).toISOString()}`
                  : "No successful response yet"}
              </span>
            </div>
            {snapshot && state.status === "loading" && (
              <p className="lv-warning">
                Updating query · showing the previous response until the new request succeeds.
              </p>
            )}
            {state.error && (
              <div role="alert" className="lv-warning">
                <strong>Telemetry could not be updated.</strong> {state.error.message}{" "}
                {snapshot && "Showing the last successful response; it can be stale."}{" "}
                <button type="button" onClick={state.refresh}>
                  Try again
                </button>
              </div>
            )}
            {snapshot && (
              <Histogram
                buckets={snapshot.histogram}
                window={snapshot.window}
                onSelect={interval}
              />
            )}
            {truncated && (
              <p className="lv-warning" role="status">
                Partial results: {snapshot.spansTruncated && "span limit; "}
                {snapshot.logsTruncated && "log limit; "}
                {snapshot.contextTruncated && "context limit; "}
                {snapshot.traceGroupsTruncated && "trace-group limit; "}narrow the window or
                filters. Histogram counts are not limited by these row caps.
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
                  Collapse all
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded(
                      new Set(
                        records
                          .filter((record) => record.kind === "span")
                          .map((record) => record.id),
                      ),
                    )
                  }
                >
                  Expand all
                </button>
                {forced && <span>Filters keep matching paths open</span>}
              </div>
              <div className="lp-feed-options">
                <label>
                  <input
                    type="checkbox"
                    checked={autoExpand}
                    onChange={(event) => setAutoExpand(event.target.checked)}
                  />
                  Auto-expand
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(event) => {
                      setFollow(event.target.checked)
                      if (event.target.checked) setPending(0)
                    }}
                  />
                  Follow latest
                </label>
              </div>
            </div>
            {snapshot && rows.length === 0 && (
              <div className="lp-empty">
                <strong>No matching events</strong>
                <p>Change the filters or send telemetry through your Collector.</p>
              </div>
            )}
            <LiveTree
              ref={treeHandle}
              rows={rows}
              selected={selected?.id ?? null}
              expanded={effectiveExpanded}
              forced={forced}
              follow={follow}
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
                {pending}
                {pending === 9999 ? "+" : ""} newly visible records · Jump to latest
              </button>
            )}
            <footer className="lv-note">
              Bounded window polling · Identical stored content is grouped · No
              delivery/completeness guarantee
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
      </div>
    </div>
  )
}
