import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { localProjectPath, projectApi, projectId, projectPath } from "./project-path"
import { canManageTokens, ProjectGate, projectRequest } from "./projects"
import { ThemeProvider } from "./theme"

const id = "11111111-1111-4111-8111-111111111111"
afterEach(() => vi.unstubAllGlobals())

describe("project scope and roles", () => {
  it("keeps the project in URLs and removes it only for local route parsing", () => {
    const href = `http://localhost/projects/${id}/traces?range=1h`
    expect(projectId(href)).toBe(id)
    expect(projectPath("/logs?limit=1", href)).toBe(`/projects/${id}/logs?limit=1`)
    expect(localProjectPath(href)).toBe("/traces")
    expect(projectId("/projects/not-a-uuid/traces")).toBe("")
    expect(() => projectApi("/traces")).toThrow("Select a project")
    vi.stubGlobal("window", { location: { href } })
    expect(projectApi("/live")).toBe(`/api/projects/${id}/live`)
  })
  it("grants token management only to Owner and Developer", () => {
    expect(canManageTokens("Owner")).toBe(true)
    expect(canManageTokens("Developer")).toBe(true)
    expect(canManageTokens("Viewer")).toBe(false)
  })
  it("does not render telemetry or credentials while project authorization loads", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ProjectGate>
          <span>private telemetry</span>
        </ProjectGate>
      </ThemeProvider>,
    )
    expect(html).toContain("Loading projects")
    expect(html).not.toContain("private telemetry")
  })
})

describe("project management client", () => {
  it("uses session credentials, CSRF, JSON and no-store for mutations", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id, token: "single-display-secret" })))
    vi.stubGlobal("fetch", fetcher)
    const result = await projectRequest<{ token: string }>(`/${id}/tokens`, "POST", { name: "app" })
    expect(result.token).toBe("single-display-secret")
    const [url, options] = fetcher.mock.calls[1]
    expect(url).toBe(`/api/projects/${id}/tokens`)
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-CSRF-Token": "csrf", "Content-Type": "application/json" },
    })
    expect(options.body).toBe('{"name":"app"}')
    expect(url).not.toContain("single-display-secret")
  })
  it("does not expose server error bodies and signals session expiry", async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal("window", { dispatchEvent })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret database failure", { status: 401 })),
    )
    await expect(projectRequest(`/${id}`)).rejects.toThrow("Project request failed (401)")
    expect(dispatchEvent).toHaveBeenCalledOnce()
  })
})
