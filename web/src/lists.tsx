import type { ListResult, Log, TimeWindow, TraceSummary } from "./api"
import { Attributes, Badge, EmptyState, Timestamp, Truncation } from "./components"
import { useI18n } from "./i18n"
import { formatDuration, isTraceId, severity, traceHref } from "./telemetry"

export function TraceList({
  result,
  window,
  resetHref,
}: {
  result: ListResult<TraceSummary>
  window: TimeWindow
  resetHref?: string
}) {
  const { t, number } = useI18n()
  const errors = result.items.reduce((total, trace) => total + trace.errorCount, 0)
  const services = new Set(result.items.map((trace) => trace.serviceName)).size
  return (
    <>
      <section className="metrics" aria-label={t("Returned trace statistics")}>
        <div>
          <span>{t("Traces returned")}</span>
          <strong>{number(result.items.length, { useGrouping: false })}</strong>
        </div>
        <div>
          <span>{t("Services in results")}</span>
          <strong>{number(services, { useGrouping: false })}</strong>
        </div>
        <div>
          <span>{t("Error spans in results")}</span>
          <strong className={errors ? "text-error" : ""}>
            {number(errors, { useGrouping: false })}
          </strong>
        </div>
      </section>
      <section className="panel" aria-labelledby="trace-results">
        <div className="panel-heading">
          <h2 id="trace-results">
            {t("Traces")}{" "}
            <span className="count">{number(result.items.length, { useGrouping: false })}</span>
          </h2>
          <span className="muted">{t("Window-bounded summaries")}</span>
        </div>
        {result.items.length === 0 ? (
          <EmptyState kind="traces" resetHref={resetHref} />
        ) : (
          <div className="table-scroll">
            <table className="data-table record-table trace-table">
              <caption className="sr-only">{t("Traces in the selected time window")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("Trace / span name")}</th>
                  <th scope="col">{t("Service")}</th>
                  <th scope="col">{t("Started (UTC)")}</th>
                  <th scope="col" className="numeric">
                    {t("Duration")}
                  </th>
                  <th scope="col" className="numeric">
                    {t("Spans")}
                  </th>
                  <th scope="col">{t("Errors")}</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((trace) => (
                  <tr key={trace.traceId}>
                    <td className="trace-identity">
                      <div className="record-name">
                        {isTraceId(trace.traceId) ? (
                          <a href={traceHref(trace.traceId, window)}>
                            {trace.name || t("Unnamed span")}
                          </a>
                        ) : (
                          trace.name || t("Unnamed span")
                        )}
                      </div>
                      <code className="secondary-id">{trace.traceId}</code>
                    </td>
                    <td data-label={t("Service")}>
                      <span className="service-name">
                        {trace.serviceName || t("Unknown service")}
                      </span>
                    </td>
                    <td className="time-cell" data-label={t("Started (UTC)")}>
                      <Timestamp value={trace.startTime} />
                    </td>
                    <td className="numeric duration" data-label={t("Duration")}>
                      {formatDuration(trace.durationNs)}
                    </td>
                    <td className="numeric" data-label={t("Spans")}>
                      {number(trace.spanCount, { useGrouping: false })}
                    </td>
                    <td data-label={t("Errors")}>
                      <Badge
                        label={
                          trace.errorCount
                            ? trace.errorCount === 1
                              ? t("{count} error", {
                                  count: number(trace.errorCount, { useGrouping: false }),
                                })
                              : t("{count} errors", {
                                  count: number(trace.errorCount, { useGrouping: false }),
                                })
                            : t("No errors")
                        }
                        tone={trace.errorCount ? "error" : "neutral"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {result.hasMore && (
        <Truncation>
          {t(
            "The trace list reached its limit. Narrow the time window or filters to see other traces. No total count is available.",
          )}
        </Truncation>
      )}
      <p className="footnote">
        {t("Only spans in this query window contribute to each summary. Traces can be partial.")}
      </p>
    </>
  )
}

export function LogRecord({ log, window }: { log: Log; window: TimeWindow }) {
  const { t } = useI18n()
  return (
    <div className="record-detail">
      <h4>{t("Log record")}</h4>
      <dl className="metadata">
        <div>
          <dt>{t("Timestamp")}</dt>
          <dd>
            <Timestamp value={log.timestamp} />
          </dd>
        </div>
        <div>
          <dt>{t("Service")}</dt>
          <dd>{log.serviceName || t("Unknown service")}</dd>
        </div>
        <div>
          <dt>{t("Severity")}</dt>
          <dd>
            <Badge {...severity(log)} /> <span className="muted">({log.severityNumber})</span>
          </dd>
        </div>
        <div>
          <dt>{t("Trace ID")}</dt>
          <dd>
            {isTraceId(log.traceId) ? (
              <a className="mono" href={traceHref(log.traceId, window)}>
                {log.traceId}
              </a>
            ) : (
              <code>{log.traceId || t("Not recorded")}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("Span ID")}</dt>
          <dd>
            <code>{log.spanId || t("Not recorded")}</code>
          </dd>
        </div>
      </dl>
      <h4>{t("Body")}</h4>
      <pre className="log-body">{log.body || t("(Empty body)")}</pre>
      <Attributes title={t("Resource attributes")} values={log.resourceAttributes} />
      <Attributes title={t("Log attributes")} values={log.attributes} />
    </div>
  )
}

export function LogTable({
  logs,
  window,
  correlated = false,
  resetHref,
}: {
  logs: Log[]
  window: TimeWindow
  correlated?: boolean
  resetHref?: string
}) {
  const { t } = useI18n()
  if (logs.length === 0)
    return <EmptyState kind={correlated ? "correlated logs" : "logs"} resetHref={resetHref} />
  return (
    <div className="table-scroll">
      <table className="data-table record-table log-table">
        <caption className="sr-only">
          {correlated ? t("Correlated logs") : t("Logs in the selected time window")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("Timestamp (UTC)")}</th>
            <th scope="col">{t("Severity")}</th>
            <th scope="col">{t("Service")}</th>
            <th scope="col">{t("Body / record details")}</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: This immutable response has no stable log ID; loading unmounts the table before replacement.
            <tr key={`${log.timestamp}-${index}`}>
              <td className="time-cell" data-label={t("Timestamp (UTC)")}>
                <Timestamp value={log.timestamp} />
              </td>
              <td data-label={t("Severity")}>
                <Badge {...severity(log)} />
              </td>
              <td data-label={t("Service")}>
                <span className="service-name">{log.serviceName || t("Unknown service")}</span>
              </td>
              <td className="log-content">
                <pre className="body-preview">{log.body || t("(Empty body)")}</pre>
                <details className="log-expansion">
                  <summary>
                    <span className="log-show-label">{t("Show log details")}</span>
                    <span className="log-hide-label">{t("Hide log details")}</span>
                  </summary>
                  <LogRecord log={log} window={window} />
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function LogList({
  result,
  window,
  resetHref,
}: {
  result: ListResult<Log>
  window: TimeWindow
  resetHref?: string
}) {
  const { t, number } = useI18n()
  return (
    <>
      <section className="panel" aria-labelledby="log-results">
        <div className="panel-heading">
          <h2 id="log-results">
            {t("Logs")}{" "}
            <span className="count">{number(result.items.length, { useGrouping: false })}</span>
          </h2>
          <span className="muted">{t("Expand a record to inspect attributes")}</span>
        </div>
        <LogTable logs={result.items} window={window} resetHref={resetHref} />
      </section>
      {result.hasMore && (
        <Truncation>
          {t(
            "The log list reached its limit. Narrow the time window or filters to see other logs. No total count is available.",
          )}
        </Truncation>
      )}
      <p className="footnote">
        {t("Showing returned records only. Trace links use this same time window.")}
      </p>
    </>
  )
}
