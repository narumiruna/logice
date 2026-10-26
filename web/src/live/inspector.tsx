// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The inspector tabpanel is a keyboard entry point for static content.

import { useEffect, useMemo, useRef, useState } from "react"
import type { TimeWindow } from "../api"
import { useI18n } from "../i18n"
import { Glyph } from "../preview/icons"
import { formatDuration, severity, spanStatus, traceHref } from "../telemetry"
import type { LiveRecord } from "./api"
import { isLinkable } from "./model"
import "./inspector.css"

const JSON_PREVIEW_LIMIT = 65_536
const tabs = ["attributes", "raw"] as const

function CopyButton({
  label,
  value,
  attributeKey,
  onCopy,
}: {
  label: string
  value: string
  attributeKey?: string
  onCopy: (value: string, label: string, attributeKey?: string) => Promise<void>
}) {
  const { t } = useI18n()
  const translatedLabel =
    attributeKey === undefined
      ? t(label)
      : t("{group}: {key}", { group: t(label), key: attributeKey })
  return (
    <button
      type="button"
      className="lv-detail-copy"
      aria-label={t("Copy {label}", { label: translatedLabel })}
      title={t("Copy {label}", { label: translatedLabel })}
      onClick={() => void onCopy(value, label, attributeKey)}
    >
      <Glyph name="copy" size={13} />
    </button>
  )
}

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
  const { t, number } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const selection = useRef(record.id)
  selection.current = record.id
  const [tab, setTab] = useState<(typeof tabs)[number]>("attributes")
  const [filter, setFilter] = useState("")
  const [copyStatus, setCopyStatus] = useState<{
    message: string
    label?: string
    attributeKey?: string
  } | null>(null)
  const storedJSON = useMemo(() => JSON.stringify(record.stored, null, 2), [record.stored])
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const media = matchMedia("(max-width: 900px)")
    const display = () => {
      const active = document.activeElement
      const focused = active instanceof HTMLElement && element.contains(active) ? active : null
      element.close()
      if (media.matches) element.showModal()
      else element.show()
      // A breakpoint change must not reset the current detail control.
      focused?.focus({ preventScroll: true })
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
    setCopyStatus(null)
    setFilter("")
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
            "button, a[href], input, select, textarea, summary, [tabindex]",
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
  async function copy(value: string, label: string, attributeKey?: string) {
    const id = record.id
    try {
      await navigator.clipboard.writeText(value)
      if (selection.current === id)
        setCopyStatus({ message: "{label} copied", label, attributeKey })
    } catch {
      if (selection.current === id) setCopyStatus({ message: "Clipboard is not available" })
    }
  }
  const status = record.kind === "span" ? spanStatus(record.statusCode) : severity(record)
  const groups = [
    ["Record attributes", record.attributes],
    ["Resource attributes", record.resourceAttributes],
    ["Scope attributes", record.scopeAttributes],
  ] as const
  const query = filter.trim().toLowerCase()
  const attributeCount = groups.reduce((count, [, values]) => count + Object.keys(values).length, 0)
  const matches = groups.map(([title, values]) => ({
    title,
    total: Object.keys(values).length,
    entries: Object.entries(values).filter(([key, value]) =>
      `${key}\n${value}`.toLowerCase().includes(query),
    ),
  }))
  const matchCount = matches.reduce((count, group) => count + group.entries.length, 0)
  return (
    <dialog
      ref={dialog}
      className="lv-inspector lp-inspector"
      aria-label={t("Event details")}
      onCancel={(event) => {
        event.preventDefault()
        dialog.current?.close()
        onClose()
      }}
    >
      <div className="lp-inspector-top">
        <span>
          <span className="lp-detail-dot" aria-hidden="true" /> {t("Event details")}
        </span>
        <button
          type="button"
          className="lp-icon-button"
          aria-label={t("Close event details")}
          onClick={() => {
            dialog.current?.close()
            onClose()
          }}
        >
          <Glyph name="close" />
        </button>
      </div>
      <div className="lp-inspector-content">
        <span className="lp-section-label">
          {record.kind === "span" ? t("EXPORTED SPAN") : t("STORED LOG RECORD")}
        </span>
        <h2 ref={heading} tabIndex={-1}>
          {record.kind === "span"
            ? record.name || t("Unnamed span")
            : record.body || t("(Empty body)")}
        </h2>
        <div className="lp-detail-tags">
          <span className={`lp-status-tag lv-detail-tone-${status.tone}`}>
            {record.kind === "span" && ["Error", "OK", "Unset"].includes(status.label)
              ? t(status.label)
              : status.label}
          </span>
          <span className="lp-soft-tag">{record.serviceName || t("Unknown service")}</span>
          {record.kind === "span" && (
            <span
              className="lp-soft-tag lp-mono"
              title={t("{duration} ns", { duration: record.durationNs })}
            >
              {formatDuration(record.durationNs)}
            </span>
          )}
        </div>
        <div className="lp-detail-time">
          <Glyph name="clock" size={14} />
          <div>
            <span className="lv-detail-time-label">{t("Timestamp (UTC)")}</span>
            <time dateTime={record.startTime}>{record.startTime}</time>
          </div>
          <CopyButton label="timestamp" value={record.startTime} onCopy={copy} />
        </div>
        <div className="lv-detail-notices">
          {outside && (
            <p className="lv-warning">{t("Outside current results · retained selection")}</p>
          )}
          {record.contextOnly && <p>{t("Context only · not a matching row")}</p>}
          {record.conflict && (
            <p className="lv-warning">
              {t("Conflicting exports · deterministic representative, not a latest version")}
            </p>
          )}
          {record.parentConflict && (
            <p className="lv-warning">{t("Ambiguous parent · no parent edge is inferred")}</p>
          )}
          {BigInt(record.occurrences) > 1n && (
            <p>
              {t(
                "{count} stored occurrences · identical emissions and retries cannot be distinguished",
                { count: record.occurrences },
              )}
            </p>
          )}
        </div>
        <dl className="lp-detail-ids">
          <div>
            <dt>{t("Trace ID")}</dt>
            <dd>
              {isLinkable(record) ? (
                <a href={traceHref(record.traceId, window)}>{record.traceId}</a>
              ) : (
                record.traceId || t("Not recorded")
              )}
              {record.traceId && (
                <CopyButton label="Trace ID" value={record.traceId} onCopy={copy} />
              )}
            </dd>
          </div>
          <div>
            <dt>{t("Span ID")}</dt>
            <dd>
              <span>{record.spanId || t("Not recorded")}</span>
              {record.spanId && <CopyButton label="Span ID" value={record.spanId} onCopy={copy} />}
            </dd>
          </div>
          {record.parentSpanId && (
            <div>
              <dt>{t("Recorded parent span")}</dt>
              <dd>
                <span>{record.parentSpanId}</span>
                <CopyButton label="parent Span ID" value={record.parentSpanId} onCopy={copy} />
              </dd>
            </div>
          )}
          <div>
            <dt>{t("Scope")}</dt>
            <dd>{record.scopeName || t("Not recorded")}</dd>
          </div>
          {record.scopeVersion && (
            <div>
              <dt>{t("Scope version")}</dt>
              <dd>{record.scopeVersion}</dd>
            </div>
          )}
          {record.kind === "span" ? (
            <>
              <div>
                <dt>{t("Duration (ns)")}</dt>
                <dd>{record.durationNs}</dd>
              </div>
              <div>
                <dt>{t("Status code")}</dt>
                <dd>{record.statusCode || t("Not recorded")}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>{t("Severity number")}</dt>
              <dd>{record.severityNumber}</dd>
            </div>
          )}
          {record.statusMessage && (
            <div>
              <dt>{t("Status message")}</dt>
              <dd>{record.statusMessage}</dd>
            </div>
          )}
          <div>
            <dt>{t("Stored occurrences")}</dt>
            <dd>{record.occurrences}</dd>
          </div>
        </dl>
        <div className="lp-detail-tabs" role="tablist" aria-label={t("Event detail view")}>
          {tabs.map((item, index) => (
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
                let next: (typeof tabs)[number]
                if (event.key === "ArrowLeft" || event.key === "ArrowRight")
                  next = tabs[(index + 1) % tabs.length]
                else if (event.key === "Home") next = tabs[0]
                else if (event.key === "End") next = tabs[tabs.length - 1]
                else return
                event.preventDefault()
                setTab(next)
                document.getElementById(`live-tab-${next}`)?.focus()
              }}
            >
              {item === "raw" ? t("Stored record JSON") : t("Attributes")}
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
            <>
              <div className="lp-property-heading">
                <h3>{t("Stored projection")}</h3>
                <span>{t("Not original OTLP")}</span>
              </div>
              {storedJSON.length > JSON_PREVIEW_LIMIT && (
                <p className="lv-detail-empty">
                  {t(
                    "Preview limited to {count} characters. Copy stored record JSON for the full stored projection.",
                    { count: number(JSON_PREVIEW_LIMIT) },
                  )}
                </p>
              )}
              <section aria-label={t("Stored record JSON preview")}>
                <pre className="lp-raw-data" tabIndex={0}>
                  {storedJSON.slice(0, JSON_PREVIEW_LIMIT)}
                </pre>
              </section>
            </>
          ) : (
            <>
              <div className="lp-property-heading">
                <h3>{t("Event attributes")}</h3>
                <span>{t("{attributeCount} fields", { attributeCount: attributeCount })}</span>
              </div>
              <div className="lv-detail-filter">
                <Glyph name="search" size={14} />
                <input
                  aria-label={t("Filter attributes")}
                  placeholder={t("Filter by key or value…")}
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                {filter && (
                  <button
                    type="button"
                    aria-label={t("Clear attribute filter")}
                    onClick={() => setFilter("")}
                  >
                    <Glyph name="close" size={13} />
                  </button>
                )}
              </div>
              {query && (
                <p className="lv-detail-empty" role="status">
                  {matchCount === 0
                    ? t("No matching attributes")
                    : t("{matchCount} matching attributes", { matchCount: matchCount })}
                </p>
              )}
              {matches.map(({ title, total, entries }) => (
                <details className="lv-detail-group" key={title} open>
                  <summary>
                    {t(title)}
                    <span>
                      {query
                        ? `${entries.length} / ${total}`
                        : t("{total} fields", { total: total })}
                    </span>
                  </summary>
                  {entries.length ? (
                    <div className="lp-property-list">
                      {entries.map(([key, value]) => (
                        <div className="lp-property" key={key}>
                          <div className="lv-detail-property-key">
                            <code>{key}</code>
                            <CopyButton
                              label={title}
                              attributeKey={key}
                              value={value}
                              onCopy={copy}
                            />
                          </div>
                          <span>{value || t("(Empty string)")}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="lv-detail-empty">
                      {total ? t("No matches in this group") : t("No attributes recorded")}
                    </p>
                  )}
                </details>
              ))}
              <details className="lv-detail-group">
                <summary>{t("Export metadata")}</summary>
                <dl className="lp-detail-ids">
                  <div>
                    <dt>{t("Trace flags")}</dt>
                    <dd>{record.traceFlags}</dd>
                  </div>
                  <div>
                    <dt>{t("Resource schema URL")}</dt>
                    <dd>{record.resourceSchemaUrl || t("Not recorded")}</dd>
                  </div>
                  <div>
                    <dt>{t("Scope schema URL")}</dt>
                    <dd>{record.scopeSchemaUrl || t("Not recorded")}</dd>
                  </div>
                </dl>
              </details>
            </>
          )}
        </div>
        <button
          type="button"
          className="lp-copy-button"
          onClick={() => void copy(storedJSON, "Stored record JSON")}
        >
          <Glyph name="copy" size={14} /> {t("Copy stored record JSON")}
        </button>
        <span className="lp-copy-status" role="status">
          {copyStatus &&
            t(copyStatus.message, {
              label: copyStatus.label
                ? copyStatus.attributeKey === undefined
                  ? t(copyStatus.label)
                  : t("{group}: {key}", {
                      group: t(copyStatus.label),
                      key: copyStatus.attributeKey,
                    })
                : "",
            })}
        </span>
        <div className="lp-code-note">
          <Glyph name="code" size={16} />
          <div>
            <strong>{t("Stored projection, not original OTLP")}</strong>
            <p>
              {t(
                "Attribute types use the exporter's string representation. Trace completeness is unknown.",
              )}
            </p>
          </div>
        </div>
      </div>
    </dialog>
  )
}
