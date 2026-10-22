import { expect, test } from "@playwright/test"
import {
  advance,
  control,
  maximumSnapshot,
  record,
  row,
  snapshot,
  testTarget,
} from "./live-fixtures"

test.beforeEach(() => {
  testTarget(process.env.LOGICE_E2E_URL)
})

test("Live ignores an obsolete response even when transport ignores abort, and never restarts after pause", async ({
  page,
}) => {
  const state = await control(page, snapshot([record(2)]))
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input).startsWith("/api/live?"))
        return original(input, { ...init, signal: undefined })
      return original(input, init)
    }
  })
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/live?**", async (route) => {
    const query = new URL(route.request().url()).searchParams
    if (query.get("service") !== "obsolete") {
      await route.fallback()
      return
    }
    state.queries.push(query)
    await held
    const old = snapshot([record(1, { name: "Obsolete telemetry" })])
    old.filters.service = "obsolete"
    await route.fulfill({ json: old })
  })
  await page.goto("/live?service=obsolete")
  await expect.poll(() => state.queries.length).toBe(1)
  await page.getByLabel("Service filter", { exact: true }).fill("current")
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  // A physical in-flight slot remains owned until ignored-abort work settles.
  expect(state.queries).toHaveLength(1)
  release()
  await expect(row(page, record(2).id)).toBeVisible()
  await expect(page.getByRole("button", { name: "Inspect Obsolete telemetry" })).toHaveCount(0)
  expect(state.queries.map((query) => query.get("service"))).toEqual(["obsolete", "current"])
  await page.getByRole("button", { name: "Pause live updates" }).click()
  const count = state.queries.length
  await page.clock.fastForward(60_000)
  expect(state.queries).toHaveLength(count)
})

for (const status of [400, 404, 422]) {
  test(`Live first-load ${status} is explicit, stops retries, and never substitutes simulated data`, async ({
    page,
  }) => {
    const state = await control(page)
    state.status = status
    await page.goto("/live")
    const error = page.getByRole("alert")
    await expect(error).toBeVisible()
    await expect(error).toContainText(status === 404 ? "does not support Live" : String(status))
    await expect(page.locator("[data-event-id]")).toHaveCount(0)
    await expect(page.getByText("No matching events", { exact: true })).toHaveCount(0)
    const count = state.queries.length
    await page.clock.fastForward(60_000)
    expect(state.queries).toHaveLength(count)
    state.status = 200
    await page.getByRole("button", { name: "Try again", exact: true }).click()
    await expect(row(page, record(0).id)).toBeVisible()
    await expect(error).toHaveCount(0)
  })
}

test("Live waits two seconds after response completion and clamps overload retry before recovery", async ({
  page,
}) => {
  const state = await control(page)
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let initial = true
  await page.route("**/api/live?**", async (route) => {
    if (initial) {
      initial = false
      await held
      await route.fallback()
      return
    }
    if (state.status === 429) {
      state.queries.push(new URL(route.request().url()).searchParams)
      await route.fulfill({
        status: 429,
        headers: { "Retry-After": "0" },
        json: { error: { code: "overloaded", message: "Try later." } },
      })
      return
    }
    await route.fallback()
  })
  await page.goto("/live")
  await page.clock.fastForward(4000)
  expect(state.queries).toHaveLength(0)
  release()
  await expect(row(page, record(0).id)).toBeVisible()
  await page.clock.fastForward(1900)
  expect(state.queries).toHaveLength(1)
  state.status = 429
  await advance(page, state, 150)
  await expect(page.getByRole("alert")).toContainText("429")
  const count = state.queries.length
  await page.clock.fastForward(1900)
  expect(state.queries).toHaveLength(count)
  state.status = 200
  await advance(page, state, 150)
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("Live shows stored conflict and ambiguous-parent warnings without inventing running duration", async ({
  page,
}) => {
  const conflicted = record(0, {
    conflict: true,
    parentConflict: true,
    parentSpanId: record(1).spanId,
  })
  const state = await control(page, snapshot([conflicted, record(1)]))
  await page.goto("/live")
  await expect(row(page, conflicted.id)).toContainText("Ambiguous parent")
  await expect(row(page, conflicted.id)).toHaveAttribute("aria-level", "1")
  const duration = await row(page, conflicted.id).locator(".lv-duration").textContent()
  await row(page, conflicted.id).getByRole("button", { name: "Inspect Exported span 0" }).click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await expect(inspector).toContainText("Conflicting exports")
  await expect(inspector).toContainText("not a latest version")
  await expect(inspector).toContainText("Ambiguous parent")
  await expect(inspector).toContainText("Unset")
  await expect(inspector).not.toContainText("Running")
  await advance(page, state, 60_000)
  await expect(row(page, conflicted.id).locator(".lv-duration")).toHaveText(duration ?? "")
})

test("Live retains only a bounded snapshot plus one outside selection through fifteen simulated minutes", async ({
  page,
}) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const base = maximumSnapshot()
  const state = await control(page, base)
  let active = 0
  let maximumActive = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/live") {
      active++
      maximumActive = Math.max(maximumActive, active)
    }
  })
  const complete = (request: { url: () => string }) => {
    if (new URL(request.url()).pathname === "/api/live") active--
  }
  page.on("requestfinished", complete)
  page.on("requestfailed", complete)
  await page.goto("/live")
  const tree = page.getByRole("treegrid")
  await expect(tree).toHaveAttribute("aria-rowcount", "1501")
  await tree.focus()
  await page.keyboard.press("End")
  await page.clock.runFor(50)
  await page.keyboard.press("Enter")
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await expect(inspector).toBeVisible()
  for (let generation = 1; generation <= 30; generation++) {
    const next = structuredClone(base)
    const shift = BigInt(generation * 10_000)
    for (const item of [...next.spans, ...next.logs, ...next.context]) {
      item.spanId = (BigInt(`0x${item.spanId}`) + shift).toString(16).padStart(16, "0")
      if (item.parentSpanId)
        item.parentSpanId = (BigInt(`0x${item.parentSpanId}`) + shift)
          .toString(16)
          .padStart(16, "0")
      item.id =
        item.kind === "span"
          ? `span:validation:${item.traceId}:${item.spanId}`
          : `log:${generation}:${item.id.slice(4)}`
      item.name = item.kind === "span" ? `Generation ${generation} ${item.name}` : ""
      item.body = item.kind === "log" ? `Generation ${generation} ${item.body}` : ""
    }
    state.data = next
    await advance(page, state, 30_000)
    await expect(tree).toHaveAttribute("aria-rowcount", "1501")
    await expect(page.locator("[data-event-id] .lv-message-button").last()).toContainText(
      `Generation ${generation} `,
    )
    expect(await page.locator("[data-event-id]").count()).toBeLessThanOrEqual(120)
    await expect(inspector).toContainText("Outside current results")
  }
  expect(maximumActive).toBe(1)
  expect(state.queries).toHaveLength(31)
  await page.getByRole("button", { name: "Pause live updates" }).click()
  await page.clock.fastForward(60_000)
  expect(state.queries).toHaveLength(31)
})

test("Live preserves the orphan anchor itself and its keyboard focus when a late parent reparents it", async ({
  page,
}) => {
  const rows = Array.from({ length: 180 }, (_, index) => record(index))
  const child = rows[90]
  const parent = record(900, {
    traceId: child.traceId,
    startTime: rows[0].startTime,
    name: "Late focused ancestor",
  })
  child.parentSpanId = parent.spanId
  const state = await control(page, snapshot(rows))
  await page.goto("/live")
  await expect(page.getByRole("treegrid")).toHaveAttribute("aria-rowcount", "181")
  await page.clock.runFor(50)
  const pane = page.locator(".lv-scroll")
  await pane.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }))
    element.scrollTop = 90 * 34 + 7
    element.dispatchEvent(new Event("scroll"))
  })
  await page.clock.runFor(50)
  const anchor = row(page, child.id)
  await expect(anchor).toContainText("Missing parent")
  await anchor.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }))
  await expect(anchor).toBeFocused()
  const offset = () =>
    anchor.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        (element.closest(".lv-scroll")?.getBoundingClientRect().top ?? 0),
    )
  const before = await offset()
  expect(before).toBeLessThan(0)
  expect(before).toBeGreaterThan(-34)
  state.data = snapshot([parent, ...rows])
  await advance(page, state)
  await expect(anchor).toHaveAttribute("aria-level", "2")
  await page.clock.runFor(50)
  expect(Math.abs((await offset()) - before)).toBeLessThan(3)
  await expect(anchor).toBeFocused()
  await expect(page.getByLabel("Follow latest", { exact: true })).not.toBeChecked()
})

test("Live Pause during an uncommitted search freezes the displayed snapshot's query and window", async ({
  page,
}) => {
  const state = await control(page)
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  await page.route("**/api/live?**", async (route) => {
    const query = new URL(route.request().url()).searchParams
    if (query.get("search") !== "Uncommitted B") {
      await route.fallback()
      return
    }
    state.queries.push(query)
    started = true
    await held
    const response = snapshot([record(1)])
    response.filters.search = "Uncommitted B"
    await route.fulfill({ json: response })
  })
  await page.goto("/live?search=Committed%20A")
  await expect(row(page, record(0).id)).toBeVisible()
  await page.getByLabel("Search live events", { exact: true }).fill("Uncommitted B")
  await page.getByRole("button", { name: "Apply filters", exact: true }).click()
  await expect.poll(() => started).toBe(true)
  await page.getByRole("button", { name: "Pause live updates" }).click()
  const frozen = new URL(page.url()).searchParams
  expect(frozen.get("mode")).toBe("paused")
  expect(frozen.get("search")).toBe("Committed A")
  expect(frozen.get("from")).toBe(state.data.window.from)
  expect(frozen.get("to")).toBe(state.data.window.to)
  await expect(page.getByLabel("Search live events", { exact: true })).toHaveValue("Committed A")
  release()
  await page.clock.runFor(50)
  await expect(row(page, record(0).id)).toBeVisible()
  await expect(row(page, record(1).id)).toHaveCount(0)
  const count = state.queries.length
  await page.clock.fastForward(30_000)
  expect(state.queries).toHaveLength(count)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => state.queries.length).toBe(count + 1)
  expect(state.queries.at(-1)?.get("search")).toBe("Committed A")
  expect(state.queries.at(-1)?.get("from")).toBe(frozen.get("from"))
})

test("Live fixed UTC drafts survive polling and follow or auto-expand changes until explicit submission", async ({
  page,
}) => {
  const state = await control(page)
  await page.goto("/live")
  await expect(row(page, record(0).id)).toBeVisible()
  await page.getByText("Fixed UTC interval", { exact: true }).click()
  const from = "2026-10-23T00:00:10.000000123Z"
  const to = "2026-10-23T00:01:11.000000456Z"
  await page.getByLabel("From UTC", { exact: true }).fill(from)
  await page.getByLabel("To UTC", { exact: true }).fill(to)
  await advance(page, state)
  await expect(page.getByLabel("From UTC", { exact: true })).toHaveValue(from)
  await expect(page.getByLabel("To UTC", { exact: true })).toHaveValue(to)
  const count = state.queries.length
  await page.getByLabel("Follow latest", { exact: true }).uncheck()
  await page.getByLabel("Auto-expand", { exact: true }).uncheck()
  await page.getByLabel("Auto-expand", { exact: true }).check()
  await expect(page.getByLabel("From UTC", { exact: true })).toHaveValue(from)
  await expect(page.getByLabel("To UTC", { exact: true })).toHaveValue(to)
  expect(state.queries).toHaveLength(count)
  await page.getByRole("button", { name: "Apply fixed interval", exact: true }).click()
  await expect.poll(() => state.queries.at(-1)?.get("from")).toBe(from)
  expect(state.queries.at(-1)?.get("to")).toBe(to)
  expect(new URL(page.url()).searchParams.get("mode")).toBe("paused")
})

test("Live keeps selection through a healthy empty snapshot and Escape restores focus to the results area", async ({
  page,
}) => {
  const state = await control(page)
  await page.goto("/live")
  await row(page, record(0).id).getByRole("button", { name: "Inspect Exported span 0" }).click()
  const inspector = page.getByRole("dialog", { name: "Event details" })
  await expect(inspector).toBeVisible()
  state.data = snapshot([])
  await advance(page, state)
  await expect(page.locator(".lp-empty")).toContainText("No matching events")
  await expect(inspector).toContainText("Outside current results")
  await page.keyboard.press("Escape")
  await page.clock.runFor(50)
  await expect(inspector).toHaveCount(0)
  await expect(page.getByRole("treegrid", { name: "Live telemetry events" })).toBeFocused()
})
