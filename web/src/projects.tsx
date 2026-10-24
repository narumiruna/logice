import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { type Page, type Project, projectRequest } from "./project-api"
import { ProjectContext } from "./project-context"
import { ProjectDashboard } from "./project-dashboard"
import { localProjectPath, projectId } from "./project-path"
import { ProjectSettings } from "./project-settings"
import { AppShell } from "./shell"
import "./projects.css"

export { canManageTokens, type Project, projectRequest } from "./project-api"

export function ProjectGate({ children }: { children: ReactNode }) {
  const id = projectId()
  const path = typeof window === "undefined" ? "/projects" : window.location.pathname
  const local = localProjectPath(path).replace(/\/$/, "") || "/"
  const projectIndex = ["/", "/projects", "/projects/"].includes(path)
  const [projects, setProjects] = useState<Page<Project> | null>(null)
  const [selected, setSelected] = useState<Project | null>(null)
  const [error, setError] = useState("")
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
        if (!controller.signal.aborted)
          setError(
            `Projects could not be loaded. ${error instanceof Error ? error.message : "Try again."}`,
          )
      })
    return () => controller.abort()
  }, [id, offset, revision])
  if (selected && projects)
    return (
      <ProjectContext value={{ project: selected, projects: projects.items }}>
        <div key={id} className="project-content">
          {local === "/settings" ? (
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
              <h1>This page does not exist</h1>
              <a href="/projects">Choose a project</a>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">Workspace</span>
                  <h1>Projects</h1>
                  <p>Organize your applications. Share access without sharing credentials.</p>
                </div>
                <a className="button button-secondary" href="/account">
                  Manage your account
                </a>
              </div>
              {error ? (
                <div className="workspace-error" role="alert">
                  <h2>Project list unavailable</h2>
                  <p>{error}</p>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => setRevision((v) => v + 1)}
                  >
                    Retry projects
                  </button>
                  <a href="/account">Open account settings</a>
                </div>
              ) : !projects ? (
                <p className="workspace-loading" role="status">
                  Loading projects…
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
  const [name, setName] = useState("")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const visible = page.items.filter((p) =>
    `${p.name} ${p.id} ${p.role}`.toLowerCase().includes(search.toLowerCase()),
  )
  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const project = await projectRequest<Project>("", "POST", { name: name.trim() })
      if (!validProject(project)) throw new Error("Invalid project response.")
      window.location.assign(`/projects/${project.id}/dashboard`)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Project creation failed.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="settings-card project-create">
        <div>
          <h2>Create a project</h2>
          <p>You become its Owner. Project data and tokens stay separate.</p>
        </div>
        <form className="project-create-form" onSubmit={(event) => void create(event)}>
          <label>
            Project name
            <input
              value={name}
              maxLength={80}
              required
              disabled={busy}
              placeholder="e.g. Production API"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="button button-primary" type="submit" disabled={busy || !name.trim()}>
            Create project
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
      <div className="project-list-toolbar">
        <label>
          Search this page
          <input
            aria-label="Search projects on this page"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, project ID, or role"
          />
        </label>
        <span>
          {visible.length} of {page.items.length} projects on this page
        </span>
      </div>
      {page.items.length === 0 ? (
        <section className="workspace-empty">
          <h2>No projects yet</h2>
          <p>Create your first project, or share your account UUID with a project Owner.</p>
          <a href="/account">Find your account UUID</a>
        </section>
      ) : visible.length === 0 ? (
        <section className="workspace-empty">
          <h2>No matching projects on this page</h2>
          <button className="button button-secondary" type="button" onClick={() => setSearch("")}>
            Clear search
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
                  {project.role}
                </span>
              </div>
              <h2>
                <a href={`/projects/${project.id}/dashboard`}>{project.name}</a>
              </h2>
              <code>{project.id}</code>
              <p>
                {project.role === "Owner"
                  ? "Manage members, tokens, and project settings."
                  : project.role === "Developer"
                    ? "Inspect telemetry and manage ingestion tokens."
                    : "Inspect project telemetry with read-only access."}
              </p>
              <div className="project-card-actions">
                <a href={`/projects/${project.id}/dashboard`}>Open dashboard →</a>
                <a href={`/projects/${project.id}/settings`}>Settings</a>
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
          Previous projects
        </button>
        <span>Page {offset / 100 + 1}</span>
        <button
          className="button button-secondary"
          disabled={!page.hasMore}
          type="button"
          onClick={() => {
            setSearch("")
            onPage(offset + 100)
          }}
        >
          Next projects
        </button>
      </div>
    </>
  )
}
