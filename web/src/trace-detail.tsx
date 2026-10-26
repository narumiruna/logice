import type { Span, TimeWindow, TraceDetail as TraceDetailData } from "./api"
import { Attributes, Badge, LinkedMessage, Notice, Timestamp } from "./components"
import { useI18n } from "./i18n"
import { LogTable } from "./lists"
import { formatDuration, listHref, spanDepth, spanStatus, spanTimeline } from "./telemetry"

function SpanStatusBadge({ code }: { code: Span["statusCode"] }) {
  const { t } = useI18n()
  const status = spanStatus(code)
  return (
    <Badge
      {...status}
      label={["Error", "OK", "Unset"].includes(status.label) ? t(status.label) : status.label}
    />
  )
}

function SpanRecord({ span, byId }: { span: Span; byId: Map<string, Span> }) {
  const { t } = useI18n()
  const parent = span.parentSpanId
  const hasParent = parent && !/^0+$/.test(parent)
  return (
    <div className="record-detail">
      <dl className="metadata">
        <div>
          <dt>{t("Span ID")}</dt>
          <dd>
            <code>{span.spanId}</code>
          </dd>
        </div>
        <div>
          <dt>{t("Parent span ID")}</dt>
          <dd>
            {hasParent ? (
              byId.has(parent) && parent !== span.spanId ? (
                <a className="mono" href={`#span-${parent}`}>
                  {parent}
                </a>
              ) : (
                <>
                  <code>{parent}</code> <span className="muted">{t("(parent not available)")}</span>
                </>
              )
            ) : (
              t("None recorded (root span)")
            )}
          </dd>
        </div>
        <div>
          <dt>{t("Trace ID")}</dt>
          <dd>
            <code>{span.traceId}</code>
          </dd>
        </div>
        <div>
          <dt>{t("Service")}</dt>
          <dd>{span.serviceName || t("Unknown service")}</dd>
        </div>
        <div>
          <dt>{t("Started")}</dt>
          <dd>
            <Timestamp value={span.startTime} />
          </dd>
        </div>
        <div>
          <dt>{t("Duration")}</dt>
          <dd>
            {formatDuration(span.durationNs)}{" "}
            <span className="muted">{t("({duration} ns)", { duration: span.durationNs })}</span>
          </dd>
        </div>
        <div>
          <dt>{t("Status")}</dt>
          <dd>
            <SpanStatusBadge code={span.statusCode} />
          </dd>
        </div>
        <div>
          <dt>{t("Status message")}</dt>
          <dd className="preserve-text">{span.statusMessage || t("Not recorded")}</dd>
        </div>
      </dl>
      <Attributes title={t("Resource attributes")} values={span.resourceAttributes} />
      <Attributes title={t("Span attributes")} values={span.attributes} />
    </div>
  )
}

export function SpanList({ spans }: { spans: Span[] }) {
  const { t } = useI18n()
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  const timeline = spanTimeline(spans)
  return (
    <>
      <div className="span-column-head" aria-hidden="true">
        <span>{t("Span / parent")}</span>
        <span>{t("Service")}</span>
        <span>{t("Status")}</span>
        <span>{t("Duration")}</span>
        <span>{t("Relative timing")}</span>
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
                    <strong>{span.name || t("Unnamed span")}</strong>
                    <code>{span.spanId}</code>
                    <span className="span-parent">
                      {span.parentSpanId && !/^0+$/.test(span.parentSpanId)
                        ? t("Parent: {parent}", { parent: span.parentSpanId })
                        : t("Parent: none")}
                    </span>
                  </span>
                  <span className="service-name">{span.serviceName || t("Unknown service")}</span>
                  <SpanStatusBadge code={span.statusCode} />
                  <span className="duration">{formatDuration(span.durationNs)}</span>
                  <span
                    className="timeline"
                    role="img"
                    aria-label={t("Duration {duration} on a common trace scale", {
                      duration: formatDuration(span.durationNs),
                    })}
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
  const { t, number } = useI18n()
  const root =
    detail.spans.find((span) => !span.parentSpanId || /^0+$/.test(span.parentSpanId)) ??
    detail.spans[0]
  const services = new Set(detail.spans.map((span) => span.serviceName)).size
  const errors = detail.spans.filter((span) => spanStatus(span.statusCode).tone === "error").length
  return (
    <>
      <Notice title={t("Window-bounded trace · possibly partial")}>
        {t(
          "Only spans and correlated logs in the selected window are shown. Missing parents or records outside this window can make this trace incomplete.",
        )}
      </Notice>
      <section className="panel trace-overview" aria-labelledby="trace-summary">
        <div>
          <span className="eyebrow">{t("Trace summary")}</span>
          <h2 id="trace-summary">{root?.name || t("Trace with correlated logs")}</h2>
          <code className="trace-id">{detail.traceId}</code>
          <p className="muted">{root?.serviceName || t("No spans returned in this window")}</p>
        </div>
        <dl className="trace-stats">
          <div>
            <dt>{t("Spans returned")}</dt>
            <dd>
              {detail.spansTruncated
                ? t("{count}+", { count: number(detail.spans.length, { useGrouping: false }) })
                : number(detail.spans.length, { useGrouping: false })}
            </dd>
          </div>
          <div>
            <dt>{t("Services returned")}</dt>
            <dd>{number(services, { useGrouping: false })}</dd>
          </div>
          <div>
            <dt>{t("Error spans")}</dt>
            <dd className={errors ? "text-error" : ""}>{number(errors, { useGrouping: false })}</dd>
          </div>
          <div>
            <dt>{t("Logs returned")}</dt>
            <dd>
              {detail.logsTruncated
                ? t("{count}+", { count: number(detail.logs.length, { useGrouping: false }) })
                : number(detail.logs.length, { useGrouping: false })}
            </dd>
          </div>
        </dl>
      </section>
      {detail.spansTruncated && (
        <Notice title={t("Span limit reached")} tone="warning">
          {t(
            "At most 500 spans are returned. This trace is truncated; narrow the query window to inspect other spans.",
          )}
        </Notice>
      )}
      <section className="panel" aria-labelledby="spans-title">
        <div className="panel-heading">
          <h2 id="spans-title">
            {t("Spans")}{" "}
            <span className="count">{number(detail.spans.length, { useGrouping: false })}</span>
          </h2>
          <span className="muted">{t("Expand a span · bars share one time scale")}</span>
        </div>
        {detail.spans.length ? (
          <SpanList spans={detail.spans} />
        ) : (
          <div className="section-empty">
            <LinkedMessage
              message="No spans in this window. Correlated logs are available below. {returnToTraces} or use a wider window."
              links={{
                returnToTraces: <a href={listHref("traces", window)}>{t("Return to traces")}</a>,
              }}
            />
          </div>
        )}
      </section>
      {detail.logsTruncated && (
        <Notice title={t("Correlated log limit reached")} tone="warning">
          {t(
            "At most 200 correlated logs are returned. Narrow the query window to inspect other logs.",
          )}
        </Notice>
      )}
      <section className="panel" aria-labelledby="correlated-logs-title">
        <div className="panel-heading">
          <h2 id="correlated-logs-title">
            {t("Correlated logs")}{" "}
            <span className="count">{number(detail.logs.length, { useGrouping: false })}</span>
          </h2>
          <a href={`${listHref("logs", window)}&traceId=${encodeURIComponent(detail.traceId)}`}>
            {t("Open in Logs →")}
          </a>
        </div>
        <LogTable logs={detail.logs} window={window} correlated />
      </section>
    </>
  )
}
