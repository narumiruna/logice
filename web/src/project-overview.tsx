import { useEffect, useState } from "react"
import { requestJSON, type TimeWindow } from "./api"
import { useI18n } from "./i18n"
import { projectApi } from "./project-path"
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
export function ProjectOverview({ window, service }: { window: TimeWindow; service: string }) {
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
  const link = (w: TimeWindow) =>
    `${listHref("traces", w)}${service ? `&service=${encodeURIComponent(service)}` : ""}`
  return (
    <section aria-label={t("Full-window telemetry statistics")}>
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
          <div className="dashboard-stats">
            <article>
              <span>{t("Stored traces")}</span>
              <strong>{number(BigInt(data.traces), { useGrouping: false })}</strong>
              <small>{t("Distinct eligible trace IDs in this window")}</small>
            </article>
            <article>
              <span>{t("Stored logs (deduplicated)")}</span>
              <strong>{number(BigInt(data.logs), { useGrouping: false })}</strong>
              <small>{t("Identical stored log content counts once")}</small>
            </article>
            <article>
              <span>{t("Error trace proportion")}</span>
              <strong>
                {data.errorProportion === null
                  ? "—"
                  : number(Number((data.errorProportion * 100).toFixed(2)) / 100, {
                      style: "percent",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                      useGrouping: false,
                    })}
              </strong>
              <small>
                {t("{count} traces with a canonical Error span", {
                  count: number(BigInt(data.errorTraces), { useGrouping: false }),
                })}
              </small>
            </article>
            <article>
              <span>{t("Root-span p50")}</span>
              <strong>{data.p50Ns === null ? "—" : formatDuration(data.p50Ns)}</strong>
              <small>
                {t("{count} unambiguous exported root spans", {
                  count: number(BigInt(data.rootSpans), { useGrouping: false }),
                })}
              </small>
            </article>
            <article>
              <span>{t("Root-span p95")}</span>
              <strong>{data.p95Ns === null ? "—" : formatDuration(data.p95Ns)}</strong>
              <small>{t("Exact stored-duration percentile, not request latency")}</small>
            </article>
            <article>
              <span>{t("Conflicting span identities")}</span>
              <strong>{number(BigInt(data.conflicts), { useGrouping: false })}</strong>
              <small>{t("Excluded from root latency; counts use canonical representatives")}</small>
            </article>
          </div>
          <details className="settings-card">
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
                    <th>{t("From UTC")}</th>
                    <th>{t("Traces")}</th>
                    <th>{t("Logs")}</th>
                    <th>{t("Error traces")}</th>
                    <th>{t("Root p95")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b) => (
                    <tr key={b.from}>
                      <td>
                        <a href={link(b)}>{b.from}</a>
                      </td>
                      <td>{number(BigInt(b.traces), { useGrouping: false })}</td>
                      <td>{number(BigInt(b.logs), { useGrouping: false })}</td>
                      <td>{number(BigInt(b.errorTraces), { useGrouping: false })}</td>
                      <td>{b.p95Ns === null ? "—" : formatDuration(b.p95Ns)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="settings-hint">
            {t(
              "Counts cover stored matching data, not total application traffic or complete traces. Canonical records are assigned to their representative timestamp. Service filters choose matching representatives; conflict flags consider all stored variants of each retained identity in the window. Late exports can change results; the span and log reads are not a transactional snapshot. Queried {date}.",
              { date: data.queriedAt },
            )}
          </p>
        </>
      )}
    </section>
  )
}
