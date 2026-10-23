import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { TimeWindow } from "../api"
import { timestampNs } from "../telemetry"
import type { LiveBucket } from "./api"
import { formatTimestampNs, selectInterval } from "./route"
import "./histogram.css"

// The 60 positions stay fixed while rolling-window timestamps change.
const bucketSlots = Array.from({ length: 60 }, (_, slot) => slot)
const tickSlots = [0n, 1n, 2n, 3n, 4n]

type Drag = {
  pointerId: number
  first: number
  last: number
  buckets: LiveBucket[]
  window: TimeWindow
}

export function Histogram({
  buckets,
  window: timeWindow,
  onSelect,
  live = false,
}: {
  buckets: LiveBucket[]
  window: TimeWindow
  onSelect: (window: TimeWindow) => void
  live?: boolean
}) {
  const active = useRef<Drag | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const hintId = useId()
  // Keep the displayed data and selected timestamps together during a drag, even across polls.
  const shownBuckets = drag?.buckets ?? buckets
  const shownWindow = drag?.window ?? timeWindow
  const total = shownBuckets.reduce((sum, b) => sum + BigInt(b.spans) + BigInt(b.logs), 0n)
  const maximum = shownBuckets.reduce((max, b) => {
    const count = BigInt(b.spans) + BigInt(b.logs)
    return count > max ? count : max
  }, 1n)
  const fromNs = timestampNs(shownWindow.from) ?? 0n
  const widthNs = (timestampNs(shownWindow.to) ?? 0n) - fromNs
  const cancel = useCallback(() => {
    const pointerId = active.current?.pointerId
    active.current = null
    setDrag(null)
    if (pointerId !== undefined && area.current?.hasPointerCapture(pointerId))
      area.current.releasePointerCapture(pointerId)
  }, [])
  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    function cancelOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    document.addEventListener("keydown", cancelOnEscape, true)
    window.addEventListener("blur", cancel)
    return () => {
      document.removeEventListener("keydown", cancelOnEscape, true)
      window.removeEventListener("blur", cancel)
    }
  }, [dragging, cancel])
  function select(
    a: number,
    b: number,
    selectedBuckets = shownBuckets,
    selectedWindow = shownWindow,
  ) {
    const from = selectedBuckets[Math.min(a, b)]?.from
    const to = selectedBuckets[Math.max(a, b)]?.to
    if (from && to) onSelect(selectInterval(selectedWindow, from, to))
  }
  function position(x: number) {
    const rect = area.current?.getBoundingClientRect()
    return rect && rect.width > 0
      ? Math.max(0, Math.min(59, Math.floor(((x - rect.left) / rect.width) * 60)))
      : 0
  }
  return (
    <section
      className="lp-overview lv-overview"
      aria-label="Stored event histogram"
      aria-describedby={hintId}
    >
      <div className="lp-overview-caption">
        <span>
          Stored event volume · <strong>{total.toString()}</strong> matching rows
        </span>
        <span>
          Includes identical stored content ·{" "}
          <span className="lv-hist-window" data-live={live && !drag}>
            {live && !drag ? "Now" : "Window end"} (UTC)
          </span>
        </span>
      </div>
      <div
        className="lv-histogram"
        data-live={live && !drag}
        ref={area}
        onPointerDown={(event) => {
          if (event.button !== 0 || active.current) return
          const first = position(event.clientX)
          const next = {
            pointerId: event.pointerId,
            first,
            last: first,
            buckets,
            window: timeWindow,
          }
          active.current = next
          setDrag(next)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const current = active.current
          if (!current || current.pointerId !== event.pointerId) return
          const last = position(event.clientX)
          if (last === current.last) return
          const next = { ...current, last }
          active.current = next
          setDrag(next)
        }}
        onPointerCancel={(event) => {
          if (active.current?.pointerId === event.pointerId) cancel()
        }}
        onLostPointerCapture={(event) => {
          if (active.current?.pointerId === event.pointerId) cancel()
        }}
        onPointerUp={(event) => {
          const current = active.current
          if (!current || current.pointerId !== event.pointerId) return
          cancel()
          select(current.first, position(event.clientX), current.buckets, current.window)
        }}
      >
        {bucketSlots.map((index) => {
          const bucket = shownBuckets[index]
          const count = BigInt(bucket.spans) + BigInt(bucket.logs)
          const errors = BigInt(bucket.errorSpans) + BigInt(bucket.errorLogs)
          const height = (Number(count) / Number(maximum)) * 90
          const errorHeight = (Number(errors) / Number(maximum)) * 90
          return (
            <button
              key={index}
              type="button"
              aria-label={`Select bucket ${index + 1}: ${bucket.from}, ${count} stored rows`}
              title={`${bucket.from} — ${bucket.to}\n${bucket.spans} spans · ${bucket.logs} logs · ${errors} errors`}
              onClick={(event) => {
                if (event.detail === 0 && !active.current) select(index, index)
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                event.preventDefault()
                const next = Math.max(
                  0,
                  Math.min(59, index + (event.key === "ArrowRight" ? 1 : -1)),
                )
                area.current?.querySelectorAll("button")[next]?.focus()
              }}
            >
              <span aria-hidden="true" style={{ height: `${height}%` }} />
              <span
                aria-hidden="true"
                className="lv-hist-error"
                style={{ height: `${errorHeight}%` }}
              />
            </button>
          )
        })}
        {drag && (
          <div
            className="lv-hist-selection"
            aria-hidden="true"
            style={{
              left: `${(Math.min(drag.first, drag.last) / 60) * 100}%`,
              width: `${((Math.abs(drag.last - drag.first) + 1) / 60) * 100}%`,
            }}
          />
        )}
      </div>
      <div className="lp-time-axis">
        {tickSlots.map((tick) => {
          const timestamp = formatTimestampNs(fromNs + (widthNs * tick) / 4n)
          return (
            <time key={tick.toString()} dateTime={timestamp} title={`${timestamp} (UTC)`}>
              {timestamp.slice(11, widthNs < 4_000_000_000n ? 23 : 19)}
            </time>
          )
        })}
      </div>
      <div className="lv-hist-hint" id={hintId}>
        {drag ? "Release to zoom · Esc to cancel" : "Select or drag to pause and zoom"} · Minimum 1
        second
      </div>
    </section>
  )
}
