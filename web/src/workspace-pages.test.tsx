import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { AccountSettings } from "./account-settings"
import { type AccountActions, AccountContext } from "./auth"
import type { Project } from "./project-api"
import { ProjectContext } from "./project-context"
import { ProjectDashboard } from "./project-dashboard"
import { ProjectSettings } from "./project-settings"
import { ThemeProvider } from "./theme"

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Application",
  ownerId: "owner",
  role: "Owner",
}
const account = (admin: boolean): AccountActions => ({
  user: { id: "account-id", name: "Operator", admin },
  busy: false,
  invite: vi.fn(),
  logout: vi.fn(),
  saveName: vi.fn(),
})

describe("workspace page structure and permissions", () => {
  it.each([true, false])(
    "shows profile settings without making platform administration a project role: %s",
    (admin) => {
      const html = renderToStaticMarkup(
        <ThemeProvider>
          <AccountContext value={account(admin)}>
            <AccountSettings />
          </AccountContext>
        </ThemeProvider>,
      )
      expect(html).toContain("Account settings")
      expect(html).toContain("Display name")
      expect(html).toContain("account-id")
      expect(html).toContain("Appearance")
      expect(html).toContain("Sign out of this browser")
      expect(html.includes("Registration invitations")).toBe(admin)
      expect(html).not.toContain("Create token")
    },
  )
  it("escapes account names as text", () => {
    const value = account(false)
    value.user.name = "<script>alert(1)</script>"
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <AccountContext value={value}>
          <AccountSettings />
        </AccountContext>
      </ThemeProvider>,
    )
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })
  it("does not invent dashboard totals or empty data before a response arrives", () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
    try {
      const html = renderToStaticMarkup(
        <ThemeProvider>
          <ProjectContext value={{ project, projects: [project] }}>
            <ProjectDashboard project={project} />
          </ProjectContext>
        </ThemeProvider>,
      )
      expect(html).toContain("Loading dashboard")
      expect(html).toContain("Up to 5 most recent")
      expect(html).toContain("Sample counts are not a project-wide error rate")
      expect(html).not.toContain("No traces in this window")
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })
  it.each(["Owner", "Developer", "Viewer"] as const)(
    "keeps settings controls consistent with the %s role",
    (role) => {
      const scoped = { ...project, role }
      const html = renderToStaticMarkup(
        <ThemeProvider>
          <ProjectContext value={{ project: scoped, projects: [scoped] }}>
            <ProjectSettings project={scoped} />
          </ProjectContext>
        </ThemeProvider>,
      )
      expect(html).toContain("Project identity")
      expect(html).toContain("Members")
      expect(html.includes("Create token")).toBe(role !== "Viewer")
      expect(html.includes("Add member")).toBe(role === "Owner")
      expect(html.includes("Delete project")).toBe(role === "Owner")
      expect(html).toContain("Loading project settings")
    },
  )
})
