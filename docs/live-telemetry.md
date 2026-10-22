# Live trace and log explorer

## Scope

Open **http://127.0.0.1:5173/live** after building the local web/API services as described in [README](../README.md). Live reads actual OpenTelemetry exports from ClickHouse for the fixed `validation` project. `/preview` remains a separate simulated design preview; `/traces` and `/logs` retain their existing manual-refresh behavior.

This stack has no user authentication or dynamic project authorization. Keep it on loopback. Do not expose it through a public proxy or Tunnel. Live does not change Collector ingestion, telemetry schemas, credentials, or retention.

## Use the page

1. Send telemetry through the existing Collector using the [Python examples](../examples/python/README.md) or your instrumented application.
2. Open **Live**. The server resolves the default five-minute rolling window. Select one, five, or fifteen minutes, then select **Apply filters**.
3. Apply an exact service name, literal text, Errors only, or minimum log severity.
   - Text matches span names, log bodies, and trace/span IDs, without case sensitivity. It does not search attributes or execute SQL.
   - Errors only matches Error spans and logs with severity at least 17. Minimum severity applies only to logs.
   - Ancestors that do not match remain marked **Context** when available. They do not increase matching counts.
4. Expand rows or enable Auto-expand. Select a message, or use the tree's arrow keys and Enter, to open the inspector.
   - The inspector shows recorded IDs, timestamps, status/severity, attributes, scope, and stored JSON. Escape closes it and restores focus.
   - Logs without a usable recorded span remain visible. Missing parents, cycles, ambiguous parents, and malformed identifiers are labeled; no parent relationship is invented.
   - Open a trace link to inspect that trace in the retained absolute time window.
5. Disable Follow latest by scrolling away from the bottom. Newly visible records do not move your reading position. Select **Jump to latest** to follow again.

SDKs normally export spans after they end. Live shows stored spans; it does not infer Running status or increase durations on a timer. `Unset`, `Ok`, and `Error` are different statuses. An incomplete trace is not evidence that a span is still running.

## Polling, pause, and time selection

A visible, online Live page sends one snapshot request at a time. It schedules the next request two seconds after the preceding successful response. This is not a fixed two-second delivery guarantee. New responses replace the previous bounded window rather than appending an unlimited history.

- **Pause** cancels active work and freezes the last successful response and its exact absolute bounds. Before the first result, the page stays paused without inventing a server window.
- **Refresh** while paused reads that fixed interval once. Before the first result, it resolves the chosen rolling range once, then pins the returned bounds.
- **Resume** immediately reads a rolling interval and restarts polling. Time spent hidden or offline is not replayed.
- Hidden/offline state suspends a requested Live mode, aborts its request, and removes its polling timer. Visibility/connectivity recovery causes at most one immediate refresh.
  - An unfinished fixed-window request or paused Refresh also resumes once after recovery. It keeps the same query and absolute bounds. A completed paused view does not refresh automatically.
  - A paused URL without a resolved window stays idle unless Refresh was requested. Query changes and page cleanup cancel any older interrupted request.
- Transient failures retain the last response as stale and retry after 2, 4, 8, 16, then at most 30 seconds. Manual retry is available. Invalid queries, oversized responses, malformed API data, and unsupported endpoints stop automatic retries.
- A future 401/403 response clears retained telemetry and stops updates. This behavior is not an authentication implementation.

The histogram counts matching **stored rows**, including repeated identical content, before feed caps. Its 60 server-counted buckets are not calculated from the rendered rows. Select a bucket, use the arrow keys to focus another bucket and Enter to select, or drag a range to pause and zoom. Selections narrower than one second expand inside the displayed bounds to the one-second minimum. Explicit **Fixed UTC interval** inputs also accept nanosecond timestamps.

Intervals include `from` and exclude `to`. Live URLs use `range`; paused URLs use absolute bounds when available. Reload and browser history preserve the represented mode and filters. A paused unresolved URL does not fetch before its first result; applying a different range to an existing paused result resolves it once. Trace links use absolute bounds, including retained selections outside the current result.

## Identity and completeness

- Valid spans use the trusted project and normalized trace/span pair as identity. Repeated stored exports have occurrence counts. Conflicting exports show a deterministic representative, not a claimed latest version. Different recorded parents make the parent ambiguous.
- Logs have no durable stored record ID. Live groups canonical identical stored content and uses a content fingerprint. Scope, schema URLs, trace flags, EventName, attributes, and other stored fields contribute to identity. Identical independent emissions and exporter retries cannot be distinguished.
- Occurrence counts describe the current response. They are not added again on every poll. A newly visible counter compares logical matching records with the preceding response, not a durable ingestion sequence.
- JSON is a stored projection, not original OTLP. Attribute values use exporter string conversion. Original OTLP types and absent exporter fields cannot be recovered.
- Full-window polling can discover late exports while their event timestamps remain inside the selected window and row caps. It does not guarantee complete delivery or reconstruction of a trace.
- Component queries share bounds and a deadline, but separate ClickHouse reads are not a transaction. Concurrent ingestion can make histogram counts and retained rows differ temporarily.

## Bounds and API

`GET /api/live` returns JSON with resolved `window`, `queriedAt`, applied `filters`, matching `spans` and `logs`, ancestor `context`, 60 `histogram` buckets, effective `limits`, four truncation flags, and `completeness: "unknown"`. Every response uses `Cache-Control: no-store`.

Time parameters are either `range=1m|5m|15m` (default `5m`) or paired RFC3339Nano `from`/`to`. Fixed intervals must be from one second through fifteen minutes. Other parameters are `service`, `search`, `errorsOnly`, and `minSeverity`. Service/search each have a 200-byte UTF-8 limit; minimum severity is 0–24. Unknown/duplicate parameters, SQL, project overrides, and mixed time modes are rejected. Page URL `mode` is not an API parameter.

| Resource | Bound |
| --- | --- |
| Matching feed | 500 grouped spans and 500 grouped logs |
| Trace groups and context | 100 eligible trace groups, up to 500 additional context spans |
| Browser state | One bounded response of at most 1,500 records, plus one retained selection |
| Histogram | 60 buckets over all matching stored rows |
| Rendering | Virtualized fixed-height rows; at most 120 mounted event rows in validated desktop/mobile viewports |
| API work | Five-second total deadline, two active Live requests per process |
| ClickHouse | Read-only queries, 128 MiB query memory, 8 MiB native result limit |
| Response/client | 4 MiB encoded JSON; eight-second browser request timeout |

Trace-group slots require a valid trace ID and, for spans, a valid span ID. Malformed content-identified spans remain non-linkable records and do not request trace context. Context is selected in one bounded query with project/time restrictions and fair per-trace ranking. Parents outside those bounds stay absent. Truncation flags distinguish span, log, context, and trace-group limits. Narrow the interval or filters when a limit is reached. A trace is not guaranteed complete even when no cap is reached. A selected record that leaves the result remains marked **Outside current results**; no unbounded history is kept.

HTTP 400 is an invalid query, 405 an unsupported method, 422 `response_too_large`, 429 an admission limit with `Retry-After: 2`, and 503 a storage/deadline/resource failure. No successful partial JSON is returned on component failure. Before first ingestion, only structured missing-table errors count as empty data. Liveness remains independent of storage.

Existing [trace/log API semantics](local-telemetry.md) are unchanged.

## Update and recovery

Rebuild only web and API in the explicitly selected local Compose project:

```sh
# Add the same --project-name option used to start your local stack, if any.
docker compose up --build --detach --no-deps --wait --wait-timeout 120 api web
```

Do not remove database volumes to update the page. To roll back, restore the previous compatible web/API application revision and rebuild those two services. Keep database/Collector versions, credentials, and volumes unchanged. A new web page against an old API reports an unsupported endpoint; it must never substitute sample data.

See [validation evidence](validation.md) for real-service/browser tests, limits, local performance measurements, and exact versions. Screenshots and browser traces remain under ignored `web/test-results/`.

## Review and release restrictions

The user can review layout density, hierarchy, inspector placement, colors, and motion using local `/live` and the prepared desktop/mobile captures. Automated tests do not establish subjective visual acceptance or full accessibility conformance.

Public use still requires separate authentication/project isolation, hostname/Tunnel configuration, production roles and migrations, approved retention/loss budgets, and backup/key recovery. Local Live completion does not close those release gates or the initial stack acceptance condition. No credentials or public deployment are required for this local page.
