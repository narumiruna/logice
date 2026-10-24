import { describe, expect, it } from "vitest"
import { captureView, liveDisplay, viewHref } from "./view-definition"

const id = "11111111-1111-4111-8111-111111111111"
describe("typed saved views", () => {
  it.each(["traces", "logs"])(
    "roundtrips committed %s filters and resolves relative time on apply",
    (kind) => {
      const d = captureView(
        `http://local/projects/${id}/${kind}?range=6h&service=api&search=timeout&limit=25`,
      )
      const href = viewHref(d, id, Date.parse("2026-10-24T12:00:00Z"))
      const url = new URL(href, "http://local")
      expect(url.pathname).toBe(`/projects/${id}/${kind}`)
      expect(url.searchParams.get("from")).toBe("2026-10-24T06:00:00.000Z")
      expect(url.searchParams.get("service")).toBe("api")
      expect(url.searchParams.get("limit")).toBe("25")
    },
  )
  it("preserves fixed nanosecond bounds", () => {
    const from = "2026-10-24T00:00:00.000000123Z"
    const to = "2026-10-24T00:00:01.000000456Z"
    const d = captureView(
      `http://local/projects/${id}/logs?from=${from}&to=${to}&traceId=${"1".repeat(32)}`,
    )
    const url = new URL(viewHref(d, id), "http://local")
    expect(url.searchParams.get("from")).toBe(from)
    expect(url.searchParams.get("to")).toBe(to)
  })
  it("keeps Live paused and restores column/follow preferences", () => {
    const d = captureView(`http://local/projects/${id}/live?mode=paused&range=5m`, {
      headers: false,
      follow: false,
      autoExpand: true,
    })
    const href = viewHref(d, id)
    expect(new URL(href, "http://local").searchParams.get("mode")).toBe("paused")
    expect(liveDisplay(new URL(href, "http://local").hash)).toEqual(d.display)
  })
  it("uses the owning project, never a supplied URL override", () => {
    const d = captureView(`http://local/projects/${id}/traces`)
    const other = "22222222-2222-4222-8222-222222222222"
    expect(viewHref(d, other)).toMatch(new RegExp(`^/projects/${other}/traces`))
    expect(() => viewHref({ ...d, url: "https://evil.example" }, id)).toThrow()
    expect(() => viewHref({ ...d, projectId: other }, id)).toThrow()
  })
  it("rejects unknown versions, unsupported fields, invalid filters and invalid fixed windows", () => {
    const d = captureView(`http://local/projects/${id}/traces`)
    for (const bad of [
      { ...d, version: 2 },
      { ...d, sql: "SELECT *" },
      { ...d, kind: "detail" },
      { ...d, filters: { ...d.filters, limit: 101 } },
      { ...d, time: { mode: "fixed", range: "", from: "not UTC", to: "not UTC" } },
    ])
      expect(() => viewHref(bad, id)).toThrow()
  })
})
