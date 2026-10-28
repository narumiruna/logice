import { type ReactNode, useEffect, useRef } from "react"
import { LanguageSelect, useI18n } from "./i18n"
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
  | "setup"
  | "views"
  | "alerts"

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
  const { t } = useI18n()
  const context = useProject()
  const navigation = useRef<HTMLDialogElement>(null)
  const menu = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 701px)")
    const closeOnDesktop = () => {
      if (desktop.matches) navigation.current?.close()
    }
    desktop.addEventListener("change", closeOnDesktop)
    return () => desktop.removeEventListener("change", closeOnDesktop)
  }, [])
  const preview = page === "preview"
  const project = context?.project
  const scoped =
    Boolean(project || projectId()) || page === "traces" || page === "logs" || page === "live"
  const links: { page: Page; label: string; icon: GlyphName; href: string }[] = [
    { page: "projects", label: t("Projects"), icon: "box", href: "/projects" },
    ...(scoped
      ? [
          {
            page: "dashboard" as const,
            label: t("Dashboard"),
            icon: "activity" as const,
            href: projectPath("/dashboard"),
          },
          {
            page: "live" as const,
            label: t("Live"),
            icon: "activity" as const,
            href: projectPath("/live"),
          },
          {
            page: "traces" as const,
            label: t("Traces"),
            icon: "layers" as const,
            href: tracesHref,
          },
          { page: "logs" as const, label: t("Logs"), icon: "code" as const, href: logsHref },
          {
            page: "settings" as const,
            label: t("Project settings"),
            icon: "box" as const,
            href: projectPath("/settings"),
          },
        ]
      : []),
    ...(scoped
      ? [
          {
            page: "setup" as const,
            label: t("Connect application"),
            icon: "box" as const,
            href: projectPath("/setup"),
          },
        ]
      : []),
    ...(scoped
      ? [
          {
            page: "views" as const,
            label: t("Saved views"),
            icon: "layers" as const,
            href: projectPath("/views"),
          },
        ]
      : []),
    ...(scoped
      ? [
          {
            page: "alerts" as const,
            label: t("Alerts"),
            icon: "activity" as const,
            href: projectPath("/alerts"),
          },
        ]
      : []),
    { page: "account", label: t("Account"), icon: "box", href: "/account" },
    { page: "preview", label: t("Design preview"), icon: "box", href: projectPath("/preview") },
  ]
  const navigationLinks = (
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
  )
  return (
    <div className="application-shell">
      <a href={`#${contentId}`} className="skip-link">
        {t("Skip to content")}
      </a>
      <a className="shell-brand" href="/projects" aria-label={t("Logice — Open projects")}>
        <span className="shell-brand-mark" aria-hidden="true">
          L
        </span>
        <span>
          Logice<span className="shell-brand-caption">{t("Telemetry explorer")}</span>
        </span>
      </a>
      <button
        ref={menu}
        className="shell-menu-button"
        type="button"
        aria-label={t("Application navigation")}
        aria-haspopup="dialog"
        aria-controls="mobile-navigation"
        onClick={() => navigation.current?.showModal()}
      >
        <Glyph name="menu" size={24} />
      </button>
      <dialog
        ref={navigation}
        id="mobile-navigation"
        className="shell-mobile-navigation"
        aria-label={t("Application navigation")}
        onClose={() => menu.current?.focus()}
      >
        <div className="shell-navigation-heading">
          <strong>{t("Application navigation")}</strong>
          <button
            type="button"
            aria-label={t("Close navigation")}
            onClick={() => navigation.current?.close()}
          >
            <Glyph name="close" size={22} />
          </button>
        </div>
        <div className="shell-sidebar">{navigationLinks}</div>
      </dialog>
      <header className="shell-header">
        {project && context ? (
          <label className="shell-switcher">
            <span>{t("Project")}</span>
            <select
              aria-label={t("Project")}
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
            {" "}
            {t("Workspace")} <span aria-hidden="true">/</span>{" "}
            <strong>{page === "account" ? t("Your account") : t("Project workspace")}</strong>
          </span>
        )}
        <span className="shell-badge">
          {preview
            ? t("DESIGN PREVIEW")
            : project
              ? t(project.role)
              : page === "live"
                ? t("REAL TELEMETRY")
                : t("Project-scoped telemetry")}
        </span>
        <LanguageSelect />
        <ThemeSelect />
      </header>
      <aside className="shell-sidebar" aria-label={t("Application navigation")}>
        <div className="shell-project">
          <Glyph name="box" size={20} />
          <div>
            <strong>{project?.name ?? t("Project workspace")}</strong>
            <span>
              {project ? t("{role} access", { role: t(project.role) }) : t("Project-scoped access")}
            </span>
          </div>
        </div>
        <span className="shell-nav-label">{t("Workspace")}</span>
        {navigationLinks}
        <div className="shell-note">
          <strong>{preview ? t("Simulated data") : t("Stored OpenTelemetry data")}</strong>
          <p>
            {preview
              ? t("This preview does not read or write your telemetry.")
              : t("Project-scoped traces and logs. Access is checked on every request.")}
          </p>
        </div>
      </aside>
      <div className="shell-content">{children}</div>
    </div>
  )
}
