import { expect, test } from "@playwright/test"
import {
  advance,
  control,
  iso,
  ns,
  rebucket,
  record,
  row,
  snapshot,
  testTarget,
} from "./live-fixtures"

test.beforeEach(() => {
  testTarget(process.env.LOGICE_E2E_URL)
})

for (const suspension of ["hidden", "offline"] as const) {
  test(`Live resumes an interrupted fixed-window request after ${suspension}, then stays paused`, async ({
    page,
    context,
  }) => {
    const state = await control(page)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    let aborted = false
    await page.route("**/api/live?**", async (route) => {
      if (!first) {
        await route.fallback()
        return
      }
      first = false
      state.queries.push(new URL(route.request().url()).searchParams)
      await held
      try {
        await route.fulfill({ json: snapshot([record(1, { name: "Obsolete fixed result" })]) })
      } catch (error) {
        if (!aborted) throw error
      }
    })
    const query = new URLSearchParams({
      ...state.data.window,
      mode: "paused",
      service: "fixed-review",
    })
    await page.goto(`/live?${query}`)
    const url = page.url()
    await expect.poll(() => state.queries.length).toBe(1)
    const failure = page.waitForEvent(
      "requestfailed",
      (request) => new URL(request.url()).pathname === "/api/live",
    )
    if (suspension === "hidden") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        })
        document.dispatchEvent(new Event("visibilitychange"))
      })
    } else await context.setOffline(true)
    await failure
    aborted = true
    release()
    await page.clock.runFor(50)
    await expect(page.locator("[data-event-id]")).toHaveCount(0)
    if (suspension === "hidden") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        })
        document.dispatchEvent(new Event("visibilitychange"))
        document.dispatchEvent(new Event("visibilitychange"))
      })
    } else await context.setOffline(false)
    await expect(row(page, record(0).id)).toBeVisible()
    await expect(page.getByText("Obsolete fixed result", { exact: true })).toHaveCount(0)
    await expect(page.locator(".lv-status strong")).toHaveText("Paused")
    expect(state.queries).toHaveLength(2)
    for (const request of state.queries) {
      expect(request.get("from")).toBe(state.data.window.from)
      expect(request.get("to")).toBe(state.data.window.to)
      expect(request.get("service")).toBe("fixed-review")
    }
    // Recovery of a completed paused view must not start another request.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      })
      document.dispatchEvent(new Event("visibilitychange"))
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await page.clock.fastForward(60_000)
    expect(state.queries).toHaveLength(2)
    expect(page.url()).toBe(url)
  })
}

test("Live keeps the focused histogram slot when rolling timestamps change", async ({ page }) => {
  const state = await control(page)
  await page.goto("/live")
  await expect(row(page, record(0).id)).toBeVisible()
  const buttons = page.locator(".lv-histogram button")
  const selected = buttons.nth(27)
  await selected.focus()
  const original = await selected.elementHandle()
  if (!original) throw new Error("The focused histogram slot is missing")
  const shifted = structuredClone(state.data)
  const offset = 10_000_000_001n
  shifted.window.from = iso(ns(shifted.window.from) + offset)
  shifted.window.to = iso(ns(shifted.window.to) + offset)
  shifted.queriedAt = shifted.window.to
  for (const item of [...shifted.spans, ...shifted.logs, ...shifted.context])
    item.startTime = iso(ns(item.startTime) + offset)
  state.data = rebucket(shifted)
  await advance(page, state)
  await expect
    .poll(() => selected.getAttribute("aria-label"))
    .toContain(state.data.histogram[27].from)
  expect(await original.evaluate((element) => element.isConnected)).toBe(true)
  await expect(selected).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(buttons.nth(28)).toBeFocused()
  const interval = state.data.histogram[28]
  await page.keyboard.press("Enter")
  await expect.poll(() => new URL(page.url()).searchParams.get("mode")).toBe("paused")
  const fixed = new URL(page.url()).searchParams
  expect(fixed.get("from")).toBe(interval.from)
  expect(fixed.get("to")).toBe(interval.to)
})
