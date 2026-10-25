# Deployment state

The promotion workflow creates `logice.json` and `release.json` in a draft PR. No deployable Application is present until the first candidate is approved.

- `logice.json` is the child Argo CD Application. It pins the chart commit and both image digests.
- `release.json` records the source version, commit, image pair, and successful Release run.
- The parent Application reads **only** `logice.json`. It must not apply the evidence record.
- Both files are generated and checked together. Do not edit image tags, replay old records, or rebuild a promoted version in place.

See [deployment operations](../../docs/deployment.md) for one-time adoption, required branch rules, release gates, rollout checks, and recovery.
