import { useEffect, useState } from "react"
import { flushSync } from "react-dom"
import { useI18n } from "./i18n"
import { canManageTokens, type Project, projectRequest } from "./project-api"
import { AppShell } from "./shell"

interface Destination {
  id: string
  name: string
  revision: string
  disabled: boolean
}
interface Rule {
  id: string
  name: string
  destinationId: string
  kind: string
  service: string
  threshold: string
  minPopulation: number
  enabled: boolean
  revision: string
  state: string
  incidentActive: boolean
  lastWindowTo: string | null
}
interface History {
  items: { id: string; ruleId: string | null; state: string; result: string; createdAt: string }[]
  hasMore: boolean
}
const blankRule = {
  name: "",
  destinationId: "",
  kind: "error_ratio",
  service: "",
  threshold: "0.1",
  minPopulation: 10,
  enabled: true,
}
export function ProjectAlerts({ project }: { project: Project }) {
  const { t } = useI18n()
  const [rules, setRules] = useState<Rule[]>([])
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [incidents, setIncidents] = useState<History | null>(null)
  const [deliveries, setDeliveries] = useState<History | null>(null)
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [editingRule, setEditingRule] = useState<Rule | null>(null)
  const [rule, setRule] = useState(blankRule)
  const [editingDestination, setEditingDestination] = useState<Destination | null>(null)
  const [name, setName] = useState("")
  const [url, setURL] = useState("")
  const base = `/${project.id}/alerts`
  useEffect(() => {
    const clear = () => flushSync(() => setURL(""))
    window.addEventListener("pagehide", clear)
    return () => window.removeEventListener("pagehide", clear)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh and successful mutations reload bounded history.
  useEffect(() => {
    const c = new AbortController()
    setError("")
    void Promise.all([
      projectRequest<{ items: Rule[] }>(`${base}/rules`, "GET", undefined, c.signal),
      projectRequest<{ items: Destination[] }>(`${base}/destinations`, "GET", undefined, c.signal),
      projectRequest<History>(`${base}/incidents?offset=${offset}`, "GET", undefined, c.signal),
      projectRequest<History>(`${base}/deliveries?offset=${offset}`, "GET", undefined, c.signal),
    ])
      .then(([r, d, i, o]) => {
        if (!c.signal.aborted) {
          setRules(r.items)
          setDestinations(d.items)
          setIncidents(i)
          setDeliveries(o)
        }
      })
      .catch(() => {
        if (!c.signal.aborted) {
          setRules([])
          setDestinations([])
          setIncidents(null)
          setDeliveries(null)
          setError("Alert settings could not be loaded. Check membership or retry.")
        }
      })
    return () => c.abort()
  }, [base, offset, revision])
  async function mutate(path: string, method: string, body: unknown) {
    if (busy) return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      await projectRequest(`${base}${path}`, method, body)
      setURL("")
      setName("")
      setEditingDestination(null)
      setEditingRule(null)
      setRule(blankRule)
      setRevision((n) => n + 1)
      setMessage(
        "Change saved. Notifications are processed by the separate worker; queue acceptance is not delivery confirmation.",
      )
    } catch (error) {
      setError(error instanceof Error ? error.message : "Alert update failed.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <AppShell page="alerts">
      <main id="main" tabIndex={-1} className="workspace-page">
        <div className="page-heading">
          <div>
            <h1>{t("Alerts")}</h1>
            <p>
              {t("Project-scoped stored-data conditions and durable Webhook delivery history.")}
            </p>
          </div>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setRevision((n) => n + 1)}
          >
            {t("Refresh alerts")}
          </button>
        </div>
        <p className="settings-hint">
          {t(
            "A separate alert worker must be running. State reflects the last evaluation, not current application health. Five-minute windows close after a 30-second export delay. New rules have a five-minute grace period; three consecutive breaches fire, two healthy windows recover, with a five-minute notification cooldown. Outages and insufficient populations are unknown, not healthy. Delivery can repeat; receivers must deduplicate event IDs.",
          )}
        </p>
        {error && (
          <p role="alert" className="workspace-error">
            {/^Project request failed \(\d+\)\.$/.test(error)
              ? t("Project request failed ({status}).", { status: error.slice(24, -2) })
              : t(error)}
          </p>
        )}
        {message && <p role="status">{t(message)}</p>}
        <section className="settings-card">
          <h2>{t("Rules")}</h2>
          {incidents !== null && !rules.length && (
            <p>{t("No alert rules. An Owner must first approve a Webhook destination.")}</p>
          )}
          {rules.map((r) => (
            <div key={r.id} className="settings-card">
              <h3>{r.name}</h3>
              <p>
                {t("{state} · {kind} · Service: {service} · Revision {revision}", {
                  state: r.enabled ? t(r.state) : t("disabled"),
                  kind: t(r.kind),
                  service: r.service || t("all services"),
                  revision: r.revision,
                })}
                <br />
                {t("Last evaluated window: {date}", {
                  date: r.lastWindowTo ?? t("Not evaluated yet"),
                })}
              </p>
              {canManageTokens(project.role) && (
                <div className="dashboard-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      setEditingRule(r)
                      setRule({
                        name: r.name,
                        destinationId: r.destinationId,
                        kind: r.kind,
                        service: r.service,
                        threshold: r.threshold,
                        minPopulation: r.minPopulation,
                        enabled: r.enabled,
                      })
                    }}
                  >
                    {t("Edit alert rule")}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || !r.enabled}
                    onClick={() => {
                      if (confirm(t("Disable this rule and cancel undelivered notifications?")))
                        void mutate(`/rules/${r.id}`, "DELETE", { revision: r.revision })
                    }}
                  >
                    {t("Disable alert rule")}
                  </button>
                </div>
              )}
            </div>
          ))}
          {canManageTokens(project.role) && (
            <form
              className="settings-form"
              onSubmit={(e) => {
                e.preventDefault()
                void mutate(
                  `/rules${editingRule ? `/${editingRule.id}` : ""}`,
                  editingRule ? "PATCH" : "POST",
                  {
                    ...rule,
                    name: rule.name.trim(),
                    ...(editingRule ? { revision: editingRule.revision } : {}),
                  },
                )
              }}
            >
              <h3>{editingRule ? t("Edit rule") : t("Create rule")}</h3>
              <label>
                {t("Alert rule name")}
                <input
                  value={rule.name}
                  onChange={(e) => setRule({ ...rule, name: e.target.value })}
                  maxLength={80}
                  required
                />
              </label>
              <label>
                {t("Approved destination")}
                <select
                  value={rule.destinationId}
                  onChange={(e) => setRule({ ...rule, destinationId: e.target.value })}
                  required
                >
                  <option value="">{t("Select destination")}</option>
                  {destinations
                    .filter((d) => !d.disabled)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {t("Alert condition")}
                <select
                  value={rule.kind}
                  onChange={(e) =>
                    setRule({
                      ...rule,
                      kind: e.target.value,
                      threshold:
                        e.target.value === "no_data"
                          ? "0"
                          : e.target.value === "root_p95"
                            ? "1000000000"
                            : "0.1",
                    })
                  }
                >
                  <option value="error_ratio">{t("Error trace proportion")}</option>
                  <option value="root_p95">{t("Exported root-span p95")}</option>
                  <option value="no_data">{t("No stored telemetry")}</option>
                </select>
              </label>
              <label>
                {t("Alert service (optional)")}
                <input
                  value={rule.service}
                  maxLength={200}
                  onChange={(e) => setRule({ ...rule, service: e.target.value })}
                />
              </label>
              <label>
                {t("Threshold (ratio 0–1, or latency in nanoseconds)")}
                <input
                  value={rule.threshold}
                  onChange={(e) => setRule({ ...rule, threshold: e.target.value })}
                  required
                  readOnly={rule.kind === "no_data"}
                />
              </label>
              <label>
                {t("Minimum population (ignored for no-data)")}
                <input
                  type="number"
                  min={1}
                  max={1_000_000}
                  value={rule.minPopulation}
                  onChange={(e) => setRule({ ...rule, minPopulation: Number(e.target.value) })}
                  required
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => setRule({ ...rule, enabled: e.target.checked })}
                />
                {t("Rule enabled")}
              </label>
              <button
                className="button button-primary"
                type="submit"
                disabled={busy || !rule.name.trim() || !rule.destinationId}
              >
                {t("Save alert rule")}
              </button>
              {editingRule && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    setEditingRule(null)
                    setRule(blankRule)
                  }}
                >
                  {t("Cancel rule edit")}
                </button>
              )}
              <p>
                {t(
                  "Limits: 20 retained rule slots per project. Disable and edit existing slots to reuse them.",
                )}
              </p>
            </form>
          )}
        </section>
        <section className="settings-card">
          <h2>{t("Webhook destinations")}</h2>
          <p>
            {t(
              "Public HTTPS on port 443 only. URLs remain encrypted and are never returned. Private addresses, redirects, and untrusted TLS are rejected. Editing a destination cancels pending notifications; disabling it also disables its rules.",
            )}
          </p>
          {destinations.map((d) => (
            <div key={d.id}>
              <strong>{d.name}</strong>
              <span> · {d.disabled ? t("disabled") : t("approved")}</span>
              {project.role === "Owner" && (
                <div className="dashboard-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingDestination(d)
                      setName(d.name)
                      setURL("")
                    }}
                  >
                    {t("Edit destination")}
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy || d.disabled}
                    onClick={() => void mutate(`/destinations/${d.id}/test`, "POST", {})}
                  >
                    {t("Queue test notification")}
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy || d.disabled}
                    onClick={() => {
                      if (confirm(t("Disable this destination and its rules?")))
                        void mutate(`/destinations/${d.id}`, "DELETE", { revision: d.revision })
                    }}
                  >
                    {t("Disable destination")}
                  </button>
                </div>
              )}
            </div>
          ))}
          {project.role === "Owner" && (
            <form
              className="settings-form"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault()
                void mutate(
                  `/destinations${editingDestination ? `/${editingDestination.id}` : ""}`,
                  editingDestination ? "PATCH" : "POST",
                  {
                    name: name.trim(),
                    url,
                    ...(editingDestination ? { revision: editingDestination.revision } : {}),
                  },
                )
              }}
            >
              <label>
                {t("Destination name")}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                />
              </label>
              <label>
                {t("Destination HTTPS URL")}
                <input
                  type="password"
                  value={url}
                  onChange={(e) => setURL(e.target.value)}
                  autoComplete="off"
                  maxLength={2048}
                  required={!editingDestination}
                />
              </label>
              <p>
                {t(
                  "For an edit, leave URL empty to keep it. Supply a new URL to re-enable a disabled destination. URLs can contain secrets; never put them in shared logs or screenshots.",
                )}
              </p>
              <button
                className="button button-primary"
                type="submit"
                disabled={busy || !name.trim()}
              >
                {t("Save destination")}
              </button>
              {editingDestination && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    setEditingDestination(null)
                    setName("")
                    setURL("")
                  }}
                >
                  {t("Cancel destination edit")}
                </button>
              )}
              <p>{t("Limits: five retained destination slots per project.")}</p>
            </form>
          )}
        </section>
        <section className="settings-card">
          <h2>{t("Incident and delivery history")}</h2>
          <p>
            {t(
              "History is retained for up to 30 days. Pending delivery expires after 24 hours or eight failed attempts. In-flight delivery can finish after a disable or deletion.",
            )}
          </p>
          {incidents === null && !error && <p role="status">{t("Loading alert history…")}</p>}
          <h3>{t("Incidents")}</h3>
          <ul>
            {incidents?.items.map((i) => (
              <li key={i.id}>
                {t("{date} · {state} · Rule {rule} · Event {event}", {
                  date: i.createdAt,
                  state: t(i.state),
                  rule: i.ruleId ?? "",
                  event: i.id,
                })}
              </li>
            ))}
          </ul>
          <h3>{t("Deliveries")}</h3>
          <ul>
            {deliveries?.items.map((i) => (
              <li key={i.id}>
                {t("{date} · {state} · {result} · Event {event}", {
                  date: i.createdAt,
                  state: t(i.state),
                  result: i.result ? t(i.result) : t("not attempted"),
                  event: i.id,
                })}
              </li>
            ))}
          </ul>
          <div className="workspace-pagination">
            <button
              className="button button-secondary"
              type="button"
              disabled={!offset || busy}
              onClick={() => setOffset(offset - 100)}
            >
              {t("Previous alert history")}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || (!incidents?.hasMore && !deliveries?.hasMore)}
              onClick={() => setOffset(offset + 100)}
            >
              {t("Next alert history")}
            </button>
          </div>
        </section>
      </main>
    </AppShell>
  )
}
