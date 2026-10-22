import type { Span, TimeWindow, TraceDetail as TraceDetailData } from "./api"
import { Attributes, Badge, Notice, Timestamp } from "./components"
import { LogTable } from "./lists"
import { formatDuration, listHref, spanDepth, spanStatus, spanTimeline } from "./telemetry"

function SpanRecord({ span, byId }: { span: Span; byId: Map<string, Span> }) {
  const parent = span.parentSpanId
  const hasParent = parent && !/^0+$/.test(parent)
  return (
    <div className="record-detail">
      <dl className="metadata">
        <div>
          <dt>Span ID</dt>
          <dd>
            <code>{span.spanId}</code>
          </dd>
        </div>
        <div>
          <dt>Parent span ID</dt>
          <dd>
            {hasParent ? (
              byId.has(parent) && parent !== span.spanId ? (
                <a className="mono" href={`#span-${parent}`}>
                  {parent}
                </a>
              ) : (
                <>
                  <code>{parent}</code> <span className="muted">(parent not available)</span>
                </>
              )
            ) : (
              "None recorded (root span)"
            )}
          </dd>
        </div>
        <div>
          <dt>Trace ID</dt>
          <dd>
            <code>{span.traceId}</code>
          </dd>
        </div>
        <div>
          <dt>Service</dt>
          <dd>{span.serviceName || "Unknown service"}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            <Timestamp value={span.startTime} />
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {formatDuration(span.durationNs)} <span className="muted">({span.durationNs} ns)</span>
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <Badge {...spanStatus(span.statusCode)} />
          </dd>
        </div>
        <div>
          <dt>Status message</dt>
          <dd className="preserve-text">{span.statusMessage || "Not recorded"}</dd>
        </div>
      </dl>
      <Attributes title="Resource attributes" values={span.resourceAttributes} />
      <Attributes title="Span attributes" values={span.attributes} />
    </div>
  )
}

export function SpanList({ spans }: { spans: Span[] }) {
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  const timeline = spanTimeline(spans)
  return (
    <>
      <div className="span-column-head" aria-hidden="true">
        <span>Span / parent</span>
        <span>Service</span>
        <span>Status</span>
        <span>Duration</span>
        <span>Relative timing</span>
      </div>
      <ol className="span-list">
        {spans.map((span) => {
          const position = timeline.get(span)
          const depth = spanDepth(span, byId)
          return (
            <li id={`span-${span.spanId}`} key={span.spanId}>
              <details>
                <summary className="span-summary">
                  <span className="span-name" style={{ paddingLeft: `${depth * 12}px` }}>
                    <strong>{span.name || "Unnamed span"}</strong>
                    <code>{span.spanId}</code>
                    <span className="span-parent">
                      Parent:{" "}
                      {span.parentSpanId && !/^0+$/.test(span.parentSpanId)
                        ? span.parentSpanId
                        : "none"}
                    </span>
                  </span>
                  <span className="service-name">{span.serviceName || "Unknown service"}</span>
                  <Badge {...spanStatus(span.statusCode)} />
                  <span className="duration">{formatDuration(span.durationNs)}</span>
                  <span
                    className="timeline"
                    role="img"
                    aria-label={`Duration ${formatDuration(span.durationNs)} on a common trace scale`}
                  >
                    <span
                      className={`timeline-bar ${spanStatus(span.statusCode).tone}`}
                      style={{ left: `${position?.left ?? 0}%`, width: `${position?.width ?? 0}%` }}
                    />
                  </span>
                </summary>
                <SpanRecord span={span} byId={byId} />
              </details>
            </li>
          )
        })}
      </ol>
    </>
  )
}

export function TraceDetail({ detail, window }: { detail: TraceDetailData; window: TimeWindow }) {
  const root =
    detail.spans.find((span) => !span.parentSpanId || /^0+$/.test(span.parentSpanId)) ??
    detail.spans[0]
  const services = new Set(detail.spans.map((span) => span.serviceName)).size
  const errors = detail.spans.filter((span) => spanStatus(span.statusCode).tone === "error").length
  return (
    <>
      <Notice title="Window-bounded trace · possibly partial">
        Only spans and correlated logs in the selected window are shown. Missing parents or records
        outside this window can make this trace incomplete.
      </Notice>
      <section className="panel trace-overview" aria-labelledby="trace-summary">
        <div>
          <span className="eyebrow">Trace summary</span>
          <h2 id="trace-summary">{root?.name || "Trace with correlated logs"}</h2>
          <code className="trace-id">{detail.traceId}</code>
          <p className="muted">{root?.serviceName || "No spans returned in this window"}</p>
        </div>
        <dl className="trace-stats">
          <div>
            <dt>Spans returned</dt>
            <dd>
              {detail.spans.length}
              {detail.spansTruncated ? "+" : ""}
            </dd>
          </div>
          <div>
            <dt>Services returned</dt>
            <dd>{services}</dd>
          </div>
          <div>
            <dt>Error spans</dt>
            <dd className={errors ? "text-error" : ""}>{errors}</dd>
          </div>
          <div>
            <dt>Logs returned</dt>
            <dd>
              {detail.logs.length}
              {detail.logsTruncated ? "+" : ""}
            </dd>
          </div>
        </dl>
      </section>
      {detail.spansTruncated && (
        <Notice title="Span limit reached" tone="warning">
          At most 500 spans are returned. This trace is truncated; narrow the query window to
          inspect other spans.
        </Notice>
      )}
      <section className="panel" aria-labelledby="spans-title">
        <div className="panel-heading">
          <h2 id="spans-title">
            Spans <span className="count">{detail.spans.length}</span>
          </h2>
          <span className="muted">Expand a span · bars share one time scale</span>
        </div>
        {detail.spans.length ? (
          <SpanList spans={detail.spans} />
        ) : (
          <div className="section-empty">
            No spans in this window. Correlated logs are available below.{" "}
            <a href={listHref("traces", window)}>Return to traces</a> or use a wider window.
          </div>
        )}
      </section>
      {detail.logsTruncated && (
        <Notice title="Correlated log limit reached" tone="warning">
          At most 200 correlated logs are returned. Narrow the query window to inspect other logs.
        </Notice>
      )}
      <section className="panel" aria-labelledby="correlated-logs-title">
        <div className="panel-heading">
          <h2 id="correlated-logs-title">
            Correlated logs <span className="count">{detail.logs.length}</span>
          </h2>
          <a href={`${listHref("logs", window)}&traceId=${encodeURIComponent(detail.traceId)}`}>
            Open in Logs →
          </a>
        </div>
        <LogTable logs={detail.logs} window={window} correlated />
      </section>
    </>
  )
}
