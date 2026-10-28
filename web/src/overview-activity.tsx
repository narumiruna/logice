import type { TimeWindow } from "./api"
import { useI18n } from "./i18n"

interface ActivityBucket extends TimeWindow {
  traces: string
  errorTraces: string
}

// Counts remain integers. Only the bounded graphical height is converted to Number.
export function OverviewActivity({ buckets }: { buckets: ActivityBucket[] }) {
  const { t, number } = useI18n()
  const max = buckets.reduce((value, bucket) => {
    const count = BigInt(bucket.traces)
    return count > value ? count : value
  }, 1n)
  const height = (count: string) => Number((BigInt(count) * 7200n) / max) / 100
  return (
    <figure className="dashboard-activity">
      <div className="dashboard-panel-heading">
        <h2>{t("Trace activity")}</h2>
        <div className="dashboard-chart-legend">
          <span>
            <i />
            {t("Traces")}
          </span>
          <span>
            <i className="is-error" />
            {t("Error traces")}
          </span>
        </div>
      </div>
      <div className="dashboard-chart-scale">
        <span>{number(max)}</span>
        <span>0</span>
      </div>
      <svg
        viewBox="0 0 960 76"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("Stored trace and error counts across 60 UTC buckets")}
      >
        <title>{t("Stored trace and error counts across 60 UTC buckets")}</title>
        <line x1="0" x2="960" y1="75" y2="75" stroke="var(--color-border)" />
        {buckets.map((bucket, index) => (
          <g key={bucket.from}>
            <title>{`${bucket.from} – ${bucket.to}: ${t("Traces")} ${number(BigInt(bucket.traces))}; ${t("Error traces")} ${number(BigInt(bucket.errorTraces))}`}</title>
            <rect
              x={index * 16 + 2}
              y={74 - height(bucket.traces)}
              width="11"
              height={height(bucket.traces)}
              fill="var(--chart-primary)"
            />
            <rect
              x={index * 16 + 2}
              y={74 - height(bucket.errorTraces)}
              width="11"
              height={height(bucket.errorTraces)}
              fill="var(--color-error)"
            />
          </g>
        ))}
      </svg>
      <div className="dashboard-chart-times" aria-hidden="true">
        <span>{new Date(buckets[0].from).toISOString().slice(11, 16)}</span>
        <span>{new Date(buckets[30].from).toISOString().slice(11, 16)} UTC</span>
        <span>{new Date(buckets[59].to).toISOString().slice(11, 16)}</span>
      </div>
      <figcaption>
        {t("Trace counts per bucket are not additive across a trace spanning multiple buckets.")}
      </figcaption>
    </figure>
  )
}
