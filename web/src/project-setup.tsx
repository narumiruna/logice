import { useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { canManageTokens, type Project, projectRequest } from "./project-api"
import { observeReceipt, type ReceiptState, type ReceiptWindow } from "./project-receipt"
import { AppShell } from "./shell"

export function setupInstructions(origin: string): string {
  return `export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nexport OTEL_EXPORTER_OTLP_ENDPOINT=${JSON.stringify(origin)}\n# Load LOGICE_PROJECT_TOKEN from protected storage, not shell history.\nexport OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer \${LOGICE_PROJECT_TOKEN}"\nexport OTEL_SERVICE_NAME=my-application`
}

export function ProjectSetup({ project }: { project: Project }) {
  const [name, setName] = useState("Application")
  const [secret, setSecret] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copy, setCopy] = useState("")
  const [state, setState] = useState<ReceiptState>("stopped")
  const [window, setWindow] = useState<ReceiptWindow | null>(null)
  const observation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const creating = useRef(false)
  useEffect(() => {
    mounted.current = true
    const clear = () => {
      generation.current++
      observation.current?.abort()
      flushSync(() => {
        setSecret("")
        setState("stopped")
      })
    }
    globalThis.window.addEventListener("pagehide", clear)
    return () => {
      mounted.current = false
      generation.current++
      observation.current?.abort()
      globalThis.window.removeEventListener("pagehide", clear)
    }
  }, [])
  async function create() {
    if (creating.current) return
    creating.current = true
    const version = generation.current
    setBusy(true)
    setSecret("")
    setError("")
    setCopy("")
    try {
      const result = await projectRequest<{ token: string }>(`/${project.id}/tokens`, "POST", {
        name: name.trim(),
      })
      if (typeof result.token !== "string" || !result.token)
        throw new Error("Invalid token response.")
      if (mounted.current && version === generation.current) setSecret(result.token)
    } catch (error) {
      if (mounted.current && version === generation.current)
        setError(error instanceof Error ? error.message : "Token creation failed.")
    } finally {
      creating.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopy("Copied.")
    } catch {
      setCopy("Copy failed. Select and copy the displayed text manually.")
    }
  }
  function verify() {
    observation.current?.abort()
    const controller = new AbortController()
    observation.current = controller
    const from = Date.now()
    const bounds = {
      from: new Date(from).toISOString(),
      to: new Date(from + 120_000).toISOString(),
    }
    setWindow(bounds)
    void observeReceipt(controller.signal, bounds, (next) => {
      if (mounted.current && observation.current === controller && !controller.signal.aborted)
        setState(next)
    })
  }
  const instructions = setupInstructions(
    typeof location === "undefined" ? "https://logice.example" : location.origin,
  )
  return (
    <AppShell page="setup">
      <main id="main" tabIndex={-1} className="workspace-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">{project.name} / Setup</span>
            <h1>Connect your application</h1>
            <p>
              Create an application credential, configure an exporter, and check for stored
              telemetry.
            </p>
          </div>
          <a href={`/projects/${project.id}/dashboard`}>Open dashboard</a>
        </div>
        <section className="settings-card">
          <h2>1. Create an ingestion token</h2>
          <p>
            Project tokens allow writes only. Registration invitations and browser sessions cannot
            send telemetry.
          </p>
          {canManageTokens(project.role) ? (
            <>
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <label>
                  Setup token name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                    disabled={busy}
                  />
                </label>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={busy || !name.trim()}
                >
                  Create setup token
                </button>
              </form>
              <p>You can also use an existing token from your application's secret store.</p>
            </>
          ) : (
            <p>
              Ask a project Owner or Developer for an ingestion token. Viewer access cannot create
              tokens.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {secret && (
            <div className="secret-card">
              <p>
                Copy this token now. Leaving this page clears it; the token stays valid until
                revoked.
              </p>
              <pre role="note" aria-label="Setup ingestion token">
                {secret}
              </pre>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void copyText(secret)}
              >
                Copy setup token
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setSecret("")
                  setCopy("")
                }}
              >
                Dismiss setup token
              </button>
            </div>
          )}
        </section>
        <section className="settings-card">
          <h2>2. Configure OTLP HTTP protobuf</h2>
          <p>
            These instructions contain a placeholder, not your secret. Set LOGICE_PROJECT_TOKEN
            through protected storage before running your application. Do not paste secrets into
            shell history.
          </p>
          <pre className="log-body">{instructions}</pre>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void copyText(instructions)}
          >
            Copy exporter configuration
          </button>
          <h3>Python example</h3>
          <p>
            From the Logice repository root, export LOGICE_PROJECT_TOKEN from protected storage and
            run:
          </p>
          <pre className="log-body">
            uv run --project examples/python --locked python examples/python/send_telemetry.py
          </pre>
          <p>
            The example sends traces and logs. Collector batching can delay storage. An accepted
            export is not a durable-storage guarantee.
          </p>
          {copy && <p role="status">{copy}</p>}
        </section>
        <section className="settings-card">
          <h2>3. Observe stored telemetry</h2>
          <p>
            Start this check before sending telemetry. It observes a fixed two-minute UTC window in
            this project. A result does not identify which token or application sent it.
          </p>
          {window && (
            <p>
              UTC: {window.from} – {window.to}
            </p>
          )}
          <button
            type="button"
            className="button button-primary"
            onClick={verify}
            disabled={state === "observing"}
          >
            Check for telemetry
          </button>
          {state === "observing" && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                observation.current?.abort()
                setState("stopped")
              }}
            >
              Stop observation
            </button>
          )}
          <p role={state === "error" ? "alert" : "status"}>
            {state === "observing"
              ? "Observing stored telemetry…"
              : state === "observed"
                ? "Stored telemetry observed in this project's observation window."
                : state === "timeout"
                  ? "No stored telemetry observed before timeout. This does not prove ingestion was rejected."
                  : state === "error"
                    ? "Could not read project telemetry. Check access and storage, then retry."
                    : "Observation stopped. Start a check when ready."}
          </p>
        </section>
      </main>
    </AppShell>
  )
}
