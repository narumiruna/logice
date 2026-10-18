import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { App } from "./app"

describe("App", () => {
  it("renders the application shell without a browser or API", () => {
    const html = renderToStaticMarkup(<App />)

    expect(html).toBe(
      "<main><h1>Logice</h1><p>Application foundation. Telemetry views are not available yet.</p></main>",
    )
  })
})
