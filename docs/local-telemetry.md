# Local trace and log views

## Start

Create `.env` as described in [README.md](../README.md), then run:

```sh
docker compose up --build --detach --wait --wait-timeout 120
```

Open `http://127.0.0.1:5173`. If the page still shows the old foundation message, rebuild the web/API services and reload the page. Do not remove database volumes to update the application.

Sign in, then create or select a project. Queries require project membership; ingestion uses project-level tokens. See [project roles, API, and migration](project-access.md). Keep local published ports on loopback; public deployment requires separate operator validation.

## Use the views

This document describes the manual-refresh Traces and Logs pages. Use [Live](live-telemetry.md) for the separate real-data polling page, unified hierarchy, and server-counted histogram. The limits and search rules below remain unchanged for Traces and Logs.

1. Open **Traces** or **Logs**.
2. Select a time range. Optionally enter an exact service name and a text search.
   - Trace search matches span names or trace IDs.
   - Log search matches the body. Searches are case-sensitive literal substrings; `%` and `_` are not wildcards.
   - **Errors only** selects traces with an error among the matching spans.
   - **Minimum severity** selects logs at or above the selected OpenTelemetry severity number.
3. Select **Apply filters**. Select **Refresh** to move a relative time window forward. There is no automatic polling.
   - Select **Reset filters** below the controls or in an empty result to remove filters. This keeps the exact query window, time-range preset, and result limit.
4. Select a trace name to see its spans and correlated logs. Expand a span or log to see its IDs and attributes.
   - A log with a valid trace ID links to that trace in the same time window.
   - A log without a trace ID still has a detail view. The exporter does not give logs a durable record ID.

On narrow screens, trace and log rows use labeled fields. Log messages and expanded details use the full row width; no horizontal table scrolling is needed.

Trace links retain absolute time bounds. Detail pages can be reloaded or bookmarked. An old link can become empty when telemetry passes the Collector's 24-hour retention period.

The application does not automatically insert sample records. You can send sample data with the [Python examples](../examples/python/README.md). Empty views mean that no matching telemetry is available. They are not evidence of a failed web build.

## Send data

Create an ingestion token in **Project settings**, and load it into `LOGICE_PROJECT_TOKEN` from protected application storage. Configure these SDK settings:

```sh
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:5173
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${LOGICE_PROJECT_TOKEN}"
export OTEL_SERVICE_NAME=my-application
```

Use the project token, not the internal `.env` `OTLP_TOKEN`. Set it in the application's environment; do not commit it or paste it into shared logs. These settings require an SDK that supports them; they do not instrument an application by themselves. Send traces to `/v1/traces` and logs to `/v1/logs`. Include the trace and span IDs on log records for correlation.

The Go proxy authenticates the project token and sends trusted project metadata to the private Collector. Collector replaces the resource project attribute with that project UUID. Clients cannot choose another project with resource attributes, headers, or a browser query parameter.

## Query API

All routes use GET and return JSON:

| Route | Result | Filters |
| --- | --- | --- |
| `/api/projects/{projectID}/traces` | Trace summaries | `from`, `to`, `service`, `search`, `errorsOnly`, `limit` |
| `/api/projects/{projectID}/logs` | Log records with detail fields | `from`, `to`, `service`, `search`, `minSeverity`, `traceId`, `limit` |
| `/api/projects/{projectID}/traces/{traceId}` | Spans and correlated logs | `from`, `to` |

- `from` and `to` are RFC3339 timestamps with up to nine fractional digits. Supply both or neither. The default is the last hour.
  - The interval includes `from` and excludes `to`. The maximum interval is 24 hours.
- `limit` defaults to 50 and must be from 1 through 100. Lists return `{items, hasMore}`. Narrow the window or filters when `hasMore` is true; pagination is not implemented.
- `service` and `search` have a maximum length of 200 bytes each.
- `minSeverity` must be from 0 through 24. `errorsOnly` is a Boolean.
- Trace IDs must have 32 hexadecimal digits and must not be all zeroes.
- Duplicate and unknown parameters are rejected. No route accepts SQL or a project override.
- Trace detail returns at most 500 spans and 200 logs, with separate truncation flags.
- Timestamps preserve nanoseconds in JSON. Duration values are decimal nanosecond strings to avoid JavaScript integer precision loss.

Every storage query enforces the authorized project and time bounds. Queries have a five-second deadline, a 128 MiB ClickHouse memory limit, and an 8 MiB result limit. The application uses read-only query settings with the existing local database account; this is not a separate least-privilege production role.

HTTP 400 indicates invalid filters. HTTP 404 indicates an unknown trace in the selected window. HTTP 503 indicates unavailable storage or a query resource limit. `/api/healthz` remains a process-liveness check, not a database-readiness check.

## Limits

Summaries include only spans that match the selected window, service, and search. A root span outside those bounds can be absent. Details also apply the selected time window and row caps. Missing parents, incomplete traces, late arrivals, and duplicate exporter rows are not reconstructed or deduplicated. A duration bar uses one time scale for the returned spans, not for a complete trace.

Attribute values use the exporter's string representation, not the original OTLP types. The initial views do not display span events, links, metrics, or histograms. No throughput, durability, public-access, or production-security claim follows from the local views.

## Development and validation

Compose supplies `CLICKHOUSE_ADDR=clickhouse:9000` and `CLICKHOUSE_PASSWORD` to the API. The user and database are fixed at `logice`. For a host-run API, set `CLICKHOUSE_ADDR` to the random native address from `docker compose port clickhouse 9000`, and supply the same password in its environment. Without an address, liveness works and query routes return HTTP 503.

```sh
sh scripts/check-go.sh
npm --prefix web ci
npm --prefix web run ci
npm --prefix web exec -- playwright install --with-deps chromium
sh scripts/validate-compose-web.sh
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
```

The browser script requires Docker Compose 2.24.4 or later, curl, OpenSSL, GNU timeout, and the web-local Playwright installation. It starts only a unique disposable project, generates credentials, sends fixtures through its own Collector, checks the built web/API containers, and removes its own containers, volumes, network, and image tags. It must not use the operator's project or read `.env`. Playwright artifacts stay under the ignored `web/test-results/` directory.
