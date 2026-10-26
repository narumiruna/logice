import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useI18n } from "../i18n"
import { AppShell } from "../shell"
import { Glyph } from "./icons"
import { formatDuration, PreviewInspector } from "./inspector"
import {
  advancePreview,
  createPreviewState,
  durationMs,
  flattenPreview,
  type PreviewEvent,
  type PreviewTrace,
} from "./model"
import "./preview.css"

const services = ["api", "worker", "postgres", "openai"]
const initialExpanded = (traces: PreviewTrace[]) =>
  new Set(
    traces
      .slice(-2)
      .flatMap((trace) =>
        trace.events.filter((event) => event.kind === "span").map((event) => event.id),
      ),
  )
const timeLabel = (time: number) => new Date(time).toISOString().slice(11, 19)

function Overview({
  traces,
  now,
  windowMs,
}: {
  traces: PreviewTrace[]
  now: number
  windowMs: number
}) {
  const { t } = useI18n()
  const buckets = Array.from({ length: 60 }, (_, slot) => ({ slot, count: 0, errors: 0 }))
  for (const event of traces.flatMap((trace) => trace.events)) {
    const index = Math.floor(((event.startMs - (now - windowMs)) / windowMs) * buckets.length)
    if (index >= 0 && index < buckets.length) {
      buckets[index].count += 1
      if (event.status === "error") buckets[index].errors += 1
    }
  }
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count))
  return (
    <section className="lp-overview" aria-label={t("Sample event volume over time")}>
      <div className="lp-overview-caption">
        <span>
          {t("Event volume")} <span className="lp-muted">{t("/ sample data")}</span>
        </span>
        <span className="lp-overview-now">
          <span /> {t("Now")}
        </span>
      </div>
      <svg
        className="lp-histogram"
        viewBox="0 0 960 43"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("Histogram of simulated events in the selected time window")}
      >
        <title>{t("Sample event volume")}</title>
        <rect x="880" y="0" width="80" height="43" fill="var(--chart-highlight)" />
        <line x1="0" x2="960" y1="42" y2="42" stroke="var(--color-border)" />
        {buckets.map((bucket) => (
          <g key={bucket.slot}>
            <rect
              x={bucket.slot * 16 + 3}
              y={42 - (bucket.count / max) * 34}
              width="10"
              height={(bucket.count / max) * 34}
              rx="1.5"
              fill={bucket.slot > 54 ? "var(--chart-accent)" : "var(--chart-primary)"}
            />
            <rect
              x={bucket.slot * 16 + 3}
              y={42 - (bucket.errors / max) * 34}
              width="10"
              height={(bucket.errors / max) * 34}
              rx="1.5"
              fill="var(--chart-error)"
            />
          </g>
        ))}
        <line x1="958" x2="958" y1="1" y2="43" stroke="var(--chart-accent)" strokeDasharray="2 3" />
      </svg>
      <div className="lp-time-axis">
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <span key={fraction}>{timeLabel(now - windowMs + windowMs * fraction)}</span>
        ))}
      </div>
    </section>
  )
}

export function LivePreview() {
  const { t } = useI18n()
  const [updatesBefore, updatesAfter] = t("{count} updates", { count: "\0" }).split("\0")
  const [session, setSession] = useState(() => createPreviewState(Date.now()))
  const [live, setLive] = useState(true)
  const [expanded, setExpanded] = useState(() => initialExpanded(session.traces))
  const [autoExpand, setAutoExpand] = useState(true)
  const [follow, setFollow] = useState(true)
  const [headers, setHeaders] = useState(true)
  const [windowMs, setWindowMs] = useState(300_000)
  const [search, setSearch] = useState("")
  const [service, setService] = useState("all")
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [selected, setSelected] = useState<PreviewEvent | null>(null)
  const [pending, setPending] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const lastSelection = useRef<HTMLButtonElement | null>(null)
  const knownIds = useRef(
    new Set(session.traces.flatMap((trace) => trace.events.map((event) => event.id))),
  )
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const traces = useMemo(
    () =>
      session.traces.filter((trace) =>
        trace.events.some((event) => event.startMs >= session.now - windowMs),
      ),
    [session, windowMs],
  )
  const rows = useMemo(
    () => flattenPreview(traces, expanded, { search, service, errorsOnly }),
    [traces, expanded, search, service, errorsOnly],
  )
  const allEvents = useMemo(() => session.traces.flatMap((trace) => trace.events), [session.traces])
  const forcedExpansion = Boolean(search.trim() || service !== "all" || errorsOnly)
  const currentSelection = selected
    ? (allEvents.find((event) => event.id === selected.id) ?? selected)
    : null
  const roots = useMemo(
    () => new Map(session.traces.map((trace) => [trace.events[0]?.traceId, trace.events[0]])),
    [session.traces],
  )
  const scaleMs = Math.max(
    5000,
    ...session.traces.map((trace) => durationMs(trace.events[0], session.now)),
  )

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setSession((value) => advancePreview(value))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [live])
  useEffect(() => {
    const newEvents = allEvents.filter((event) => !knownIds.current.has(event.id))
    knownIds.current = new Set(allEvents.map((event) => event.id))
    if (newEvents.length && !follow) setPending((value) => value + newEvents.length)
    const retained = knownIds.current
    setExpanded((value) => {
      const next = new Set([...value].filter((id) => retained.has(id)))
      if (autoExpand) for (const event of newEvents) if (event.kind === "span") next.add(event.id)
      return next.size === value.size && [...next].every((id) => value.has(id)) ? value : next
    })
  }, [allEvents, autoExpand, follow])
  useEffect(() => {
    if (!selected) return
    const latest = allEvents.find((event) => event.id === selected.id)
    if (latest && latest !== selected) setSelected(latest)
  }, [allEvents, selected])
  useEffect(() => {
    const shortcut = (key: KeyboardEvent) => {
      const target = key.target
      if (
        key.key === "/" &&
        target instanceof HTMLElement &&
        !target.closest("input, textarea, select, [contenteditable]")
      ) {
        key.preventDefault()
        searchInput.current?.focus()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [])
  const rememberAnchor = useCallback(() => {
    const pane = scroll.current
    if (!pane) return
    const top = pane.getBoundingClientRect().top
    const visible = Array.from(
      pane.querySelectorAll<HTMLTableRowElement>("tr[data-event-id]"),
    ).find((row) => row.getBoundingClientRect().top >= top + (headers ? 30 : 0))
    anchor.current = visible
      ? { id: visible.dataset.eventId ?? "", offset: visible.getBoundingClientRect().top - top }
      : null
  }, [headers])
  useLayoutEffect(() => {
    const pane = scroll.current
    if (!pane || rows.length === 0) return
    if (follow) {
      pane.scrollTop = pane.scrollHeight
      setPending(0)
    } else if (anchor.current) {
      const previous = anchor.current
      const row = Array.from(pane.querySelectorAll<HTMLTableRowElement>("tr[data-event-id]")).find(
        (item) => item.dataset.eventId === previous.id,
      )
      if (row)
        pane.scrollTop +=
          row.getBoundingClientRect().top - pane.getBoundingClientRect().top - previous.offset
    }
    rememberAnchor()
  }, [rows, follow, rememberAnchor])
  const closeInspector = useCallback(() => {
    setSelected(null)
    if (lastSelection.current?.isConnected) lastSelection.current.focus({ preventScroll: true })
  }, [])
  function toggle(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function reset() {
    const next = createPreviewState(Date.now())
    knownIds.current = new Set(
      next.traces.flatMap((trace) => trace.events.map((event) => event.id)),
    )
    setSession(next)
    setExpanded(initialExpanded(next.traces))
    setSelected(null)
    setPending(0)
    setFollow(true)
    setAutoExpand(true)
  }
  return (
    <AppShell page="preview" contentId="lp-content">
      <div className="lp-root" data-live={live}>
        <div className={currentSelection ? "lp-main-layout lp-with-inspector" : "lp-main-layout"}>
          <main className="lp-main" id="lp-content" tabIndex={-1}>
            <div className="lp-page-title">
              <div>
                <span className="lp-breadcrumb">
                  {t("Explore")} <span>/</span> {t("Live")}
                </span>
                <h1>
                  {t("Live")}{" "}
                  <span className="lp-heading-caption">{t("Every event. In context.")}</span>
                </h1>
              </div>
              <span className="lp-live-meta">
                {live ? t("Updating every second") : t("Updates paused")}
                <span className={live ? "lp-connection-dot" : "lp-connection-dot paused"} />
              </span>
            </div>
            <div className="lp-querybar">
              <label className="lp-search">
                <Glyph name="search" />
                <input
                  ref={searchInput}
                  aria-label={t("Filter sample events")}
                  placeholder={t("Search messages, services, or trace IDs…")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <kbd>/</kbd>
              </label>
              <select
                aria-label={t("Service filter")}
                className="lp-select"
                value={service}
                onChange={(event) => setService(event.target.value)}
              >
                <option value="all">{t("All services")}</option>
                {services.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <div className="lp-time-control">
                <Glyph name="clock" size={14} />
                <select
                  aria-label={t("Time window")}
                  value={windowMs}
                  onChange={(event) => setWindowMs(Number(event.target.value))}
                >
                  <option value="60000">{t("Last 1 minute")}</option>
                  <option value="300000">{t("Last 5 minutes")}</option>
                  <option value="900000">{t("Last 15 minutes")}</option>
                </select>
              </div>
              <button
                className={live ? "lp-live-button active" : "lp-live-button"}
                type="button"
                aria-label={live ? t("Pause live updates") : t("Resume live updates")}
                aria-pressed={live}
                onClick={() => setLive((value) => !value)}
              >
                <Glyph name={live ? "pause" : "play"} size={13} />
                <span className="lp-live-dot" />
                {live ? t("Live") : t("Paused")}
              </button>
            </div>
            <Overview traces={traces} now={session.now} windowMs={windowMs} />
            <div className="lp-feed-toolbar">
              <div className="lp-feed-actions">
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(new Set())
                    setAutoExpand(false)
                  }}
                >
                  <Glyph name="collapse" size={14} />
                  {t("Collapse all")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded(
                      new Set(
                        allEvents.filter((event) => event.kind === "span").map((event) => event.id),
                      ),
                    )
                  }
                >
                  <Glyph name="expand" size={14} />
                  {t("Expand all")}
                </button>
                <span className="lp-toolbar-divider" />
                <label>
                  <input
                    type="checkbox"
                    checked={errorsOnly}
                    onChange={(event) => setErrorsOnly(event.target.checked)}
                  />
                  <span className="lp-error-dot" />
                  {t("Errors only")}
                </label>
              </div>
              <div className="lp-feed-options">
                <label>
                  <input
                    type="checkbox"
                    checked={autoExpand}
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
                  className="lp-icon-button"
                  type="button"
                  onClick={reset}
                  aria-label={t("Reset demo")}
                  title={t("Reset simulated events")}
                >
                  <Glyph name="reset" size={14} />
                </button>
              </div>
            </div>
            <section className="lp-feed" aria-label={t("Unified live event tree")}>
              <div className="lp-day-divider">
                <span>{t("Recent events")}</span>
                <span>
                  {new Date(session.now).toISOString().slice(0, 10)}{" "}
                  <span className="lp-muted">UTC</span>
                </span>
                <span className="lp-day-rule" />
                <span className="lp-retained-count">
                  {t("{count} traces in window", { count: traces.length })}
                </span>
              </div>
              <div
                className="lp-feed-scroll"
                ref={scroll}
                onScroll={() => {
                  const pane = scroll.current
                  if (pane) setFollow(pane.scrollHeight - pane.scrollTop - pane.clientHeight < 28)
                  rememberAnchor()
                }}
              >
                <table className="lp-event-table" aria-label={t("Live telemetry events")}>
                  {headers && (
                    <thead>
                      <tr>
                        <th scope="col">
                          {t("Time")} <span>UTC</span>
                        </th>
                        <th scope="col">{t("Service")}</th>
                        <th scope="col">{t("Message")}</th>
                        <th scope="col" className="lp-timing-heading">
                          {t("Relative timing")} <span>0 — {formatDuration(scaleMs)}</span>
                        </th>
                        <th scope="col" className="lp-duration-heading">
                          {t("Duration")}
                        </th>
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {rows.map(({ event, depth, hasChildren, childCount }) => {
                      const root = roots.get(event.traceId)
                      const isExpanded = forcedExpansion || expanded.has(event.id)
                      const left = Math.max(
                        0,
                        Math.min(
                          99.5,
                          ((event.startMs - (root?.startMs ?? event.startMs)) / scaleMs) * 100,
                        ),
                      )
                      const width = Math.max(
                        0.7,
                        Math.min(100 - left, (durationMs(event, session.now) / scaleMs) * 100),
                      )
                      return (
                        <tr
                          key={event.id}
                          data-event-id={event.id}
                          data-event-kind={event.kind}
                          data-status={event.status}
                          className={[
                            currentSelection?.id === event.id ? "lp-selected" : "",
                            event.addedAtTick > 0 && session.tick - event.addedAtTick < 2
                              ? "lp-arrival"
                              : "",
                            !event.parentId ? "lp-root-row" : "",
                          ].join(" ")}
                        >
                          <td className="lp-event-time">
                            <time dateTime={new Date(event.startMs).toISOString()}>
                              {timeLabel(event.startMs)}
                            </time>
                          </td>
                          <td className="lp-service-cell">
                            <span className={`lp-service-chip lp-service-${event.service}`}>
                              <span />
                              {event.service}
                            </span>
                          </td>
                          <td className="lp-message-cell">
                            <div className="lp-tree-content" style={{ paddingLeft: depth * 20 }}>
                              <span
                                className="lp-tree-guides"
                                aria-hidden="true"
                                style={{ width: depth * 20 }}
                              />
                              {hasChildren ? (
                                <button
                                  className={
                                    isExpanded ? "lp-tree-toggle expanded" : "lp-tree-toggle"
                                  }
                                  type="button"
                                  aria-label={
                                    isExpanded
                                      ? t("Collapse {message}", { message: event.message })
                                      : t("Expand {message}", { message: event.message })
                                  }
                                  aria-expanded={isExpanded}
                                  disabled={forcedExpansion}
                                  title={
                                    forcedExpansion
                                      ? t("Filters keep matching paths expanded")
                                      : t("{childCount} direct children", {
                                          childCount: childCount,
                                        })
                                  }
                                  onClick={() => toggle(event.id)}
                                >
                                  <Glyph name="chevron" size={10} />
                                  <span>{childCount}</span>
                                </button>
                              ) : (
                                <span
                                  className={`lp-event-marker ${event.kind} ${event.level} ${event.status}`}
                                  aria-hidden="true"
                                />
                              )}
                              <button
                                type="button"
                                className={`lp-event-message ${event.kind} ${event.level}`}
                                aria-label={t("Inspect {message}", { message: event.message })}
                                aria-pressed={currentSelection?.id === event.id}
                                onClick={(click) => {
                                  lastSelection.current = click.currentTarget
                                  setSelected(event)
                                }}
                              >
                                {event.message}
                              </button>
                              {event.status === "running" && (
                                <span className="lp-running-label">
                                  <span />
                                  {t("running")}
                                </span>
                              )}
                              {event.status === "error" && (
                                <span className="lp-row-error">{t("error")}</span>
                              )}
                            </div>
                          </td>
                          <td className="lp-event-timing">
                            <span className="lp-bar-track">
                              {event.kind === "span" ? (
                                <span
                                  className={`lp-duration-bar ${event.status}`}
                                  style={{ left: `${left}%`, width: `${width}%` }}
                                />
                              ) : (
                                <span
                                  className={`lp-log-tick ${event.level}`}
                                  style={{ left: `${left}%` }}
                                />
                              )}
                            </span>
                          </td>
                          <td className="lp-event-duration">
                            {event.kind === "span" ? (
                              formatDuration(durationMs(event, session.now))
                            ) : (
                              <span className="lp-duration-dash">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {rows.length === 0 && (
                  <div className="lp-empty">
                    <Glyph name="search" size={24} />
                    <strong>{t("No matching events")}</strong>
                    <p>{t("Try another message, service, or time window.")}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("")
                        setService("all")
                        setErrorsOnly(false)
                      }}
                    >
                      {t("Reset filters")}
                    </button>
                  </div>
                )}
              </div>
              {!follow && pending > 0 && (
                <button type="button" className="lp-new-events" onClick={() => setFollow(true)}>
                  <Glyph name="arrow-down" size={14} />
                  {t("{count} new events · Jump to latest", { count: pending })}
                </button>
              )}
              <div className="lp-feed-footer">
                <span>
                  <span className={live ? "lp-footer-dot" : "lp-footer-dot paused"} />
                  {live ? t("Receiving simulated events") : t("Simulation paused")}
                  <span className="lp-footer-separator">·</span>
                  {updatesBefore}
                  <span className="lp-mono" data-testid="preview-tick">
                    {session.tick}
                  </span>
                  {updatesAfter}
                </span>
                <span>
                  {t("{count} rows shown", { count: rows.length })}{" "}
                  <span className="lp-footer-separator">·</span>
                  <label>
                    <input
                      type="checkbox"
                      checked={follow}
                      onChange={(event) => setFollow(event.target.checked)}
                    />
                    {t("Follow latest")}
                  </label>
                </span>
              </div>
            </section>
            <div className="lp-bottom-note">
              <span className="lp-keyboard-hint">
                <kbd>/</kbd> {t("search")} <span>·</span> <kbd>{t("esc")}</kbd> {t("close details")}
              </span>
              <span>
                {t("Design preview")} <span>·</span> {t("Sample data only")} <span>·</span>{" "}
                {t("Up to 24 traces retained")}
              </span>
            </div>
          </main>
          {currentSelection && (
            <PreviewInspector event={currentSelection} now={session.now} onClose={closeInspector} />
          )}
        </div>
      </div>
    </AppShell>
  )
}
