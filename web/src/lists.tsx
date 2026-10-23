import type { ListResult, Log, TimeWindow, TraceSummary } from "./api"
import { Attributes, Badge, EmptyState, Timestamp, Truncation } from "./components"
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
  const errors = result.items.reduce((total, trace) => total + trace.errorCount, 0)
  const services = new Set(result.items.map((trace) => trace.serviceName)).size
  return (
    <>
      <section className="metrics" aria-label="Returned trace statistics">
        <div>
          <span>Traces returned</span>
          <strong>{result.items.length}</strong>
        </div>
        <div>
          <span>Services in results</span>
          <strong>{services}</strong>
        </div>
        <div>
          <span>Error spans in results</span>
          <strong className={errors ? "text-error" : ""}>{errors}</strong>
        </div>
      </section>
      <section className="panel" aria-labelledby="trace-results">
        <div className="panel-heading">
          <h2 id="trace-results">
            Traces <span className="count">{result.items.length}</span>
          </h2>
          <span className="muted">Window-bounded summaries</span>
        </div>
        {result.items.length === 0 ? (
          <EmptyState kind="traces" resetHref={resetHref} />
        ) : (
          <div className="table-scroll">
            <table className="data-table record-table trace-table">
              <caption className="sr-only">Traces in the selected time window</caption>
              <thead>
                <tr>
                  <th scope="col">Trace / span name</th>
                  <th scope="col">Service</th>
                  <th scope="col">Started (UTC)</th>
                  <th scope="col" className="numeric">
                    Duration
                  </th>
                  <th scope="col" className="numeric">
                    Spans
                  </th>
                  <th scope="col">Errors</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((trace) => (
                  <tr key={trace.traceId}>
                    <td className="trace-identity">
                      <div className="record-name">
                        {isTraceId(trace.traceId) ? (
                          <a href={traceHref(trace.traceId, window)}>
                            {trace.name || "Unnamed span"}
                          </a>
                        ) : (
                          trace.name || "Unnamed span"
                        )}
                      </div>
                      <code className="secondary-id">{trace.traceId}</code>
                    </td>
                    <td data-label="Service">
                      <span className="service-name">{trace.serviceName || "Unknown service"}</span>
                    </td>
                    <td className="time-cell" data-label="Started (UTC)">
                      <Timestamp value={trace.startTime} />
                    </td>
                    <td className="numeric duration" data-label="Duration">
                      {formatDuration(trace.durationNs)}
                    </td>
                    <td className="numeric" data-label="Spans">
                      {trace.spanCount}
                    </td>
                    <td data-label="Errors">
                      <Badge
                        label={
                          trace.errorCount
                            ? `${trace.errorCount} error${trace.errorCount === 1 ? "" : "s"}`
                            : "No errors"
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
          The trace list reached its limit. Narrow the time window or filters to see other traces.
          No total count is available.
        </Truncation>
      )}
      <p className="footnote">
        Only spans in this query window contribute to each summary. Traces can be partial.
      </p>
    </>
  )
}

export function LogRecord({ log, window }: { log: Log; window: TimeWindow }) {
  return (
    <div className="record-detail">
      <h4>Log record</h4>
      <dl className="metadata">
        <div>
          <dt>Timestamp</dt>
          <dd>
            <Timestamp value={log.timestamp} />
          </dd>
        </div>
        <div>
          <dt>Service</dt>
          <dd>{log.serviceName || "Unknown service"}</dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd>
            <Badge {...severity(log)} /> <span className="muted">({log.severityNumber})</span>
          </dd>
        </div>
        <div>
          <dt>Trace ID</dt>
          <dd>
            {isTraceId(log.traceId) ? (
              <a className="mono" href={traceHref(log.traceId, window)}>
                {log.traceId}
              </a>
            ) : (
              <code>{log.traceId || "Not recorded"}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Span ID</dt>
          <dd>
            <code>{log.spanId || "Not recorded"}</code>
          </dd>
        </div>
      </dl>
      <h4>Body</h4>
      <pre className="log-body">{log.body || "(Empty body)"}</pre>
      <Attributes title="Resource attributes" values={log.resourceAttributes} />
      <Attributes title="Log attributes" values={log.attributes} />
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
  if (logs.length === 0)
    return <EmptyState kind={correlated ? "correlated logs" : "logs"} resetHref={resetHref} />
  return (
    <div className="table-scroll">
      <table className="data-table record-table log-table">
        <caption className="sr-only">
          {correlated ? "Correlated logs" : "Logs in the selected time window"}
        </caption>
        <thead>
          <tr>
            <th scope="col">Timestamp (UTC)</th>
            <th scope="col">Severity</th>
            <th scope="col">Service</th>
            <th scope="col">Body / record details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: This immutable response has no stable log ID; loading unmounts the table before replacement.
            <tr key={`${log.timestamp}-${index}`}>
              <td className="time-cell" data-label="Timestamp (UTC)">
                <Timestamp value={log.timestamp} />
              </td>
              <td data-label="Severity">
                <Badge {...severity(log)} />
              </td>
              <td data-label="Service">
                <span className="service-name">{log.serviceName || "Unknown service"}</span>
              </td>
              <td className="log-content">
                <pre className="body-preview">{log.body || "(Empty body)"}</pre>
                <details className="log-expansion">
                  <summary>
                    <span className="log-show-label">Show log details</span>
                    <span className="log-hide-label">Hide log details</span>
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
  return (
    <>
      <section className="panel" aria-labelledby="log-results">
        <div className="panel-heading">
          <h2 id="log-results">
            Logs <span className="count">{result.items.length}</span>
          </h2>
          <span className="muted">Expand a record to inspect attributes</span>
        </div>
        <LogTable logs={result.items} window={window} resetHref={resetHref} />
      </section>
      {result.hasMore && (
        <Truncation>
          The log list reached its limit. Narrow the time window or filters to see other logs. No
          total count is available.
        </Truncation>
      )}
      <p className="footnote">
        Showing returned records only. Trace links use this same time window.
      </p>
    </>
  )
}
