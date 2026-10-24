# Saved Views

## Goal

Save and share project-scoped Traces, Logs, and Live query settings without sharing credentials or granting access to another project.

## Context

`web/src/telemetry.ts` already parses and serializes explorer routes. `web/src/live/route.ts` validates separate rolling/fixed Live windows. Live supports column and display preferences. PostgreSQL currently has project membership but no saved-view table. Existing authorization and CSRF rules are in [project access](../project-access.md).

## Architecture

- First release: project-shared views. All members read/apply them; Owners and Developers create, edit, and delete them. Private views and per-view permissions are out of scope. These are proposed product defaults to confirm before implementation.
- Store a UUID, project ID, name, versioned typed definition, creator/updater UUIDs, timestamps, and revision in PostgreSQL. Use an additive migration under the existing migration lock; do not edit an already-applied schema version in place.
- Proposed API: `/api/projects/{id}/views` and `/{viewId}` with bounded listing and CRUD. Require current membership on every read and role/Origin/CSRF checks on mutations. Use revisions for update/delete conflicts; return 409 instead of overwriting concurrent edits.
- Definitions contain only supported explorer filters, time mode, and supported column/display preferences. Reuse parser semantics, with explicit distinction between a moving relative range and fixed UTC bounds. Validate byte lengths, enum values, and range limits server-side as well as in the UI.
- Do not store arbitrary URLs, SQL, project overrides, tokens, inspector payloads, or browser state. Applying a view builds a URL for its owning project. A shared link names the project and view UUID and still requires membership. Loading an unknown definition version fails explicitly without executing a query.

## Plan

- [ ] Specify the typed definition, role matrix, supported preferences, and fixed quotas (proposed 100 views/project and 16 KiB/definition); acceptance: fixtures round-trip through current route parsers, and unsupported fields/versions fail validation.
- [ ] Add the versioned schema migration and bounded CRUD API; acceptance: real PostgreSQL tests prove role checks, cross-project ID denial, quotas, revision conflicts, transaction audit, deletion, and migration retry safety.
- [ ] Add Save view, project view listing, apply/share, rename/update, and delete controls; acceptance: reload restores saved definitions and Viewer controls remain read-only without relying on UI authorization.
- [ ] Integrate Traces, Logs, and Live state restoration; acceptance: fixed timestamps retain nanoseconds, relative windows resolve at apply time, and Live pause mode does not silently resume.
- [ ] Add browser and race tests; acceptance: stale revisions, removed membership, malformed definitions, storage failure, denied clipboard access, and two-project links are handled without stale data or request leaks.
- [ ] Update usage/API documentation and review both themes/mobile layouts; acceptance: links, role rules, definition-version behavior, and quotas match tests.

## Completion Checklist

- [ ] `GOTOOLCHAIN=go1.26.10 sh scripts/check-go.sh`, `GOTOOLCHAIN=go1.26.10 go test -race -tags=integration -count=1 -timeout=8m ./internal/auth/...`, `npm --prefix web run ci`, and `sh scripts/validate-compose-web.sh` pass.
- [ ] Migration tests prove preservation of existing accounts/projects and compatibility with the previous reader during an approved rollout.
- [ ] Audit events contain identifiers only, not saved searches or sensitive telemetry values; shared links do not bypass authorization.
- [ ] Deliver the verified PR and migration/rollback notes; delete this plan only after completion.

## Rollback / Recovery

Back up PostgreSQL before an approved migration. Disable saved-view routes/navigation on rollback while retaining additive tables and definitions. Do not restore legacy unscoped readers. An older application must reject unsupported definitions rather than reinterpret them. No production migration is authorized here.
