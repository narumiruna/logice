import { useEffect, useState } from "react"
import { type Project, projectRequest } from "./project-api"

interface AuditPage {
  items: {
    id: string
    action: string
    actorId: string | null
    actorName: string
    actorKind: "account" | "operator"
    target: string
    occurredAt: string
  }[]
  nextCursor: string
  from: string
  to: string
}
const actions = [
  "create_alert_destination",
  "change_alert_destination",
  "test_alert_destination",
  "create_alert_rule",
  "change_alert_rule",
  "create",
  "patch",
  "delete",
  "member_post",
  "member_patch",
  "member_delete",
  "transfer_owner",
  "create_token",
  "revoke_token",
  "operator_account_recovery",
  "create_view",
  "view_PATCH",
  "view_DELETE",
]
export function ProjectAudit({ project }: { project: Project }) {
  const [from, setFrom] = useState(() => new Date(Date.now() - 86_400_000).toISOString())
  const [to, setTo] = useState(() => new Date().toISOString())
  const [action, setAction] = useState("")
  const [query, setQuery] = useState(() => new URLSearchParams({ from, to, action: "" }).toString())
  const [cursors, setCursors] = useState<string[]>([""])
  const [data, setData] = useState<AuditPage | null>(null)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const cursor = cursors.at(-1) ?? ""
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the current cursor without changing its filters.
  useEffect(() => {
    const c = new AbortController()
    setData(null)
    setError("")
    void projectRequest<AuditPage>(
      `/${project.id}/events?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      "GET",
      undefined,
      c.signal,
    )
      .then((page) => {
        if (!c.signal.aborted) setData(page)
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError(
            "Audit history could not be loaded. Check ownership and the UTC interval (maximum 30 days).",
          )
      })
    return () => c.abort()
  }, [project.id, query, cursor, retry])
  if (project.role !== "Owner") return null
  return (
    <section id="audit" className="settings-card">
      <div className="settings-card-heading">
        <h2>Audit history</h2>
        <p>
          Successful project changes. Actor names are current names, not historical snapshots. This
          database history is not tamper-proof compliance storage.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setCursors([""])
          setQuery(new URLSearchParams({ from, to, action }).toString())
        }}
      >
        <label>
          Audit from UTC
          <input value={from} onChange={(e) => setFrom(e.target.value)} required />
        </label>
        <label>
          Audit to UTC
          <input value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>
        <label>
          Audit action
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <button type="submit">Apply audit filters</button>
      </form>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Retry audit
          </button>
        </div>
      )}
      {!data && !error && <p role="status">Loading audit history…</p>}
      {data && !data.items.length && (
        <p>
          No audit events in this page and window. Older changes may not have historical records.
        </p>
      )}
      <ul>
        {data?.items.map((event) => (
          <li key={event.id}>
            <strong>{event.action}</strong>
            <time>{event.occurredAt}</time>
            <span>
              {event.actorKind === "operator" ? "Operator" : "Actor (current name)"}:{" "}
              {event.actorName}
            </span>
            <code>{event.actorId}</code>
            <span>Target:</span>
            <code>{event.target}</code>
            <span>Event {event.id}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={cursors.length === 1 || !data}
        onClick={() => setCursors((items) => items.slice(0, -1))}
      >
        Previous audit events
      </button>
      <button
        type="button"
        disabled={!data?.nextCursor}
        onClick={() => {
          if (data?.nextCursor) setCursors((items) => [...items, data.nextCursor])
        }}
      >
        Next audit events
      </button>
      <p className="settings-hint">
        New events are excluded above the first page's event ID. Each page checks current ownership.
        Existing history is retained; no automatic cleanup is enabled.
      </p>
    </section>
  )
}
