import { Fragment, type ReactNode } from "react"
import type { TimeWindow } from "./api"
import { useI18n } from "./i18n"
import { projectPath } from "./project-path"

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

// Keep linked sentences together so translations can change link order.
export function LinkedMessage({
  message,
  links,
}: {
  message: string
  links: Record<string, ReactNode>
}) {
  const { t } = useI18n()
  const placeholders = Object.fromEntries(Object.keys(links).map((key) => [key, `{${key}}`]))
  return t(message, placeholders)
    .split(/(\{\w+\})/)
    .map((part, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: Message parts have no state and can repeat.
      <Fragment key={index}>{index % 2 ? (links[part.slice(1, -1)] ?? part) : part}</Fragment>
    ))
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
  const { t } = useI18n()
  return (
    <div className="window-label">
      <span className="eyebrow">{t("Query window")}</span>
      <div>
        <Timestamp value={window.from} />
        <span className="sr-only"> {t("to")} </span>
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
  const { t, number } = useI18n()
  const entries = Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return (
    <section className="attribute-section" aria-label={title}>
      <h4>
        {title} <span className="count">{number(entries.length, { useGrouping: false })}</span>
      </h4>
      {entries.length ? (
        <div className="table-scroll">
          <table className="attribute-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t("Key")}</th>
                <th scope="col">{t("Value")}</th>
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
        <p className="muted">{t("No attributes recorded.")}</p>
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
  const { t } = useI18n()
  return (
    <div className="empty-state">
      <span className="empty-symbol" aria-hidden="true">
        ∅
      </span>
      <h3>
        {kind === "traces"
          ? t("No traces in this window")
          : kind === "logs"
            ? t("No logs in this window")
            : t("No correlated logs in this window")}
      </h3>
      <p>{t("Try a wider time range or remove filters.")}</p>
      {resetHref && (
        <a className="button button-secondary empty-reset" href={resetHref}>
          {t("Reset filters")}
        </a>
      )}
      <p>{t("Connect your application to send OTLP traces and logs to this project.")}</p>
      <a href={projectPath("/setup")}>{t("Connect application")}</a>
      {kind === "correlated logs" && <p>{t("Logs must include this trace ID to appear here.")}</p>}
    </div>
  )
}

export function Truncation({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <Notice title={t("More records are available")} tone="warning">
      {children}
    </Notice>
  )
}
