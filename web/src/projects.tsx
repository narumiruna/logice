import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { flushSync } from "react-dom"
import { localProjectPath, projectId } from "./project-path"
import { ThemeSelect } from "./theme"
import "./projects.css"

export interface Project {
  id: string
  name: string
  ownerId: string
  role: "Owner" | "Developer" | "Viewer"
}
interface Member {
  userId: string
  name: string
  role: Project["role"]
}
interface Token {
  id: string
  name: string
  creatorId: string
  status: string
  expiresAt: string | null
}
interface Page<T> {
  items: T[]
  hasMore: boolean
}

export function canManageTokens(role: Project["role"]): boolean {
  return role === "Owner" || role === "Developer"
}

export async function projectRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let csrf = ""
  if (method !== "GET") {
    const response = await fetch("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    })
    if (!response.ok) throw new Error("Cannot validate this request. Try again.")
    csrf = (await response.json()).csrfToken
  }
  const response = await fetch(`/api/projects${path}`, {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  if (response.status === 401) window.dispatchEvent(new Event("logice:session-expired"))
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "Project or resource is unavailable."
        : response.status === 403
          ? "Your project role does not permit this action."
          : `Project request failed (${response.status}).`,
    )
  return response.json() as Promise<T>
}

export function ProjectGate({ children }: { children: ReactNode }) {
  const id = projectId()
  const projectIndex =
    typeof window === "undefined" ||
    ["/", "/projects", "/projects/"].includes(window.location.pathname)
  const [projects, setProjects] = useState<Page<Project> | null>(null)
  const [selected, setSelected] = useState<Project | null>(null)
  const [error, setError] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [offset, setOffset] = useState(0)
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
        if (!controller.signal.aborted) {
          setProjects(list)
          setSelected(project)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Projects could not be loaded. Reload to try again.")
      })
    return () => controller.abort()
  }, [id, offset])
  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const project = await projectRequest<Project>("", "POST", { name })
      window.location.assign(`/projects/${project.id}/traces`)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Project creation failed.")
    } finally {
      setBusy(false)
    }
  }
  const settings =
    typeof window !== "undefined" && localProjectPath(window.location.href) === "/settings"
  return (
    <>
      <nav className="project-bar" aria-label="Project navigation">
        <a href="/projects">Projects</a>
        {selected && (
          <>
            <label>
              Project{" "}
              <select
                aria-label="Project"
                value={id}
                onChange={(e) => window.location.assign(`/projects/${e.target.value}/traces`)}
              >
                {!projects?.items.some((p) => p.id === id) && (
                  <option value={id}>{selected.name}</option>
                )}
                {projects?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <span>{selected.role}</span>
            {settings && <a href={`/projects/${id}/traces`}>Open telemetry</a>}
            <a href={`/projects/${id}/settings`}>Project settings</a>
          </>
        )}
        {(!selected || settings) && <ThemeSelect />}
      </nav>
      {!id && !projectIndex && (
        <main className="project-page">
          <h1>This page does not exist</h1>
          <a href="/projects">Choose a project</a>
        </main>
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
      {!projects && !error && <p role="status">Loading projects…</p>}
      {projects && !id && projectIndex && (
        <main className="project-page">
          <h1>Projects</h1>
          <p>Each project has separate telemetry, members, and ingestion tokens.</p>
          <form onSubmit={(e) => void create(e)}>
            <label>
              Project name{" "}
              <input
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button disabled={busy} type="submit">
              Create project
            </button>
          </form>
          {projects.items.length === 0 && (
            <p>No projects. Create a project or ask an Owner to add your account.</p>
          )}
          <ul>
            {projects.items.map((p) => (
              <li key={p.id}>
                <a href={`/projects/${p.id}/traces`}>{p.name}</a> — {p.role}
              </li>
            ))}
          </ul>
          <button disabled={offset === 0} type="button" onClick={() => setOffset(offset - 100)}>
            Previous projects
          </button>
          <button
            disabled={!projects.hasMore}
            type="button"
            onClick={() => setOffset(offset + 100)}
          >
            Next projects
          </button>
        </main>
      )}
      {selected &&
        (settings ? (
          <ProjectSettings key={id} project={selected} />
        ) : (
          <div key={id} className="project-content">
            {children}
          </div>
        ))}
    </>
  )
}

function ProjectSettings({ project }: { project: Project }) {
  const [members, setMembers] = useState<Page<Member> | null>(null)
  const [tokens, setTokens] = useState<Page<Token> | null>(null)
  const [secret, setSecret] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [tokenName, setTokenName] = useState("")
  const [expiry, setExpiry] = useState("")
  const [userId, setUserId] = useState("")
  const [role, setRole] = useState("Viewer")
  const [name, setName] = useState(project.name)
  const [memberOffset, setMemberOffset] = useState(0)
  const [tokenOffset, setTokenOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    // Remove the secret before a page can enter the browser back/forward cache.
    const clearSecret = () => flushSync(() => setSecret(""))
    window.addEventListener("pagehide", clearSecret)
    return () => window.removeEventListener("pagehide", clearSecret)
  }, [])
  const owner = project.role === "Owner"
  const manageTokens = canManageTokens(project.role)
  const base = `/${project.id}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: successful mutations explicitly refresh the lists.
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      projectRequest<Page<Member>>(
        `${base}/members?offset=${memberOffset}`,
        "GET",
        undefined,
        controller.signal,
      ),
      manageTokens
        ? projectRequest<Page<Token>>(
            `${base}/tokens?offset=${tokenOffset}`,
            "GET",
            undefined,
            controller.signal,
          )
        : Promise.resolve(null),
    ])
      .then(([members, tokens]) => {
        if (!controller.signal.aborted) {
          setMembers(members)
          setTokens(tokens)
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
    return () => controller.abort()
  }, [base, manageTokens, memberOffset, tokenOffset, revision])
  async function mutate(path: string, method: string, body: unknown, token = false) {
    setBusy(true)
    setError("")
    setSecret("")
    try {
      const result = await projectRequest<{ token?: string }>(`${base}${path}`, method, body)
      if (token && result.token) setSecret(result.token)
      setRevision((value) => value + 1)
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed.")
      return false
    } finally {
      setBusy(false)
    }
  }
  function confirm(message: string): boolean {
    return window.confirm(message)
  }
  return (
    <main className="project-page">
      <h1>{project.name} settings</h1>
      <p>
        Project ID: <code>{project.id}</code>
      </p>
      <p>Your role: {project.role}</p>
      {error && <p role="alert">{error}</p>}
      {owner && (
        <section>
          <h2>Project</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void mutate("", "PATCH", { name }).then((ok) => {
                if (ok) window.location.reload()
              })
            }}
          >
            <label>
              Project name{" "}
              <input
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button disabled={busy} type="submit">
              Rename project
            </button>
          </form>
        </section>
      )}
      <section>
        <h2>Members</h2>
        {owner && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void mutate("/members", "POST", { userId, role })
            }}
          >
            <label>
              Registered account UUID{" "}
              <input value={userId} required onChange={(e) => setUserId(e.target.value)} />
            </label>
            <label>
              Role{" "}
              <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option>Viewer</option>
                <option>Developer</option>
              </select>
            </label>
            <button disabled={busy} type="submit">
              Add member
            </button>
          </form>
        )}
        <ul>
          {members?.items.map((member) => (
            <li key={member.userId}>
              <strong>{member.name}</strong> <code>{member.userId}</code> — {member.role}
              {owner && member.role !== "Owner" && (
                <>
                  <label>
                    Member role{" "}
                    <select
                      disabled={busy}
                      value={member.role}
                      onChange={(e) =>
                        void mutate(`/members/${member.userId}`, "PATCH", { role: e.target.value })
                      }
                    >
                      <option>Viewer</option>
                      <option>Developer</option>
                    </select>
                  </label>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => {
                      if (confirm("Remove this member? Project tokens remain active."))
                        void mutate(`/members/${member.userId}`, "DELETE", {})
                    }}
                  >
                    Remove member
                  </button>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => {
                      if (
                        confirm("Transfer ownership to this member? You will become a Developer.")
                      )
                        void mutate("/owner", "POST", { userId: member.userId }).then((ok) => {
                          if (ok) window.location.reload()
                        })
                    }}
                  >
                    Transfer ownership
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={memberOffset === 0 || busy}
          onClick={() => setMemberOffset(memberOffset - 100)}
        >
          Previous members
        </button>
        <button
          type="button"
          disabled={!members?.hasMore || busy}
          onClick={() => setMemberOffset(memberOffset + 100)}
        >
          Next members
        </button>
      </section>
      {manageTokens && (
        <section>
          <h2>Ingestion tokens</h2>
          <p>
            Tokens belong to this project. Removing their creator does not revoke them. Tokens allow
            writes only.
          </p>
          <p>
            OTLP HTTP endpoint:{" "}
            <code>{typeof window === "undefined" ? "" : window.location.origin}</code>. Use Bearer
            authorization with your project token.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void mutate(
                "/tokens",
                "POST",
                {
                  name: tokenName,
                  expiresAt: expiry ? new Date(`${expiry}Z`).toISOString() : null,
                },
                true,
              )
            }}
          >
            <label>
              Token name{" "}
              <input
                value={tokenName}
                maxLength={80}
                required
                onChange={(e) => setTokenName(e.target.value)}
              />
            </label>
            <label>
              Expiry UTC (optional){" "}
              <input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </label>
            <button disabled={busy} type="submit">
              Create token
            </button>
          </form>
          {secret && (
            <div role="status">
              <strong>Copy this token now. It will not be shown again.</strong>
              <pre role="note" aria-label="New ingestion token">
                {secret}
              </pre>
              <button type="button" onClick={() => setSecret("")}>
                Dismiss token
              </button>
            </div>
          )}
          <ul>
            {tokens?.items.map((token) => (
              <li key={token.id}>
                <strong>{token.name}</strong> — {token.status} · expiry: {token.expiresAt ?? "none"}{" "}
                · creator: <code>{token.creatorId}</code>
                <button
                  disabled={busy || token.status === "revoked"}
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        "Revoke this project token? Applications that use it will no longer write telemetry.",
                      )
                    )
                      void mutate(`/tokens/${token.id}/revoke`, "POST", {})
                  }}
                >
                  Revoke token
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={tokenOffset === 0 || busy}
            onClick={() => setTokenOffset(tokenOffset - 100)}
          >
            Previous tokens
          </button>
          <button
            type="button"
            disabled={!tokens?.hasMore || busy}
            onClick={() => setTokenOffset(tokenOffset + 100)}
          >
            Next tokens
          </button>
        </section>
      )}
      {owner && (
        <section>
          <h2>Delete project</h2>
          <p>
            Deletion blocks access and revokes tokens. Stored telemetry remains until its normal
            retention expiry.
          </p>
          <button
            disabled={busy}
            type="button"
            onClick={() => {
              if (confirm("Delete this project and revoke all its tokens?"))
                void mutate("", "DELETE", {}).then((ok) => {
                  if (ok) window.location.assign("/projects")
                })
            }}
          >
            Delete project
          </button>
        </section>
      )}
    </main>
  )
}
