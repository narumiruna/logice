# Dashboard Aggregates

## Goal

Add full-window counts, error proportions, and latency trends from stored project telemetry, while retaining honest limits about sampling, duplicate exports, and incomplete traces.

## Context

`web/src/project-dashboard.tsx` currently shows up to five recent traces/logs. `internal/telemetry/query.go` filters stored spans before grouping traces, so summaries can be partial. Live already implements bounded aggregate histograms in `internal/telemetry/live_query.go`. Store queries enforce project scope, readonly access, five-second execution, 128 MiB memory, and 8 MiB result limits. The configured default telemetry TTL is 24 hours; changing Collector configuration does not automatically alter existing tables.

## Architecture

- Add `GET /api/projects/{id}/overview`, authorized through the same project boundary as other telemetry reads. Return fixed UTC bounds, query time, totals, explicitly defined error proportions, and at most 60 time buckets. Initially support the Dashboard's 15-minute, 1-hour, and 24-hour windows and an optional service filter.
- Define logical identity, duplicate/conflict handling, and error status before SQL. Prefer consistency with Live's exported-record identity rules rather than counting retransmissions as new events. Group only within the authorized project and requested window.
- Define trace count as distinct eligible trace IDs with matching stored spans. Define trace error proportion over that same population; empty populations return null, not a healthy zero percent. No claim of total application traffic or complete trace coverage.
- First latency measure: p50/p95 of exported root-span durations, labeled as such, not end-to-end request latency. Exclude invalid durations, state multi-root/conflict behavior, and label any approximate quantile method. Do not derive latency from arbitrary partial trace envelopes.
- Separate aggregate completeness from recent-list truncation. Query failure or limit overflow produces unavailable statistics, never partial totals disguised as complete data. Multiple storage reads are not a transactional snapshot; document consistency and late-arrival behavior.

## Plan

- [ ] Write executable metric fixtures and response semantics for duplicates, conflicts, roots, invalid IDs, no data, late arrivals, and service filters; acceptance: expected populations/denominators and bucket boundaries are reviewed before implementation.
- [ ] Implement bounded aggregate queries and scoped HTTP response validation; acceptance: native ClickHouse tests prove exact count fixtures, nanosecond half-open bounds, cross-project isolation, null empty values, and quantile semantics.
- [ ] Measure query costs on representative data and define admission limits; acceptance: effective server settings, cancellation, overload behavior, and a documented local p95 target of two seconds pass without raising existing resource limits. Resolve excessive cost before proceeding; do not silently add unbounded scans or materialized storage.
- [ ] Replace sample statistic cards with validated aggregate cards/charts while retaining recent records; acceptance: labels distinguish aggregate/root-span measures from samples, and chart links preserve project, time, and service filters.
- [ ] Add browser/controller regressions; acceptance: refresh, range changes, stale-response cancellation, errors, both themes, keyboard access, and mobile views never retain another scope's numbers or fabricate zeroes.
- [ ] Document interpretation and retention limits; acceptance: the UI/API contract explains stored-data coverage, bucket assignment, error denominators, and approximate versus exact measures.

## Completion Checklist

- [ ] `GOTOOLCHAIN=go1.26.10 sh scripts/check-go.sh`, `GOTOOLCHAIN=go1.26.10 go test -race -tags=integration -count=1 -timeout=8m ./tests/integration/...`, `npm --prefix web run ci`, and `sh scripts/validate-compose-web.sh` pass, including the new native aggregate cases.
- [ ] Full-window counts are independent of list limits; two-project duplicate-ID fixtures and query-log resource checks pass.
- [ ] Recorded benchmark evidence meets the agreed workload and does not claim production capacity.
- [ ] Deliver a verified PR; delete this plan only after checks and handoff are complete.

## Rollback / Recovery

Retain the existing sample Dashboard as a code rollback with its original sample labels. Do not relabel samples as aggregates if the API fails. No ingestion/schema/TTL change is planned; any required materialized storage needs a separate approved migration and recovery procedure. Deployment remains separately authorized.
