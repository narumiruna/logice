import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { validateLiveSnapshot } from "./api"
import { Inspector } from "./inspector"

const fixture = validateLiveSnapshot(
  JSON.parse(
    readFileSync(new URL("../../../tests/fixtures/live/records.json", import.meta.url), "utf8"),
  ),
)
const project = "11111111-1111-4111-8111-111111111111"
afterEach(() => vi.unstubAllGlobals())

describe("Live inspector trace links", () => {
  it.each(["", "broken", "0".repeat(16)])(
    "links a log to its recorded trace independently of span ID %j",
    (spanId) => {
      vi.stubGlobal("window", { location: { href: `http://local/projects/${project}/live` } })
      const record = { ...fixture.logs[0], spanId }
      const markup = renderToStaticMarkup(
        <Inspector record={record} window={fixture.window} outside={false} onClose={() => {}} />,
      )
      const query = new URLSearchParams({ ...fixture.window }).toString().replaceAll("&", "&amp;")
      expect(markup).toContain(
        `<a href="/projects/${project}/traces/${record.traceId}?${query}">${record.traceId}</a>`,
      )
    },
  )
  it("does not link a malformed span identity", () => {
    const record = { ...fixture.spans[0], spanId: "" }
    const markup = renderToStaticMarkup(
      <Inspector record={record} window={fixture.window} outside={false} onClose={() => {}} />,
    )
    expect(markup).not.toContain("<a ")
  })
  it("does not link an invalid log trace ID", () => {
    const record = { ...fixture.logs[0], traceId: "0".repeat(32), spanId: "" }
    const markup = renderToStaticMarkup(
      <Inspector record={record} window={fixture.window} outside={false} onClose={() => {}} />,
    )
    expect(markup).not.toContain("<a ")
  })
})
