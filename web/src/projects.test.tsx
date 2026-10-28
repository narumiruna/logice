import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "./api"
import { translate } from "./i18n"
import { projectErrorMessage } from "./project-api"
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
  it.each([
    [401, `/${id}`, "Project request failed (401).", "project_request_failed"],
    [403, `/${id}`, "Your project role does not permit this action.", "project_access_failed"],
    [
      404,
      "",
      "Project API unavailable. Deploy matching API/web versions and apply the project migration.",
      "project_access_failed",
    ],
    [
      404,
      "?offset=100",
      "Project API unavailable. Deploy matching API/web versions and apply the project migration.",
      "project_access_failed",
    ],
    [404, `/${id}`, "Project or resource is unavailable.", "project_access_failed"],
    [409, `/${id}`, "Project request failed (409).", "project_request_failed"],
    [500, `/${id}`, "Project request failed (500).", "project_request_failed"],
    [503, `/${id}`, "Project request failed (503).", "project_request_failed"],
  ] as const)(
    "retains safe error metadata for status %s at %s",
    async (status, path, message, code) => {
      const dispatchEvent = vi.fn()
      vi.stubGlobal("window", { dispatchEvent })
      const response = new Response("secret database failure", { status })
      const readBody = vi.spyOn(response, "json")
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
      const error = await projectRequest(path).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status, message, code })
      expect(readBody).not.toHaveBeenCalled()
      expect(dispatchEvent).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
      expect(
        projectErrorMessage(error as Error, (key, values) => translate("en", key, values)),
      ).toBe(message)
      const translated = projectErrorMessage(error as Error, (key, values) =>
        translate("it", key, values),
      )
      expect(translated).toBe(
        code === "project_request_failed"
          ? translate("it", "Project request failed ({status}).", { status })
          : translate("it", message),
      )
      expect(translated).not.toContain("secret database failure")
    },
  )
  it("formats status metadata without parsing error wording and preserves local messages", () => {
    const t = (key: string, values?: Parameters<typeof translate>[2]) =>
      translate("it", key, values)
    expect(
      projectErrorMessage(new ApiError("Different wording", 502, "project_request_failed"), t),
    ).toBe(t("Project request failed ({status}).", { status: 502 }))
    expect(projectErrorMessage(new Error("Invalid project response."), t)).toBe(
      t("Invalid project response."),
    )
    expect(projectErrorMessage("View saved.", t)).toBe(t("View saved."))
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
