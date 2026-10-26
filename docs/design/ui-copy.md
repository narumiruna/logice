# UI wording and terminology

UI labels must describe the displayed data or the action that a control performs. Keep API identifiers separate from display labels.

## Preferred terms

| Concept | UI wording |
| --- | --- |
| Application credential that writes project telemetry | Ingestion token |
| Exported root-span duration percentile | Root span duration (p50) or Root span duration (p95) |
| Root-span alert threshold | Root span duration threshold (ns) |
| Error-trace alert threshold | Error trace proportion threshold (0–1) |
| Minimum population for an error-trace condition | Minimum traces |
| Minimum population for a root-span duration condition | Minimum root spans |
| Fields ignored by the no-data condition | Mark the label as not used |
| Control that shows or hides table headings | Column headers |
| Navigation to a saved query | Open view |
| Copying a saved-view URL | Copy link |

## Rules

- Use sentence case for English labels and messages. Use lowercase passkey and webhook within prose, except at the start of a sentence. Follow each translation's grammar and capitalization rules.
- Do not call stored root-span duration request latency. Keep the limits on eligible root spans and incomplete traces in the supporting text.
- Keep API values unchanged. Use the display metadata in `web/src/project-labels.ts` for alert conditions, delivery failures, and audit actions. Unknown future values retain their existing fallback.
- Do not imply that copying a link grants access. Saved views still require project membership.
- Call the same ingestion credential an ingestion token in setup, settings, confirmations, and recovery guidance. Keep it distinct from invitation tokens, passkeys, and browser sessions.
- Refer to the selected project, not a validation project. Do not assume that the API or OpenTelemetry Collector runs on the user's device. Provide a relevant setup link or retry action.
- Keep telemetry content, existing user names, identifiers, protocol values, and exact timestamps unchanged.
- Update source message keys, all nine catalogs, and affected accessibility tests together. Keep interpolation variables unchanged.

## Verification

Run `npm --prefix web run ci` for formatting, types, catalog parity, display-label coverage, unit tests, and the production build. Run `sh scripts/validate-compose-web.sh` for the disposable browser checks. Select controls by accessible role and name when their labels also contain option text.
