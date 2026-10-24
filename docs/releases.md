# Releases

Logice uses [narumiruna/changenote](https://github.com/narumiruna/changenote) for language-independent versioning, change notes, and GitHub source releases. The CLI and Actions use the same reviewed revision: `66afe581b2f7b19f96188a1f217518c41aaaf77d` (`v0.7.0`). CI builds that CLI with Rust 1.92.0. No Changesets npm dependency or root npm package is required.

## One application version

`.changenote/config.json` defines one package, `logice`:

- Root `VERSION` is the main application version source.
- `web/package.json` is an additional version output and remains private.
- `changenote version` updates both files and the existing `web/package-lock.json`, generates root `CHANGELOG.md`, saves `.changenote/releases.json`, and consumes pending notes.
- Both version files must match before planning. Supported lockfiles are refreshed offline; npm lifecycle scripts are disabled. CI installs the locked frontend dependencies first to populate the npm cache.
- The initial `0.0.0` metadata and pending minor note select the first release, `v0.1.0`. Versioning is not performed directly on `main`; the Action creates a reviewable release PR.

The Git tag and source archive contain Go and React from the same validated release commit. This workflow does not embed the version in the Go binary, build release binaries, or publish to npm or another registry. Go binary packaging is a separate task. Ordinary Go checks still need neither Node.js nor Rust.

Helm chart versions remain separate. `.github/workflows/docker.yml` still publishes commit-tagged API/web images and `latest` on `main`; it does not add version image tags. Pin both images to the validated release commit, not to `v<version>`.

## Add a note

Install the pinned CLI. Source installation needs Rust with edition 2024 support; CI uses Rust 1.92.0.

```sh
cargo install --git https://github.com/narumiruna/changenote \
  --rev 66afe581b2f7b19f96188a1f217518c41aaaf77d --locked
changenote add --patch logice -m "Fix the stated behavior."
changenote status
```

Use `--minor logice` for a feature or `--major logice` for a breaking change. Commit the generated `.changenote/*.md` file with the code. Notes can also be written as Markdown with a `logice: patch`, `minor`, or `major` frontmatter entry. Do not include credentials or private telemetry. A change without release impact does not need a note.

## Release workflow

`.github/workflows/release.yml` runs only on `main`. One concurrency group serializes release work and does not cancel an active run. Each job has a 15-minute deadline.

1. A read-only job checks the triggering commit. The pinned preview Action then selects the latest verifiable release batch without remote writes. If a batch exists, the job checks out that exact commit and runs Go, frontend, and release checks on it. Only a successful job passes that immutable commit to publication.
2. On a `main` push, the Release PR job uses tooling from the checked triggering commit. The pinned Action refreshes pending notes from `main` and opens or updates `narumi/chore/changenote-release-main`. Reserve that branch for automation. PR generation is not publication approval. Removing all pending notes closes its managed PR.
3. Review the generated version files, lockfile, changelog, consumed notes, and saved batch. Complete CI on the exact PR head and all applicable operator release gates before merge.
4. Publication checks out only the selected, checked release commit. It invokes the pinned upstream `publish.sh` with that expected commit because the composite publication Action has no expected-commit input. The script fetches `main`, reconstructs the latest batch, and compares its commit with the expected value before any tag or Release write. A new batch stops publication and requires a new validation run. Unrelated commits or pending notes do not change the selected target. No batch means no publication job.
5. Existing matching tags and Releases remain unchanged. A partial failure can be retried without moving a tag or replacing release notes.

Publication also runs on ordinary `main` pushes to recover the latest validated batch. It can recover an earlier batch if Release PR management fails, but it cannot run after validation fails or the workflow is cancelled. It does not publish an unmerged release PR. Full-tree validation rejects manually edited release batches or release commits with unrelated source changes.

Manual runs have two modes:

1. `manage-pr` is the default. It checks the source and manages the release PR without publication.
2. `retry-publication` checks the source and retries the latest validated batch without updating the release PR.

The Release PR job needs `contents: write` and `pull-requests: write`. Publication needs only `contents: write`. Validation and CI use read permissions. Checkout credentials are not persisted. The Actions use their `github-token` input, which defaults to the workflow token; no npm or production credential is needed.

Enable **Actions → General → Allow GitHub Actions to create and approve pull requests** in repository settings. A PR created with `GITHUB_TOKEN` does not start another workflow automatically. Start CI on its exact branch before merge:

```sh
gh workflow run ci.yml --ref narumi/chore/changenote-release-main
```

Check the resulting run against the version PR head. Do not bypass required checks or assume version generation grants release approval. Physical-authenticator validation, database/key backups, and production deployment checks remain operator tasks.

## Validation

```sh
tools=$(mktemp -d)
git init "$tools/source"
git -C "$tools/source" fetch --depth=1 --no-tags https://github.com/narumiruna/changenote \
  66afe581b2f7b19f96188a1f217518c41aaaf77d
git -C "$tools/source" checkout --detach FETCH_HEAD
cargo install --path "$tools/source" --locked --root "$tools"
export PATH="$tools/bin:$PATH"
export CHANGENOTE_ACTION_PATH="$tools/source"
npm --prefix web ci
changenote status
uv run tests/release/check.py
npm --prefix web run ci
actionlint .github/workflows/*.yml
sh scripts/validate-checks.sh
```

`tests/release/check.py` uses the pinned CLI and Action source, local npm, disposable Git repositories, and PyYAML 6.0.3. It checks version/lockfile synchronization, note consumption, no-op runs, rollback, invalid input, symlink denial, local tags, reconstruction, and workflow contracts. Two Linux-only tests run the real pinned publisher against local bare remotes and a mock `gh`: a newer batch must produce no tag or Release write, while unrelated `main` changes must retain the checked target. They do not contact GitHub. Other platforms skip only these Action-platform tests; CI must run both on Linux. Remove the temporary `$tools` directory after local checks. Go/frontend hooks do not install Rust or the CLI.

### Migration verification

[CI run 40102871692](https://github.com/narumiruna/logice/actions/runs/40102871692) passed all eight jobs on migration revision `b59f02b`. This includes the pinned CLI build, all nine release tests, 287 frontend unit tests, 109 real-service browser tests, race-enabled native integration, Helm/layout checks, and clean-checkout failure checks. Local Actionlint, shell syntax, npm audit, and the eight injected hook/CI failures also passed. npm audit reported zero vulnerabilities.

The first migration CI run hit the existing maximum-snapshot Live keyboard-focus failure. No Live code changed in this migration. The later complete run passed all 109 browser tests; the failed run is not counted as passing evidence.

The completed execution plan `docs/plans/2026-10-24_changenote-migration-plan.md` was removed after verification and handoff in [PR #20](https://github.com/narumiruna/logice/pull/20). Live publication and production release gates remain unverified.

## Recovery and rollback

Upgrade the CLI, Action pins, and schema pin together. Keep Node.js/npm compatible with the version used to generate each batch. Publication replays offline lockfile synchronization; the dependency cache must contain the release dependencies. If they are missing after later dependency changes, populate the cache from the selected release's parent lockfile in an isolated checkout before retrying. Do not use the hidden no-lockfile reconstruction option for new releases.

After a partial publication failure, rerun Release on `main` with `operation=retry-publication`. Inspect tags and Releases first. Do not merge another release PR until the latest batch is fully published: discovery covers only the latest batch. Wrong tag targets, draft Releases, a Release without its tag, edited batches, or unavailable remote data stop publication. Do not force-push, move tags, or edit committed batches to bypass validation.

If PR creation fails, check Actions permissions, branch rules, and ownership of the managed branch. Do not delete an automation branch without checking its PR and commit history.

Disable the Release workflow to stop automation. Before an approved release, this migration can be reverted to restore the earlier tooling. After publication, keep tags, changelogs, and saved batches; correct a published result with a new note and version. No live release, release-workflow dispatch, registry publication, or deployment was run while adding this setup. Live token/branch-rule behavior still needs operator validation.
