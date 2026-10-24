import type { ReactNode } from "react"
import { Glyph, type GlyphName } from "./preview/icons"
import { useProject } from "./project-context"
import { projectId, projectPath } from "./project-path"
import { ThemeSelect } from "./theme"
import "./styles.css"
import "./shell.css"

type Page =
  | "live"
  | "traces"
  | "logs"
  | "preview"
  | "projects"
  | "dashboard"
  | "settings"
  | "account"

export function AppShell({
  page,
  contentId = "main",
  tracesHref = projectPath("/traces"),
  logsHref = projectPath("/logs"),
  children,
}: {
  page?: Page
  contentId?: string
  tracesHref?: string
  logsHref?: string
  children: ReactNode
}) {
  const context = useProject()
  const preview = page === "preview"
  const project = context?.project
  const scoped =
    Boolean(project || projectId()) || page === "traces" || page === "logs" || page === "live"
  const links: { page: Page; label: string; icon: GlyphName; href: string }[] = [
    { page: "projects", label: "Projects", icon: "box", href: "/projects" },
    ...(scoped
      ? [
          {
            page: "dashboard" as const,
            label: "Dashboard",
            icon: "activity" as const,
            href: projectPath("/dashboard"),
          },
          {
            page: "live" as const,
            label: "Live",
            icon: "activity" as const,
            href: projectPath("/live"),
          },
          { page: "traces" as const, label: "Traces", icon: "layers" as const, href: tracesHref },
          { page: "logs" as const, label: "Logs", icon: "code" as const, href: logsHref },
          {
            page: "settings" as const,
            label: "Project settings",
            icon: "box" as const,
            href: projectPath("/settings"),
          },
        ]
      : []),
    { page: "account", label: "Account", icon: "box", href: "/account" },
    { page: "preview", label: "Design preview", icon: "box", href: projectPath("/preview") },
  ]
  return (
    <div className="application-shell">
      <a href={`#${contentId}`} className="skip-link">
        Skip to content
      </a>
      <a className="shell-brand" href="/projects" aria-label="Logice — Open projects">
        <span className="shell-brand-mark" aria-hidden="true">
          L
        </span>
        <span>
          Logice<span className="shell-brand-caption">Telemetry explorer</span>
        </span>
      </a>
      <header className="shell-header">
        {project && context ? (
          <label className="shell-switcher">
            <span>Project</span>
            <select
              aria-label="Project"
              value={project.id}
              onChange={(e) => window.location.assign(`/projects/${e.target.value}/traces`)}
            >
              {!context.projects.some((item) => item.id === project.id) && (
                <option value={project.id}>{project.name}</option>
              )}
              {context.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="shell-workspace">
            Workspace <span aria-hidden="true">/</span>{" "}
            <strong>{page === "account" ? "Your account" : "Project workspace"}</strong>
          </span>
        )}
        <span className="shell-badge">
          {preview
            ? "DESIGN PREVIEW"
            : project
              ? project.role
              : page === "live"
                ? "REAL TELEMETRY"
                : "Project-scoped telemetry"}
        </span>
        <ThemeSelect />
      </header>
      <aside className="shell-sidebar" aria-label="Application navigation">
        <div className="shell-project">
          <Glyph name="box" size={20} />
          <div>
            <strong>{project?.name ?? "Project workspace"}</strong>
            <span>{project ? `${project.role} access` : "Project-scoped access"}</span>
          </div>
        </div>
        <span className="shell-nav-label">Workspace</span>
        <nav>
          {links.map((link) => (
            <a
              key={link.page}
              href={link.href}
              aria-current={page === link.page ? "page" : undefined}
              title={link.label}
            >
              <Glyph name={link.icon} size={19} />
              <span>{link.label}</span>
            </a>
          ))}
        </nav>
        <div className="shell-note">
          <strong>{preview ? "Simulated data" : "Stored OpenTelemetry data"}</strong>
          <p>
            {preview
              ? "This preview does not read or write your telemetry."
              : "Project-scoped traces and logs. Access is checked on every request."}
          </p>
        </div>
      </aside>
      <div className="shell-content">{children}</div>
    </div>
  )
}
