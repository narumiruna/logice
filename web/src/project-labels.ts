export const alertConditions = [
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
] as const

export function alertConditionLabel(value: string): string {
  return alertConditions.find((condition) => condition.value === value)?.label ?? value
}

export const alertDeliveryResults = [
  { value: "invalid_destination", label: "Invalid destination" },
  { value: "transport_failure", label: "Connection failed" },
  { value: "retryable_status", label: "Retryable HTTP error" },
  { value: "rejected_status", label: "HTTP response rejected" },
] as const

export function alertDeliveryResultLabel(value: string): string {
  return alertDeliveryResults.find((result) => result.value === value)?.label ?? value
}

export const auditActions = [
  { value: "create_alert_destination", label: "Webhook destination created" },
  { value: "change_alert_destination", label: "Webhook destination updated" },
  { value: "test_alert_destination", label: "Test notification queued" },
  { value: "create_alert_rule", label: "Alert rule created" },
  { value: "change_alert_rule", label: "Alert rule updated" },
  { value: "create", label: "Project created" },
  { value: "patch", label: "Project updated" },
  { value: "delete", label: "Project deleted" },
  { value: "member_post", label: "Member added" },
  { value: "member_patch", label: "Member role updated" },
  { value: "member_delete", label: "Member removed" },
  { value: "transfer_owner", label: "Project ownership transferred" },
  { value: "create_token", label: "Ingestion token created" },
  { value: "revoke_token", label: "Ingestion token revoked" },
  { value: "operator_account_recovery", label: "Account recovered by operator" },
  { value: "create_view", label: "Saved view created" },
  { value: "view_PATCH", label: "Saved view updated" },
  { value: "view_DELETE", label: "Saved view deleted" },
] as const

export function auditActionLabel(value: string): string {
  return auditActions.find((action) => action.value === value)?.label ?? value
}
