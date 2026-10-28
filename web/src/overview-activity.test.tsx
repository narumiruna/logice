import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { OverviewActivity } from "./overview-activity"

const buckets = () =>
  Array.from({ length: 60 }, (_, index) => ({
    from: new Date(Date.UTC(2026, 9, 28, 10, index)).toISOString(),
    to: new Date(Date.UTC(2026, 9, 28, 10, index + 1)).toISOString(),
    traces: "0",
    errorTraces: "0",
  }))

describe("overview activity", () => {
  it("scales large integer counters without rounding their labels or overflowing the plot", () => {
    const data = buckets()
    data[0].traces = "18446744073709551614"
    data[0].errorTraces = "9223372036854775807"
    const html = renderToStaticMarkup(<OverviewActivity buckets={data} />)
    expect(html).toContain("18,446,744,073,709,551,614")
    expect(html).toContain("9,223,372,036,854,775,807")
    expect(html).toContain('height="72"')
    expect(html).toContain('height="36"')
    expect(html).not.toMatch(/NaN|Infinity/)
  })

  it("keeps an empty series at zero without division by zero", () => {
    const html = renderToStaticMarkup(<OverviewActivity buckets={buckets()} />)
    expect(html.match(/height="0"/g)).toHaveLength(120)
    expect(html).not.toMatch(/NaN|Infinity/)
  })

  it("describes the series, UTC interval and non-additive count semantics", () => {
    const html = renderToStaticMarkup(<OverviewActivity buckets={buckets()} />)
    expect(html).toContain('role="img"')
    expect(html).toContain("Stored trace and error counts across 60 UTC buckets")
    expect(html).toContain("2026-10-28T10:00:00.000Z – 2026-10-28T10:01:00.000Z")
    expect(html).toContain("not additive")
    expect(html).toContain("10:30 UTC")
    expect(html).not.toContain("<button")
  })
})
