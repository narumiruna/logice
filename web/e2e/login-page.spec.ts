import { expect, projectHref, test } from "./auth-fixtures"

test.use({ storageState: { cookies: [], origins: [] } })

for (const theme of ["classic", "studio"] as const) {
  for (const width of [320, 1440]) {
    test(`login page supports ${theme} at ${width}px without querying telemetry`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const queries: string[] = []
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname
        if (path.startsWith("/api/") && !path.startsWith("/api/auth/")) queries.push(path)
      })
      await page.goto(projectHref("/live"))
      await expect(page.getByRole("heading", { name: "Sign in to Logice" })).toBeVisible()
      await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const signIn = page.getByRole("button", { name: "Sign in with a passkey" })
      await expect(signIn).toBeVisible()
      expect((await signIn.boundingBox())?.height).toBeGreaterThanOrEqual(48)
      await expect(page.getByLabel("Invitation token", { exact: true })).toBeHidden()
      const disclosure = page.locator(".auth-enrollment summary")
      await disclosure.focus()
      await page.keyboard.press("Enter")
      const invitation = page.getByLabel("Invitation token", { exact: true })
      await expect(invitation).toBeVisible()
      await invitation.fill("do-not-send-this-token")
      await expect(invitation).toHaveAttribute("type", "password")
      await expect(
        page.getByRole("button", { name: "Create a passkey", exact: true }),
      ).toBeEnabled()
      expect(page.url()).not.toContain("do-not-send-this-token")
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true)
      expect(queries).toEqual([])
      await page.reload()
      await expect(page.getByRole("heading", { name: "Sign in to Logice" })).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await page.locator(".auth-enrollment summary").click()
      await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue("")
    })
  }
}

test("loading and session errors use the login layout and keep telemetry locked", async ({
  page,
}) => {
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let retry = false
  await page.route("**/api/auth/session", async (route) => {
    if (!retry) await pending
    await route.fulfill({ status: retry ? 401 : 503, json: { error: { code: "unavailable" } } })
  })
  await page.goto(projectHref("/live"))
  await expect(page.getByRole("heading", { name: "Checking your session…" })).toBeVisible()
  await expect(page.locator(".auth-layout")).toBeVisible()
  await expect(page.locator(".application-shell")).toHaveCount(0)
  release?.()
  await expect(page.getByRole("heading", { name: "Session unavailable" })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Telemetry is locked")
  await expect(page.locator(".application-shell")).toHaveCount(0)
  retry = true
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Sign in to Logice" })).toBeVisible()
})

test("canceled Passkey requests show a safe inline error and allow retry", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, "get", {
      value: async () => {
        throw new DOMException("PRIVATE DEVICE DETAILS", "NotAllowedError")
      },
    })
  })
  await page.goto("/")
  const signIn = page.getByRole("button", { name: "Sign in with a passkey" })
  await signIn.click()
  await expect(page.locator(".auth-form-panel").getByRole("alert")).toContainText("canceled")
  await expect(page.getByRole("alert")).not.toContainText("PRIVATE DEVICE DETAILS")
  await expect(signIn).toBeEnabled()
  await expect(page.locator(".application-shell")).toHaveCount(0)
})

test("pending Passkey requests disable both authentication actions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, "get", { value: () => new Promise(() => {}) })
  })
  await page.goto("/")
  await page.locator(".auth-enrollment summary").click()
  await page.getByLabel("Invitation token", { exact: true }).fill("invitation-not-submitted")
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await expect(page.getByRole("status")).toContainText("Complete the passkey request")
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Create a passkey", exact: true })).toBeDisabled()
  await expect(page.getByLabel("Invitation token", { exact: true })).toBeDisabled()
})
