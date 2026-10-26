import {
  authenticator,
  credentials,
  encodeOTLP,
  enroll,
  expect,
  post,
  test,
  workspace,
} from "./auth-fixtures"

test("project setup observes only fresh stored data and clears one-time credentials", async ({
  page,
}) => {
  const id = workspace().project.id
  await page.goto(`/projects/${id}/setup`)
  await expect(
    page.getByRole("heading", { name: "Connect your application", exact: true }),
  ).toBeVisible()
  await expect(page.locator("pre").filter({ hasText: "OTEL_EXPORTER_OTLP_HEADERS" })).toContainText(
    "LOGICE_PROJECT_TOKEN",
  )
  await page.getByLabel("Token name").fill("Setup browser test")
  await page.getByRole("button", { name: "Create ingestion token", exact: true }).click()
  const token = await page.getByRole("note", { name: "New ingestion token" }).textContent()
  expect(token).toBeTruthy()
  await expect(
    page.locator("pre").filter({ hasText: "OTEL_EXPORTER_OTLP_HEADERS" }),
  ).not.toContainText(token ?? "missing")
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new Error("denied")),
    }),
  )
  await page.getByRole("button", { name: "Copy exporter configuration", exact: true }).click()
  await expect(
    page.getByText("Copy failed. Select and copy the displayed text manually.", { exact: true }),
  ).toBeVisible()
  expect(page.url()).not.toContain(token ?? "missing")
  await page.getByRole("button", { name: "Check for telemetry", exact: true }).click()
  await expect(page.getByText("Observing stored telemetry…", { exact: true })).toBeVisible()
  const now = BigInt(Date.now()) * 1_000_000n
  const response = await fetch(`${process.env.LOGICE_E2E_URL}/v1/traces`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-protobuf" },
    body: new Uint8Array(
      encodeOTLP("traces", {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "ab".repeat(16),
                    spanId: "cd".repeat(8),
                    name: "Setup receipt",
                    startTimeUnixNano: now.toString(),
                    endTimeUnixNano: (now + 1_000_000n).toString(),
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  })
  expect(response.status).toBe(200)
  await expect(
    page.getByText("Stored telemetry observed in this project's observation window.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 })
  await page.getByRole("link", { name: "Open dashboard", exact: true }).click()
  await page.goBack()
  await expect(page.getByRole("note", { name: "New ingestion token" })).toHaveCount(0)
})

test("project setup never accepts another project's receipt", async ({ page, context }) => {
  const csrf = (await (await context.request.get("/api/auth/csrf")).json()).csrfToken
  const headers = { Origin: process.env.LOGICE_E2E_URL ?? "", "X-CSRF-Token": csrf }
  const created = await context.request.post("/api/projects", {
    headers,
    data: { name: "Isolated setup" },
  })
  expect(created.status()).toBe(201)
  const project = (await created.json()).id
  const issued = await context.request.post(`/api/projects/${project}/tokens`, {
    headers,
    data: { name: "Isolated setup" },
  })
  expect(issued.status()).toBe(201)
  const own = (await issued.json()).token
  await page.clock.install({ time: new Date() })
  await page.goto(`/projects/${project}/setup`)
  await page.getByRole("button", { name: "Check for telemetry", exact: true }).click()
  const send = async (token: string, id: string) => {
    const now = BigInt(Date.now()) * 1_000_000n
    const response = await fetch(`${process.env.LOGICE_E2E_URL}/v1/traces`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-protobuf" },
      body: new Uint8Array(
        encodeOTLP("traces", {
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: id.repeat(16),
                      spanId: "ef".repeat(8),
                      name: "Scoped receipt",
                      startTimeUnixNano: now.toString(),
                      endTimeUnixNano: (now + 1_000_000n).toString(),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    })
    expect(response.status).toBe(200)
  }
  await send(workspace().ingestionToken, "11")
  await page.clock.runFor(5_100)
  await expect(page.getByText("Observing stored telemetry…", { exact: true })).toBeVisible()
  await send(own, "22")
  await expect
    .poll(async () => {
      await page.clock.runFor(5_100)
      return page
        .getByText("Stored telemetry observed in this project's observation window.", {
          exact: true,
        })
        .isVisible()
    })
    .toBe(true)
})

test("shared views restore typed filters and reject stale updates", async ({ page, context }) => {
  const id = workspace().project.id
  const name = `View ${Date.now()}`
  await page.goto(`/projects/${id}/traces?range=1h&service=workflow-service&search=timeout`)
  await page.getByRole("button", { name: "Save current view", exact: true }).click()
  await page.getByLabel("Saved view name", { exact: true }).fill(name)
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await expect(page.getByText("View saved.", { exact: true })).toBeVisible()
  const list = await (await context.request.get(`/api/projects/${id}/views`)).json()
  const saved = list.items.find((item: { name: string }) => item.name === name)
  expect(saved).toBeTruthy()
  await page.goto(`/projects/${id}/views?open=${saved.id}`)
  await expect(page).toHaveURL(new RegExp(`/projects/${id}/traces\\?`))
  expect(new URL(page.url()).searchParams.get("service")).toBe("workflow-service")
  expect(new URL(page.url()).searchParams.get("search")).toBe("timeout")
  await page.goto(`/projects/${id}/views`)
  const card = page
    .locator("section.settings-card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
  await card.getByRole("button", { name: "Open view", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${id}/traces\\?`))
  expect(new URL(page.url()).searchParams.get("service")).toBe("workflow-service")
  expect(new URL(page.url()).searchParams.get("search")).toBe("timeout")
  await page.goBack()
  await expect(card).toBeVisible()
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new Error("denied")),
    }),
  )
  await card.getByRole("button", { name: "Copy link", exact: true }).click()
  await expect(
    page.getByText(`Copy failed. Copy this path: /projects/${id}/views?open=${saved.id}`, {
      exact: true,
    }),
  ).toBeVisible()
  await card.getByRole("button", { name: "Edit view", exact: true }).click()
  await card.getByLabel("View name", { exact: true }).fill(`${name} updated`)
  await card.getByRole("button", { name: "Update view", exact: true }).click()
  await expect(page.getByRole("heading", { name: `${name} updated`, exact: true })).toBeVisible()
  const csrf = (await (await context.request.get("/api/auth/csrf")).json()).csrfToken
  const stale = await context.request.patch(`/api/projects/${id}/views/${saved.id}`, {
    headers: { Origin: process.env.LOGICE_E2E_URL ?? "", "X-CSRF-Token": csrf },
    data: { name, definition: saved.definition, revision: saved.revision },
  })
  expect(stale.status()).toBe(409)
  await page.goto(`/projects/${id}/settings#audit`)
  await expect(page.locator("#audit")).toContainText("Saved view created")
  await expect(page.locator("#audit")).not.toContainText("workflow-service")
})

test("Dashboard statistics fail explicitly, retry, and keep range and service in trend links", async ({
  page,
}) => {
  const id = workspace().project.id
  await page.route("**/overview?*", (route) =>
    route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }),
  )
  await page.goto(`/projects/${id}/dashboard`)
  const stats = page.getByRole("region", { name: "Full-window telemetry statistics" })
  await expect(stats.getByRole("alert")).toContainText("No sample or partial count is substituted")
  await expect(stats.locator("strong")).toHaveCount(0)
  await page.unroute("**/overview?*")
  await page.getByRole("button", { name: "Retry statistics", exact: true }).click()
  await expect(stats.getByText("Stored traces", { exact: true })).toBeVisible()
  await page.getByLabel("Dashboard time range", { exact: true }).selectOption("15m")
  await page.getByLabel("Dashboard service", { exact: true }).fill("scope-not-present")
  await page.getByRole("button", { name: "Apply dashboard service", exact: true }).click()
  await expect(stats.getByText("Stored traces", { exact: true })).toBeVisible()
  await stats.locator("summary").click()
  const href = await stats.locator("tbody a").first().getAttribute("href")
  const link = new URL(href ?? "", page.url())
  expect(link.pathname).toBe(`/projects/${id}/traces`)
  expect(link.searchParams.get("service")).toBe("scope-not-present")
  expect(
    Date.parse(link.searchParams.get("to") ?? "") - Date.parse(link.searchParams.get("from") ?? ""),
  ).toBe(15_000)
  await expect(
    stats.getByText("Error trace proportion", { exact: true }).locator("..").locator("strong"),
  ).toHaveText("—")
})

test("backup Passkey enrollment requires reauthentication and removed credentials lose access", async ({
  browser,
  context,
}) => {
  const invitation = await post(context, "invitations", { name: "Managed Passkey member" })
  expect(invitation.status()).toBe(201)
  const token = (await invitation.json()).token
  const memberContext = await browser.newContext({
    baseURL: process.env.LOGICE_E2E_URL,
    storageState: { cookies: [], origins: [] },
  })
  const staleContext = await browser.newContext({
    baseURL: process.env.LOGICE_E2E_URL,
    storageState: { cookies: [], origins: [] },
  })
  try {
    const page = await memberContext.newPage()
    const original = await authenticator(page)
    await enroll(page, token)
    const originalCredentials = await credentials(original)
    const subject = (await (await memberContext.request.get("/api/auth/session")).json()).user.id
    const before = (await (await memberContext.request.get("/api/auth/passkeys")).json()).items
    expect(before).toHaveLength(1)
    const saved = await memberContext.storageState()
    await staleContext.addCookies(saved.cookies)
    await page.goto("/account")
    await page.getByLabel("New passkey name", { exact: true }).fill("USB backup")
    let switched = false
    await page.route("**/api/auth/passkeys/authorize/finish", async (route) => {
      const response = await route.fetch()
      if (!switched && response.ok()) {
        switched = true
        await original.cdp.send("WebAuthn.removeVirtualAuthenticator", {
          authenticatorId: original.authenticatorId,
        })
        await authenticator(page)
      }
      await route.fulfill({ response })
    })
    await page.getByRole("button", { name: "Add backup passkey", exact: true }).click()
    await expect(page.getByText("Backup passkey added.", { exact: true })).toBeVisible()
    await page.unroute("**/api/auth/passkeys/authorize/finish")
    expect(
      (await (await memberContext.request.get("/api/auth/passkeys")).json()).items,
    ).toHaveLength(2)
    // Locate by the input value, not a raw WebAuthn credential ID.
    const inputs = page.locator('#passkeys input[name="name"]')
    let index = -1
    for (let i = 0; i < (await inputs.count()); i++)
      if ((await inputs.nth(i).inputValue()) !== "USB backup") index = i
    expect(index).toBeGreaterThanOrEqual(0)
    page.once("dialog", (dialog) => void dialog.accept())
    await page
      .locator("#passkeys .settings-card")
      .nth(index)
      .getByRole("button", { name: "Remove passkey", exact: true })
      .click()
    await expect(
      page.getByText("Passkey removed. Other account sessions were signed out.", { exact: true }),
    ).toBeVisible()
    expect((await staleContext.request.get("/api/auth/session")).status()).toBe(401)
    expect((await (await memberContext.request.get("/api/auth/session")).json()).user.id).toBe(
      subject,
    )
    await expect(page.getByRole("button", { name: "Remove passkey", exact: true })).toBeDisabled()
    const adminCSRF = (await (await context.request.get("/api/auth/csrf")).json()).csrfToken
    const membership = await context.request.post(
      `/api/projects/${workspace().project.id}/members`,
      {
        headers: { Origin: process.env.LOGICE_E2E_URL ?? "", "X-CSRF-Token": adminCSRF },
        data: { userId: subject, role: "Viewer" },
      },
    )
    expect(membership.status()).toBe(200)
    await page.goto(`/projects/${workspace().project.id}/setup`)
    await expect(
      page.getByRole("button", { name: "Create ingestion token", exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByText(
        "Ask a project Owner or Developer for an ingestion token. Viewer access cannot create tokens.",
        { exact: true },
      ),
    ).toBeVisible()
    await page.goto(`/projects/${workspace().project.id}/views`)
    await expect(page.getByRole("button", { name: "Edit view", exact: true })).toHaveCount(0)
    await page.goto(`/projects/${workspace().project.id}/alerts`)
    await expect(page.getByRole("button", { name: "Save alert rule", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Save destination", exact: true })).toHaveCount(0)
    expect(
      (await memberContext.request.get(`/api/projects/${workspace().project.id}/events`)).status(),
    ).toBe(403)
    // The remaining independent authenticator must establish a new session,
    // not merely keep using the session rotated by removal.
    await page.getByRole("button", { name: "Sign out", exact: true }).click()
    await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click()
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible()
    expect((await (await memberContext.request.get("/api/auth/session")).json()).user.id).toBe(
      subject,
    )
    const stalePage = await staleContext.newPage()
    const device = await authenticator(stalePage)
    for (const credential of originalCredentials.credentials)
      await device.cdp.send("WebAuthn.addCredential", {
        authenticatorId: device.authenticatorId,
        credential,
      })
    await stalePage.goto("/account")
    await stalePage.getByRole("button", { name: "Sign in with a passkey", exact: true }).click()
    await expect(stalePage.getByRole("alert")).toBeVisible()
    expect((await staleContext.request.get("/api/auth/session")).status()).toBe(401)
  } finally {
    await memberContext.close()
    await staleContext.close()
  }
})

for (const theme of ["classic", "studio"] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} new workflow pages fit a ${width}px viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript((theme) => localStorage.setItem("logice.theme", theme), theme)
      for (const path of ["setup", "views", "alerts", "dashboard", "settings"]) {
        await page.goto(`/projects/${workspace().project.id}/${path}`)
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
      }
      await page.goto("/account")
      await expect(page.locator("#passkeys")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    })
  }
}
