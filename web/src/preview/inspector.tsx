import { useEffect, useRef, useState } from "react"
import { useI18n } from "../i18n"
import { Glyph } from "./icons"
import { durationMs, type PreviewEvent } from "./model"

export function formatDuration(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}

export function PreviewInspector({
  event,
  now,
  onClose,
}: {
  event: PreviewEvent
  now: number
  onClose: () => void
}) {
  const { t } = useI18n()
  const [tab, setTab] = useState<"attributes" | "raw">("attributes")
  const [copied, setCopied] = useState("")
  const heading = useRef<HTMLHeadingElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Move focus only when selection changes, not on live field updates.
  useEffect(() => {
    setCopied("")
    heading.current?.focus({ preventScroll: true })
  }, [event.id])
  useEffect(() => {
    const closeOnEscape = (key: KeyboardEvent) => {
      if (key.key === "Escape") onClose()
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [onClose])
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2))
      setCopied("Event JSON copied")
    } catch {
      setCopied("Clipboard is not available")
    }
  }
  return (
    <aside className="lp-inspector" aria-label={t("Event details")}>
      <div className="lp-inspector-top">
        <span>
          <span className="lp-detail-dot" /> {t("Event details")}
        </span>
        <button
          className="lp-icon-button"
          type="button"
          onClick={onClose}
          aria-label={t("Close event details")}
        >
          <Glyph name="close" />
        </button>
      </div>
      <div className="lp-inspector-content">
        <div className="lp-section-label">
          {event.kind === "span" ? t("SPAN") : t("LOG RECORD")}
        </div>
        <h2 ref={heading} tabIndex={-1}>
          {event.message}
        </h2>
        <div className="lp-detail-tags">
          <span className={`lp-status-tag ${event.status}`}>
            {event.status === "running"
              ? t("Running")
              : event.status === "error"
                ? t("Error")
                : event.kind === "log"
                  ? event.level.toUpperCase()
                  : t("OK")}
          </span>
          <span className="lp-soft-tag">{event.service}</span>
          {event.kind === "span" && (
            <span className="lp-soft-tag lp-mono">{formatDuration(durationMs(event, now))}</span>
          )}
        </div>
        <p className="lp-detail-time">
          <Glyph name="clock" size={14} />
          <time dateTime={new Date(event.startMs).toISOString()}>
            {new Date(event.startMs).toISOString().replace("T", " ").replace("Z", " UTC")}
          </time>
        </p>
        <dl className="lp-detail-ids">
          <div>
            <dt>{t("Trace ID")}</dt>
            <dd>{event.traceId}</dd>
          </div>
          <div>
            <dt>{t("Span ID")}</dt>
            <dd>{event.spanId}</dd>
          </div>
          {event.parentId && (
            <div>
              <dt>{t("Parent event")}</dt>
              <dd>{event.parentId}</dd>
            </div>
          )}
        </dl>
        <div className="lp-detail-tabs" role="tablist" aria-label={t("Event detail view")}>
          {(["attributes", "raw"] as const).map((item) => (
            <button
              key={item}
              id={`lp-tab-${item}`}
              role="tab"
              type="button"
              aria-selected={tab === item}
              aria-controls="lp-detail-panel"
              tabIndex={tab === item ? 0 : -1}
              onClick={() => setTab(item)}
              onKeyDown={(key) => {
                if (key.key === "ArrowLeft" || key.key === "ArrowRight") {
                  key.preventDefault()
                  const next = tab === "attributes" ? "raw" : "attributes"
                  setTab(next)
                  document.getElementById(`lp-tab-${next}`)?.focus()
                }
              }}
            >
              {item === "attributes" ? t("Attributes") : t("Raw data")}
            </button>
          ))}
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The tab panel must be reachable from its tab when its content has no interactive elements. */}
        <div id="lp-detail-panel" role="tabpanel" aria-labelledby={`lp-tab-${tab}`} tabIndex={0}>
          {tab === "attributes" ? (
            <>
              <div className="lp-property-heading">
                <h3>{t("Event attributes")}</h3>
                <span>{t("{count} fields", { count: Object.keys(event.attributes).length })}</span>
              </div>
              <div className="lp-property-list">
                {Object.entries(event.attributes).map(([key, value]) => (
                  <div className="lp-property" key={key}>
                    <code>{key}</code>
                    <span>{value}</span>
                  </div>
                ))}
              </div>
              <div className="lp-code-note">
                <Glyph name="code" />
                <div>
                  <strong>{t("Connected by context")}</strong>
                  <p>
                    {t(
                      "Logs stay with the span that created them. Select a parent or child to inspect the same trace.",
                    )}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <pre className="lp-raw-data">{JSON.stringify(event, null, 2)}</pre>
          )}
        </div>
        <button className="lp-copy-button" type="button" onClick={() => void copy()}>
          <Glyph name="copy" size={14} /> {t("Copy event JSON")}
        </button>
        <span className="lp-copy-status" role="status">
          {t(copied)}
        </span>
        <div className="lp-detail-preview-note">
          {t("Design preview · generated sample data")}
          <br />
          {t("No production telemetry is being read.")}
        </div>
      </div>
    </aside>
  )
}
