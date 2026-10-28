import { useEffect, useState } from "react"
import { requestJSON, type TimeWindow } from "./api"
import { useI18n } from "./i18n"
import { OverviewActivity } from "./overview-activity"
import { canManageTokens, type Project } from "./project-api"
import { projectApi, projectPath } from "./project-path"
import { formatDuration, listHref, timestampNs } from "./telemetry"

interface Stats {
  traces: string
  logs: string
  errorTraces: string
  rootSpans: string
  conflicts: string
  p50Ns: string | null
  p95Ns: string | null
  errorProportion: number | null
}
interface Overview extends Stats, TimeWindow {
  queriedAt: string
  buckets: (Stats & TimeWindow)[]
}
function validStats(v: Stats): boolean {
  if (
    !v ||
    ![v.traces, v.logs, v.errorTraces, v.rootSpans, v.conflicts].every(
      (s) => typeof s === "string" && /^(0|[1-9]\d{0,19})$/.test(s),
    )
  )
    return false
  return (
    [v.p50Ns, v.p95Ns].every(
      (s) => s === null || (typeof s === "string" && /^\d{1,20}$/.test(s)),
    ) &&
    (v.errorProportion === null ||
      (Number.isFinite(v.errorProportion) && v.errorProportion >= 0 && v.errorProportion <= 1)) &&
    (v.traces !== "0" || v.errorProportion === null) &&
    (v.rootSpans !== "0" || (v.p50Ns === null && v.p95Ns === null))
  )
}
export function validateOverview(v: Overview, window: TimeWindow): Overview {
  if (
    !validStats(v) ||
    timestampNs(v.from) !== timestampNs(window.from) ||
    timestampNs(v.to) !== timestampNs(window.to) ||
    !Array.isArray(v.buckets) ||
    v.buckets.length !== 60 ||
    timestampNs(v.queriedAt) === null
  )
    throw new Error("Invalid overview response.")
  let previous = timestampNs(window.from)
  for (const b of v.buckets) {
    const end = timestampNs(b.to)
    if (
      !validStats(b) ||
      timestampNs(b.from) !== previous ||
      end === null ||
      previous === null ||
      end <= previous
    )
      throw new Error("Invalid overview buckets.")
    previous = end
  }
  if (previous !== timestampNs(window.to)) throw new Error("Incomplete overview buckets.")
  return v
}
export function ProjectOverview({
  window,
  service,
  project,
}: {
  window: TimeWindow
  service: string
  project: Project
}) {
  const { t, number } = useI18n()
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the same window.
  useEffect(() => {
    const c = new AbortController()
    setData(null)
    setError("")
    const q = new URLSearchParams({ ...window, ...(service ? { service } : {}) })
    void requestJSON<Overview>(`${projectApi("/overview")}?${q}`, c.signal)
      .then((result) => {
        const value = validateOverview(result, window)
        if (!c.signal.aborted) setData(value)
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError(
            "Full-window statistics are unavailable. No sample or partial count is substituted.",
          )
      })
    return () => c.abort()
  }, [window, service, retry])
  const link = (kind: "traces" | "logs", w: TimeWindow = window) =>
    `${listHref(kind, w)}${service ? `&service=${encodeURIComponent(service)}` : ""}`
  return (
    <section className="dashboard-overview" aria-label={t("Full-window telemetry statistics")}>
      {error && (
        <div className="workspace-error" role="alert">
          <p>{t(error)}</p>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setRetry((n) => n + 1)}
          >
            {t("Retry statistics")}
          </button>
        </div>
      )}
      {!data && !error && <p role="status">{t("Loading full-window statistics…")}</p>}
      {data && (
        <>
          {data.traces === "0" && data.logs === "0" && (
            <div className="dashboard-onboarding">
              <div>
                <h2>
                  {service
                    ? t("No telemetry matches this service in this window.")
                    : t("No stored telemetry in this window")}
                </h2>
                <p>
                  {service
                    ? t("Try another service or a wider time range.")
                    : t("Connect an application or widen the time range.")}
                </p>
              </div>
              <a className="button button-primary" href={projectPath("/setup")}>
                {t("Connect application")}
              </a>
              {!service && canManageTokens(project.role) && (
                <a href={projectPath("/settings#tokens")}>{t("Manage ingestion tokens")}</a>
              )}
              {!canManageTokens(project.role) && (
                <p>{t("Ask an Owner or Developer for an ingestion token.")}</p>
              )}
            </div>
          )}
          <div className="dashboard-stats">
            <article>
              <a href={link("traces")}>
                <span>{t("Stored traces")}</span>
                <strong>{number(BigInt(data.traces))}</strong>
              </a>
            </article>
            <article>
              <a href={link("logs")}>
                <span>{t("Stored logs (deduplicated)")}</span>
                <strong>{number(BigInt(data.logs))}</strong>
              </a>
            </article>
            <article className={data.errorTraces !== "0" ? "has-errors" : undefined}>
              <a href={`${link("traces")}&errorsOnly=true`}>
                <span>{t("Error trace proportion")}</span>
                <strong>
                  {data.errorProportion === null
                    ? "—"
                    : number(data.errorProportion, {
                        style: "percent",
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                </strong>
              </a>
            </article>
            <article>
              <span>{t("Root span duration (p95)")}</span>
              <strong>{data.p95Ns === null ? "—" : formatDuration(data.p95Ns)}</strong>
            </article>
          </div>
          <p className="dashboard-qualification">
            {t("Stored matching data, not total application traffic.")}
          </p>
          {data.traces !== "0" && <OverviewActivity buckets={data.buckets} />}
          <div className="dashboard-disclosures">
            <details className="dashboard-definitions">
              <summary>{t("Metric definitions")}</summary>
              <dl>
                <div>
                  <dt>{t("Stored traces")}</dt>
                  <dd>{t("Distinct eligible trace IDs in this window")}</dd>
                </div>
                <div>
                  <dt>{t("Stored logs (deduplicated)")}</dt>
                  <dd>{t("Identical stored log content counts once")}</dd>
                </div>
                <div>
                  <dt>{t("Error trace proportion")}</dt>
                  <dd>
                    {t("{count} traces with a canonical Error span", {
                      count: number(BigInt(data.errorTraces)),
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t("Root span duration (p50)")}</dt>
                  <dd>{data.p50Ns === null ? "—" : formatDuration(data.p50Ns)}</dd>
                </div>
                <div>
                  <dt>{t("Root span duration (p95)")}</dt>
                  <dd>
                    {t("Exact stored-duration percentile, not request latency")} ·{" "}
                    {t("{count} unambiguous exported root spans", {
                      count: number(BigInt(data.rootSpans)),
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t("Conflicting span identities")}</dt>
                  <dd>
                    {number(BigInt(data.conflicts))} ·{" "}
                    {t(
                      "Excluded from root span duration statistics; counts use canonical representatives",
                    )}
                  </dd>
                </div>
              </dl>
              <p>
                {t(
                  "Counts cover stored matching data, not total application traffic or complete traces. Canonical records are assigned to their representative timestamp. Service filters choose matching representatives; conflict flags consider all stored variants of each retained identity in the window. Late exports can change results; the span and log reads are not a transactional snapshot. Queried {date}.",
                  { date: data.queriedAt },
                )}
              </p>
            </details>
            <details className="dashboard-buckets">
              <summary>{t("Full-window trends (60 UTC buckets)")}</summary>
              <div className="table-scroll">
                <table className="data-table">
                  <caption>
                    {t(
                      "Trace counts per bucket are not additive across a trace spanning multiple buckets.",
                    )}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("From UTC")}</th>
                      <th scope="col">{t("Traces")}</th>
                      <th scope="col">{t("Logs")}</th>
                      <th scope="col">{t("Error traces")}</th>
                      <th scope="col">{t("Root span duration (p95)")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((b) => (
                      <tr key={b.from}>
                        <td>
                          <a href={link("traces", b)}>{b.from}</a>
                        </td>
                        <td>{number(BigInt(b.traces))}</td>
                        <td>{number(BigInt(b.logs))}</td>
                        <td>{number(BigInt(b.errorTraces))}</td>
                        <td>{b.p95Ns === null ? "—" : formatDuration(b.p95Ns)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </>
      )}
    </section>
  )
}
