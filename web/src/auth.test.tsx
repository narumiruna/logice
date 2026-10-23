import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { requestJSON } from "./api"
import {
  AccountPanel,
  authErrorMessage,
  authenticateWithPasskey,
  creationOptions,
  decodeBase64url,
  encodeBase64url,
  loadSession,
  requestOptions,
  SessionGate,
  SessionView,
  SignIn,
  serializeCredential,
} from "./auth"
import { fetchLive } from "./live/api"
import { parseLiveRoute } from "./live/route"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const user = { id: "user-1", name: "<script>Admin</script>", admin: true }

describe("WebAuthn encoding", () => {
  it("round trips binary bytes without padding or standard base64 symbols", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 254, 255]).buffer
    expect(encodeBase64url(bytes)).toBe("AAF_gP7_")
    expect(new Uint8Array(decodeBase64url("AAF_gP7_"))).toEqual(new Uint8Array(bytes))
    expect(encodeBase64url(Uint8Array.from([255]).buffer)).toBe("_w")
    expect(new Uint8Array(decodeBase64url("_w"))).toEqual(Uint8Array.from([255]))
    expect(() => decodeBase64url("a")).toThrow()
    expect(() => decodeBase64url("+/==")).toThrow()
  })

  it("transforms all creation and request binary fields without changing input", () => {
    const descriptor = { type: "public-key", id: "_w", transports: ["internal"] }
    const input = {
      publicKey: {
        challenge: "AQI",
        user: { id: "Aw", name: "A", displayName: "A" },
        rp: { name: "Logice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        excludeCredentials: [descriptor],
      },
    }
    const options = creationOptions(input)
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(Uint8Array.from([1, 2]))
    expect(new Uint8Array(options.user.id as ArrayBuffer)).toEqual(Uint8Array.from([3]))
    expect(new Uint8Array(options.excludeCredentials?.[0].id as ArrayBuffer)).toEqual(
      Uint8Array.from([255]),
    )
    expect(input.publicKey.excludeCredentials[0].id).toBe("_w")
    const request = requestOptions({
      publicKey: { challenge: "AQI", allowCredentials: [descriptor], userVerification: "required" },
    })
    expect(request.userVerification).toBe("required")
    expect(new Uint8Array(request.allowCredentials?.[0].id as ArrayBuffer)).toEqual(
      Uint8Array.from([255]),
    )
    expect(requestOptions({ publicKey: { challenge: "AQI" } }).allowCredentials).toBeUndefined()
  })

  it("uses native credential JSON when available", () => {
    const json = { id: "native", response: {} }
    expect(serializeCredential({ toJSON: () => json } as unknown as PublicKeyCredential)).toBe(json)
  })

  it("serializes standard attestation and assertion fallback fields", () => {
    const bytes = Uint8Array.from([255]).buffer
    const common = {
      id: "_w",
      rawId: bytes,
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    }
    const attestation = serializeCredential({
      ...common,
      response: {
        clientDataJSON: bytes,
        attestationObject: bytes,
        getTransports: () => ["internal"],
      },
    } as unknown as PublicKeyCredential)
    expect(attestation).toMatchObject({
      id: "_w",
      rawId: "_w",
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: "_w", attestationObject: "_w", transports: ["internal"] },
    })
    const assertion = (userHandle: ArrayBuffer | null) =>
      serializeCredential({
        ...common,
        response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes, userHandle },
      } as unknown as PublicKeyCredential)
    expect(assertion(null)).toMatchObject({
      response: {
        clientDataJSON: "_w",
        authenticatorData: "_w",
        signature: "_w",
        userHandle: null,
      },
    })
    expect(assertion(bytes)).toMatchObject({ response: { userHandle: "_w" } })
  })
})

describe("passkey request contract", () => {
  it.each(["login", "enroll"])(
    "sends CSRF headers on both %s POSTs and decodes browser options",
    async (kind) => {
      const publicKey = {
        challenge: "AQI",
        user: { id: "Aw", name: "A", displayName: "A" },
        rp: { name: "Logice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      }
      const serialized = {
        id: "credential",
        type: "public-key",
        response: { clientDataJSON: "AQI" },
      }
      const create = vi.fn().mockResolvedValue({ toJSON: () => serialized })
      const get = vi.fn().mockResolvedValue({ toJSON: () => serialized })
      vi.stubGlobal("window", { isSecureContext: true, PublicKeyCredential: class {} })
      vi.stubGlobal("navigator", { credentials: { create, get } })
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ csrfToken: "browser-bound-csrf" }))
        .mockResolvedValueOnce(Response.json({ publicKey }))
        .mockResolvedValueOnce(Response.json({ user }))
      vi.stubGlobal("fetch", fetcher)
      const invitation = kind === "enroll" ? { token: "SECRET-INVITE" } : undefined
      expect(await authenticateWithPasskey(invitation)).toEqual(user)
      expect(fetcher.mock.calls[0][0]).toBe("/api/auth/csrf")
      for (const [index, endpoint] of [
        [1, "begin"],
        [2, "finish"],
      ] as const) {
        expect(fetcher.mock.calls[index][0]).toBe(`/api/auth/${kind}/${endpoint}`)
        expect(fetcher.mock.calls[index][1]).toMatchObject({
          method: "POST",
          credentials: "same-origin",
          headers: { "X-CSRF-Token": "browser-bound-csrf" },
        })
      }
      expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(invitation ?? {})
      expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual(serialized)
      expect(fetcher.mock.calls.map(([url]) => url).join()).not.toContain("SECRET-INVITE")
      const authenticator = kind === "enroll" ? create : get
      expect(new Uint8Array(authenticator.mock.calls[0][0].publicKey.challenge)).toEqual(
        Uint8Array.from([1, 2]),
      )
      expect(kind === "enroll" ? get : create).not.toHaveBeenCalled()
    },
  )

  it("does not call the API on unsupported browsers", async () => {
    vi.stubGlobal("window", { isSecureContext: false })
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    await expect(authenticateWithPasskey()).rejects.toMatchObject({ name: "NotSupportedError" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not finish when the authenticator is canceled", async () => {
    vi.stubGlobal("window", { isSecureContext: true, PublicKeyCredential: class {} })
    vi.stubGlobal("navigator", { credentials: { get: vi.fn().mockResolvedValue(null) } })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(Response.json({ publicKey: { challenge: "AQI" } }))
    vi.stubGlobal("fetch", fetcher)
    await expect(authenticateWithPasskey()).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe("session and authentication UI", () => {
  it("does not render telemetry or fetch while checking the session", () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
    const html = renderToStaticMarkup(
      <SessionGate>
        <div>PRIVATE TELEMETRY</div>
      </SessionGate>,
    )
    expect(html).toContain("Checking your session")
    expect(html).not.toContain("PRIVATE TELEMETRY")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("fails closed on session errors and offers retry", () => {
    const html = renderToStaticMarkup(
      <SessionView state={{ status: "error" }} onRetry={() => {}}>
        PRIVATE TELEMETRY
      </SessionView>,
    )
    expect(html).toContain("Telemetry is locked")
    expect(html).toContain("Retry")
    expect(html).not.toContain("PRIVATE TELEMETRY")
  })

  it("offers explicit passkey actions and keeps invitation tokens out of URLs", () => {
    const html = renderToStaticMarkup(<SignIn busy={false} onAuthenticate={() => {}} />)
    expect(html).toContain("Sign in with a passkey")
    expect(html).toContain("Create a passkey")
    expect(html).toContain('type="password"')
    expect(html).toContain('autoComplete="off"')
    expect(html).not.toContain("action=")
    expect(html).not.toContain("href=")
    const pending = renderToStaticMarkup(<SignIn busy onAuthenticate={() => {}} />)
    expect(pending).toContain("disabled")
    expect(pending).toContain("Complete the passkey request")
  })

  it("shows account and logout, but invitations only for admins", () => {
    const render = (admin: boolean) =>
      renderToStaticMarkup(
        <AccountPanel
          user={{ ...user, admin }}
          busy={false}
          onLogout={() => {}}
          onInvite={async () => undefined}
        />,
      )
    expect(render(true)).toContain("Create an invitation")
    expect(render(false)).not.toContain("Create an invitation")
    expect(render(false)).toContain("Sign out")
    expect(render(true)).not.toContain("<script>")
    expect(render(true)).toContain("&lt;script&gt;")
  })

  it("accepts a valid session and sends same-origin no-store GET", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ user, csrfToken: "csrf" }))
    vi.stubGlobal("fetch", fetcher)
    expect(await loadSession()).toEqual({ status: "authenticated", user })
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    )
  })

  it.each([401, 403, 500])(
    "handles session HTTP %s without exposing response details",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("SECRET BACKEND ERROR", { status })),
      )
      expect(await loadSession()).toEqual({ status: status === 401 ? "anonymous" : "error" })
    },
  )

  it("fails closed on network, malformed JSON, and invalid user responses", async () => {
    for (const result of [
      () => Promise.reject(new Error("SECRET")),
      () => Promise.resolve(new Response("bad json")),
      () => Promise.resolve(Response.json({ user: { ...user, admin: "true" } })),
    ]) {
      vi.stubGlobal("fetch", vi.fn(result))
      expect(await loadSession()).toEqual({ status: "error" })
    }
  })

  it("shows safe messages for canceled, unsupported, and unknown errors", () => {
    expect(authErrorMessage(new DOMException("SECRET", "NotAllowedError"))).toContain("canceled")
    expect(authErrorMessage(new DOMException("SECRET", "NotSupportedError"))).toContain(
      "not supported",
    )
    expect(authErrorMessage(new Error("SECRET"))).not.toContain("SECRET")
  })

  it("dispatches session expiration on Live query 401", async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal("window", { dispatchEvent })
    const response = new Response("PRIVATE BACKEND DETAILS", { status: 401 })
    await expect(
      fetchLive(
        parseLiveRoute("/live"),
        new AbortController().signal,
        vi.fn().mockResolvedValue(response),
      ),
    ).rejects.toMatchObject({ status: 401 })
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent.mock.calls[0][0].type).toBe("logice:session-expired")
  })

  it("dispatches session expiration on query 401 before reading the response body", async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal("window", { dispatchEvent })
    const response = new Response("PRIVATE BACKEND DETAILS", { status: 401 })
    await expect(
      requestJSON("/api/traces", new AbortController().signal, vi.fn().mockResolvedValue(response)),
    ).rejects.toMatchObject({ status: 401, code: "session_expired" })
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent.mock.calls[0][0].type).toBe("logice:session-expired")
    expect(response.bodyUsed).toBe(false)
  })
})
