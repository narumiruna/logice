import { authenticator, enroll, expect, post, test } from "./auth-fixtures"

test.use({ storageState: { cookies: [], origins: [] } })

test("passkey login, single-use challenges, logout, invitations, and authorization", async ({
  browser,
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
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await expect(page.getByLabel("Account", { exact: true })).toContainText("Browser administrator")
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByRole("heading", { name: "Sign in to Logice" })).toBeVisible()
  for (const path of ["/api/traces", "/api/logs", "/api/live", "/api/auth/session"]) {
    expect((await page.context().request.get(path)).status()).toBe(401)
  }

  // Capture a genuine signed assertion, then prove its challenge is single-use.
  let assertion: unknown
  await page.route("**/api/auth/login/finish", async (route) => {
    assertion = route.request().postDataJSON()
    await route.continue()
  })
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
  expect((await post(page.context(), "login/finish", assertion)).status()).toBe(401)
  expect((await post(page.context(), "login/begin", {}, { "X-CSRF-Token": "" })).status()).toBe(403)
  expect(
    (
      await post(page.context(), "login/begin", {}, { Origin: "http://untrusted.invalid" })
    ).status(),
  ).toBe(403)

  await page.getByText("Create an invitation", { exact: true }).click()
  await page.getByLabel("Invitation name").fill("Browser member")
  await page.getByRole("button", { name: "Create invitation", exact: true }).click()
  const invitation = await page.getByLabel("Invitation token", { exact: true }).inputValue()
  const member = await browser.newContext({ baseURL: process.env.LOGICE_E2E_URL })
  try {
    const visitor = await member.newPage()
    await authenticator(visitor)
    await enroll(visitor, invitation)
    await expect(visitor.getByLabel("Account", { exact: true })).toContainText("Browser member")
    await expect(visitor.getByText("Create an invitation", { exact: true })).toHaveCount(0)
    expect((await post(member, "invitations", { name: "Forbidden account" })).status()).toBe(403)
    expect((await post(member, "enroll/begin", { token: invitation })).status()).toBe(401)
    expect((await post(member, "enroll/begin", { token: "invalid-invitation" })).status()).toBe(401)
    expect((await post(member, "enroll/finish", {})).status()).toBe(401)
  } finally {
    await member.close()
  }
})

test("rejects an authenticator without user verification and a credential for another RP", async ({
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
  // The browser rejects requests that the authenticator cannot verify. Use a
  // short timeout and never wait for the browser's full ceremony timeout.
  const attempt = async () =>
    page.evaluate(async () => {
      const csrf = await (await fetch("/api/auth/csrf")).json()
      const begin = await fetch("/api/auth/login/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken },
        body: "{}",
      })
      const { publicKey } = await begin.json()
      publicKey.challenge = Uint8Array.from(
        atob(publicKey.challenge.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      )
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1000)
      try {
        await navigator.credentials.get({ publicKey, signal: controller.signal })
        return "unexpected credential"
      } catch (error) {
        return (error as DOMException).name
      } finally {
        clearTimeout(timer)
      }
    })
  await device.cdp.send("WebAuthn.setUserVerified", {
    authenticatorId: device.authenticatorId,
    isUserVerified: false,
  })
  expect(["NotAllowedError", "AbortError"]).toContain(await attempt())
  await device.cdp.send("WebAuthn.setUserVerified", {
    authenticatorId: device.authenticatorId,
    isUserVerified: true,
  })
  await device.cdp.send("WebAuthn.clearCredentials", { authenticatorId: device.authenticatorId })
  for (const credential of administrator.credentials.credentials) {
    await device.cdp.send("WebAuthn.addCredential", {
      authenticatorId: device.authenticatorId,
      credential: { ...credential, rpId: "wrong.invalid" },
    })
  }
  expect(["NotAllowedError", "AbortError"]).toContain(await attempt())
  expect((await page.context().request.get("/api/auth/session")).status()).toBe(401)
})
