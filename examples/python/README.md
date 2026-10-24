# Python examples

These examples send traces and standard-library logs to Logice through OTLP/HTTP protobuf. They use Python 3.12 or later and [uv](https://docs.astral.sh/uv/). Dependencies are pinned in `pyproject.toml` and `uv.lock`.

| File | Purpose |
| --- | --- |
| `send_telemetry.py` | Generate successful and failed checkouts, parent/child spans, correlated logs, and one log without a trace. |
| `http_server.py` | Run a loopback HTTP server with request spans, child spans, logs, and incoming W3C trace context. |
| `multi_service.py` | Export cross-service sample traces and logs for `api`, `worker`, `postgres`, and `openai`, without remote service calls. |
| `telemetry.py` | Configure authenticated exporters, log correlation, and shutdown. |
| `test_examples.py` | Check protobuf exports with a local test receiver. |

## Prepare the project

Run these commands from the repository root. Create the protected `.env` first as described in the [main README](../../README.md).

```sh
docker compose up --build --detach --wait --wait-timeout 120
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:5173
```

Sign in at the exact configured origin, create or select a project, and create an ingestion token in **Project settings** as Owner or Developer. Load it from protected storage into `LOGICE_PROJECT_TOKEN` and export that variable. Do not use the infrastructure `.env` `OTLP_TOKEN` for these examples.

The endpoint is the application origin, not the private Collector. Do not append `/v1/traces` or `/v1/logs`; the shared setup adds each signal path. Use the same Compose project name for all lifecycle commands. Never put the token in source, URLs, shell history, or shared logs.

## Generate traces and logs

```sh
uv run --project examples/python --locked python examples/python/send_telemetry.py
```

One run generates two traces with four spans and seven logs. One checkout intentionally fails: its request and inventory spans have Error status, and its inventory log has ERROR severity. The other checkout succeeds. The final log has no trace ID.

The command prints the service name `python-send-example` and the generated trace IDs as JSON. In the selected Logice project at `http://localhost:5173`:

1. Open **Traces**, set **Service** to `python-send-example`, and select **Refresh**.
2. Open a checkout trace and expand its spans or correlated logs.
3. Open **Logs** with the same service filter to see all seven records, including the uncorrelated log.

Exporters flush before the process exits. Collector export batching can add a short delay before records appear. Generated IDs do not prove that storage accepted the records; check SDK errors on stderr and verify the records in Logice.

## Generate multiple services

After setting the application endpoint and project token above, run:

```sh
uv run --project examples/python --locked python examples/python/multi_service.py
```

One run exports four traces, twenty spans, and thirty-six logs across `api`, `worker`, `postgres`, and `openai`. Each trace starts in `api`, continues in `worker` through W3C trace context, and includes database and completion spans. Two requests succeed; two have an intentional completion error with Error spans, ERROR logs, and WARN logs. Each service also emits one uncorrelated completion log.

Open **Live** in the selected project with the service filter empty to see all four services in the same hierarchy. Remove an existing service filter or select Reset view. Inspect a request to see its recorded IDs, service resources, and correlated logs.

These operations run in one local process and use short real delays. They do not connect to PostgreSQL or call OpenAI. Only the OTLP exports use the network. All spans are completed exports; there is no simulated Running status. The command prints the service names and trace IDs, then flushes exporters and exits.

## Run the HTTP server

```sh
uv run --project examples/python --locked python examples/python/http_server.py
```

In another terminal:

```sh
curl http://127.0.0.1:8000/checkout
curl http://127.0.0.1:8000/fail
curl -H 'traceparent: 00-1234567890abcdef1234567890abcdef-1234567890abcdef-01' \
  http://127.0.0.1:8000/checkout
```

- `/checkout` returns HTTP 200 and creates a request span and inventory child span.
- `/fail` intentionally returns HTTP 500 with error spans and an ERROR log.
- `/` shows route guidance. Unknown routes return HTTP 404.
- Each response includes the trace ID. A valid incoming `traceparent` continues the supplied trace.
- Use the service filter `python-http-example` in Logice. Logs created inside a span carry its trace and span IDs.
- The server binds only to `127.0.0.1`. Use `--port 8001` if port 8000 is occupied.
- Press Ctrl-C to stop. Active request threads finish before providers flush and close.

This is a development example, not a production HTTP server. It does not export request headers, raw query strings, or authentication tokens as telemetry. Resource attributes are examples, not access controls; the proxy and Collector assign the project authenticated by the token.

## Checks

Run from the repository root:

```sh
uv run --project examples/python --locked python -m unittest discover -s examples/python -v
```

The five tests need no Docker, credentials, or existing Logice data. They check authenticated OTLP paths and protobuf payloads, span hierarchy, cross-service resource names, error status, log correlation, HTTP status and trace-context propagation, configuration validation, and logger cleanup. They use a temporary loopback receiver and do not read `.env`.

A separate local check on Python 3.14.7 ran both examples against the pinned Collector and ClickHouse images in a unique disposable Compose project. It verified eight stored spans, eleven logs, expected Error status and ERROR severity, and trace correlation. That check did not use operator credentials or data; its containers, network, and volume were removed.
