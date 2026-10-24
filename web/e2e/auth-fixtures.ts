import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type BrowserContext, test as base, expect, type Page } from "@playwright/test"

export { expect }

export function workspace(): { project: { id: string }; ingestionToken: string } {
  const file = process.env.LOGICE_E2E_AUTH_FILE
  if (!file) throw new Error("Run through the disposable validation script")
  return JSON.parse(readFileSync(file, "utf8"))
}

export function encodeOTLP(signal: "traces" | "logs", data: unknown): Buffer {
  return execFileSync(
    "uv",
    [
      "run",
      "--locked",
      "--project",
      fileURLToPath(new URL("../../examples/python", import.meta.url)),
      "python",
      fileURLToPath(new URL("../../tests/fixtures/telemetry/encode.py", import.meta.url)),
      signal,
    ],
    { input: JSON.stringify(data), maxBuffer: 8 << 20, timeout: 30_000 },
  )
}

export function projectHref(path: string): string {
  // Playwright discovers modules before the setup project creates its private state file.
  if (!process.env.LOGICE_E2E_AUTH_FILE || !existsSync(process.env.LOGICE_E2E_AUTH_FILE))
    return path
  if (/^\/api\/(traces|logs|live)([/?]|$)/.test(path))
    return path.replace("/api/", `/api/projects/${workspace().project.id}/`)
  if (/^\/(traces|logs|live)([/?]|$)/.test(path))
    return `/projects/${workspace().project.id}${path}`
  return path
}

export async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: true,
      defaultBackupState: true,
    },
  })
  return { cdp, authenticatorId }
}

export async function enroll(page: Page, token: string) {
  await page.goto("/")
  await page.getByText("Accept an invitation", { exact: true }).click()
  await page.getByLabel("Invitation token", { exact: true }).fill(token)
  await page.getByRole("button", { name: "Create a passkey", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
}

export async function post(context: BrowserContext, path: string, data: unknown, headers = {}) {
  const csrf = await (await context.request.get("/api/auth/csrf")).json()
  return context.request.post(`/api/auth/${path}`, {
    data,
    headers: {
      Origin: process.env.LOGICE_E2E_URL ?? "",
      "X-CSRF-Token": csrf.csrfToken,
      ...headers,
    },
  })
}

export async function credentials(device: Awaited<ReturnType<typeof authenticator>>) {
  return device.cdp.send("WebAuthn.getCredentials", { authenticatorId: device.authenticatorId })
}

type AuthState = {
  state: Awaited<ReturnType<BrowserContext["storageState"]>>
  credentials: Awaited<ReturnType<typeof credentials>>
}

// Each test gets an isolated context with the setup project's real session.
// No authentication endpoints are mocked. The script deletes this private file.
export const test = base.extend<object, { administrator: AuthState }>({
  administrator: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring.
    async ({}, use) => {
      const file = process.env.LOGICE_E2E_AUTH_FILE
      if (!file || !/^logice-web-check-[a-f0-9]{16}$/.test(process.env.LOGICE_E2E_PROJECT ?? "")) {
        throw new Error("Run this suite through scripts/validate-compose-web.sh")
      }
      await use(JSON.parse(readFileSync(file, "utf8")) as AuthState)
    },
    { scope: "worker" },
  ],
  storageState: async ({ administrator }, use) => {
    await use(administrator.state)
  },
})
