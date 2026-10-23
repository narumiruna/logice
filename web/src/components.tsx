import type { ReactNode } from "react"
import type { TimeWindow } from "./api"

export function Notice({
  title,
  children,
  tone = "info",
}: {
  title: string
  children?: ReactNode
  tone?: "info" | "warning" | "error"
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  )
}

export function Badge({ label, tone }: { label: string; tone: string }) {
  return <span className={`badge badge-${tone}`}>{label}</span>
}

export function Timestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {value.replace("T", " ").replace(/Z$/, " UTC")}
    </time>
  )
}

export function WindowLabel({ window }: { window: TimeWindow }) {
  return (
    <div className="window-label">
      <span className="eyebrow">Query window</span>
      <div>
        <Timestamp value={window.from} />
        <span className="sr-only"> to </span>
        <span className="window-arrow" aria-hidden="true">
          {" "}
          →{" "}
        </span>
        <Timestamp value={window.to} />
      </div>
    </div>
  )
}

export function Attributes({ title, values }: { title: string; values: Record<string, string> }) {
  const entries = Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return (
    <section className="attribute-section" aria-label={title}>
      <h4>
        {title} <span className="count">{entries.length}</span>
      </h4>
      {entries.length ? (
        <div className="table-scroll">
          <table className="attribute-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <th scope="row">
                    <code>{key}</code>
                  </th>
                  <td>
                    <pre>{value}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No attributes recorded.</p>
      )}
    </section>
  )
}

export function EmptyState({
  kind,
  resetHref,
}: {
  kind: "traces" | "logs" | "correlated logs"
  resetHref?: string
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol" aria-hidden="true">
        ∅
      </span>
      <h3>No {kind} in this window</h3>
      <p>Try a wider time range or remove filters.</p>
      {resetHref && (
        <a className="button button-secondary empty-reset" href={resetHref}>
          Reset filters
        </a>
      )}
      <p>
        To add local telemetry, send OTLP traces and logs from your application to the Collector
        configured for this validation project.
      </p>
      {kind === "correlated logs" && <p>Logs must include this trace ID to appear here.</p>}
    </div>
  )
}

export function Truncation({ children }: { children: ReactNode }) {
  return (
    <Notice title="More records are available" tone="warning">
      {children}
    </Notice>
  )
}
