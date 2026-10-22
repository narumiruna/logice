import { expect, test } from "@playwright/test"

const fixedTime = new Date("2026-10-22T14:30:00Z")

test("preview updates in place, pauses, resumes, and uses no telemetry APIs", async ({
  page,
}, testInfo) => {
  const apiRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url())
  })
  await page.clock.install({ time: fixedTime })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto("/preview")
  await expect(page.getByText("DESIGN PREVIEW", { exact: true })).toBeVisible()
  await page.clock.runFor(1100)
  await expect(page.getByTestId("preview-tick")).toHaveText("1")
  const arriving = page.locator('tr[data-event-id="trace-25"]')
  await expect(arriving).toHaveAttribute("data-status", "running")
  await expect(arriving).toHaveClass(/lp-arrival/)
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.clock.runFor(3100)
  await expect(page.getByTestId("preview-tick")).toHaveText("1")
  await page.getByRole("button", { name: "Resume live updates" }).click()
  await page.clock.runFor(3100)
  await expect(page.getByTestId("preview-tick")).toHaveText("4")
  await expect(arriving).toHaveAttribute("data-status", "ok")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.screenshot({
    path: testInfo.outputPath("preview-live.png"),
    animations: "disabled" as const,
    fullPage: true,
  })
  expect(apiRequests).toEqual([])
})

test("preview expands hierarchy, filters descendants, and opens a keyboard-accessible inspector", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: fixedTime })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto("/preview")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  await expect(page.locator("tr[data-event-id]")).toHaveCount(24)
  await page
    .locator('tr[data-event-id="trace-24"]')
    .getByRole("button", { name: "Expand POST /api/chat", exact: true })
    .click()
  await expect(
    page
      .locator('tr[data-event-id="trace-24"]')
      .getByRole("button", { name: "Collapse POST /api/chat", exact: true }),
  ).toHaveAttribute("aria-expanded", "true")
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  await expect(page.locator("tr[data-event-kind=log]").first()).toBeAttached()
  const selection = page
    .locator('tr[data-event-id="trace-24"]')
    .getByRole("button", { name: "Inspect POST /api/chat", exact: true })
  await selection.click()
  const inspector = page.getByRole("complementary", { name: "Event details" })
  await expect(inspector).toBeVisible()
  await expect(
    inspector.getByRole("heading", { name: "POST /api/chat", exact: true }),
  ).toBeFocused()
  await page.getByRole("tab", { name: "Raw data", exact: true }).click()
  await expect(page.getByRole("tabpanel")).toContainText('"traceId"')
  await page.getByRole("tab", { name: "Attributes", exact: true }).click()
  await page.screenshot({
    path: testInfo.outputPath("preview-inspector.png"),
    animations: "disabled" as const,
    fullPage: true,
  })
  await page.keyboard.press("Escape")
  await expect(inspector).toHaveCount(0)
  await expect(selection).toBeFocused()
  await page.keyboard.press("/")
  await expect(page.getByRole("textbox", { name: "Filter sample events" })).toBeFocused()
  await page.getByRole("textbox", { name: "Filter sample events" }).fill("SELECT stock")
  await expect(
    page.locator(".lp-event-message").filter({ hasText: "SELECT stock" }).first(),
  ).toBeAttached()
  await expect(
    page.locator(".lp-event-message").filter({ hasText: "POST /checkout" }).first(),
  ).toBeAttached()
  await page.getByRole("textbox", { name: "Filter sample events" }).fill("not-an-event")
  await expect(page.getByText("No matching events", { exact: true })).toBeVisible()
})

test("preview preserves a scroll anchor and selection when new events arrive", async ({ page }) => {
  await page.clock.install({ time: fixedTime })
  await page.goto("/preview")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  const pane = page.locator(".lp-feed-scroll")
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(page.getByRole("checkbox", { name: "Follow latest" })).not.toBeChecked()
  const anchor = await pane.evaluate((element) => {
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll<HTMLElement>("tr[data-event-id]")].find(
      (item) => item.getBoundingClientRect().top >= top + 30,
    )
    if (!row) throw new Error("No visible scroll anchor")
    return { id: row.dataset.eventId, offset: row.getBoundingClientRect().top - top }
  })
  const row = page.locator(`tr[data-event-id="${anchor.id}"]`)
  await row.locator(".lp-event-message").click()
  const heading = page
    .getByRole("complementary", { name: "Event details" })
    .getByRole("heading", { level: 2 })
  const selectedMessage = await heading.textContent()
  await page.getByRole("button", { name: "Resume live updates" }).click()
  await page.clock.runFor(4100)
  await expect(heading).toHaveText(selectedMessage ?? "")
  const offset = await row.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      (element.closest(".lp-feed-scroll")?.getBoundingClientRect().top ?? 0),
  )
  expect(Math.abs(offset - anchor.offset)).toBeLessThan(3)
  await expect(page.getByRole("button", { name: /new events · Jump to latest/ })).toBeVisible()
  await page.getByRole("button", { name: /new events · Jump to latest/ }).click()
  await expect(page.getByRole("checkbox", { name: "Follow latest" })).toBeChecked()
})

test("preview supports reduced motion and a narrow viewport", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.clock.install({ time: fixedTime })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/preview")
  await page.clock.runFor(1100)
  await expect(page.getByTestId("preview-tick")).toHaveText("1")
  expect(
    await page
      .locator(".lp-live-dot")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none")
  expect(
    await page
      .locator(".lp-duration-bar.running")
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.locator(".lp-event-message").last().click()
  await expect(page.getByRole("button", { name: "Close event details" })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("preview-mobile.png"),
    animations: "disabled" as const,
    fullPage: true,
  })
})
