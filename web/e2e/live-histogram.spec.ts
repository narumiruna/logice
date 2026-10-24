import { expect, projectHref, test } from "./auth-fixtures"
import { advance, control, iso, ns, rebucket, record, snapshot, testTarget } from "./live-fixtures"

test.beforeEach(() => {
  testTarget(process.env.LOGICE_E2E_URL)
})

test("Live histogram has compact bars, empty buckets and five readable UTC ticks", async ({
  page,
}) => {
  await control(
    page,
    snapshot([record(0, { occurrences: "9007199254740993", statusCode: "Error" })]),
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(projectHref("/live"))
  const histogram = page.getByRole("region", { name: "Stored event histogram" })
  await expect(histogram).toContainText("9007199254740993 matching rows")
  const chart = histogram.locator(".lv-histogram")
  await expect(chart).toHaveCSS("height", "38px")
  const buttons = chart.locator("button")
  await expect(buttons).toHaveCount(60)
  await expect(buttons.nth(1).locator("span").first()).toHaveCSS("height", "0px")
  await expect(buttons.nth(1).locator(".lv-hist-error")).toHaveCSS("height", "0px")
  await expect(buttons.first()).toHaveAttribute("title", /9007199254740993 errors/)
  const ticks = histogram.locator(".lp-time-axis time")
  await expect(ticks).toHaveText(["00:00:00", "00:01:15", "00:02:30", "00:03:45", "00:05:00"])
  const boxes = await ticks.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right }
    }),
  )
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThan(boxes[i - 1].right)
})

for (const reverse of [false, true]) {
  test(`Live histogram shows a ${reverse ? "reverse" : "forward"} drag and keeps its exact server bounds across polling`, async ({
    page,
  }) => {
    const state = await control(page)
    await page.goto(projectHref("/live"))
    const chart = page.locator(".lv-histogram")
    await expect(chart.locator("button")).toHaveCount(60)
    const box = await chart.boundingBox()
    if (!box) throw new Error("Histogram is not visible")
    const x = (slot: number) => box.x + ((slot + 0.5) / 60) * box.width
    const original = structuredClone(state.data)
    await page.mouse.move(x(reverse ? 17 : 8), box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x(reverse ? 8 : 17), box.y + box.height / 2)
    const selection = chart.locator(".lv-hist-selection")
    await expect(selection).toBeVisible()
    const selectedBox = await selection.boundingBox()
    expect(selectedBox?.width).toBeCloseTo(box.width / 6, 0)
    await expect(page.getByText("Release to zoom · Esc to cancel", { exact: false })).toBeVisible()
    const shifted = structuredClone(state.data)
    shifted.window.from = iso(ns(shifted.window.from) + 10_000_000_000n)
    shifted.window.to = iso(ns(shifted.window.to) + 10_000_000_000n)
    shifted.queriedAt = shifted.window.to
    state.data = rebucket(shifted)
    await advance(page, state)
    await expect(chart.locator("button").nth(8)).toHaveAttribute(
      "aria-label",
      new RegExp(original.histogram[8].from.replaceAll(".", "\\.")),
    )
    await page.mouse.up()
    await expect(selection).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).searchParams.get("mode")).toBe("paused")
    const query = new URL(page.url()).searchParams
    expect(query.get("from")).toBe(original.histogram[8].from)
    expect(query.get("to")).toBe(original.histogram[17].to)
  })
}

for (const cancellation of ["Escape", "pointercancel", "lostpointercapture"] as const) {
  test(`Live histogram clears its drag without zoom on ${cancellation}`, async ({ page }) => {
    const state = await control(page)
    await page.goto(projectHref("/live"))
    const chart = page.locator(".lv-histogram")
    await expect(chart.locator("button")).toHaveCount(60)
    const box = await chart.boundingBox()
    if (!box) throw new Error("Histogram is not visible")
    await chart.evaluate((element) => {
      element.addEventListener(
        "pointerdown",
        (event) => {
          element.setAttribute("data-test-pointer", String((event as PointerEvent).pointerId))
        },
        { once: true },
      )
    })
    await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(chart.locator(".lv-hist-selection")).toBeVisible()
    const url = page.url()
    const queries = state.queries.length
    if (cancellation === "Escape") await page.keyboard.press("Escape")
    else
      await chart.dispatchEvent(cancellation, {
        pointerId: Number(await chart.getAttribute("data-test-pointer")),
      })
    await expect(chart.locator(".lv-hist-selection")).toHaveCount(0)
    await page.mouse.up()
    expect(page.url()).toBe(url)
    expect(state.queries).toHaveLength(queries)
    await expect(page.getByRole("button", { name: "Pause live updates" })).toBeVisible()
  })
}
