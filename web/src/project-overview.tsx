import { useEffect, useState } from "react"
import { requestJSON, type TimeWindow } from "./api"
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
    <section aria-label="Full-window telemetry statistics">
      {error && (
        <div className="workspace-error" role="alert">
          <p>{error}</p>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry statistics
          </button>
        </div>
      )}
      {!data && !error && <p role="status">Loading full-window statistics…</p>}
      {data && (
        <>
          <div className="dashboard-stats">
            <article>
              <span>Stored traces</span>
              <strong>{data.traces}</strong>
              <small>Distinct eligible trace IDs in this window</small>
            </article>
            <article>
              <span>Stored logs (deduplicated)</span>
              <strong>{data.logs}</strong>
              <small>Identical stored log content counts once</small>
            </article>
            <article>
              <span>Error trace proportion</span>
              <strong>
                {data.errorProportion === null
                  ? "—"
                  : `${(data.errorProportion * 100).toFixed(2)}%`}
              </strong>
              <small>{data.errorTraces} traces with a canonical Error span</small>
            </article>
            <article>
              <span>Root-span p50</span>
              <strong>{data.p50Ns === null ? "—" : formatDuration(data.p50Ns)}</strong>
              <small>{data.rootSpans} unambiguous exported root spans</small>
            </article>
            <article>
              <span>Root-span p95</span>
              <strong>{data.p95Ns === null ? "—" : formatDuration(data.p95Ns)}</strong>
              <small>Exact stored-duration percentile, not request latency</small>
            </article>
            <article>
              <span>Conflicting span identities</span>
              <strong>{data.conflicts}</strong>
              <small>Excluded from root latency; counts use canonical representatives</small>
            </article>
          </div>
          <details className="settings-card">
            <summary>Full-window trends (60 UTC buckets)</summary>
            <div className="table-scroll">
              <table className="data-table">
                <caption>
                  Trace counts per bucket are not additive across a trace spanning multiple buckets.
                </caption>
                <thead>
                  <tr>
                    <th>From UTC</th>
                    <th>Traces</th>
                    <th>Logs</th>
                    <th>Error traces</th>
                    <th>Root p95</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b) => (
                    <tr key={b.from}>
                      <td>
                        <a href={link(b)}>{b.from}</a>
                      </td>
                      <td>{b.traces}</td>
                      <td>{b.logs}</td>
                      <td>{b.errorTraces}</td>
                      <td>{b.p95Ns === null ? "—" : formatDuration(b.p95Ns)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="settings-hint">
            Counts cover stored matching data, not total application traffic or complete traces.
            Canonical records are assigned to their representative timestamp. Service filters choose
            matching representatives; conflict flags consider all stored variants of each retained
            identity in the window. Late exports can change results; the span and log reads are not
            a transactional snapshot. Queried {data.queriedAt}.
          </p>
        </>
      )}
    </section>
  )
}
