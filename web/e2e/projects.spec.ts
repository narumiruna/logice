import { randomBytes } from "node:crypto"
import { authenticator, enroll, expect, post, test } from "./auth-fixtures"

test("project roles, one-time tokens, membership removal, ownership and project switching", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  page.setDefaultTimeout(10_000)
  await page.goto("/projects")
  const name = `Project ${randomBytes(5).toString("hex")}`
  await page.getByLabel("Project name", { exact: true }).fill(name)
  await page.getByRole("button", { name: "Create project", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Connect your application", exact: true }),
  ).toBeVisible()
  const project = /\/projects\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1]
  if (!project) throw new Error("Project creation did not navigate")
  const base = `/api/projects/${project}`
  await page.getByRole("link", { name: "Project settings" }).click()
  await page.getByLabel("Token name", { exact: true }).fill("Owner application")
  await page.getByRole("button", { name: "Create token", exact: true }).click()
  await expect(page.getByRole("note", { name: "New ingestion token" })).toBeVisible()
  const token = await page.getByRole("note", { name: "New ingestion token" }).textContent()
  if (!token) throw new Error("Token creation returned no credential")
  await page.getByRole("button", { name: "Dismiss token" }).click()
  await expect(page.getByRole("note", { name: "New ingestion token" })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("note", { name: "New ingestion token" })).toHaveCount(0)
  const contexts = []
  try {
    for (const role of ["Developer", "Viewer"] as const) {
      const response = await post(page.context(), "invitations", { name: `${role} ${name}` })
      expect(response.status()).toBe(201)
      const invitation = (await response.json()).token
      const context = await browser.newContext({
        baseURL: process.env.LOGICE_E2E_URL,
        storageState: { cookies: [], origins: [] },
      })
      contexts.push(context)
      context.setDefaultTimeout(10_000)
      const member = await context.newPage()
      await authenticator(member)
      await test.step(`Enroll ${role}`, () => enroll(member, invitation))
      const account = (await (await context.request.get("/api/auth/session")).json()).user
      // A newly registered account does not inherit the platform administrator's projects.
      expect((await context.request.get(base)).status()).toBe(404)
      await page.getByLabel("Registered account UUID").fill(account.id)
      await page.getByLabel("Role", { exact: true }).selectOption(role)
      await page.getByRole("button", { name: "Add member", exact: true }).click()
      await expect(page.locator("li").filter({ hasText: account.id })).toContainText(role)
      await member.goto(`/projects/${project}/settings`)
      await expect(member.getByRole("heading", { level: 1 })).toHaveText(`${name} settings`)
      await expect(member.getByRole("button", { name: "Add member", exact: true })).toHaveCount(0)
      if (role === "Developer") {
        await member.getByLabel("Token name", { exact: true }).fill("Developer application")
        await member.getByRole("button", { name: "Create token", exact: true }).click()
        await expect(member.getByRole("note", { name: "New ingestion token" })).toBeVisible()
        await member.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
        await expect(member.getByRole("note", { name: "New ingestion token" })).toHaveCount(0)
        await page.reload()
        await expect(page.locator("li").filter({ hasText: "Developer application" })).toBeVisible()
        const row = page
          .locator("li")
          .filter({ hasText: account.id })
          .filter({ has: page.getByRole("button", { name: "Remove member" }) })
        page.once("dialog", (dialog) => dialog.accept())
        await row.getByRole("button", { name: "Remove member" }).click()
        await expect(row).toHaveCount(0)
        await member.reload()
        await expect(member.getByRole("alert")).toContainText("Projects could not be loaded")
        await expect(page.locator("li").filter({ hasText: "Developer application" })).toContainText(
          "active",
        )
      } else {
        await expect(member.getByRole("button", { name: "Create token", exact: true })).toHaveCount(
          0,
        )
        const csrf = (await (await context.request.get("/api/auth/csrf")).json()).csrfToken
        const denied = await context.request.post(`${base}/tokens`, {
          headers: { Origin: process.env.LOGICE_E2E_URL ?? "", "X-CSRF-Token": csrf },
          data: { name: "denied" },
        })
        expect(denied.status()).toBe(403)
        await member.goto("/account")
        await expect(member.getByLabel("Display name", { exact: true })).toBeVisible()
        await expect(
          member.getByRole("heading", { name: "Registration invitations", exact: true }),
        ).toHaveCount(0)
      }
    }
    const ownerToken = page.locator("li").filter({ hasText: "Owner application" })
    page.once("dialog", (dialog) => dialog.accept())
    await ownerToken.getByRole("button", { name: "Revoke token" }).click()
    await expect(ownerToken).toContainText("revoked")
    // A switch is a full navigation: no old data, inspector, or pending request survives.
    await page.getByRole("link", { name: "Projects", exact: true }).click()
    await page.getByLabel("Project name", { exact: true }).fill(`${name} second`)
    await page.getByRole("button", { name: "Create project", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Connect your application", exact: true }),
    ).toBeVisible()
    await page.getByRole("combobox", { name: "Project", exact: true }).selectOption(project)
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/traces`))
    await expect(page.getByRole("heading", { name: "Traces", exact: true })).toBeVisible()
    await page.getByRole("link", { name: "Project settings" }).click()
    const viewer = page.locator("li").filter({ hasText: `Viewer ${name}` })
    page.once("dialog", (dialog) => dialog.accept())
    await viewer.getByRole("button", { name: "Transfer ownership" }).click()
    await expect(page.getByText("Your role: Developer", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Delete project", exact: true })).toHaveCount(0)
  } finally {
    for (const context of contexts) await context.close()
  }
})

test("unknown unscoped URLs do not select a default project", async ({ page }) => {
  const reads: string[] = []
  page.on("request", (request) => {
    if (/\/api\/projects\/[^/]+\/(traces|logs|live)/.test(request.url())) reads.push(request.url())
  })
  await page.goto("/missing")
  await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Choose a project" })).toHaveAttribute(
    "href",
    "/projects",
  )
  await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toBeVisible()
  expect(reads).toEqual([])
})
