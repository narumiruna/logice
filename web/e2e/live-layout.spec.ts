import { expect, test } from "./auth-fixtures"
import { advance, control, record, snapshot, testTarget } from "./live-fixtures"

test.beforeEach(() => {
  testTarget(process.env.LOGICE_E2E_URL)
})

function hierarchy() {
  const root = record(0, {
    name: "POST /checkout",
    serviceName: "api",
    durationNs: "1000000000",
    statusCode: "Error",
  })
  const child = record(1, {
    name: "reserve_inventory",
    serviceName: "inventory-worker",
    parentSpanId: root.spanId,
    durationNs: "500000000",
    statusCode: "Error",
  })
  const log = record(2, {
    id: "log:inventory-error",
    kind: "log",
    name: "",
    body: "Inventory unavailable",
    serviceName: child.serviceName,
    spanId: child.spanId,
    durationNs: "0",
    severityNumber: 17,
    severityText: "ERROR",
  })
  const warning = record(3, {
    id: "log:checkout-warning",
    kind: "log",
    name: "",
    body: "Checkout will retry",
    serviceName: "api",
    spanId: root.spanId,
    durationNs: "0",
    severityNumber: 13,
    severityText: "WARN",
  })
  return [root, child, log, warning]
}

test("Live presents a connected hierarchy with counts, stable service chips and accurate colored timings", async ({
  page,
}, testInfo) => {
  const rows = hierarchy()
  const state = await control(page, snapshot(rows))
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto("/live")
  const root = page.locator(`[data-event-id="${rows[0].id}"]`)
  const child = page.locator(`[data-event-id="${rows[1].id}"]`)
  const log = page.locator('[data-event-id="log:inventory-error"]')
  const warning = page.locator('[data-event-id="log:checkout-warning"]')
  await expect(root).toBeVisible()
  await expect(
    root.getByRole("button", { name: "Collapse POST /checkout", exact: true }),
  ).toHaveText("2")
  await expect(
    child.getByRole("button", { name: "Collapse reserve_inventory", exact: true }),
  ).toHaveText("1")
  await expect(child.locator(".lp-tree-guides")).toBeVisible()
  await expect(log).toHaveAttribute("aria-level", "3")
  await expect(root.locator(".lv-bar")).toHaveClass(/error/)
  await expect(log.locator(".lv-tick")).toHaveClass(/error/)
  await expect(warning.locator(".lv-tick")).toHaveClass(/warning/)
  await expect(log.locator(".lv-duration")).toHaveText("—")
  await expect(log.locator(".lp-row-error")).toHaveText("error")
  await expect(page.getByRole("columnheader", { name: /Relative timing/ })).toContainText("0 — 1 s")
  const color = await child
    .locator(".lp-service-chip")
    .evaluate((element) => getComputedStyle(element).color)
  const tick = await log.locator(".lv-tick").boundingBox()
  const track = await log.locator(".lv-track").boundingBox()
  expect(
    tick && track && tick.x >= track.x && tick.x + tick.width <= track.x + track.width,
  ).toBeTruthy()
  state.data = snapshot([...rows].reverse())
  await advance(page, state)
  expect(
    await child.locator(".lp-service-chip").evaluate((element) => getComputedStyle(element).color),
  ).toBe(color)
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.screenshot({
    path: testInfo.outputPath("live-preview-parity.png"),
    animations: "disabled",
    fullPage: true,
  })
})

test("Live columns toggle preserves selection and Reset view restores controls without deleting telemetry", async ({
  page,
}) => {
  const rows = hierarchy()
  const state = await control(page, snapshot(rows))
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto("/live")
  await page.getByRole("button", { name: "Inspect reserve_inventory", exact: true }).click()
  const selected = page.locator(`[data-event-id="${rows[1].id}"]`)
  await page.getByLabel("Columns", { exact: true }).uncheck()
  await expect(page.getByRole("columnheader")).toHaveCount(0)
  await expect(page.getByRole("treegrid")).toHaveAttribute("aria-rowcount", "4")
  await expect(selected).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible()
  await page.getByRole("button", { name: "Close event details" }).click()
  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  await expect(page.getByLabel("Auto-expand", { exact: true })).not.toBeChecked()
  await expect(page.locator(".lv-event-row")).toHaveCount(1)
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.getByRole("button", { name: "Reset view", exact: true }).click()
  await expect(page.getByRole("button", { name: "Pause live updates" })).toBeVisible()
  await expect(page.getByLabel("Auto-expand", { exact: true })).toBeChecked()
  await expect(page.getByLabel("Follow latest", { exact: true })).toBeChecked()
  await expect(page.getByLabel("Columns", { exact: true })).toBeChecked()
  await expect(page.getByRole("columnheader")).toHaveCount(5)
  await expect(page.locator(".lv-event-row")).toHaveCount(4)
  expect(state.data.spans).toHaveLength(2)
  expect(state.data.logs).toHaveLength(2)
  expect(state.queries.every((query) => !query.has("from"))).toBe(true)
})

test("Live marks new arrivals once, keeps explicit filter submission and service suggestions", async ({
  page,
}) => {
  const first = record(0, { name: "First event", serviceName: "my-service" })
  const state = await control(page, snapshot([first]))
  await page.goto("/live")
  await expect(page.locator(".lv-event-row")).toBeVisible()
  await expect(page.locator("#live-services option")).toHaveAttribute("value", "my-service")
  await page.keyboard.press("/")
  await expect(page.getByLabel("Search live events", { exact: true })).toBeFocused()
  await page.getByLabel("Search live events", { exact: true }).fill("First")
  const requests = state.queries.length
  expect(state.queries.at(-1)?.get("search")).toBeNull()
  await expect(page.getByRole("button", { name: "Apply filters", exact: true })).toHaveClass(
    /dirty/,
  )
  await page.getByLabel("Search live events", { exact: true }).press("Enter")
  await expect.poll(() => state.queries.length).toBe(requests + 1)
  expect(state.queries.at(-1)?.get("search")).toBe("First")
  await expect(page.getByRole("button", { name: "Expand all", exact: true })).toBeDisabled()
  const beforeReset = state.queries.length
  await page.getByRole("button", { name: "Reset view" }).click()
  await expect.poll(() => state.queries.length).toBe(beforeReset + 1)
  await expect(page.getByText("Live · polling after each response", { exact: true })).toBeVisible()
  await page.clock.runFor(50)
  await expect(page.getByLabel("Search live events", { exact: true })).toHaveValue("")
  await expect(page.getByRole("button", { name: "Expand all", exact: true })).toBeEnabled()
  const added = record(1, { name: "New event" })
  state.data = snapshot([first, added])
  await advance(page, state)
  const arrival = page.locator(`[data-event-id="${added.id}"]`)
  await expect(arrival).toHaveClass(/lv-arrival/)
  const position = await arrival.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      expected: new DOMMatrixReadOnly((element as HTMLElement).style.transform).m42,
      actual: new DOMMatrixReadOnly(style.transform).m42,
      animation: style.animationName,
      animatesTransform: element
        .getAnimations()
        .some((animation) =>
          (animation.effect as KeyframeEffect)
            .getKeyframes()
            .some((frame) => frame.transform !== undefined),
        ),
    }
  })
  expect(position.expected).toBeGreaterThan(0)
  expect(position.animation).toBe("lv-arrive")
  expect(position.actual).toBe(position.expected)
  expect(position.animatesTransform).toBe(false)
  await page.clock.runFor(1300)
  await expect(arrival).not.toHaveClass(/lv-arrival/)
  await advance(page, state)
  await expect(arrival).not.toHaveClass(/lv-arrival/)
})

test("Live follows the bottom through column, inspector and viewport size changes while paused", async ({
  page,
}) => {
  const state = await control(
    page,
    snapshot(Array.from({ length: 100 }, (_, index) => record(index))),
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto("/live")
  await expect(page.getByRole("treegrid")).toHaveAttribute("aria-rowcount", "101")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  const requests = state.queries.length
  const pane = page.locator(".lv-scroll")
  const atBottom = async () => {
    await page.clock.runFor(50)
    await expect
      .poll(() =>
        pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
      )
      .toBe(0)
    await expect(page.getByLabel("Follow latest", { exact: true })).toBeChecked()
  }
  await atBottom()
  await page.getByLabel("Columns", { exact: true }).uncheck()
  await atBottom()
  await page.getByLabel("Columns", { exact: true }).check()
  await atBottom()
  await page.getByRole("button", { name: "Inspect Exported span 99", exact: true }).click()
  await atBottom()
  await page.setViewportSize({ width: 1100, height: 700 })
  await atBottom()
  await page.getByRole("button", { name: "Close event details" }).click()
  await atBottom()
  expect(state.queries).toHaveLength(requests)
})

for (const theme of ["classic", "studio"]) {
  test(`Live ${theme} mobile keeps hierarchy and controls within the viewport`, async ({
    page,
  }, testInfo) => {
    await control(page, snapshot(hierarchy()))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/live")
    await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme)
    await expect(page.locator(".lv-event-row")).toHaveCount(4)
    await expect(page.getByLabel("Columns", { exact: true })).toBeVisible()
    await expect(page.locator(".lv-time").first()).toHaveText("00:00:00")
    expect(
      await page
        .locator(".lv-time")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole("button", { name: "Pause live updates" }).click()
    await page.screenshot({
      path: testInfo.outputPath(`live-${theme}-mobile.png`),
      animations: "disabled",
      fullPage: true,
    })
    await page.getByRole("button", { name: "Inspect Inventory unavailable", exact: true }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator('[data-event-id="log:inventory-error"]')).toBeFocused()
  })
}
