import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { validateLiveSnapshot } from "./api"
import { Histogram } from "./histogram"

const empty = validateLiveSnapshot(
  JSON.parse(
    readFileSync(new URL("../../../tests/fixtures/live/empty.json", import.meta.url), "utf8"),
  ),
)
function render(data = structuredClone(empty), live?: boolean) {
  return renderToStaticMarkup(
    <Histogram buckets={data.histogram} window={data.window} onSelect={() => {}} live={live} />,
  )
}
function labels(markup: string) {
  return [...markup.matchAll(/<time\b[^>]*>([^<]+)<\/time>/g)].map((match) => match[1])
}

describe("stored event histogram", () => {
  it("keeps all 60 empty buckets selectable without drawing any volume", () => {
    const markup = render()
    expect(markup).toContain("Stored event histogram")
    expect(markup).toContain("<strong>0</strong> matching rows")
    expect(markup.match(/<button /g)).toHaveLength(60)
    expect(markup.match(/height:0%/g)).toHaveLength(120)
    expect(markup).toContain("Select bucket 1: 2026-10-23T00:00:00Z, 0 stored rows")
    expect(markup).toContain("Select bucket 60:")
    expect(markup).toContain("Minimum 1 second")
    expect(markup).not.toContain("Now")
    expect(markup).not.toContain("lv-hist-selection")
  })

  it("shows a current edge only when the caller supplies live mode", () => {
    expect(render()).toContain("Window end")
    expect(render()).toContain('class="lv-histogram" data-live="false"')
    expect(render(structuredClone(empty), true)).toContain("Now")
    expect(render(structuredClone(empty), true)).toContain('class="lv-histogram" data-live="true"')
  })

  it("keeps exact server counts above Number.MAX_SAFE_INTEGER and proportional error bars", () => {
    const data = structuredClone(empty)
    data.histogram[0].spans = "9007199254740993"
    data.histogram[0].logs = "2"
    data.histogram[0].errorSpans = "4503599627370496"
    data.histogram[1].spans = "18014398509481990"
    const markup = render(data)
    expect(markup).toContain("<strong>27021597764222985</strong> matching rows")
    expect(markup).toContain("9007199254740995 stored rows")
    expect(markup).toContain("9007199254740993 spans · 2 logs · 4503599627370496 errors")
    const heights = [...markup.matchAll(/height:([\d.]+)%/g)].map((match) => Number(match[1]))
    expect(heights[0]).toBeCloseTo(45)
    expect(heights[1]).toBeCloseTo(22.5)
    expect(heights[2]).toBe(90)
    expect(heights[3]).toBe(0)
  })

  it("shows five evenly spaced UTC ticks, with exact timestamps in their titles", () => {
    const markup = render()
    expect(labels(markup)).toEqual(["00:00:00", "00:00:15", "00:00:30", "00:00:45", "00:01:00"])
    expect(markup).toContain('title="2026-10-23T00:00:15.000000000Z (UTC)"')
  })

  it("keeps all five labels distinct at the minimum one-second window", () => {
    const data = structuredClone(empty)
    data.window = { from: "2026-10-23T23:59:59.000000001Z", to: "2026-10-24T00:00:00.000000001Z" }
    const markup = render(data)
    expect(labels(markup)).toEqual([
      "23:59:59.000",
      "23:59:59.250",
      "23:59:59.500",
      "23:59:59.750",
      "00:00:00.000",
    ])
    expect(markup).toContain('title="2026-10-24T00:00:00.000000001Z (UTC)"')
  })
})
