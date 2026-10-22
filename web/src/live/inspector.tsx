// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The inspector tabpanel is a keyboard entry point for static content.
import { useEffect, useRef, useState } from "react"
import type { TimeWindow } from "../api"
import { formatDuration, severity, spanStatus, traceHref } from "../telemetry"
import type { LiveRecord } from "./api"
import { isLinkable } from "./model"

export function Inspector({
  record,
  window,
  outside,
  onClose,
}: {
  record: LiveRecord
  window: TimeWindow
  outside: boolean
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [tab, setTab] = useState<"attributes" | "raw">("attributes")
  const [copyStatus, setCopyStatus] = useState("")
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const media = matchMedia("(max-width: 900px)")
    const display = () => {
      element.close()
      if (media.matches) element.showModal()
      else element.show()
    }
    display()
    media.addEventListener("change", display)
    return () => {
      media.removeEventListener("change", display)
      element.close()
    }
  }, [])
  // Move focus on selection only, never on a polling update.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection identity controls focus.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    setCopyStatus("")
  }, [record.id])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = dialog.current
      if (!element?.open) return
      if (event.key === "Escape") {
        event.preventDefault()
        element.close()
        onClose()
      } else if (event.key === "Tab" && element.matches(":modal")) {
        const controls = [
          ...element.querySelectorAll<HTMLElement>(
            "button, a[href], input, select, textarea, [tabindex]",
          ),
        ].filter(
          (control) =>
            control.tabIndex >= 0 &&
            !control.hasAttribute("disabled") &&
            control.getClientRects().length > 0,
        )
        const first = controls[0]
        const last = controls[controls.length - 1]
        const active = document.activeElement
        if (
          event.shiftKey &&
          (active === first || active === heading.current || !element.contains(active))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && (active === last || !element.contains(active))) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  const label =
    record.kind === "span" ? spanStatus(record.statusCode).label : severity(record).label
  return (
    <dialog
      ref={dialog}
      className="lv-inspector lp-inspector"
      aria-label="Event details"
      onCancel={(event) => {
        event.preventDefault()
        dialog.current?.close()
        onClose()
      }}
    >
      <div className="lp-inspector-top">
        <strong>Event details</strong>
        <button
          type="button"
          aria-label="Close event details"
          onClick={() => {
            dialog.current?.close()
            onClose()
          }}
        >
          ×
        </button>
      </div>
      <div className="lp-inspector-content">
        <span className="lp-section-label">
          {record.kind === "span" ? "EXPORTED SPAN" : "STORED LOG RECORD"}
        </span>
        <h2 ref={heading} tabIndex={-1}>
          {record.kind === "span" ? record.name || "Unnamed span" : record.body || "(Empty body)"}
        </h2>
        <div className="lp-detail-tags">
          <span className="lp-soft-tag">{label}</span>
          <span className="lp-soft-tag">{record.serviceName || "Unknown service"}</span>
          {record.kind === "span" && (
            <span className="lp-soft-tag">{formatDuration(record.durationNs)}</span>
          )}
        </div>
        {outside && <p className="lv-warning">Outside current results · retained selection</p>}
        {record.contextOnly && <p>Context only · not a matching row</p>}
        {record.conflict && (
          <p className="lv-warning">
            Conflicting exports · deterministic representative, not a latest version
          </p>
        )}
        {record.parentConflict && (
          <p className="lv-warning">Ambiguous parent · no parent edge is inferred</p>
        )}
        {BigInt(record.occurrences) > 1n && (
          <p>
            {record.occurrences} stored occurrences · identical emissions and retries cannot be
            distinguished
          </p>
        )}
        <dl className="lp-detail-ids">
          <div>
            <dt>Timestamp (UTC)</dt>
            <dd>{record.startTime}</dd>
          </div>
          <div>
            <dt>Trace ID</dt>
            <dd>
              {isLinkable(record) ? (
                <a href={traceHref(record.traceId, window)}>{record.traceId}</a>
              ) : (
                record.traceId || "Not recorded"
              )}
            </dd>
          </div>
          <div>
            <dt>Span ID</dt>
            <dd>{record.spanId || "Not recorded"}</dd>
          </div>
          {record.parentSpanId && (
            <div>
              <dt>Recorded parent span</dt>
              <dd>{record.parentSpanId}</dd>
            </div>
          )}
          <div>
            <dt>Scope</dt>
            <dd>
              {record.scopeName || "Not recorded"} {record.scopeVersion}
            </dd>
          </div>
          {record.statusMessage && (
            <div>
              <dt>Status message</dt>
              <dd>{record.statusMessage}</dd>
            </div>
          )}
          <div>
            <dt>Stored occurrences</dt>
            <dd>{record.occurrences}</dd>
          </div>
        </dl>
        <div className="lp-detail-tabs" role="tablist" aria-label="Event detail view">
          {(["attributes", "raw"] as const).map((item) => (
            <button
              key={item}
              id={`live-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls="live-detail-panel"
              tabIndex={tab === item ? 0 : -1}
              onClick={() => setTab(item)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                event.preventDefault()
                const next = item === "raw" ? "attributes" : "raw"
                setTab(next)
                document.getElementById(`live-tab-${next}`)?.focus()
              }}
            >
              {item === "raw" ? "Stored record JSON" : "Attributes"}
            </button>
          ))}
        </div>
        <div
          id="live-detail-panel"
          role="tabpanel"
          aria-labelledby={`live-tab-${tab}`}
          tabIndex={0}
        >
          {tab === "raw" ? (
            <pre className="lp-raw-data">{JSON.stringify(record.stored, null, 2)}</pre>
          ) : (
            [
              ["Resource attributes", record.resourceAttributes],
              ["Record attributes", record.attributes],
              ["Scope attributes", record.scopeAttributes],
            ].map(([title, values]) => (
              <section key={String(title)}>
                <h3>{String(title)}</h3>
                <div className="lp-property-list">
                  {Object.entries(values).map(([key, value]) => (
                    <div className="lp-property" key={key}>
                      <code>{key}</code>
                      <span>{String(value)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
        <button
          type="button"
          className="lp-copy-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(record.stored, null, 2))
              setCopyStatus("Stored record JSON copied")
            } catch {
              setCopyStatus("Clipboard is not available")
            }
          }}
        >
          Copy stored record JSON
        </button>
        <span role="status">{copyStatus}</span>
        <p className="lp-detail-preview-note">
          Stored projection, not original OTLP. Attribute types use the exporter's string
          representation. Trace completeness is unknown.
        </p>
      </div>
    </dialog>
  )
}
