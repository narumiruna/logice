import { authenticator, expect, test } from "./auth-fixtures"

test.use({ storageState: { cookies: [], origins: [] } })

test("server rejects signed assertions without UV, with a wrong challenge, and with a wrong RP hash", async ({
  page,
  administrator,
}) => {
  const device = await authenticator(page)
  for (const credential of administrator.credentials.credentials) {
    await device.cdp.send("WebAuthn.addCredential", {
      authenticatorId: device.authenticatorId,
      credential,
    })
  }
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Sign in to Logice" })).toBeVisible()
  for (const fault of ["no-uv", "challenge", "rp-hash", "origin"] as const) {
    await device.cdp.send("WebAuthn.setUserVerified", {
      authenticatorId: device.authenticatorId,
      isUserVerified: fault !== "no-uv",
    })
    const status = await page.evaluate(async (fault) => {
      const decode = (value: string) =>
        Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
          c.charCodeAt(0),
        )
      const encode = (value: Uint8Array) =>
        btoa(String.fromCharCode(...value))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "")
      const { csrfToken } = await (await fetch("/api/auth/csrf")).json()
      const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }
      const begin = await fetch("/api/auth/login/begin", { method: "POST", headers, body: "{}" })
      if (begin.status !== 200) return begin.status
      const { publicKey } = await begin.json()
      publicKey.challenge = decode(publicKey.challenge)
      // Ask Chromium to produce a genuine signature without UV. The server's
      // stored ceremony still requires UV and must reject this assertion.
      if (fault === "no-uv") publicKey.userVerification = "discouraged"
      if (fault === "challenge") publicKey.challenge[0] ^= 1
      const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential
      const body = credential.toJSON() as {
        response: { authenticatorData: string; clientDataJSON: string }
      }
      // RP hash and origin are signed: changing either must fail closed too.
      if (fault === "rp-hash") {
        const data = decode(body.response.authenticatorData)
        data[0] ^= 1
        body.response.authenticatorData = encode(data)
      }
      if (fault === "origin") {
        const data = JSON.parse(new TextDecoder().decode(decode(body.response.clientDataJSON)))
        data.origin = "http://wrong.invalid"
        body.response.clientDataJSON = encode(new TextEncoder().encode(JSON.stringify(data)))
      }
      return (
        await fetch("/api/auth/login/finish", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status
    }, fault)
    expect(status, fault).toBe(401)
    expect((await page.context().request.get("/api/auth/session")).status()).toBe(401)
  }
})
