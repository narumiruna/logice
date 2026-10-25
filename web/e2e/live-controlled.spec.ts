import { expect, projectHref, test } from "./auth-fixtures"
import {
  advance,
  assertBuckets,
  control,
  empty,
  expectClockFocus,
  maximumSnapshot,
  ns,
  record,
  row,
  snapshot,
  testTarget,
} from "./live-fixtures"

test.beforeEach(() => {
  testTarget(process.env.LOGICE_E2E_URL)
})

test("Live shared empty contract has exact fields and 60 integer-nanosecond buckets", () => {
  expect(Object.keys(empty).sort()).toEqual(
    [
      "window",
      "queriedAt",
      "filters",
      "spans",
      "logs",
      "context",
      "histogram",
      "spansTruncated",
      "logsTruncated",
      "contextTruncated",
      "traceGroupsTruncated",
      "limits",
      "completeness",
    ].sort(),
  )
  expect(empty.window).toEqual({ from: "2026-10-23T00:00:00Z", to: "2026-10-23T00:01:00Z" })
  expect(empty.queriedAt).toBe(empty.window.to)
  expect(empty.filters).toEqual({ service: "", search: "", errorsOnly: false, minSeverity: 0 })
  expect([empty.spans, empty.logs, empty.context]).toEqual([[], [], []])
  expect(empty.limits).toEqual({ spans: 500, logs: 500, context: 500, traceGroups: 100 })
  expect(empty.completeness).toBe("unknown")
  expect([
    empty.spansTruncated,
    empty.logsTruncated,
    empty.contextTruncated,
    empty.traceGroupsTruncated,
  ]).toEqual([false, false, false, false])
  assertBuckets(empty)
  for (const bucket of empty.histogram) {
    expect(Object.keys(bucket).sort()).toEqual(
      ["from", "to", "spans", "logs", "errorSpans", "errorLogs"].sort(),
    )
    expect([bucket.spans, bucket.logs, bucket.errorSpans, bucket.errorLogs]).toEqual([
      "0",
      "0",
      "0",
      "0",
    ])
  }
})

test("Live pauses the exact committed window, one-shot refreshes, resumes, and submits filters together", async ({
  page,
}) => {
  const first = record(0)
  const second = record(1)
  const state = await control(page, snapshot([first]))
  await page.goto(projectHref("/live"))
  await expect(row(page, first.id)).toBeVisible()
  expect(state.queries[0].get("range")).toBe("5m")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  const frozen = new URL(page.url()).searchParams
  expect(frozen.get("mode")).toBe("paused")
  expect(ns(frozen.get("from") ?? "")).toBe(ns(state.data.window.from))
  expect(ns(frozen.get("to") ?? "")).toBe(ns(state.data.window.to))
  const pausedCount = state.queries.length
  state.data = snapshot([first, second])
  await page.clock.fastForward(30_000)
  expect(state.queries).toHaveLength(pausedCount)
  await expect(row(page, second.id)).toHaveCount(0)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(row(page, second.id)).toBeVisible()
  expect(state.queries).toHaveLength(pausedCount + 1)
  expect(state.queries.at(-1)?.get("from")).toBe(frozen.get("from"))
  await page.clock.fastForward(30_000)
  expect(state.queries).toHaveLength(pausedCount + 1)
  await page.getByRole("button", { name: "Resume live updates" }).click()
  await expect.poll(() => state.queries.length).toBe(pausedCount + 2)
  expect(state.queries.at(-1)?.get("range")).toBe("5m")
  expect(state.queries.every((query) => !query.has("mode"))).toBe(true)
  const beforeEdit = state.queries.length
  await page.getByLabel("Service filter", { exact: true }).fill("exact service")
  await page.getByLabel("Search live events", { exact: true }).fill("literal %_ '<script>")
  await page.getByLabel("Errors only", { exact: true }).check()
  await page.getByLabel("Minimum log severity", { exact: true }).selectOption("21")
  expect(state.queries).toHaveLength(beforeEdit)
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  await expect.poll(() => state.queries.length).toBe(beforeEdit + 1)
  expect(Object.fromEntries(state.queries.at(-1) ?? [])).toEqual({
    range: "5m",
    service: "exact service",
    search: "literal %_ '<script>",
    errorsOnly: "true",
    minSeverity: "21",
  })
})

test("Live unresolved pause makes no request until Refresh and pins its first returned window", async ({
  page,
}) => {
  const state = await control(page, snapshot([]))
  await page.goto(projectHref("/live?mode=paused&range=5m"))
  await expect(page.getByText("Paused before first result", { exact: true })).toBeVisible()
  await page.clock.fastForward(60_000)
  expect(state.queries).toHaveLength(0)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("No matching events", { exact: true })).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.has("from")).toBe(true)
  expect(state.queries).toHaveLength(1)
  await page.clock.fastForward(60_000)
  expect(state.queries).toHaveLength(1)
})

test("Live URL reload, back and forward restore mode, filters and absolute nanoseconds without polling history", async ({
  page,
}) => {
  const state = await control(page)
  await page.goto(projectHref("/live?mode=live&range=1m&service=first"))
  await expect(row(page, record(0).id)).toBeVisible()
  const historyLength = await page.evaluate(() => history.length)
  await advance(page, state)
  await advance(page, state)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
  await page.getByLabel("Service filter", { exact: true }).fill("second")
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  await expect.poll(() => state.queries.at(-1)?.get("service")).toBe("second")
  await page.getByRole("button", { name: "Pause live updates" }).click()
  const pausedURL = page.url()
  await page.reload()
  await expect(page.getByRole("button", { name: "Resume live updates" })).toBeVisible()
  await expect(page.getByLabel("Service filter", { exact: true })).toHaveValue("second")
  expect(page.url()).toBe(pausedURL)
  await page.goBack()
  await expect(page.getByRole("button", { name: "Pause live updates" })).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel("Service filter", { exact: true })).toHaveValue("first")
  await page.goForward()
  await expect(page.getByLabel("Service filter", { exact: true })).toHaveValue("second")
  await page.goForward()
  await expect(page.getByRole("button", { name: "Resume live updates" })).toBeVisible()
  expect(page.url()).toBe(pausedURL)
})

test("Live histogram keyboard zoom never submits less than one second and explicit subsecond input is rejected", async ({
  page,
}) => {
  const state = await control(page, snapshot([]))
  await page.goto(projectHref("/live?range=1m"))
  const bucket = page.getByRole("button", { name: /^Select bucket 1:/ })
  await expect(bucket).toBeVisible()
  await expect(page.getByText(/Minimum 1 second/)).toBeVisible()
  await bucket.focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("button", { name: /^Select bucket 2:/ })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Resume live updates" })).toBeVisible()
  await expect.poll(() => state.queries.at(-1)?.has("from")).toBe(true)
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: /^Select bucket 30:/ }).focus()
    await page.keyboard.press("Enter")
    await page.clock.runFor(50)
    const query = state.queries.at(-1)
    expect(ns(query?.get("to") ?? "") - ns(query?.get("from") ?? "")).toBe(1_000_000_000n)
  }
  const before = state.queries.length
  await page.getByText("Fixed UTC interval", { exact: true }).click()
  await page.getByLabel("From UTC", { exact: true }).fill("2026-10-23T00:00:00.000000001Z")
  await page.getByLabel("To UTC", { exact: true }).fill("2026-10-23T00:00:00.999999999Z")
  await page.getByRole("button", { name: "Apply fixed interval", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText(/one second|1 second/i)
  expect(state.queries).toHaveLength(before)
})

test("Live late parents preserve selection, inspector tab and focus; duplicate content counts do not grow across polls", async ({
  page,
}, testInfo) => {
  const parent = record(0, { name: "Late parent" })
  const child = record(1, {
    parentSpanId: parent.spanId,
    name: "Initially orphaned child",
    occurrences: "3",
    statusCode: "Error",
  })
  const state = await control(page, snapshot([child]))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(projectHref("/live"))
  await expect(row(page, child.id)).toContainText("Missing parent")
  await row(page, child.id)
    .getByRole("button", { name: "Inspect Initially orphaned child" })
    .click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  const raw = inspector.getByRole("tab", { name: "Stored record JSON", exact: true })
  await raw.click()
  await expect(raw).toBeFocused()
  state.data = snapshot([parent, child])
  await advance(page, state)
  await expect(row(page, parent.id)).toBeVisible()
  await expect(row(page, child.id)).toHaveAttribute("aria-level", "2")
  await expect(row(page, child.id)).toHaveAttribute("aria-selected", "true")
  await expect(row(page, child.id)).not.toContainText("Missing parent")
  await expect(raw).toHaveAttribute("aria-selected", "true")
  await expect(raw).toBeFocused()
  await expect(inspector).toContainText("3 stored occurrences")
  await expect(page.getByRole("region", { name: "Stored event histogram" })).toContainText(
    "4 matching rows",
  )
  await advance(page, state)
  await expect(inspector).toContainText("3 stored occurrences")
  const link = inspector.getByRole("link", { name: child.traceId, exact: true })
  const bounds = new URL((await link.getAttribute("href")) ?? "", page.url()).searchParams
  expect(ns(bounds.get("from") ?? "")).toBe(ns(state.data.window.from))
  expect(ns(bounds.get("to") ?? "")).toBe(ns(state.data.window.to))
  state.data = snapshot([parent])
  await advance(page, state)
  await expect(inspector).toContainText("Outside current results")
  await expect(raw).toBeFocused()
  await expect(page.getByRole("tabpanel")).toContainText("stored projection")
  await page.screenshot({
    path: testInfo.outputPath("live-desktop-inspector.png"),
    animations: "disabled",
    fullPage: true,
  })
  await page.keyboard.press("Escape")
  await expect(inspector).toHaveCount(0)
  await expect(page.getByRole("treegrid", { name: "Live telemetry events" })).toBeFocused()
})

test("Live renders only bounded virtual rows at the maximum valid snapshot and keyboard focuses offscreen records", async ({
  page,
}) => {
  await control(page, maximumSnapshot())
  await page.goto(projectHref("/live"))
  const tree = page.getByRole("treegrid", { name: "Live telemetry events" })
  await expect(tree).toHaveAttribute("aria-rowcount", "1501")
  await expect(page.getByText(/Partial results:/)).toContainText(
    "span limit; log limit; context limit; trace-group limit",
  )
  for (const viewport of [
    { width: 1600, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.clock.runFor(50)
    const mounted = page.locator("[data-event-id]")
    expect(await mounted.count()).toBeGreaterThan(0)
    expect(await mounted.count()).toBeLessThanOrEqual(120)
    await tree.focus()
    await page.keyboard.press("Home")
    // Navigation must stop following before a resize or poll can move us back.
    // Keep animation frames frozen until this state change is committed.
    await expect(page.getByLabel("Follow latest", { exact: true })).not.toBeChecked()
    await page.clock.runFor(50)
    await expectClockFocus(page, tree.locator('[data-event-id][aria-rowindex="2"]'))
    await expect(tree.locator('[data-event-id][aria-rowindex="2"]')).toBeFocused()
    await page.keyboard.press("End")
    await page.clock.runFor(50)
    await expectClockFocus(page, tree.locator('[data-event-id][aria-rowindex="1501"]'))
    await expect(tree.locator('[data-event-id][aria-rowindex="1501"]')).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await page.clock.runFor(50)
    await expectClockFocus(page, tree.locator('[data-event-id][aria-rowindex="1500"]'))
    await expect(tree.locator('[data-event-id][aria-rowindex="1500"]')).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible()
    await page.keyboard.press("Escape")
    await page.clock.runFor(50)
    await expectClockFocus(page, tree.locator('[data-event-id][aria-rowindex="1500"]'))
    await expect(tree.locator('[data-event-id][aria-rowindex="1500"]')).toBeFocused()
  }
})

test("Live scroll anchor drifts less than 3px after late-parent and earlier-row insertion; repeated snapshots do not add notifications", async ({
  page,
}) => {
  const rows = Array.from({ length: 180 }, (_, index) => record(index))
  const parent = record(900, {
    traceId: rows[25].traceId,
    startTime: rows[0].startTime,
    name: "Late ancestor",
  })
  rows[25].parentSpanId = parent.spanId
  const state = await control(page, snapshot(rows))
  await page.goto(projectHref("/live"))
  const pane = page.locator(".lv-scroll")
  await expect(page.getByRole("treegrid")).toHaveAttribute("aria-rowcount", "181")
  await page.clock.runFor(50)
  await pane.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }))
    const height = element.querySelector(".lv-event-row")?.getBoundingClientRect().height ?? 0
    element.scrollTop = 90 * height + 7
    element.dispatchEvent(new Event("scroll"))
  })
  await page.clock.runFor(50)
  await expect(page.getByLabel("Follow latest", { exact: true })).not.toBeChecked()
  const anchor = await pane.evaluate((element) => {
    const top = element.getBoundingClientRect().top
    const candidate = [...element.querySelectorAll<HTMLElement>("[data-event-id]")].find(
      (item) => item.getBoundingClientRect().bottom > top && item.getBoundingClientRect().top < top,
    )
    if (!candidate) throw new Error("No visible anchor")
    return {
      id: candidate.dataset.eventId ?? "",
      offset: candidate.getBoundingClientRect().top - top,
    }
  })
  state.data = snapshot([parent, ...rows, record(901, { startTime: rows[0].startTime })])
  await advance(page, state)
  const offset = await row(page, anchor.id).evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      (element.closest(".lv-scroll")?.getBoundingClientRect().top ?? 0),
  )
  expect(Math.abs(offset - anchor.offset)).toBeLessThan(3)
  await expect(page.getByLabel("Follow latest", { exact: true })).not.toBeChecked()
  const jump = page.getByRole("button", { name: /2 newly visible records · Jump to latest/ })
  await expect(jump).toBeVisible()
  await advance(page, state)
  await expect(jump).toBeVisible()
  state.data = snapshot(state.data.spans.filter((item) => item.id !== anchor.id))
  await advance(page, state)
  await expect(page.getByText(/Scroll anchor left the window or result limits/)).toBeVisible()
  await jump.click()
  await expect(page.getByLabel("Follow latest", { exact: true })).toBeChecked()
  expect(
    await pane.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    ),
  ).toBeLessThan(3)
})

test("Live tree arrows preserve manual collapse and expose error context without counting ancestors", async ({
  page,
}) => {
  const parent = record(0, { name: "Healthy context", contextOnly: true, statusCode: "Ok" })
  const child = record(1, { name: "Error match", parentSpanId: parent.spanId, statusCode: "Error" })
  const state = await control(page, snapshot([parent, child]))
  await page.goto(projectHref("/live"))
  await expect(row(page, parent.id)).toContainText("Context")
  await expect(page.getByRole("region", { name: "Stored event histogram" })).toContainText(
    "1 matching rows",
  )
  await expect(page.getByRole("button", { name: /^Select bucket 1:/ })).toHaveAttribute(
    "title",
    /1 spans · 0 logs · 1 errors/,
  )
  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  const tree = page.getByRole("treegrid")
  await tree.focus()
  await page.keyboard.press("Home")
  await page.clock.runFor(50)
  await page.keyboard.press("ArrowRight")
  await expect(row(page, child.id)).toBeVisible()
  await page.keyboard.press("ArrowRight")
  await page.clock.runFor(50)
  await expect(row(page, child.id)).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await page.clock.runFor(50)
  await expect(row(page, parent.id)).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, child.id)).toHaveCount(0)
  await advance(page, state)
  await expect(row(page, child.id)).toHaveCount(0)
  await page.getByLabel("Errors only", { exact: true }).check()
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  await expect(row(page, child.id)).toBeVisible()
  await expect(page.getByRole("button", { name: "Collapse all", exact: true })).toBeDisabled()
})

for (const failure of ["invalid JSON", "invalid schema", "503"] as const) {
  test(`Live ${failure} retains stale telemetry, never simulates empty, and recovers atomically`, async ({
    page,
  }) => {
    const state = await control(page)
    await page.goto(projectHref("/live"))
    await expect(row(page, record(0).id)).toBeVisible()
    if (failure === "503") state.status = 503
    else
      state.malformed =
        failure === "invalid JSON" ? "{broken" : JSON.stringify({ ...state.data, histogram: [] })
    await advance(page, state)
    await expect(page.getByRole("alert")).toContainText(/stale|last successful/i)
    await expect(row(page, record(0).id)).toBeVisible()
    await expect(page.getByText("No matching events", { exact: true })).toHaveCount(0)
    const count = state.queries.length
    if (failure !== "503") {
      await page.clock.fastForward(60_000)
      expect(state.queries).toHaveLength(count)
    } else await expect(page.getByText("Retrying · stale data", { exact: true })).toBeVisible()
    state.status = 200
    state.malformed = null
    state.data = snapshot([record(2)])
    await page.getByRole("button", { name: "Try again", exact: true }).click()
    await expect(row(page, record(2).id)).toBeVisible()
    await expect(row(page, record(0).id)).toHaveCount(0)
    await expect(page.getByRole("alert")).toHaveCount(0)
  })
}

for (const status of [401, 403]) {
  test(`Live ${status} clears telemetry and selection and stops polling`, async ({ page }) => {
    const state = await control(page)
    await page.goto(projectHref("/live"))
    await row(page, record(0).id).getByRole("button", { name: "Inspect Exported span 0" }).click()
    await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible()
    state.status = status
    await advance(page, state)
    await expect(page.getByRole("alert")).toContainText(
      status === 401 ? "session expired" : String(status),
    )
    if (status === 401) {
      await expect(page.getByRole("heading", { name: "Sign in to Logice" })).toBeVisible()
    }
    await expect(page.locator("[data-event-id]")).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Event details" })).toHaveCount(0)
    const count = state.queries.length
    await page.clock.fastForward(60_000)
    expect(state.queries).toHaveLength(count)
    await expect(page.getByText("No matching events", { exact: true })).toHaveCount(0)
  })
}

test("Live hidden and offline lifecycle suspends without changing URL mode and coalesces resume events", async ({
  page,
  context,
}) => {
  const state = await control(page)
  await page.goto(projectHref("/live"))
  await expect(row(page, record(0).id)).toBeVisible()
  const url = page.url()
  // Chromium headless has no reliable tab occlusion. Dispatch the browser visibility
  // event with the documented property; offline additionally uses a real context transition.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(page.getByText(/Suspended · tab hidden or offline/)).toBeVisible()
  let count = state.queries.length
  await page.clock.fastForward(60_000)
  expect(state.queries).toHaveLength(count)
  expect(page.url()).toBe(url)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("online"))
  })
  await expect.poll(() => state.queries.length).toBe(count + 1)
  await context.setOffline(true)
  await expect(page.getByText(/Suspended · tab hidden or offline/)).toBeVisible()
  count = state.queries.length
  await page.clock.fastForward(60_000)
  expect(state.queries).toHaveLength(count)
  await context.setOffline(false)
  await expect.poll(() => state.queries.length).toBe(count + 1)
  expect(page.url()).toBe(url)
  await page.goto("/preview")
  count = state.queries.length
  await page.clock.fastForward(60_000)
  expect(state.queries).toHaveLength(count)
})

test("Live mobile inspector is a native modal with inert background, contained focus, Escape restore, and reduced motion", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await control(page)
  await page.goto(projectHref("/live"))
  const selected = row(page, record(0).id)
  await selected.getByRole("button", { name: "Inspect Exported span 0" }).click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await expect(inspector).toBeVisible()
  expect(
    await inspector.evaluate(
      (element) => element instanceof HTMLDialogElement && element.matches(":modal"),
    ),
  ).toBe(true)
  await expect(inspector.getByRole("heading", { name: "Exported span 0" })).toBeFocused()
  await page
    .getByLabel("Search live events")
    .evaluate((element) => (element as HTMLElement).focus())
  expect(await inspector.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab")
    expect(await inspector.evaluate((element) => element.contains(document.activeElement))).toBe(
      true,
    )
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    await page.evaluate(() =>
      [...document.getAnimations()].every((animation) => animation.playState !== "running"),
    ),
  ).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath("live-mobile-inspector.png"),
    animations: "disabled",
    fullPage: true,
  })
  await page.keyboard.press("Escape")
  await page.clock.runFor(50)
  await expect(inspector).toHaveCount(0)
  await expect(selected).toBeFocused()
})
