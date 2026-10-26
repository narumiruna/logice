import { useEffect, useState } from "react"
import { useI18n } from "./i18n"
import { canManageTokens, type Page, type Project, projectRequest } from "./project-api"
import { AppShell } from "./shell"
import { viewHref } from "./view-definition"

interface SavedView {
  id: string
  name: string
  revision: string
  definition: unknown
  updaterId: string
  updatedAt: string
}
export function SavedViews({ project }: { project: Project }) {
  const { t } = useI18n()
  const [data, setData] = useState<Page<SavedView> | null>(null)
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<SavedView | null>(null)
  const [name, setName] = useState("")
  const [definition, setDefinition] = useState("")
  const [message, setMessage] = useState("")
  const [messagePath, setMessagePath] = useState("")
  const base = `/${project.id}/views`
  // biome-ignore lint/correctness/useExhaustiveDependencies: Successful mutations and retry refresh the page.
  useEffect(() => {
    const c = new AbortController()
    setData(null)
    setError("")
    void projectRequest<Page<SavedView>>(`${base}?offset=${offset}`, "GET", undefined, c.signal)
      .then((page) => {
        if (!c.signal.aborted) setData(page)
      })
      .catch(() => {
        if (!c.signal.aborted) setError("Saved views could not be loaded.")
      })
    return () => c.abort()
  }, [base, offset, revision])
  useEffect(() => {
    const id = new URL(location.href).searchParams.get("open")
    if (!id) return
    const c = new AbortController()
    if (!/^[a-f\d-]{36}$/.test(id)) {
      setError("Invalid shared view.")
      return
    }
    void projectRequest<SavedView>(`${base}/${id}`, "GET", undefined, c.signal)
      .then((view) => {
        const href = viewHref(view.definition, project.id)
        if (!c.signal.aborted) location.assign(href)
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError("This shared view is unavailable or has an unsupported definition.")
      })
    return () => c.abort()
  }, [base, project.id])
  async function mutate(view: SavedView, method: string) {
    setBusy(true)
    setError("")
    try {
      const d = method === "PATCH" ? JSON.parse(definition) : undefined
      if (d) viewHref(d, project.id)
      await projectRequest(`${base}/${view.id}`, method, {
        revision: view.revision,
        ...(method === "PATCH" ? { name: name.trim(), definition: d } : {}),
      })
      setEditing(null)
      setRevision((n) => n + 1)
    } catch (error) {
      setError(error instanceof Error ? error.message : "View update failed.")
    } finally {
      setBusy(false)
    }
  }
  async function share(id: string) {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/projects/${project.id}/views?open=${id}`,
      )
      setMessage("View link copied. Project membership is still required.")
    } catch {
      setMessagePath(`/projects/${project.id}/views?open=${id}`)
      setMessage("Copy failed. Copy this path: {path}")
    }
  }
  return (
    <AppShell page="views">
      <main id="main" tabIndex={-1} className="workspace-page">
        <div className="page-heading">
          <div>
            <h1>{t("Saved views")}</h1>
            <p>
              {t(
                "Save the applied filters and display settings from Traces, Logs, or Live. Project members can open these saved views.",
              )}
            </p>
          </div>
        </div>
        {message && <p role="status">{t(message, { path: messagePath })}</p>}
        {error && (
          <div role="alert" className="workspace-error">
            <p>
              {/^Project request failed \(\d+\)\.$/.test(error)
                ? t("Project request failed ({status}).", { status: error.slice(24, -2) })
                : t(error)}
            </p>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setEditing(null)
                setRevision((n) => n + 1)
              }}
            >
              {t("Retry saved views")}
            </button>
          </div>
        )}
        {!data && !error && <p role="status">{t("Loading saved views…")}</p>}
        {data && !data.items.length && (
          <p className="workspace-empty">
            {t("No saved views on this page. Open an explorer and select Save current view.")}
          </p>
        )}
        {data?.items.map((view) => (
          <section key={view.id} className="settings-card">
            <h2>{view.name}</h2>
            <p>
              {t("Revision {revision} · Updated {date} · Account {account}", {
                revision: view.revision,
                date: view.updatedAt,
                account: view.updaterId,
              })}
            </p>
            <div className="dashboard-actions">
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  try {
                    location.assign(viewHref(view.definition, project.id))
                  } catch (error) {
                    setError(error instanceof Error ? error.message : "Invalid view.")
                  }
                }}
              >
                {t("Open view")}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void share(view.id)}
              >
                {t("Copy link")}
              </button>
              {canManageTokens(project.role) && (
                <>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      setEditing(view)
                      setName(view.name)
                      setDefinition(JSON.stringify(view.definition, null, 2))
                    }}
                  >
                    {t("Edit view")}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(t("Delete this shared view?"))) void mutate(view, "DELETE")
                    }}
                  >
                    {t("Delete view")}
                  </button>
                </>
              )}
            </div>
            {editing?.id === view.id && (
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void mutate(editing, "PATCH")
                }}
              >
                <label>
                  {t("View name")}
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </label>
                <label>
                  {t("Typed view definition (JSON)")}
                  <textarea
                    value={definition}
                    onChange={(e) => setDefinition(e.target.value)}
                    rows={14}
                    maxLength={16_384}
                    style={{ width: "100%" }}
                  />
                </label>
                <p>
                  {t(
                    "Definitions accept supported filters and display settings only. Concurrent changes require a reload.",
                  )}
                </p>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={busy || !name.trim()}
                >
                  {t("Update view")}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setEditing(null)}
                >
                  {t("Cancel edit")}
                </button>
              </form>
            )}
          </section>
        ))}
        <div className="workspace-pagination">
          <button
            className="button button-secondary"
            type="button"
            disabled={!offset || busy}
            onClick={() => setOffset(offset - 100)}
          >
            {t("Previous views")}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={!data?.hasMore || busy}
            onClick={() => setOffset(offset + 100)}
          >
            {t("Next views")}
          </button>
        </div>
      </main>
    </AppShell>
  )
}
