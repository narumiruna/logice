import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { fixtureQuery, StackSample } from "./layout"

test("renders stack imports and runs a typed query without a browser", async () => {
  const client = new QueryClient()
  try {
    expect(await client.fetchQuery(fixtureQuery)).toBe("Stack compatibility fixture only")
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <StackSample />
      </QueryClientProvider>,
    )
    expect(html).toContain("Stack compatibility fixture only")
    expect(html).toContain("Primitive compatibility")
    expect(html).toContain("<svg")
  } finally {
    client.clear()
  }
})
