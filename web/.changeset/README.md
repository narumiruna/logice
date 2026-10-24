# Changesets

Run commands from the repository root with Node.js 26.11.1 and npm 11.20.0.

```sh
npm --prefix web ci
npm --prefix web run changeset -- add --patch logice-web --message "Describe the change."
```

Use `--minor logice-web` for a feature or `--major logice-web` for a breaking change. Commit the generated Markdown file with the code change. For a change with no release impact, do not add a changeset.

The private `web/package.json` holds the application release version. Changesets updates `web/CHANGELOG.md`. It does not publish to npm. Helm chart versions remain separate.

See [release operation](../../docs/releases.md) for version PRs, permissions, checks, and recovery.
