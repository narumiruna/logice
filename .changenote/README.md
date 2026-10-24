# Change notes

Logice uses changenote for one application release across Go and the private React frontend. Root `VERSION` is the main version source. `web/package.json` is an additional version output; npm lockfile synchronization is automatic.

Install the reviewed CLI revision:

```sh
cargo install --git https://github.com/narumiruna/changenote \
  --rev 66afe581b2f7b19f96188a1f217518c41aaaf77d --locked
```

Add a note from the repository root:

```sh
changenote add --patch logice -m "Fix the stated behavior."
changenote status
```

Use `--minor logice` for a feature or `--major logice` for a breaking change. Commit the new Markdown note with the code change. Do not put credentials or private telemetry in notes. A change with no release impact does not need a note.

See [release operation](../docs/releases.md) for version PRs, CI, publication, and recovery. Do not edit committed `.changenote/releases.json` batches or move published tags.
