import type { ReactNode } from "react"
import { Glyph, type GlyphName } from "./preview/icons"
import { ThemeSelect } from "./theme"
import "./styles.css"
import "./shell.css"

type Page = "live" | "traces" | "logs" | "preview"

export function AppShell({
  page,
  contentId = "main",
  tracesHref = "/traces",
  logsHref = "/logs",
  children,
}: {
  page?: Page
  contentId?: string
  tracesHref?: string
  logsHref?: string
  children: ReactNode
}) {
  const preview = page === "preview"
  const links: { page: Page; label: string; icon: GlyphName; href: string }[] = [
    { page: "live", label: "Live", icon: "activity", href: "/live" },
    { page: "traces", label: "Traces", icon: "layers", href: tracesHref },
    { page: "logs", label: "Logs", icon: "code", href: logsHref },
    { page: "preview", label: "Design preview", icon: "box", href: "/preview" },
  ]
  return (
    <div className="application-shell">
      <a href={`#${contentId}`} className="skip-link">
        Skip to content
      </a>
      <a className="shell-brand" href={tracesHref} aria-label="Logice — Open traces">
        <span className="shell-brand-mark" aria-hidden="true">
          L
        </span>
        <span>
          Logice<span className="shell-brand-caption">Telemetry explorer</span>
        </span>
      </a>
      <header className="shell-header">
        <span className="shell-workspace">
          Workspace <span aria-hidden="true">/</span> <strong>Local validation</strong>
        </span>
        <span className="shell-badge">
          {preview
            ? "DESIGN PREVIEW"
            : page === "live"
              ? "REAL TELEMETRY · LOCAL ONLY"
              : "Validation project only"}
        </span>
        <ThemeSelect />
      </header>
      <aside className="shell-sidebar" aria-label="Application navigation">
        <div className="shell-project">
          <Glyph name="box" size={20} />
          <div>
            <strong>Local validation</strong>
            <span>Single project · Local only</span>
          </div>
        </div>
        <span className="shell-nav-label">Explore</span>
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
              : "Local trace and log inspection. OpenTelemetry data via Collector."}
          </p>
        </div>
      </aside>
      <div className="shell-content">{children}</div>
    </div>
  )
}
