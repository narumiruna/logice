import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { useI18n } from "./i18n"
import { ProjectAlerts } from "./project-alerts"
import { type Page, type Project, projectErrorMessage, projectRequest } from "./project-api"
import { ProjectContext } from "./project-context"
import { ProjectDashboard } from "./project-dashboard"
import { localProjectPath, projectId } from "./project-path"
import { ProjectSettings } from "./project-settings"
import { ProjectSetup } from "./project-setup"
import { SavedViews } from "./saved-views"
import { AppShell } from "./shell"
import "./projects.css"

export { canManageTokens, type Project, projectRequest } from "./project-api"

export function ProjectGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const id = projectId()
  const path = typeof window === "undefined" ? "/projects" : window.location.pathname
  const local = localProjectPath(path).replace(/\/$/, "") || "/"
  const projectIndex = ["/", "/projects", "/projects/"].includes(path)
  const [projects, setProjects] = useState<Page<Project> | null>(null)
  const [selected, setSelected] = useState<Project | null>(null)
  const [error, setError] = useState<Error | string>("")
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads authorization and project metadata.
  useEffect(() => {
    const controller = new AbortController()
    setError("")
    setProjects(null)
    setSelected(null)
    void Promise.all([
      projectRequest<Page<Project>>(`?offset=${offset}`, "GET", undefined, controller.signal),
      id
        ? projectRequest<Project>(`/${id}`, "GET", undefined, controller.signal)
        : Promise.resolve(null),
    ])
      .then(([list, project]) => {
        if (
          !Array.isArray(list.items) ||
          typeof list.hasMore !== "boolean" ||
          list.items.some((item) => !validProject(item)) ||
          (project && (!validProject(project) || project.id !== id))
        )
          throw new Error("The project API returned an invalid response.")
        if (!controller.signal.aborted) {
          setProjects(list)
          setSelected(project)
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error : "Try again.")
      })
    return () => controller.abort()
  }, [id, offset, revision])
  if (selected && projects)
    return (
      <ProjectContext value={{ project: selected, projects: projects.items }}>
        <div key={id} className="project-content">
          {local === "/alerts" ? (
            <ProjectAlerts project={selected} />
          ) : local === "/views" ? (
            <SavedViews project={selected} />
          ) : local === "/setup" ? (
            <ProjectSetup project={selected} />
          ) : local === "/settings" ? (
            <ProjectSettings project={selected} />
          ) : local === "/" || local === "/dashboard" ? (
            <ProjectDashboard project={selected} />
          ) : (
            children
          )}
        </div>
      </ProjectContext>
    )
  return (
    <div className="project-content">
      <AppShell page="projects">
        <main id="main" tabIndex={-1} className="workspace-page">
          {!id && !projectIndex ? (
            <>
              <h1>{t("This page does not exist")}</h1>
              <a href="/projects">{t("Choose a project")}</a>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">{t("Workspace")}</span>
                  <h1>{t("Projects")}</h1>
                  <p>
                    {t("Organize your applications. Share access without sharing credentials.")}
                  </p>
                </div>
                <a className="button button-secondary" href="/account">
                  {t("Manage your account")}
                </a>
              </div>
              {error ? (
                <div className="workspace-error" role="alert">
                  <h2>{t("Project list unavailable")}</h2>
                  <p>
                    {t("Projects could not be loaded. {error}", {
                      error: projectErrorMessage(error, t),
                    })}
                  </p>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => setRevision((v) => v + 1)}
                  >
                    {t("Retry projects")}
                  </button>
                  <a href="/account">{t("Open account settings")}</a>
                </div>
              ) : !projects ? (
                <p className="workspace-loading" role="status">
                  {t("Loading projects…")}
                </p>
              ) : (
                <ProjectList page={projects} offset={offset} onPage={setOffset} />
              )}
            </>
          )}
        </main>
      </AppShell>
    </div>
  )
}

function validProject(project: Project): boolean {
  return Boolean(
    project &&
      typeof project.id === "string" &&
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(project.id) &&
      typeof project.name === "string" &&
      ["Owner", "Developer", "Viewer"].includes(project.role),
  )
}

function ProjectList({
  page,
  offset,
  onPage,
}: {
  page: Page<Project>
  offset: number
  onPage: (offset: number) => void
}) {
  const { t, number } = useI18n()
  const [name, setName] = useState("")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | string>("")
  const visible = page.items.filter((p) =>
    `${p.name} ${p.id} ${p.role} ${t(p.role)}`.toLowerCase().includes(search.toLowerCase()),
  )
  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const project = await projectRequest<Project>("", "POST", { name: name.trim() })
      if (!validProject(project)) throw new Error("Invalid project response.")
      window.location.assign(`/projects/${project.id}/setup`)
    } catch (error) {
      setError(error instanceof Error ? error : "Project creation failed.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="settings-card project-create">
        <div>
          <h2>{t("Create a project")}</h2>
          <p>{t("You become its Owner. Project data and ingestion tokens stay separate.")}</p>
        </div>
        <form className="project-create-form" onSubmit={(event) => void create(event)}>
          <label>
            {t("Project name")}
            <input
              value={name}
              maxLength={80}
              required
              disabled={busy}
              placeholder={t("e.g. Production API")}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="button button-primary" type="submit" disabled={busy || !name.trim()}>
            {t("Create project")}
          </button>
        </form>
        {error && <p role="alert">{projectErrorMessage(error, t)}</p>}
      </section>
      <div className="project-list-toolbar">
        <label>
          {t("Search this page")}
          <input
            aria-label={t("Search projects on this page")}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Name, project ID, or role")}
          />
        </label>
        <span>
          {t("{visible} of {total} projects on this page", {
            visible: number(visible.length),
            total: number(page.items.length),
          })}
        </span>
      </div>
      {page.items.length === 0 ? (
        <section className="workspace-empty">
          <h2>{t("No projects yet")}</h2>
          <p>{t("Create your first project, or share your account UUID with a project Owner.")}</p>
          <a href="/account">{t("Find your account UUID")}</a>
        </section>
      ) : visible.length === 0 ? (
        <section className="workspace-empty">
          <h2>{t("No matching projects on this page")}</h2>
          <button className="button button-secondary" type="button" onClick={() => setSearch("")}>
            {t("Clear search")}
          </button>
        </section>
      ) : (
        <div className="project-grid">
          {visible.map((project) => (
            <article className="project-card" key={project.id}>
              <div className="project-card-title">
                <span className="project-mark" aria-hidden="true">
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                <span className={`project-role role-${project.role.toLowerCase()}`}>
                  {t(project.role)}
                </span>
              </div>
              <h2>
                <a href={`/projects/${project.id}/dashboard`}>{project.name}</a>
              </h2>
              <code>{project.id}</code>
              <p>
                {project.role === "Owner"
                  ? t("Manage members, tokens, and project settings.")
                  : project.role === "Developer"
                    ? t("Inspect telemetry and manage ingestion tokens.")
                    : t("Inspect project telemetry with read-only access.")}
              </p>
              <div className="project-card-actions">
                <a href={`/projects/${project.id}/dashboard`}>{t("Open dashboard →")}</a>
                <a href={`/projects/${project.id}/settings`}>{t("Settings")}</a>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="workspace-pagination">
        <button
          className="button button-secondary"
          disabled={offset === 0}
          type="button"
          onClick={() => {
            setSearch("")
            onPage(offset - 100)
          }}
        >
          {t("Previous projects")}
        </button>
        <span>{t("Page {page}", { page: number(offset / 100 + 1, { useGrouping: false }) })}</span>
        <button
          className="button button-secondary"
          disabled={!page.hasMore}
          type="button"
          onClick={() => {
            setSearch("")
            onPage(offset + 100)
          }}
        >
          {t("Next projects")}
        </button>
      </div>
    </>
  )
}
