import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { catalogs, LocaleProvider, languages, translate } from "./i18n"
import { ProjectAlerts } from "./project-alerts"
import type { Project } from "./project-api"
import { ProjectAudit } from "./project-audit"
import { ProjectContext } from "./project-context"
import {
  alertConditionLabel,
  alertConditions,
  alertDeliveryResultLabel,
  alertDeliveryResults,
  auditActionLabel,
  auditActions,
} from "./project-labels"
import { ThemeProvider } from "./theme"

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Application",
  ownerId: "owner",
  role: "Owner",
}

describe("project API display labels", () => {
  it("keeps the existing alert API values and their metric-specific field labels", () => {
    expect(alertConditions).toEqual([
      {
        value: "error_ratio",
        label: "Error trace proportion",
        thresholdLabel: "Error trace proportion threshold (0–1)",
        populationLabel: "Minimum traces",
      },
      {
        value: "root_p95",
        label: "Root span duration (p95)",
        thresholdLabel: "Root span duration threshold (ns)",
        populationLabel: "Minimum root spans",
      },
      {
        value: "no_data",
        label: "No stored telemetry",
        thresholdLabel: "Threshold (not used)",
        populationLabel: "Minimum sample size (not used)",
      },
    ])
    for (const { value, label } of alertConditions) expect(alertConditionLabel(value)).toBe(label)
  })

  it("keeps every supported audit API value separate from its readable action label", () => {
    expect(auditActions.map(({ value }) => value)).toEqual([
      "create_alert_destination",
      "change_alert_destination",
      "test_alert_destination",
      "create_alert_rule",
      "change_alert_rule",
      "create",
      "patch",
      "delete",
      "member_post",
      "member_patch",
      "member_delete",
      "transfer_owner",
      "create_token",
      "revoke_token",
      "operator_account_recovery",
      "create_view",
      "view_PATCH",
      "view_DELETE",
    ])
    for (const { value, label } of auditActions) {
      expect(auditActionLabel(value)).toBe(label)
      expect(label).not.toBe(value)
    }
    expect(auditActionLabel("member_post")).toBe("Member added")
    expect(auditActionLabel("view_PATCH")).toBe("Saved view updated")
  })

  it("keeps delivery result codes separate from their readable failure labels", () => {
    expect(alertDeliveryResults).toEqual([
      { value: "invalid_destination", label: "Invalid destination" },
      { value: "transport_failure", label: "Connection failed" },
      { value: "retryable_status", label: "Retryable HTTP error" },
      { value: "rejected_status", label: "HTTP response rejected" },
    ])
    for (const { value, label } of alertDeliveryResults)
      expect(alertDeliveryResultLabel(value)).toBe(label)
    expect(alertDeliveryResultLabel("delivered")).toBe("delivered")
  })

  it.each(["future_api_value", "__proto__", "toString"])(
    "retains unknown API value %s without treating it as a known label",
    (value) => {
      expect(alertConditionLabel(value)).toBe(value)
      expect(auditActionLabel(value)).toBe(value)
      expect(alertDeliveryResultLabel(value)).toBe(value)
    },
  )

  it.each(languages)(
    "provides translations for every dynamic project label in $locale",
    ({ locale }) => {
      const labels = [
        ...auditActions.map(({ label }) => label),
        ...alertDeliveryResults.map(({ label }) => label),
        ...alertConditions.flatMap(({ label, thresholdLabel, populationLabel }) => [
          label,
          thresholdLabel,
          populationLabel,
        ]),
        "Threshold",
        "Minimum sample size",
      ]
      for (const label of labels) expect(Object.hasOwn(catalogs[locale], label), label).toBe(true)
    },
  )

  it.each(languages)(
    "renders readable audit and alert options without changing their values in $locale",
    ({ locale }) => {
      const fetcher = vi.spyOn(globalThis, "fetch")
      try {
        const html = renderToStaticMarkup(
          <ThemeProvider>
            <LocaleProvider initialLocale={locale}>
              <ProjectContext value={{ project, projects: [project] }}>
                <ProjectAudit project={project} />
                <ProjectAlerts project={project} />
              </ProjectContext>
            </LocaleProvider>
          </ThemeProvider>,
        )
        for (const { value, label } of [...auditActions, ...alertConditions]) {
          const option = renderToStaticMarkup(
            <option value={value}>{translate(locale, label)}</option>,
          )
          // React marks the first alert condition as selected.
          expect(html.replaceAll(' selected=""', "")).toContain(option)
        }
        expect(html).toContain(translate(locale, "Minimum traces"))
        expect(fetcher).not.toHaveBeenCalled()
      } finally {
        fetcher.mockRestore()
      }
    },
  )
})
