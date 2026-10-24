import { describe, expect, it } from "vitest"
import { validateOverview } from "./project-overview"

const window = { from: "2026-10-24T00:00:00Z", to: "2026-10-24T01:00:00Z" }
function empty() {
  const stats = {
    traces: "0",
    logs: "0",
    errorTraces: "0",
    rootSpans: "0",
    conflicts: "0",
    p50Ns: null,
    p95Ns: null,
    errorProportion: null,
  }
  return {
    ...window,
    ...stats,
    queriedAt: window.to,
    buckets: Array.from({ length: 60 }, (_, i) => ({
      ...stats,
      from: new Date(Date.parse(window.from) + i * 60_000).toISOString(),
      to: new Date(Date.parse(window.from) + (i + 1) * 60_000).toISOString(),
    })),
  }
}
describe("overview validation", () => {
  it("accepts a complete empty population without inventing zero latency or a healthy rate", () => {
    const result = validateOverview(empty(), window)
    expect(result.p95Ns).toBeNull()
    expect(result.errorProportion).toBeNull()
  })
  it("rejects partial buckets, changed scope windows, malformed counters and fake healthy empties", () => {
    const base = empty()
    for (const bad of [
      { ...base, buckets: base.buckets.slice(1) },
      { ...base, from: "2026-10-23T00:00:00Z" },
      { ...base, traces: "NaN" },
      { ...base, p95Ns: "0" },
      { ...base, errorProportion: 0 },
    ])
      expect(() => validateOverview(bad, window)).toThrow()
  })
})
