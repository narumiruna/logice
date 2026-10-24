import { mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { authenticator, encodeOTLP, expect, projectHref, test, workspace } from "./auth-fixtures"

const screenshotDir = fileURLToPath(new URL("../test-results/workspace-pages/", import.meta.url))

test("account settings persist a display name and remain available without the project API", async ({
  page,
}) => {
  await page.goto("/account")
  await expect(page.getByRole("heading", { name: "Account settings", exact: true })).toBeVisible()
  const name = await page.getByLabel("Display name", { exact: true }).inputValue()
  try {
    await page.getByLabel("Display name", { exact: true }).fill("Workspace operator")
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(page.getByRole("status")).toContainText("Profile saved")
    await expect(page.getByLabel("Account", { exact: true })).toContainText("Workspace operator")
    await page.reload()
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Workspace operator")
    await page.locator("#appearance").getByRole("combobox").selectOption("studio")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "studio")
    await expect(page.locator("#security")).toContainText("24 hours idle")
    await expect(page.locator("#invitations")).toContainText(
      "Registration does not grant project membership",
    )
    await page.route("**/api/projects?**", (route) => route.fulfill({ status: 404, json: {} }))
    await page.goto("/projects")
    await expect(page.getByRole("alert")).toContainText("Deploy matching API/web versions")
    await page.getByRole("link", { name: "Open account settings", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Account settings", exact: true })).toBeVisible()
    await page
      .getByRole("combobox", { name: "Appearance theme", exact: true })
      .selectOption("classic")
  } finally {
    await page.goto("/account")
    await page.getByLabel("Display name", { exact: true }).fill(name)
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(page.getByRole("status")).toContainText("Profile saved")
  }
})

test("project list search, pagination states, failure retry and dashboard links work", async ({
  page,
}) => {
  await page.goto("/projects")
  const id = workspace().project.id
  const card = page.locator(".project-card").filter({ hasText: id })
  await expect(card).toContainText("Owner")
  await page
    .getByRole("searchbox", { name: "Search projects on this page" })
    .fill("no-matching-project-93f08")
  await expect(
    page.getByRole("heading", { name: "No matching projects on this page" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear search" }).click()
  await card.getByRole("link", { name: "Open dashboard" }).click()
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Manage ingestion tokens" })).toHaveAttribute(
    "href",
    `/projects/${id}/settings#tokens`,
  )
  await page.getByRole("link", { name: "Manage ingestion tokens" }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Project settings sections" })
      .getByRole("link", { name: "Tokens", exact: true }),
  ).toHaveAttribute("aria-current", "location")
  await expect(page.getByRole("heading", { name: "Ingestion tokens", exact: true })).toBeVisible()
  let fail = true
  await page.route("**/api/projects?**", async (route) => {
    if (fail) await route.fulfill({ status: 503, json: {} })
    else await route.continue()
  })
  await page.goto("/projects")
  await expect(page.getByRole("alert")).toContainText("Projects could not be loaded")
  fail = false
  await page.getByRole("button", { name: "Retry projects" }).click()
  await expect(page.locator(".project-card").filter({ hasText: id })).toBeVisible()
})

test("project pagination and an empty account have explicit states", async ({ page }) => {
  const project = workspace().project
  let empty = false
  await page.route("**/api/projects?**", (route) => {
    const offset = new URL(route.request().url()).searchParams.get("offset")
    return route.fulfill({
      json: {
        items: empty
          ? []
          : [
              {
                ...project,
                name: offset === "100" ? "Second page project" : "First page project",
                role: "Owner",
              },
            ],
        hasMore: !empty && offset === "0",
      },
    })
  })
  await page.goto("/projects")
  await expect(page.getByRole("button", { name: "Previous projects" })).toBeDisabled()
  await page.getByRole("button", { name: "Next projects" }).click()
  await expect(page.getByRole("heading", { name: "Second page project" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Next projects" })).toBeDisabled()
  await page.getByRole("button", { name: "Previous projects" }).click()
  await expect(page.getByRole("heading", { name: "First page project" })).toBeVisible()
  empty = true
  await page.reload()
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Find your account UUID" })).toHaveAttribute(
    "href",
    "/account",
  )
  await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeDisabled()
})

for (const theme of ["classic", "studio"] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} workspace pages are usable at ${width}px`, async ({ page }) => {
      mkdirSync(screenshotDir, { recursive: true })
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.addInitScript((theme) => localStorage.setItem("logice.theme", theme), theme)
      const routes = [
        "/projects",
        "/account",
        projectHref("/dashboard"),
        projectHref("/settings#members"),
        projectHref("/settings#tokens"),
      ]
      for (const [index, path] of routes.entries()) {
        await page.goto(path)
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
        await expect(
          page.getByRole("navigation").getByRole("link", { name: "Projects", exact: true }),
        ).toBeVisible()
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        const scroll = await page.evaluate(() => ({
          viewport: innerWidth,
          width: document.documentElement.scrollWidth,
        }))
        expect(scroll.width).toBeLessThanOrEqual(scroll.viewport)
        if (index === 0) await expect(page.locator(".project-card").first()).toBeVisible()
        if (index === 2)
          await expect(
            page.getByRole("heading", { name: "Recent traces", exact: true }),
          ).toBeVisible()
        await page.screenshot({ path: `${screenshotDir}/${theme}-${width}-${index}.png` })
      }
    })
  }
}

test("dashboard labels bounded real samples, preserves scope and clears errors on retry", async ({
  page,
}) => {
  const project = workspace().project.id
  const trace = {
    traceId: "1234567890abcdef1234567890abcdef",
    name: "Dashboard scoped trace",
    serviceName: "scoped-service",
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    durationNs: "1000000",
    spanCount: 1,
    errorCount: 1,
  }
  let fail = false
  await page.route(`**/api/projects/${project}/traces?**`, (route) =>
    route.fulfill(fail ? { status: 503, json: {} } : { json: { items: [trace], hasMore: true } }),
  )
  await page.route(`**/api/projects/${project}/logs?**`, (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  )
  await page.goto(projectHref("/dashboard"))
  await expect(page.getByRole("link", { name: trace.name })).toHaveAttribute(
    "href",
    new RegExp(`/projects/${project}/traces/${trace.traceId}\\?`),
  )
  await expect(page.getByRole("region", { name: "Recent telemetry sample" })).toContainText("1+")
  await expect(page.getByText("Not a project-wide error rate", { exact: true })).toBeVisible()
  fail = true
  await page.getByRole("button", { name: "Refresh dashboard" }).click()
  await expect(page.getByRole("alert")).toContainText("Dashboard unavailable")
  await expect(page.getByRole("link", { name: trace.name })).toHaveCount(0)
  fail = false
  await page.getByRole("button", { name: "Retry dashboard" }).click()
  await expect(page.getByRole("link", { name: trace.name })).toBeVisible()
})

test("dashboards show only the selected project's real exported trace", async ({
  page,
  request,
}) => {
  const csrf = (await (await request.get("/api/auth/csrf")).json()).csrfToken
  const headers = { Origin: process.env.LOGICE_E2E_URL ?? "", "X-CSRF-Token": csrf }
  const created = await request.post("/api/projects", {
    headers,
    data: { name: "Dashboard isolation" },
  })
  expect(created.status()).toBe(201)
  const other = (await created.json()).id as string
  const credential = await request.post(`/api/projects/${other}/tokens`, {
    headers,
    data: { name: "Dashboard isolation" },
  })
  expect(credential.status()).toBe(201)
  const token = (await credential.json()).token as string
  const first = workspace()
  const traceId = "51".repeat(16)
  const now = BigInt(Date.now()) * 1_000_000n
  for (const target of [
    { id: first.project.id, token: first.ingestionToken, name: "First dashboard scope" },
    { id: other, token, name: "Second dashboard scope" },
  ]) {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "logice.project.id",
                value: { stringValue: target.id === other ? first.project.id : other },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: "1234567890abcdef",
                  name: target.name,
                  startTimeUnixNano: now.toString(),
                  endTimeUnixNano: (now + 1_000_000n).toString(),
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    }
    const response = await fetch(`${process.env.LOGICE_E2E_URL}/v1/traces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/x-protobuf",
      },
      body: new Uint8Array(encodeOTLP("traces", payload)),
    })
    expect(response.status).toBe(200)
    await expect
      .poll(async () => {
        const result = await request.get(
          `/api/projects/${target.id}/traces?search=${encodeURIComponent(target.name)}`,
        )
        return result.ok() ? (await result.json()).items.length : 0
      })
      .toBe(1)
  }
  await page.goto(`/projects/${first.project.id}/dashboard`)
  await expect(page.getByRole("link", { name: "First dashboard scope", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Second dashboard scope", exact: true })).toHaveCount(
    0,
  )
  await page.goto(`/projects/${other}/dashboard`)
  await expect(
    page.getByRole("link", { name: "Second dashboard scope", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("link", { name: "First dashboard scope", exact: true })).toHaveCount(
    0,
  )
  await page.reload()
  await expect(
    page.getByRole("link", { name: "Second dashboard scope", exact: true }),
  ).toBeVisible()
})

test("account sign out affects only this browser session", async ({ browser, administrator }) => {
  const context = await browser.newContext({
    baseURL: process.env.LOGICE_E2E_URL,
    storageState: { cookies: [], origins: [] },
  })
  try {
    const page = await context.newPage()
    const device = await authenticator(page)
    for (const credential of administrator.credentials.credentials)
      await device.cdp.send("WebAuthn.addCredential", {
        authenticatorId: device.authenticatorId,
        credential,
      })
    await page.goto("/account")
    await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Account settings", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Sign out of this browser" }).click()
    await expect(
      page.getByRole("heading", { name: "Sign in to Logice", exact: true }),
    ).toBeVisible()
    expect((await context.request.get("/api/auth/session")).status()).toBe(401)
  } finally {
    await context.close()
  }
})
