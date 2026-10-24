import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { Glyph } from "./preview/icons"
import { ThemeSelect } from "./theme"
import "./styles.css"
import "./auth.css"

export interface AuthUser {
  id: string
  name: string
  admin: boolean
}

export interface AccountActions {
  user: AuthUser
  busy: boolean
  logout: () => void
  invite: (name: string) => Promise<{ token: string; expiresAt: string } | undefined>
  saveName: (name: string) => Promise<boolean>
}
export const AccountContext = createContext<AccountActions | null>(null)
export function useAccount() {
  const account = useContext(AccountContext)
  if (!account) throw new Error("Account settings require a verified session.")
  return account
}

export type SessionState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "anonymous"; expired?: boolean }
  | { status: "authenticated"; user: AuthUser }

class AuthError extends Error {
  constructor(public readonly status: number) {
    super("Authentication request failed.")
  }
}

async function authRequest(path: string, body?: unknown, csrfToken?: string): Promise<unknown> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrfToken ?? "" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new AuthError(response.status)
  return response.status === 204 ? undefined : response.json()
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response.")
  return value as Record<string, unknown>
}

function userFrom(value: unknown): AuthUser {
  const user = object(object(value).user)
  if (
    typeof user.id !== "string" ||
    typeof user.name !== "string" ||
    typeof user.admin !== "boolean"
  ) {
    throw new Error("Invalid account.")
  }
  return { id: user.id, name: user.name, admin: user.admin }
}

async function csrf(): Promise<string> {
  const token = object(await authRequest("csrf")).csrfToken
  if (typeof token !== "string" || !token) throw new Error("Invalid response.")
  return token
}

export async function loadSession(): Promise<SessionState> {
  try {
    return { status: "authenticated", user: userFrom(await authRequest("session")) }
  } catch (error) {
    return error instanceof AuthError && error.status === 401
      ? { status: "anonymous" }
      : { status: "error" }
  }
}

export function decodeBase64url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1)
    throw new Error("Invalid encoding.")
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
  )
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer
}

export function encodeBase64url(value: ArrayBuffer): string {
  let binary = ""
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function descriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error("Invalid credentials.")
  return value.map((item) => ({ ...item, id: decodeBase64url(item.id) }))
}

export function creationOptions(value: unknown): PublicKeyCredentialCreationOptions {
  const options = object(object(value).publicKey)
  const user = object(options.user)
  return {
    ...options,
    challenge: decodeBase64url(options.challenge as string),
    user: { ...user, id: decodeBase64url(user.id as string) },
    excludeCredentials: descriptors(options.excludeCredentials),
  } as PublicKeyCredentialCreationOptions
}

export function requestOptions(value: unknown): PublicKeyCredentialRequestOptions {
  const options = object(object(value).publicKey)
  return {
    ...options,
    challenge: decodeBase64url(options.challenge as string),
    allowCredentials: descriptors(options.allowCredentials),
  }
}

export function serializeCredential(credential: PublicKeyCredential): unknown {
  if (typeof credential.toJSON === "function") return credential.toJSON()
  const response = credential.response
  const common = {
    id: credential.id,
    rawId: encodeBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  }
  if ("attestationObject" in response) {
    const attestation = response as AuthenticatorAttestationResponse
    return {
      ...common,
      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        attestationObject: encodeBase64url(attestation.attestationObject),
        ...(attestation.getTransports ? { transports: attestation.getTransports() } : {}),
      },
    }
  }
  const assertion = response as AuthenticatorAssertionResponse
  return {
    ...common,
    response: {
      clientDataJSON: encodeBase64url(response.clientDataJSON),
      authenticatorData: encodeBase64url(assertion.authenticatorData),
      signature: encodeBase64url(assertion.signature),
      userHandle: assertion.userHandle === null ? null : encodeBase64url(assertion.userHandle),
    },
  }
}

// Call only from an explicit user action; never start an authenticator on mount.
export async function authenticateWithPasskey(invitation?: { token: string }): Promise<AuthUser> {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
    throw new DOMException("Unsupported", "NotSupportedError")
  }
  const token = await csrf()
  const kind = invitation ? "enroll" : "login"
  const options = await authRequest(`${kind}/begin`, invitation ?? {}, token)
  const credential = invitation
    ? await navigator.credentials.create({ publicKey: creationOptions(options) })
    : await navigator.credentials.get({ publicKey: requestOptions(options) })
  if (!credential) throw new DOMException("Canceled", "NotAllowedError")
  return userFrom(
    await authRequest(
      `${kind}/finish`,
      serializeCredential(credential as PublicKeyCredential),
      token,
    ),
  )
}

export function authErrorMessage(error: unknown): string {
  if (error instanceof DOMException && ["NotAllowedError", "AbortError"].includes(error.name)) {
    return "Passkey request canceled or timed out. Try again."
  }
  if (error instanceof DOMException && error.name === "NotSupportedError") {
    return "Passkeys are not supported by this browser or device."
  }
  return "The request could not be completed. Try again."
}

function PasskeyIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5" />
      <path d="m12 12 9 9m-6-6 3-3m0 6 3-3" />
    </svg>
  )
}

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-layout">
      <header className="auth-header">
        <div className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true">
            L
          </span>
          <span>Logice</span>
        </div>
        <span className="auth-access-badge">Private workspace</span>
        <ThemeSelect />
      </header>
      <main className="auth-page" id="sign-in" tabIndex={-1}>
        <section className="auth-intro" aria-label="About Logice">
          <span className="auth-eyebrow">OpenTelemetry explorer</span>
          <h2>
            Trace requests.
            <br />
            Inspect logs.
          </h2>
          <p>Follow requests across services. Inspect spans and correlated logs in one place.</p>
          <div className="auth-trace-preview" aria-hidden="true">
            <div className="auth-trace-heading">
              <Glyph name="activity" size={17} />
              <span>Example trace</span>
              <span>Sample data</span>
            </div>
            <div className="auth-trace-row">
              <span>server.request</span>
              <span className="auth-trace-track">
                <i />
              </span>
            </div>
            <div className="auth-trace-row auth-trace-child">
              <span>database.query</span>
              <span className="auth-trace-track">
                <i />
              </span>
            </div>
            <div className="auth-trace-row auth-trace-child">
              <span>app.log</span>
              <span className="auth-trace-track">
                <i />
              </span>
            </div>
          </div>
          <ul className="auth-features">
            <li>
              <Glyph name="layers" />
              Trace hierarchy
            </li>
            <li>
              <Glyph name="code" />
              Correlated logs
            </li>
            <li>
              <Glyph name="activity" />
              Live events
            </li>
          </ul>
        </section>
        <section className="auth-form-panel" aria-label="Account access">
          {children}
        </section>
      </main>
      <footer className="auth-footer">
        <span>Logice · Telemetry explorer</span>
        <span>Passkey authentication · Invitation only</span>
      </footer>
    </div>
  )
}

export function SignIn({
  busy,
  onAuthenticate,
}: {
  busy: boolean
  onAuthenticate: (invitation?: { token: string }) => void
}) {
  const [token, setToken] = useState("")
  function enroll(event: FormEvent) {
    event.preventDefault()
    onAuthenticate({ token: token.trim() })
  }
  return (
    <div className="auth-card">
      <span className="auth-key-mark">
        <PasskeyIcon />
      </span>
      <div className="auth-card-heading">
        <h1>Sign in to Logice</h1>
        <p>Use your passkey to access your workspace.</p>
      </div>
      <button
        className="auth-primary auth-passkey-button"
        type="button"
        disabled={busy}
        onClick={() => onAuthenticate()}
      >
        <PasskeyIcon />
        Sign in with a passkey
      </button>
      <p className="auth-device-note">Use your fingerprint, face, device PIN, or security key.</p>
      <div className="auth-divider">
        <span>Invitation access</span>
      </div>
      <details className="auth-enrollment">
        <summary>
          Accept an invitation
          <Glyph name="chevron" size={17} />
        </summary>
        <form onSubmit={enroll}>
          <p>Ask your administrator for a one-time invitation. Your account name is already set.</p>
          <label htmlFor="invitation-token">Invitation token</label>
          <input
            id="invitation-token"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={43}
            placeholder="Paste your invitation token"
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={busy}
          />
          <button className="auth-secondary" type="submit" disabled={busy || !token.trim()}>
            Create a passkey
          </button>
        </form>
      </details>
      {busy && (
        <p className="auth-pending" role="status">
          <span className="auth-spinner" aria-hidden="true" />
          Complete the passkey request on your device.
        </p>
      )}
      <p className="auth-security-note">
        Your device verifies your identity. No password is required.
      </p>
    </div>
  )
}

export function SessionView({
  state,
  children,
  onRetry,
}: {
  state: SessionState
  children: ReactNode
  onRetry: () => void
}) {
  if (state.status === "loading")
    return (
      <AuthLayout>
        <div className="auth-card auth-state" role="status">
          <span className="auth-spinner" aria-hidden="true" />
          <h1>Checking your session…</h1>
          <p>Your workspace stays locked until your session is verified.</p>
        </div>
      </AuthLayout>
    )
  if (state.status === "error")
    return (
      <AuthLayout>
        <div className="auth-card auth-state">
          <span className="auth-key-mark">
            <PasskeyIcon />
          </span>
          <h1>Session unavailable</h1>
          <p role="alert">Your session could not be verified. Telemetry is locked.</p>
          <button className="auth-primary" type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      </AuthLayout>
    )
  return <>{children}</>
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" })
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const active = useRef(false)
  const generation = useRef(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a new session check.
  useEffect(() => {
    let canceled = false
    const version = ++generation.current
    setState({ status: "loading" })
    void loadSession().then((session) => {
      if (!canceled && version === generation.current) setState(session)
    })
    const expire = () => {
      generation.current++
      setMessage("")
      setState({ status: "anonymous", expired: true })
    }
    window.addEventListener("logice:session-expired", expire)
    return () => {
      canceled = true
      generation.current++
      window.removeEventListener("logice:session-expired", expire)
    }
  }, [retry])

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (active.current) return undefined
    active.current = true
    setBusy(true)
    setMessage("")
    try {
      return await action()
    } catch (error) {
      if (error instanceof AuthError && error.status === 401 && state.status === "authenticated") {
        generation.current++
        setState({ status: "anonymous", expired: true })
      } else setMessage(authErrorMessage(error))
      return undefined
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  function authenticate(invitation?: { token: string }) {
    void run(async () => {
      const version = generation.current
      const user = await authenticateWithPasskey(invitation)
      if (version === generation.current) setState({ status: "authenticated", user })
    })
  }

  function logout() {
    void run(async () => {
      const token = await csrf()
      await authRequest("logout", {}, token)
      generation.current++
      setState({ status: "anonymous" })
    })
  }

  async function invite(name: string) {
    return run(async () => {
      const token = await csrf()
      const result = object(await authRequest("invitations", { name }, token))
      if (typeof result.token !== "string" || typeof result.expiresAt !== "string")
        throw new Error("Invalid response.")
      return { token: result.token, expiresAt: result.expiresAt }
    })
  }

  async function saveName(name: string): Promise<boolean> {
    const result = await run(async () => {
      const version = generation.current
      const token = await csrf()
      const user = userFrom(await authRequest("profile", { name }, token))
      if (version !== generation.current) return false
      setState({ status: "authenticated", user })
      return true
    })
    return result === true
  }

  return (
    <SessionView state={state} onRetry={() => setRetry((value) => value + 1)}>
      {state.status === "authenticated" ? (
        <AccountContext value={{ user: state.user, busy, logout, invite, saveName }}>
          <div className="auth-workspace">
            {message && (
              <p className="auth-message" role="alert">
                {message}
              </p>
            )}
            <aside className="account-bar" aria-label="Account">
              <span className="account-avatar" aria-hidden="true">
                {state.user.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{state.user.name}</strong>
                <small>{state.user.admin ? "Administrator" : "Registered account"}</small>
              </span>
              <a href="/account">Account settings</a>
              <button type="button" onClick={logout} disabled={busy}>
                Sign out
              </button>
            </aside>
            {children}
          </div>
        </AccountContext>
      ) : (
        <AuthLayout>
          {message && (
            <p className="auth-message" role="alert">
              {message}
            </p>
          )}
          {state.status === "anonymous" && state.expired && (
            <p className="auth-message" role="alert">
              Your session expired. Sign in again.
            </p>
          )}
          <SignIn busy={busy} onAuthenticate={authenticate} />
        </AuthLayout>
      )}
    </SessionView>
  )
}
