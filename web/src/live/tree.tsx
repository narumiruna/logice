// biome-ignore-all lint/a11y/useSemanticElements: Virtualization requires positioned ARIA treegrid rows and cells rather than native table layout.
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { TimeWindow } from "../api"
import { Glyph } from "../preview/icons"
import { formatDuration, isTraceId, severity, spanStatus } from "../telemetry"
import type { LiveRecord } from "./api"
import type { LiveRow } from "./model"

const height = 31
// The service color must not change when a response is reordered or filtered.
function serviceClass(name: string): string {
  let hash = 0
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0
  return ["", "lp-service-worker", "lp-service-postgres", "lp-service-openai"][hash % 4]
}
export interface TreeHandle {
  focusRecord: (id: string) => void
}
export const LiveTree = forwardRef<
  TreeHandle,
  {
    rows: LiveRow[]
    selected: string | null
    expanded: ReadonlySet<string>
    forced: boolean
    follow: boolean
    headers: boolean
    window: TimeWindow | null
    scaleNs: bigint
    arrivals: ReadonlySet<string>
    footer: ReactNode
    empty: ReactNode
    onFollow: (follow: boolean) => void
    onToggle: (id: string) => void
    onSelect: (record: LiveRecord) => void
  }
>(function LiveTree(
  {
    rows,
    selected,
    expanded,
    forced,
    follow,
    headers,
    window,
    scaleNs,
    arrivals,
    footer,
    empty,
    onFollow,
    onToggle,
    onSelect,
  },
  ref,
) {
  const scroll = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const elements = useRef(new Map<string, HTMLDivElement>())
  const [active, setActive] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const [viewportHeight, setViewportHeight] = useState(0)
  const anchor = useRef<{ id: string; index: number; offset: number } | null>(null)
  const previousRows = useRef(rows)
  const frame = useRef(0)
  const focusFrame = useRef(0)
  const programmatic = useRef(false)
  const ownedFocus = useRef<string | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => height,
    getItemKey: (index) => rows[index].record.id,
    overscan: 8,
  })
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element) return
    const measure = () => setViewportHeight(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const remember = useCallback(() => {
    const element = scroll.current
    if (!element || !rows.length) return
    const index = Math.min(rows.length - 1, Math.floor(element.scrollTop / height))
    anchor.current = {
      id: rows[index].record.id,
      index,
      offset: index * height - element.scrollTop,
    }
  }, [rows])
  const restoreMountedFocus = useCallback((id: string, element: HTMLDivElement) => {
    if (ownedFocus.current !== id || pendingFocus.current !== id) return
    const current = document.activeElement
    if (element.contains(current)) pendingFocus.current = null
    else if (current === document.body || grid.current?.contains(current)) {
      element.focus({ preventScroll: true })
      pendingFocus.current = null
    }
  }, [])
  function focusRecord(id: string) {
    const index = rows.findIndex((row) => row.record.id === id)
    if (index < 0) {
      ownedFocus.current = null
      pendingFocus.current = null
      grid.current?.focus({ preventScroll: true })
      return
    }
    setActive(id)
    ownedFocus.current = id
    pendingFocus.current = id
    programmatic.current = true
    virtual.scrollToIndex(index, { align: "auto" })
    elements.current.get(id)?.focus({ preventScroll: true })
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      const element = elements.current.get(id)
      if (element) restoreMountedFocus(id, element)
      programmatic.current = false
      remember()
      const pane = scroll.current
      if (pane) onFollow(pane.scrollHeight - pane.scrollTop - pane.clientHeight < 28)
    })
  }
  useImperativeHandle(ref, () => ({ focusRecord }))
  useEffect(() => {
    const cancelIntent = () => {
      ownedFocus.current = null
      pendingFocus.current = null
    }
    const outsideFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        event.target !== document.body &&
        event.target !== document.documentElement &&
        !grid.current?.contains(event.target)
      )
        cancelIntent()
    }
    const outsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !grid.current?.contains(event.target)) cancelIntent()
    }
    // A virtualized row can already be gone when outside focus arrives, so a
    // grid-local blur listener alone cannot cancel its pending restoration.
    document.addEventListener("focusin", outsideFocus, true)
    document.addEventListener("pointerdown", outsidePointer, true)
    return () => {
      document.removeEventListener("focusin", outsideFocus, true)
      document.removeEventListener("pointerdown", outsidePointer, true)
      cancelIntent()
      cancelAnimationFrame(frame.current)
      cancelAnimationFrame(focusFrame.current)
    }
  }, [])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element) return
    programmatic.current = true
    if (follow) element.scrollTop = Math.max(0, rows.length * height - viewportHeight)
    else if (anchor.current) {
      const old = anchor.current
      let index = rows.findIndex((row) => row.record.id === old.id)
      if (index < 0) {
        const ids = new Set(rows.map((row) => row.record.id))
        const before = previousRows.current
        let neighbor: string | undefined
        for (let distance = 1; distance < before.length && !neighbor; distance++) {
          for (const candidate of [before[old.index + distance], before[old.index - distance]]) {
            if (candidate && ids.has(candidate.record.id)) {
              neighbor = candidate.record.id
              break
            }
          }
        }
        index = neighbor
          ? rows.findIndex((row) => row.record.id === neighbor)
          : Math.min(old.index, rows.length - 1)
        setNotice(
          "Scroll anchor left the window or result limits. Showing the nearest retained row.",
        )
      }
      element.scrollTop = Math.max(0, index * height - old.offset)
    }
    previousRows.current = rows
    remember()
    // Reparenting can temporarily unmount a focused virtual row. Keep its
    // logical owner until that exact row mounts; frame counts are not a render
    // completion signal on a slower browser or under a controlled test clock.
    const lostFocus = ownedFocus.current
    if (lostFocus && document.activeElement === document.body) {
      if (!rows.some((row) => row.record.id === lostFocus)) {
        ownedFocus.current = null
        pendingFocus.current = null
        grid.current?.focus({ preventScroll: true })
      } else {
        pendingFocus.current = lostFocus
        const target = elements.current.get(lostFocus)
        if (target) restoreMountedFocus(lostFocus, target)
      }
    }
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      programmatic.current = false
    })
  }, [rows, follow, viewportHeight, remember, restoreMountedFocus])
  const forcedOpen = useMemo(() => {
    const result = new Set<string>()
    if (!forced) return result
    const parents = new Map(rows.map((row) => [row.record.id, row.parentId]))
    for (const row of rows) {
      if (row.record.contextOnly) continue
      let parent = row.parentId
      while (parent && !result.has(parent)) {
        result.add(parent)
        parent = parents.get(parent) ?? null
      }
    }
    return result
  }, [rows, forced])
  const effectiveActive = rows.some((row) => row.record.id === active) ? active : rows[0]?.record.id
  return (
    <section className="lv-feed lp-feed" aria-label="Unified live event tree">
      <div className="lp-day-divider">
        <span>Recent events</span>
        <span>{window ? `${window.from.slice(0, 10)} UTC` : "UTC"}</span>
        <span className="lp-day-rule" />
        <span className="lp-retained-count">
          {new Set(rows.map((row) => row.record.traceId).filter(isTraceId)).size} traces in window
        </span>
      </div>
      {notice && (
        <p className="lv-anchor-notice" role="status">
          {notice}{" "}
          <button type="button" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </p>
      )}
      <div
        ref={grid}
        className="lv-grid"
        role="treegrid"
        aria-label="Live telemetry events"
        aria-rowcount={rows.length + (headers ? 1 : 0)}
        aria-colcount={5}
        onFocusCapture={(event) => {
          const target =
            event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>("[data-event-id]")
              : null
          ownedFocus.current = target?.dataset.eventId ?? null
          pendingFocus.current = null
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.relatedTarget !== document.body &&
            event.relatedTarget !== document.documentElement &&
            !grid.current?.contains(event.relatedTarget)
          ) {
            ownedFocus.current = null
            pendingFocus.current = null
          }
        }}
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(
              event.key,
            )
          )
            return
          const index = Math.max(
            0,
            rows.findIndex((row) => row.record.id === effectiveActive),
          )
          const row = rows[index]
          if (!row) return
          event.preventDefault()
          switch (event.key) {
            case "ArrowDown":
              focusRecord(rows[Math.min(rows.length - 1, index + 1)].record.id)
              break
            case "ArrowUp":
              focusRecord(rows[Math.max(0, index - 1)].record.id)
              break
            case "Home":
              focusRecord(rows[0].record.id)
              break
            case "End":
              focusRecord(rows[rows.length - 1].record.id)
              break
            case "ArrowRight":
              if (row.hasChildren && !expanded.has(row.record.id) && !forcedOpen.has(row.record.id))
                onToggle(row.record.id)
              else if (rows[index + 1]?.parentId === row.record.id)
                focusRecord(rows[index + 1].record.id)
              break
            case "ArrowLeft":
              if (row.hasChildren && expanded.has(row.record.id) && !forcedOpen.has(row.record.id))
                onToggle(row.record.id)
              else if (row.parentId) focusRecord(row.parentId)
              break
            case "Enter":
              onSelect(row.record)
              break
          }
        }}
      >
        {headers && (
          <div role="row" tabIndex={-1} className="lv-row lv-grid-header">
            <span role="columnheader" tabIndex={-1}>
              Time <span className="lv-heading-unit">UTC</span>
            </span>
            <span role="columnheader" tabIndex={-1}>
              Service
            </span>
            <span role="columnheader" tabIndex={-1}>
              Message
            </span>
            <span role="columnheader" tabIndex={-1}>
              Relative timing{" "}
              <span className="lv-heading-unit">0 — {formatDuration(String(scaleNs))}</span>
            </span>
            <span role="columnheader" tabIndex={-1}>
              Duration
            </span>
          </div>
        )}
        <div
          className="lv-scroll"
          ref={scroll}
          role="rowgroup"
          onWheel={() => {
            programmatic.current = false
          }}
          onTouchStart={() => {
            programmatic.current = false
          }}
          onScroll={() => {
            const element = scroll.current
            if (element && !programmatic.current)
              onFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 28)
            remember()
          }}
        >
          {rows.length === 0 && empty}
          <div className="lv-virtual-space" style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index]
              const record = row.record
              const status =
                record.kind === "span" ? spanStatus(record.statusCode) : severity(record)
              return (
                <div
                  key={record.id}
                  ref={(element) => {
                    if (element) {
                      elements.current.set(record.id, element)
                      restoreMountedFocus(record.id, element)
                    } else {
                      if (ownedFocus.current === record.id) pendingFocus.current = record.id
                      elements.current.delete(record.id)
                    }
                  }}
                  role="row"
                  aria-rowindex={item.index + (headers ? 2 : 1)}
                  aria-level={row.depth + 1}
                  aria-selected={selected === record.id}
                  aria-expanded={
                    row.hasChildren
                      ? expanded.has(record.id) || forcedOpen.has(record.id)
                      : undefined
                  }
                  data-event-id={record.id}
                  data-event-kind={record.kind}
                  data-status={record.statusCode}
                  className={[
                    "lv-row lv-event-row",
                    selected === record.id ? "lv-selected" : "",
                    arrivals.has(record.id) ? "lv-arrival" : "",
                    !row.parentId ? "lv-root-row" : "",
                  ].join(" ")}
                  style={{ transform: `translateY(${item.start}px)`, height }}
                  tabIndex={-1}
                  onFocus={() => setActive(record.id)}
                >
                  <div role="gridcell" tabIndex={-1} className="lv-time" title={record.startTime}>
                    <time dateTime={record.startTime}>{record.startTime.slice(11, 19)}</time>
                  </div>
                  <div
                    role="gridcell"
                    tabIndex={-1}
                    className="lv-service"
                    title={record.serviceName}
                  >
                    <span className={`lp-service-chip ${serviceClass(record.serviceName)}`}>
                      <span aria-hidden="true" />
                      <span className="lv-service-name">
                        {record.serviceName || "Unknown service"}
                      </span>
                    </span>
                  </div>
                  <div
                    role="gridcell"
                    tabIndex={-1}
                    className="lv-message"
                    style={{ paddingLeft: Math.min(16, row.depth) * 20 }}
                  >
                    {row.depth > 0 && (
                      <span
                        className="lp-tree-guides"
                        aria-hidden="true"
                        style={{ width: Math.min(16, row.depth) * 20 }}
                      />
                    )}
                    {row.hasChildren ? (
                      <button
                        type="button"
                        className={`lv-toggle lp-tree-toggle ${expanded.has(record.id) || forcedOpen.has(record.id) ? "expanded" : ""}`}
                        tabIndex={-1}
                        disabled={forcedOpen.has(record.id)}
                        aria-expanded={expanded.has(record.id) || forcedOpen.has(record.id)}
                        aria-label={`${expanded.has(record.id) || forcedOpen.has(record.id) ? "Collapse" : "Expand"} ${record.name || record.body}`}
                        title={
                          forcedOpen.has(record.id)
                            ? "Filters keep matching paths expanded"
                            : `${row.childCount} direct children`
                        }
                        onClick={() => onToggle(record.id)}
                      >
                        <Glyph name="chevron" size={10} />
                        <span>{row.childCount}</span>
                      </button>
                    ) : (
                      <span
                        className={`lv-marker lp-event-marker ${record.kind} ${status.tone}`}
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`lv-message-button lp-event-message ${record.kind} ${record.kind === "log" ? status.tone : ""}`}
                      aria-pressed={selected === record.id}
                      title={record.name || record.body || "Empty record"}
                      aria-label={`Inspect ${record.name || record.body || "empty record"}`}
                      onClick={() => onSelect(record)}
                    >
                      {record.kind === "span"
                        ? record.name || "Unnamed span"
                        : record.body || "(Empty body)"}
                    </button>
                    {status.tone === "error" && <span className="lp-row-error">error</span>}
                    {record.kind === "log" && status.tone === "warning" && (
                      <span className="lv-tag lv-warning-tag">{status.label}</span>
                    )}
                    {record.contextOnly && <span className="lv-tag">Context</span>}
                    {record.conflict && <span className="lv-tag lv-error">Conflict</span>}
                    {BigInt(record.occurrences) > 1n && (
                      <span className="lv-tag" title="Stored occurrences, not a proven retry count">
                        ×{record.occurrences}
                      </span>
                    )}
                    {row.issue && (
                      <span className="lv-tag" title={row.issue}>
                        {row.issue}
                      </span>
                    )}
                  </div>
                  <div role="gridcell" tabIndex={-1} className="lv-timing">
                    <span
                      className="lv-track lp-bar-track"
                      title={
                        record.kind === "span"
                          ? `${record.durationNs} ns · ${status.label}`
                          : `${record.startTime} · ${status.label}`
                      }
                    >
                      <span
                        className={`${record.kind === "span" ? "lv-bar lp-duration-bar" : "lv-tick lp-log-tick"} ${status.tone}`}
                        style={{
                          left: `${Math.min(99.5, Math.max(0, row.offsetRatio) * 100)}%`,
                          width:
                            record.kind === "span"
                              ? `${Math.min(100 - Math.min(99.5, row.offsetRatio * 100), Math.max(0.5, row.durationRatio * 100))}%`
                              : undefined,
                        }}
                      />
                    </span>
                  </div>
                  <div role="gridcell" tabIndex={-1} className="lv-duration" title={status.label}>
                    {record.kind === "span" ? formatDuration(record.durationNs) : "—"}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {footer}
    </section>
  )
})
