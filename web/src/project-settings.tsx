import { useEffect, useState } from "react"
import { flushSync } from "react-dom"
import {
  canManageTokens,
  type Member,
  type Page,
  type Project,
  projectRequest,
  type Token,
} from "./project-api"
import { ProjectAudit } from "./project-audit"
import { AppShell } from "./shell"

export function ProjectSettings({ project }: { project: Project }) {
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
  const [section, setSection] = useState(() =>
    typeof window === "undefined" ? "#general" : window.location.hash || "#general",
  )
  useEffect(() => {
    const change = () => setSection(window.location.hash || "#general")
    // The project gate mounts this page after the browser's initial anchor lookup.
    const id = window.location.hash.slice(1)
    if (["general", "members", "tokens", "danger", "audit"].includes(id))
      document.getElementById(id)?.scrollIntoView()
    window.addEventListener("hashchange", change)
    return () => window.removeEventListener("hashchange", change)
  }, [])
  const owner = project.role === "Owner"
  const manageTokens = canManageTokens(project.role)
  const base = `/${project.id}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: successful mutations explicitly refresh the lists.
  useEffect(() => {
    const controller = new AbortController()
    setMembers(null)
    setTokens(null)
    setError("")
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
    <AppShell page="settings">
      <main id="main" tabIndex={-1} className="workspace-page project-settings">
        <div className="page-heading">
          <div>
            <span className="eyebrow">Project / Settings</span>
            <h1>{project.name} settings</h1>
            <p>Manage project identity, team access, and application credentials.</p>
          </div>
          <a className="button button-secondary" href={`/projects/${project.id}/dashboard`}>
            Open dashboard
          </a>
        </div>
        <nav className="settings-tabs" aria-label="Project settings sections">
          <a href="#general" aria-current={section === "#general" ? "location" : undefined}>
            General
          </a>
          <a href="#members" aria-current={section === "#members" ? "location" : undefined}>
            Members
          </a>
          {manageTokens && (
            <a href="#tokens" aria-current={section === "#tokens" ? "location" : undefined}>
              Tokens
            </a>
          )}
          {owner && (
            <a href="#danger" aria-current={section === "#danger" ? "location" : undefined}>
              Danger zone
            </a>
          )}
        </nav>
        {owner && <a href="#audit">Audit history</a>}
        <section id="general" className="settings-card">
          <div className="settings-card-heading">
            <h2>Project identity</h2>
            <p>Stable identifiers keep your telemetry and credentials scoped to this project.</p>
          </div>
          <p>
            Project ID: <code>{project.id}</code>
          </p>
          <p>Your role: {project.role}</p>
          <a href={`/projects/${project.id}/setup`}>Connect an application to this project</a> ·{" "}
          <a href={`/projects/${project.id}/alerts`}>Manage alerts</a>
        </section>
        {error && (
          <div className="workspace-error" role="alert">
            <p>{error}</p>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setRevision((v) => v + 1)}
            >
              Retry settings
            </button>
          </div>
        )}
        {!members && !error && (
          <p className="workspace-loading" role="status">
            Loading project settings…
          </p>
        )}
        {owner && (
          <section className="settings-card">
            <h2>Project name</h2>
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
        <section id="members" className="settings-card">
          <div className="settings-card-heading">
            <h2>Members</h2>
            <p>
              Owners manage membership. Developers manage ingestion tokens. Viewers inspect
              telemetry.
            </p>
          </div>
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
                          void mutate(`/members/${member.userId}`, "PATCH", {
                            role: e.target.value,
                          })
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
          <section id="tokens" className="settings-card">
            <div className="settings-card-heading">
              <h2>Ingestion tokens</h2>
              <p>
                Separate credentials for your applications. A browser session is not an ingestion
                credential.
              </p>
            </div>
            <p>
              Tokens belong to this project. Removing their creator does not revoke them. Tokens
              allow writes only.
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
              <div className="secret-card" role="status">
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
                  <strong>{token.name}</strong> — {token.status} · expiry:{" "}
                  {token.expiresAt ?? "none"} · creator: <code>{token.creatorId}</code>
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
        {owner && <ProjectAudit project={project} />}
        {owner && (
          <section id="danger" className="settings-card danger-card">
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
    </AppShell>
  )
}
