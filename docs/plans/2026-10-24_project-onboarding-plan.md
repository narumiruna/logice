# Project Onboarding

## Goal

Guide a project member from an empty project to the first stored trace or log, with safe credential handling and working SDK instructions.

## Context

`web/src/project-dashboard.tsx` currently links to token settings and shows the application origin. `web/src/project-settings.tsx` already creates project tokens and clears displayed secrets on `pagehide`. Public ingestion accepts OTLP HTTP protobuf at `/v1/traces` and `/v1/logs`; browser sessions do not authorize ingestion. See [project access](../project-access.md).

## Architecture

- Add `/projects/{id}/setup`, linked from project creation, empty Dashboard states, and Project Settings. Keep existing explorer URLs.
- Reuse the existing token API. Owners and Developers can create tokens; Viewers see instructions to contact them. Registration invitations remain separate.
- Provide a generic OTLP environment block and a runnable Python example using the existing `examples/python` project. Use the current application origin, `http/protobuf`, and a token placeholder.
- Keep the one-time token in component memory only. Do not insert it into URLs, storage, telemetry, generated screenshots, or automatically copied snippets. Provide an explicit token-copy action; clear secrets on dismiss, navigation, session expiry, and `pagehide`.
- Verify receipt with project-scoped trace/log list requests. Freeze a UTC observation window when verification starts; label success as stored telemetry observed in that window, not proof that a specific token or application sent it. Bound observation to two minutes, at most one request pair every five seconds, with cancellation on stop/unmount/access loss. Timeout means not observed, not ingestion rejected.

## Plan

- [ ] Define setup steps and receipt wording against the current token, query-window, and SDK contracts; acceptance: reviewed UI/API examples distinguish accepted ingestion from observed storage and never claim token attribution.
- [ ] Build the role-aware setup route and reuse token creation/secret clearing; acceptance: Owner/Developer workflows succeed and Viewer mutations receive server denial.
- [ ] Add placeholder-only configuration and copy controls; acceptance: Python exports valid protobuf with a project token, clipboard denial has a manual fallback, and secrets never enter persistence or URLs.
- [ ] Add bounded receipt observation and retry states; acceptance: fake-clock tests prove request bounds, cancellation, expiry handling, empty windows, storage errors, and no fabricated success.
- [ ] Add real Collector browser tests with two projects; acceptance: only telemetry stored in the selected project completes verification, and Back/Forward navigation cannot restore a token.
- [ ] Document setup and troubleshooting; acceptance: both themes work at 390px/1440px with keyboard navigation, and examples match the tested public endpoint.

## Completion Checklist

- [ ] `npm --prefix web run ci`, `sh scripts/validate-compose-web.sh`, and `uv run --project examples/python --locked python -m unittest discover -s examples/python -v` pass with the new workflows; the existing E2E TypeScript check also passes.
- [ ] Existing token, authorization, explorer, and secret-clearing regressions pass; no new backend/schema change is required or silently introduced.
- [ ] Diff review confirms bounded requests, accurate receipt claims, no committed secrets/images, and no production changes.
- [ ] Deliver the implementation PR with verification evidence; delete this plan only after its checks and handoff are complete.

## Rollback / Recovery

Remove setup navigation/UI without reverting project authorization or deleting data. Tokens already issued remain valid until explicitly revoked; do not revoke them automatically on wizard exit or rollback. No deployment or credential rotation is authorized by this plan.
