import { expect, test } from "./auth-fixtures"
import { advance, control, record, row, snapshot, testTarget } from "./live-fixtures"

test.beforeEach(async ({ page }) => {
  testTarget(process.env.LOGICE_E2E_URL)
  // Exercise copy controls without browser permission or host clipboard dependencies.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Object.assign(window, { inspectorCopiedText: text })
        },
      },
    })
  })
})

test("Live inspector shows exact summary fields and preserves attribute controls through polling", async ({
  page,
}) => {
  const selected = record(0, {
    startTime: "2026-10-23T00:00:00.123456789Z",
    durationNs: "25000001",
    attributes: { "http.method": "POST", "user.note": "<script>not markup</script>", empty: "" },
    statusCode: "Error",
    statusMessage: "Exported error message",
  })
  const state = await control(page, snapshot([selected]))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto("/live")
  await row(page, selected.id).getByRole("button", { name: "Inspect Exported span 0" }).click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await expect(inspector.locator("time")).toHaveText(selected.startTime)
  await expect(inspector.locator("time")).toHaveAttribute("datetime", selected.startTime)
  await expect(inspector).toContainText("25000001")
  await expect(inspector).toContainText(selected.statusMessage)
  await expect(inspector.locator(".lp-status-tag")).toHaveText("Error")
  await expect(inspector.getByRole("link", { name: selected.traceId })).toHaveAttribute(
    "href",
    `/traces/${selected.traceId}?from=${encodeURIComponent(state.data.window.from)}&to=${encodeURIComponent(state.data.window.to)}`,
  )
  await inspector.getByRole("button", { name: "Copy timestamp", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "inspectorCopiedText")))
    .toBe(selected.startTime)
  await inspector.getByRole("button", { name: "Copy Trace ID", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "inspectorCopiedText")))
    .toBe(selected.traceId)

  const filter = inspector.getByRole("searchbox", { name: "Filter attributes" })
  await filter.fill("post")
  await expect(
    inspector.getByRole("button", { name: "Copy Record attributes: http.method" }),
  ).toBeVisible()
  await expect(inspector.getByText("<script>not markup</script>", { exact: true })).toHaveCount(0)
  await inspector.getByRole("button", { name: "Copy Record attributes: http.method" }).click()
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "inspectorCopiedText")))
    .toBe("POST")
  const resources = inspector
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Resource attributes" }) })
  await resources.locator("summary").click()
  await expect(resources).not.toHaveAttribute("open")
  await filter.focus()
  await advance(page, state)
  await expect(filter).toBeFocused()
  await expect(filter).toHaveValue("post")
  await expect(resources).not.toHaveAttribute("open")
  await filter.fill("no-such-attribute")
  await expect(inspector.getByText("No matching attributes", { exact: true })).toBeVisible()
  await inspector.getByRole("button", { name: "Clear attribute filter" }).click()
  await expect(filter).toHaveValue("")
  await expect(inspector.getByText("<script>not markup</script>", { exact: true })).toBeVisible()
  await expect(inspector.getByText("(Empty string)", { exact: true })).toBeVisible()

  const attributes = inspector.getByRole("tab", { name: "Attributes", exact: true })
  const raw = inspector.getByRole("tab", { name: "Stored record JSON", exact: true })
  await attributes.focus()
  await page.keyboard.press("End")
  await expect(raw).toBeFocused()
  await expect(raw).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Home")
  await expect(attributes).toBeFocused()
  await expect(attributes).toHaveAttribute("aria-selected", "true")
})

test("Live inspector bounds JSON display but copies the complete stored projection and reports clipboard failure", async ({
  page,
}) => {
  const selected = record(0, { stored: { Body: "x".repeat(90_000), sentinel: "stored-end" } })
  await control(page, snapshot([selected]))
  await page.goto("/live")
  await row(page, selected.id).getByRole("button", { name: "Inspect Exported span 0" }).click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await inspector.getByRole("tab", { name: "Stored record JSON", exact: true }).click()
  await expect(inspector.getByText(/Preview limited to 65,536 characters/)).toBeVisible()
  const preview = inspector.getByLabel("Stored record JSON preview")
  expect((await preview.textContent())?.length).toBe(65_536)
  await expect(preview).not.toContainText("stored-end")
  await inspector.getByRole("button", { name: "Copy stored record JSON", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "inspectorCopiedText")))
    .toBe(JSON.stringify(selected.stored, null, 2))
  await expect(inspector.getByRole("status")).toHaveText("Stored record JSON copied")
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Denied")
        },
      },
    })
  })
  await inspector.getByRole("button", { name: "Copy stored record JSON", exact: true }).click()
  await expect(inspector.getByRole("status")).toHaveText("Clipboard is not available")
})

test("Live log details show recorded severity and empty groups without span duration", async ({
  page,
}) => {
  const selected = record(0, {
    kind: "log",
    id: "log:inspector",
    name: "",
    body: "Recorded warning",
    severityText: "WARN",
    severityNumber: 13,
    attributes: {},
    resourceAttributes: {},
    scopeAttributes: {},
    scopeName: "",
    scopeVersion: "",
    traceId: "",
    spanId: "",
    statusCode: "",
  })
  await control(page, snapshot([selected]))
  await page.goto("/live")
  await row(page, selected.id).getByRole("button", { name: "Inspect Recorded warning" }).click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await expect(inspector.locator(".lp-status-tag")).toHaveText("WARN")
  await expect(inspector.locator(".lp-status-tag")).toHaveClass(/lv-detail-tone-warning/)
  await expect(inspector).toContainText("Severity number13")
  await expect(inspector).not.toContainText("Duration (ns)")
  await expect(inspector.getByText("No attributes recorded", { exact: true })).toHaveCount(3)
  await expect(inspector.getByRole("link")).toHaveCount(0)
  await inspector.locator("summary", { hasText: "Export metadata" }).click()
  await expect(inspector).toContainText("Trace flags")
  await expect(inspector).toContainText(selected.resourceSchemaUrl)
})
