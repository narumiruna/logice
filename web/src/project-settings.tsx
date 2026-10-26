import { useEffect, useState } from "react"
import { flushSync } from "react-dom"
import { useI18n } from "./i18n"
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
  const { t } = useI18n()
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
    return window.confirm(t(message))
  }
  return (
    <AppShell page="settings">
      <main id="main" tabIndex={-1} className="workspace-page project-settings">
        <div className="page-heading">
          <div>
            <span className="eyebrow">{t("Project / Settings")}</span>
            <h1>{t("{project} settings", { project: project.name })}</h1>
            <p>{t("Manage project identity, team access, and ingestion tokens.")}</p>
          </div>
          <a className="button button-secondary" href={`/projects/${project.id}/dashboard`}>
            {t("Open dashboard")}
          </a>
        </div>
        <nav className="settings-tabs" aria-label={t("Project settings sections")}>
          <a href="#general" aria-current={section === "#general" ? "location" : undefined}>
            {t("General")}
          </a>
          <a href="#members" aria-current={section === "#members" ? "location" : undefined}>
            {t("Members")}
          </a>
          {manageTokens && (
            <a href="#tokens" aria-current={section === "#tokens" ? "location" : undefined}>
              {t("Tokens")}
            </a>
          )}
          {owner && (
            <a href="#danger" aria-current={section === "#danger" ? "location" : undefined}>
              {t("Danger zone")}
            </a>
          )}
        </nav>
        {owner && <a href="#audit">{t("Audit history")}</a>}
        <section id="general" className="settings-card">
          <div className="settings-card-heading">
            <h2>{t("Project identity")}</h2>
            <p>
              {t(
                "Stable identifiers keep your telemetry and ingestion tokens scoped to this project.",
              )}
            </p>
          </div>
          <p>
            {t("Project ID:")} <code>{project.id}</code>
          </p>
          <p>{t("Your role: {role}", { role: t(project.role) })}</p>
          <a href={`/projects/${project.id}/setup`}>
            {t("Connect an application to this project")}
          </a>{" "}
          · <a href={`/projects/${project.id}/alerts`}>{t("Manage alerts")}</a>
        </section>
        {error && (
          <div className="workspace-error" role="alert">
            <p>
              {/^Project request failed \(\d+\)\.$/.test(error)
                ? t("Project request failed ({status}).", { status: error.slice(24, -2) })
                : t(error)}
            </p>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setRevision((v) => v + 1)}
            >
              {t("Retry settings")}
            </button>
          </div>
        )}
        {!members && !error && (
          <p className="workspace-loading" role="status">
            {t("Loading project settings…")}
          </p>
        )}
        {owner && (
          <section className="settings-card">
            <h2>{t("Project name")}</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void mutate("", "PATCH", { name }).then((ok) => {
                  if (ok) window.location.reload()
                })
              }}
            >
              <label>
                {t("Project name")}{" "}
                <input
                  value={name}
                  maxLength={80}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button disabled={busy} type="submit">
                {t("Rename project")}
              </button>
            </form>
          </section>
        )}
        <section id="members" className="settings-card">
          <div className="settings-card-heading">
            <h2>{t("Members")}</h2>
            <p>
              {t(
                "Owners manage membership. Developers manage ingestion tokens. Viewers inspect telemetry.",
              )}
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
                {t("Registered account UUID")}{" "}
                <input value={userId} required onChange={(e) => setUserId(e.target.value)} />
              </label>
              <label>
                {t("Role")}{" "}
                <select
                  aria-label={t("Role")}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  <option value="Viewer">{t("Viewer")}</option>
                  <option value="Developer">{t("Developer")}</option>
                </select>
              </label>
              <button disabled={busy} type="submit">
                {t("Add member")}
              </button>
            </form>
          )}
          <ul>
            {members?.items.map((member) => (
              <li key={member.userId}>
                <strong>{member.name}</strong> <code>{member.userId}</code> — {t(member.role)}
                {owner && member.role !== "Owner" && (
                  <>
                    <label>
                      {t("Member role")}{" "}
                      <select
                        disabled={busy}
                        value={member.role}
                        onChange={(e) =>
                          void mutate(`/members/${member.userId}`, "PATCH", {
                            role: e.target.value,
                          })
                        }
                      >
                        <option value="Viewer">{t("Viewer")}</option>
                        <option value="Developer">{t("Developer")}</option>
                      </select>
                    </label>
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => {
                        if (confirm("Remove this member? Ingestion tokens remain active."))
                          void mutate(`/members/${member.userId}`, "DELETE", {})
                      }}
                    >
                      {t("Remove member")}
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
                      {t("Transfer ownership")}
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
            {t("Previous members")}
          </button>
          <button
            type="button"
            disabled={!members?.hasMore || busy}
            onClick={() => setMemberOffset(memberOffset + 100)}
          >
            {t("Next members")}
          </button>
        </section>
        {manageTokens && (
          <section id="tokens" className="settings-card">
            <div className="settings-card-heading">
              <h2>{t("Ingestion tokens")}</h2>
              <p>
                {t(
                  "Use ingestion tokens to send telemetry from your applications. Browser sessions cannot send telemetry.",
                )}
              </p>
            </div>
            <p>
              {t(
                "Ingestion tokens belong to this project. Removing their creator does not revoke them. They allow writes only.",
              )}
            </p>
            <p>
              {t("OTLP HTTP endpoint:")}{" "}
              <code>{typeof window === "undefined" ? "" : window.location.origin}</code>.{" "}
              {t("Use Bearer authorization with your ingestion token.")}
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
                {t("Token name")}{" "}
                <input
                  value={tokenName}
                  maxLength={80}
                  required
                  onChange={(e) => setTokenName(e.target.value)}
                />
              </label>
              <label>
                {t("Expiry UTC (optional)")}{" "}
                <input
                  type="datetime-local"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
              </label>
              <button disabled={busy} type="submit">
                {t("Create ingestion token")}
              </button>
            </form>
            {secret && (
              <div className="secret-card" role="status">
                <strong>{t("Copy this token now. It will not be shown again.")}</strong>
                <pre role="note" aria-label={t("New ingestion token")}>
                  {secret}
                </pre>
                <button type="button" onClick={() => setSecret("")}>
                  {t("Dismiss token")}
                </button>
              </div>
            )}
            <ul>
              {tokens?.items.map((token) => (
                <li key={token.id}>
                  <strong>{token.name}</strong> —{" "}
                  {t("{status} · expiry: {expiry} · creator: {creator}", {
                    status: t(token.status),
                    expiry: token.expiresAt ?? t("none"),
                    creator: token.creatorId,
                  })}
                  <button
                    disabled={busy || token.status === "revoked"}
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          "Revoke this ingestion token? Applications that use it will no longer be able to send telemetry.",
                        )
                      )
                        void mutate(`/tokens/${token.id}/revoke`, "POST", {})
                    }}
                  >
                    {t("Revoke token")}
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={tokenOffset === 0 || busy}
              onClick={() => setTokenOffset(tokenOffset - 100)}
            >
              {t("Previous tokens")}
            </button>
            <button
              type="button"
              disabled={!tokens?.hasMore || busy}
              onClick={() => setTokenOffset(tokenOffset + 100)}
            >
              {t("Next tokens")}
            </button>
          </section>
        )}
        {owner && <ProjectAudit project={project} />}
        {owner && (
          <section id="danger" className="settings-card danger-card">
            <h2>{t("Delete project")}</h2>
            <p>
              {t(
                "Deletion blocks access and revokes tokens. Stored telemetry remains until its normal retention expiry.",
              )}
            </p>
            <button
              disabled={busy}
              type="button"
              onClick={() => {
                if (confirm("Delete this project and revoke all its ingestion tokens?"))
                  void mutate("", "DELETE", {}).then((ok) => {
                    if (ok) window.location.assign("/projects")
                  })
              }}
            >
              {t("Delete project")}
            </button>
          </section>
        )}
      </main>
    </AppShell>
  )
}
