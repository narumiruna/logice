import { useEffect, useRef, useState } from "react"
import { authErrorMessage, creationOptions, requestOptions, serializeCredential } from "./auth"
import { useI18n } from "./i18n"

interface Passkey {
  id: string
  name: string
  createdAt: string | null
  lastUsedAt: string | null
}
export async function passkeyRequest(path: string, body?: unknown): Promise<unknown> {
  let token = ""
  if (body !== undefined) {
    const response = await fetch("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
    })
    if (!response.ok) throw new Error("Cannot validate this request.")
    token = (await response.json()).csrfToken
  }
  const response = await fetch(`/api/auth/passkeys${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": token }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 401) window.dispatchEvent(new Event("logice:session-expired"))
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? "Passkey limit reached, or this is your last passkey. Reload and add a backup before removing it."
        : "Passkey operation could not be completed. Reload and try again.",
    )
  return response.json()
}
export function PasskeySettings() {
  const { t } = useI18n()
  const [keys, setKeys] = useState<Passkey[] | null>(null)
  const [name, setName] = useState("Backup passkey")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [revision, setRevision] = useState(0)
  const active = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Mutations and retry refresh only credential metadata.
  useEffect(() => {
    let canceled = false
    setError("")
    void passkeyRequest("")
      .then((value) => {
        const result = value as { items: Passkey[] }
        if (!Array.isArray(result.items)) throw new Error("Invalid Passkey response.")
        if (!canceled) setKeys(result.items)
      })
      .catch(() => {
        if (!canceled) setError("Passkey list could not be loaded.")
      })
    return () => {
      canceled = true
    }
  }, [revision])
  async function perform(operation: "add" | "remove", target = "") {
    if (active.current) return
    active.current = true
    setBusy(true)
    setError("")
    setMessage("")
    const c = new AbortController()
    controller.current = c
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials)
        throw new DOMException("Unsupported", "NotSupportedError")
      const options = await passkeyRequest("/authorize/begin", {
        operation,
        ...(operation === "add" ? { name: name.trim() } : { target }),
      })
      if (c.signal.aborted) return
      const assertion = await navigator.credentials.get({
        publicKey: requestOptions(options),
        signal: c.signal,
      })
      if (!assertion) throw new DOMException("Canceled", "NotAllowedError")
      const result = await passkeyRequest(
        "/authorize/finish",
        serializeCredential(assertion as PublicKeyCredential),
      )
      if (c.signal.aborted) return
      if (operation === "add") {
        const created = await navigator.credentials.create({
          publicKey: creationOptions(result),
          signal: c.signal,
        })
        if (!created) throw new DOMException("Canceled", "NotAllowedError")
        await passkeyRequest("/add/finish", serializeCredential(created as PublicKeyCredential))
      }
      if (mounted.current && !c.signal.aborted) {
        setMessage(
          operation === "add"
            ? "Backup passkey added."
            : "Passkey removed. Other account sessions were signed out.",
        )
        setRevision((n) => n + 1)
      }
    } catch (error) {
      if (mounted.current && !c.signal.aborted)
        setError(
          error instanceof DOMException
            ? authErrorMessage(error)
            : error instanceof Error
              ? error.message
              : "Passkey operation failed.",
        )
    } finally {
      active.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function rename(key: Passkey, value: string) {
    if (active.current) return
    active.current = true
    setBusy(true)
    setError("")
    try {
      await passkeyRequest("/rename", { id: key.id, name: value.trim() })
      if (mounted.current) {
        setMessage("Passkey name updated.")
        setRevision((n) => n + 1)
      }
    } catch {
      if (mounted.current) setError("Could not rename this passkey.")
    } finally {
      active.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="settings-card" id="passkeys">
      <div className="settings-card-heading">
        <h2>{t("Passkeys")}</h2>
        <p>
          {t(
            "Add a backup before removing a passkey. Adding or removing requires fresh user verification. Synced passkeys are not distinct physical devices.",
          )}
        </p>
      </div>
      {error && (
        <div role="alert">
          <p>{t(error)}</p>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setRevision((n) => n + 1)}
          >
            {t("Retry passkeys")}
          </button>
        </div>
      )}
      {message && <p role="status">{t(message)}</p>}
      {keys === null && !error && <p role="status">{t("Loading passkeys…")}</p>}
      {keys?.map((key) => (
        <div key={key.id} className="settings-card">
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault()
              const form = new FormData(e.currentTarget)
              void rename(key, String(form.get("name") ?? ""))
            }}
          >
            <label>
              {t("Passkey name")}
              <input name="name" defaultValue={key.name} maxLength={80} required disabled={busy} />
            </label>
            <p>
              {t("Created: {createdAt} · Last used: {lastUsedAt}", {
                createdAt: key.createdAt ?? t("Unknown (legacy credential)"),
                lastUsedAt: key.lastUsedAt ?? t("Unknown"),
              })}
            </p>
            <button type="submit" className="button button-secondary" disabled={busy}>
              {t("Rename passkey")}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || keys.length <= 1}
              onClick={() => {
                if (confirm(t("Remove this passkey and sign out other account sessions?")))
                  void perform("remove", key.id)
              }}
            >
              {t("Remove passkey")}
            </button>
          </form>
        </div>
      ))}
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault()
          void perform("add")
        }}
      >
        <label>
          {t("New passkey name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            disabled={busy}
          />
        </label>
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || !name.trim() || (keys?.length ?? 0) >= 8}
        >
          {t("Add backup passkey")}
        </button>
        {busy && (
          <button
            className="button button-secondary"
            type="button"
            onClick={() => {
              controller.current?.abort()
              setMessage(
                "Passkey operation canceled. Reload to check whether an in-flight server operation committed.",
              )
            }}
          >
            {t("Cancel passkey operation")}
          </button>
        )}
      </form>
      <p className="settings-hint">
        {t(
          "At most eight passkeys. Removing the last one is rejected by the server. For lost access, use operator recovery for this same account UUID; ingestion tokens are not revoked by account recovery.",
        )}
      </p>
    </section>
  )
}
