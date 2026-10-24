# Changenote Migration

## Goal

Replace Changesets in PR #20 with changenote. Use one root application version for Go and the private frontend. Keep Docker publishing and Helm versions unchanged. Do not publish a live release.

## Plan

- [x] Verify the pinned changenote CLI and Actions at `66afe581b2f7b19f96188a1f217518c41aaaf77d`; evidence: inspect their inputs, publication checks, and version-output contract, then install the same CLI revision in a temporary tools directory.
- [x] Replace Changesets with `.changenote/`, root `VERSION`/`CHANGELOG.md`, and `web/package.json` as an additional version output; evidence: no Changesets dependency or executable script remains, and the real CLI synchronizes both versions and the lockfile in disposable tests.
- [x] Replace `release.yml` with pinned changenote Release PR and publication Actions; evidence: Actionlint and tests confirm main-only execution, limited permissions, serialized writes, explicit retry, and no registry or binary publication.
- [ ] Update the clean-checkout guard, CI release checks, and operator documentation; evidence: release validation and all repository checks pass without changing production resources.
- [ ] Review and publish the migration to PR #20; evidence: commit, push, updated PR description, and final check results.

## Completion Checklist

- [x] Tests cover version/lockfile synchronization, consumed notes, no-op versioning, invalid initial versions or notes, safe local tags, and the release workflow contract.
- [ ] Go checks, frontend checks/audit, release tests, clean-checkout checks, workflow lint, and hosted CI pass.
- [ ] No live workflow dispatch, release, repository version tag, deployment, or package publication occurred.
- [ ] PR #20 documents the CLI/Action pin, token behavior, recovery, and unverified live paths. Remove this completed plan only after handoff.

## Rollback / Recovery

Before any approved release, revert this migration to restore the Changesets tooling. Do not delete or rewrite published tags or committed release batches. If publication fails after a tag write, retry the latest validated batch with the pinned changenote publication Action. Keep the physical-authenticator and production validation gates unchanged.
