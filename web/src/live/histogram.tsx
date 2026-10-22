import { useRef } from "react"
import type { TimeWindow } from "../api"
import type { LiveBucket } from "./api"
import { selectInterval } from "./route"

// The 60 positions stay fixed while rolling-window timestamps change.
const bucketSlots = Array.from({ length: 60 }, (_, slot) => slot)

export function Histogram({
  buckets,
  window,
  onSelect,
}: {
  buckets: LiveBucket[]
  window: TimeWindow
  onSelect: (window: TimeWindow) => void
}) {
  const start = useRef<number | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const total = buckets.reduce((sum, b) => sum + BigInt(b.spans) + BigInt(b.logs), 0n)
  const maximum = buckets.reduce((max, b) => {
    const count = BigInt(b.spans) + BigInt(b.logs)
    return count > max ? count : max
  }, 1n)
  function select(a: number, b: number) {
    const from = buckets[Math.min(a, b)]?.from
    const to = buckets[Math.max(a, b)]?.to
    if (from && to) onSelect(selectInterval(window, from, to))
  }
  function position(x: number) {
    const rect = area.current?.getBoundingClientRect()
    return rect ? Math.max(0, Math.min(59, Math.floor(((x - rect.left) / rect.width) * 60))) : 0
  }
  return (
    <section className="lp-overview lv-overview" aria-label="Stored event histogram">
      <div className="lp-overview-caption">
        <span>
          Stored event volume · <strong>{total.toString()}</strong> matching rows
        </span>
        <span>Includes identical stored content</span>
      </div>
      <div
        className="lv-histogram"
        ref={area}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          start.current = position(event.clientX)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          start.current = null
        }}
        onPointerUp={(event) => {
          if (start.current !== null) select(start.current, position(event.clientX))
          start.current = null
        }}
      >
        {bucketSlots.map((index) => {
          const bucket = buckets[index]
          const count = BigInt(bucket.spans) + BigInt(bucket.logs)
          const errors = BigInt(bucket.errorSpans) + BigInt(bucket.errorLogs)
          const height = Number((count * 1000n) / maximum) / 10
          const errorHeight = Number((errors * 1000n) / maximum) / 10
          return (
            <button
              key={index}
              type="button"
              aria-label={`Select bucket ${index + 1}: ${bucket.from}, ${count} stored rows`}
              title={`${bucket.from} — ${bucket.to}\n${bucket.spans} spans · ${bucket.logs} logs · ${errors} errors`}
              onClick={(event) => {
                if (event.detail === 0) select(index, index)
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
              <span style={{ height: `${Math.max(2, height)}%` }} />
              <span className="lv-hist-error" style={{ height: `${errorHeight}%` }} />
            </button>
          )
        })}
      </div>
      <div className="lp-time-axis">
        <time>{window.from}</time>
        <span>Select or drag to pause and zoom · Minimum 1 second</span>
        <time>{window.to}</time>
      </div>
    </section>
  )
}
