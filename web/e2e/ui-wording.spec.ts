import it from "../src/locales/it.json" with { type: "json" }
import { expect, projectHref, test, workspace } from "./auth-fixtures"

const destinationId = "11111111-1111-4111-8111-111111111111"

test("alert fields describe the selected metric and keep API values and units unchanged", async ({
  page,
}) => {
  const submitted: Record<string, unknown>[] = []
  const deliveryResults = [
    { value: "invalid_destination", label: "Invalid destination" },
    { value: "transport_failure", label: "Connection failed" },
    { value: "retryable_status", label: "Retryable HTTP error" },
    { value: "rejected_status", label: "HTTP response rejected" },
  ] as const
  const rules = ["error_ratio", "root_p95", "no_data"].map((kind, index) => ({
    id: `rule-${index}`,
    name: `Existing ${kind} rule`,
    destinationId,
    kind,
    service: "",
    threshold: kind === "no_data" ? "0" : kind === "root_p95" ? "1000000000" : "0.1",
    minPopulation: 10,
    enabled: true,
    revision: "1",
    state: "resolved",
    incidentActive: false,
    lastWindowTo: null,
  }))
  await page.route("**/api/projects/*/alerts/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST" && path.endsWith("/rules")) {
      submitted.push(route.request().postDataJSON())
      return route.fulfill({ json: {} })
    }
    if (path.endsWith("/rules")) return route.fulfill({ json: { items: rules } })
    if (path.endsWith("/destinations"))
      return route.fulfill({
        json: {
          items: [
            { id: destinationId, name: "Application alerts", revision: "1", disabled: false },
          ],
        },
      })
    if (path.endsWith("/deliveries"))
      return route.fulfill({
        json: {
          items: deliveryResults.map(({ value }, index) => ({
            id: `delivery-${index}`,
            ruleId: "rule-0",
            state: "pending",
            result: value,
            createdAt: new Date().toISOString(),
          })),
          hasMore: false,
        },
      })
    return route.fulfill({ json: { items: [], hasMore: false } })
  })
  await page.goto(`/projects/${workspace().project.id}/alerts`)
  await expect(page.getByRole("heading", { name: "Existing root_p95 rule" })).toBeVisible()
  for (const [kind, label] of [
    ["error_ratio", "Error trace proportion"],
    ["root_p95", "Root span duration (p95)"],
    ["no_data", "No stored telemetry"],
  ]) {
    const card = page
      .locator("div.settings-card")
      .filter({ has: page.getByRole("heading", { name: `Existing ${kind} rule`, exact: true }) })
    await expect(card.locator("p").first()).toContainText(label)
    await expect(card.locator("p").first()).not.toContainText(kind)
  }
  const history = page.locator("section.settings-card").filter({
    has: page.getByRole("heading", { name: "Incident and delivery history", exact: true }),
  })
  for (const { value, label } of deliveryResults) {
    await expect(history).toContainText(label)
    await expect(history).not.toContainText(value)
  }
  await page
    .getByRole("combobox", { name: "Alert condition", exact: true })
    .selectOption("root_p95")
  await expect(page.getByLabel("Root span duration threshold (ns)", { exact: true })).toHaveValue(
    "1000000000",
  )
  await page.getByLabel("Root span duration threshold (ns)", { exact: true }).fill("123456789")
  await page.getByLabel("Minimum root spans", { exact: true }).fill("20")
  await page.getByLabel("Alert rule name", { exact: true }).fill("Duration rule")
  await page
    .getByRole("combobox", { name: "Approved destination", exact: true })
    .selectOption(destinationId)
  await page.getByRole("button", { name: "Save alert rule", exact: true }).click()
  await expect.poll(() => submitted.length).toBe(1)
  expect(submitted[0]).toEqual({
    name: "Duration rule",
    destinationId,
    kind: "root_p95",
    service: "",
    threshold: "123456789",
    minPopulation: 20,
    enabled: true,
  })

  await expect(
    page.getByLabel("Error trace proportion threshold (0–1)", { exact: true }),
  ).toBeVisible()
  await page.getByLabel("Error trace proportion threshold (0–1)", { exact: true }).fill("0.25")
  await page.getByLabel("Minimum traces", { exact: true }).fill("12")
  await page.getByLabel("Alert rule name", { exact: true }).fill("Error rule")
  await page
    .getByRole("combobox", { name: "Approved destination", exact: true })
    .selectOption(destinationId)
  await page.getByRole("button", { name: "Save alert rule", exact: true }).click()
  await expect.poll(() => submitted.length).toBe(2)
  expect(submitted[1]).toMatchObject({ kind: "error_ratio", threshold: "0.25", minPopulation: 12 })

  await expect(
    page.getByLabel("Error trace proportion threshold (0–1)", { exact: true }),
  ).toBeVisible()
  await page.getByRole("combobox", { name: "Alert condition", exact: true }).selectOption("no_data")
  await expect(page.getByLabel("Threshold (not used)", { exact: true })).toHaveValue("0")
  await expect(page.getByLabel("Threshold (not used)", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  )
  await expect(page.getByLabel("Minimum sample size (not used)", { exact: true })).toBeVisible()
  await page.getByLabel("Alert rule name", { exact: true }).fill("No data rule")
  await page
    .getByRole("combobox", { name: "Approved destination", exact: true })
    .selectOption(destinationId)
  await page.getByRole("button", { name: "Save alert rule", exact: true }).click()
  await expect.poll(() => submitted.length).toBe(3)
  expect(submitted[2]).toMatchObject({ kind: "no_data", threshold: "0", minPopulation: 10 })

  await page.locator(".language-select select").selectOption("it")
  await page
    .getByRole("combobox", { name: it["Alert condition"], exact: true })
    .selectOption("root_p95")
  const localizedHistory = page.locator("section.settings-card").filter({
    has: page.getByRole("heading", { name: it["Incident and delivery history"], exact: true }),
  })
  for (const { label } of deliveryResults) await expect(localizedHistory).toContainText(it[label])
  await expect(
    page.getByLabel(it["Root span duration threshold (ns)"], { exact: true }),
  ).toHaveValue("1000000000")
  await expect(page.getByLabel(it["Minimum root spans"], { exact: true })).toBeVisible()
})

test("audit actions use readable localized labels but filter with the original API values", async ({
  page,
}) => {
  const queries: string[] = []
  const occurredAt = new Date().toISOString()
  await page.route("**/api/projects/*/events?**", (route) => {
    const url = new URL(route.request().url())
    queries.push(url.searchParams.get("action") ?? "")
    return route.fulfill({
      json: {
        items: [
          {
            id: "event-1",
            action: "member_post",
            actorId: "actor",
            actorName: "Operator",
            actorKind: "account",
            target: "member",
            occurredAt,
          },
          {
            id: "event-2",
            action: "view_PATCH",
            actorId: "actor",
            actorName: "Operator",
            actorKind: "account",
            target: "view",
            occurredAt,
          },
        ],
        nextCursor: "",
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
      },
    })
  })
  await page.goto(`/projects/${workspace().project.id}/settings#audit`)
  const audit = page.locator("#audit")
  await expect(audit.locator("li").first()).toContainText("Member added")
  await expect(audit.locator("li").last()).toContainText("Saved view updated")
  await expect(audit).not.toContainText("member_post")
  await expect(audit).not.toContainText("view_PATCH")
  await page
    .getByRole("combobox", { name: "Audit action", exact: true })
    .selectOption("member_patch")
  await page.getByRole("button", { name: "Apply audit filters", exact: true }).click()
  await expect.poll(() => queries.at(-1)).toBe("member_patch")
  const count = queries.length
  await page.locator(".language-select select").selectOption("it")
  await expect(audit.locator("li").first()).toContainText(it["Member added"])
  await expect(audit.locator("li").last()).toContainText(it["Saved view updated"])
  expect(queries.length).toBe(count)
  await expect(audit.locator("select")).toHaveValue("member_patch")
})

test("empty telemetry links to the selected project's application setup", async ({ page }) => {
  await page.route("**/api/projects/*/traces?**", (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  )
  await page.goto(projectHref("/traces"))
  const empty = page.locator(".empty-state")
  await expect(empty).toContainText(
    "Connect your application to send OTLP traces and logs to this project.",
  )
  await expect(empty).not.toContainText("validation project")
  const setup = empty.getByRole("link", { name: "Connect application", exact: true })
  await expect(setup).toHaveAttribute("href", `/projects/${workspace().project.id}/setup`)
  await setup.click()
  await expect(
    page.getByRole("heading", { name: "Connect your application", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Create ingestion token", exact: true }),
  ).toBeVisible()
})

test("network errors offer a retry without assuming local development services", async ({
  page,
}) => {
  await page.route("**/api/projects/*/traces?**", (route) => route.abort())
  await page.goto(projectHref("/traces"))
  const notice = page.locator(".notice")
  await expect(notice).toContainText(
    "Check your connection and try again. If the problem continues, contact your Logice operator.",
  )
  await expect(notice).not.toContainText("local API")
  await expect(notice.getByRole("button", { name: "Try again", exact: true })).toBeVisible()
})
