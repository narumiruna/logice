# Project deployment recovery plan

## Goal

Prepare a patch release and a reviewed deployment proposal that can replace the mixed-version Logice installation. Do not merge PRs, publish a release, run a production migration, or sync Argo CD without separate approval.

## Context

- The live web image is built from `3d14eb2`; the API image is built from `a297b9a`, before project routes existed.
- Read-only checks found auth schema version 1 and no `projects`, `project_members`, or `workspace_schema_versions` tables.
- The current Argo CD Application reads `charts/logice` at `HEAD` and uses `latest` for both application images. Release no longer updates `latest`.
- `main` contains the Live keyboard-focus fix from PR #26 and the release validation changes from PR #27, but it has no pending change notes.
- The `v0.2.0` release run failed its published-image browser checks. Later successful no-op Release runs did not produce a replacement deployment candidate.

## Plan

- [x] Confirm the release and promotion prerequisites against current `origin/main`, open PRs, and Release evidence. At discovery, `origin/main` was `05c5fba` with no open PRs or pending notes. The `v0.2.0` image validation failed, and later Release runs skipped publication and image builds.
- [x] Add a patch change note for the merged Live keyboard-focus fix. The pinned `changenote status` selects `0.2.1`; version files and the saved batch are unchanged.
- [x] Document mixed-version recovery in `docs/deployment.md`; require a validated image pair, the matching migration image, and explicit GitOps adoption.
- [x] Diagnose the blocking `TestLivePreflightExactSizeAndAllocation` failure. It reproduces with local Go 1.27.2; the same test and full standard Go checks pass with CI's pinned Go 1.26.10. No checks were disabled and no Go source changed. Newer-toolchain compatibility is outside this recovery PR.
- [x] Run release, deployment, chart, and repository checks. Release tests: 15 passed, 2 Linux-only tests skipped on macOS. Deployment fixtures: 19 passed. Helm and Actionlint passed. `GOTOOLCHAIN=go1.26.10 sh scripts/pre-commit.sh` passed frontend formatting/typechecks, 287 unit tests, build, Go vet/tests/build. `GOTOOLCHAIN=go1.26.10 sh scripts/validate-checks.sh` passed clean-checkout checks and all eight injected failures. Hosted CI remains required.
- [x] Open [preparation PR #28](https://github.com/narumiruna/logice/pull/28) with local validation evidence and downstream merge requirements. Branch: `narumi/fix/project-deployment-recovery`.
- [ ] After PR #28 passes CI and the user approves and merges it, confirm the managed release PR and start CI on its exact head. Blocked on user merge approval; no managed release PR exists yet.
- [ ] After the user approves and merges the release PR, require a successful Release run with a complete image-pair candidate; confirm the generated draft deployment PR and its exact-head CI. Blocked on release approval and a passing candidate; no deployment PR exists yet.

## Completion Checklist

- [x] PR #28 contains a valid patch note and safe recovery instructions, without manual version changes or fabricated image digests.
- [x] Required local checks pass with pinned Go 1.26.10. Hosted Linux publication-race tests and exact-version CI remain required; local Node.js/npm are 26.10.0/11.19.1, while CI uses 26.11.1/11.20.0.
- [ ] The managed release PR is available for review with CI on its exact head.
- [ ] The draft deployment PR contains only generated deployment state backed by a successful Release candidate.
- [x] Production migration, rollout, and first GitOps adoption remain separate operator-approved actions; this preparation changes only a pending note, documentation, and this plan.

## Current Handoff

PR #28 is open for review. Hosted CI on its final head remains required. No release workflow was dispatched, no PR was merged, and no source tag, image publication, database migration, or Argo CD update was performed. Keep this plan until the managed release PR and validated draft deployment PR are available.

## Rollback / Recovery

Before release approval, close or revise the preparation PR to stop this release request. Do not move existing tags or edit saved release batches. Do not create deployment records from the failed `v0.2.0` run or restart unpaired `latest` images. If validation fails, keep deployment state unchanged and use a new forward-fix release. Before any later production rollout, require database/key backups, a tested restore procedure, real Passkey checks, registry and Secret validation, and approval of the Recreate outage. A source revert is not a database rollback.
