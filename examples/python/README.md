# Python examples

These examples send traces and standard-library logs to Logice through OTLP/HTTP protobuf. They use Python 3.12 or later and [uv](https://docs.astral.sh/uv/). Dependencies are pinned in `pyproject.toml` and `uv.lock`.

| File | Purpose |
| --- | --- |
| `send_telemetry.py` | Generate successful and failed checkouts, parent/child spans, correlated logs, and one log without a trace. |
| `http_server.py` | Run a loopback HTTP server with request spans, child spans, logs, and incoming W3C trace context. |
| `telemetry.py` | Configure authenticated exporters, log correlation, and shutdown. |
| `test_examples.py` | Check protobuf exports with a local test receiver. |

## Prepare the Collector

Run these commands from the repository root. Create the protected `.env` first as described in the [main README](../../README.md).

```sh
docker compose up --build --detach --wait --wait-timeout 120
export OTEL_EXPORTER_OTLP_ENDPOINT="http://$(docker compose port collector 4318)"
```

Use the same Compose project for startup and port lookup. If you started with `--project-name logice-validation`, include that option in both commands.

The endpoint is the Collector's random OTLP/HTTP port, not the web port `5173` or the API port `8080`. Do not append `/v1/traces` or `/v1/logs`; the shared setup adds the correct path for each signal.

The commands below use `uv run --env-file` to read `OTLP_TOKEN` from the protected root `.env`. The token must match the running Collector. You can instead export `OTLP_TOKEN` in the process environment and omit `--env-file .env`. Do not put the token in source code or share it in logs.

## Generate traces and logs

```sh
uv run --project examples/python --locked --env-file .env python examples/python/send_telemetry.py
```

One run generates two traces with four spans and seven logs. One checkout intentionally fails: its request and inventory spans have Error status, and its inventory log has ERROR severity. The other checkout succeeds. The final log has no trace ID.

The command prints the service name `python-send-example` and the generated trace IDs as JSON. In `http://127.0.0.1:5173`:

1. Open **Traces**, set **Service** to `python-send-example`, and select **Refresh**.
2. Open a checkout trace and expand its spans or correlated logs.
3. Open **Logs** with the same service filter to see all seven records, including the uncorrelated log.

Exporters flush before the process exits. Collector export batching can add a short delay before records appear. Generated IDs do not prove that storage accepted the records; check SDK errors on stderr and verify the records in Logice.

## Run the HTTP server

```sh
uv run --project examples/python --locked --env-file .env python examples/python/http_server.py
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

This is a development example, not a production HTTP server. It does not export request headers, raw query strings, or authentication tokens as telemetry. Resource attributes are examples, not access controls; the Collector assigns the fixed `validation` project.

## Checks

Run from the repository root:

```sh
uv run --project examples/python --locked python -m unittest discover -s examples/python -v
```

The four tests need no Docker, credentials, or existing Logice data. They check authenticated OTLP paths and protobuf payloads, span hierarchy, error status, log correlation, HTTP status and trace-context propagation, configuration validation, and logger cleanup. They use a temporary loopback receiver and do not read `.env`.

A separate local check on Python 3.14.7 ran both examples against the pinned Collector and ClickHouse images in a unique disposable Compose project. It verified eight stored spans, eleven logs, expected Error status and ERROR severity, and trace correlation. That check did not use operator credentials or data; its containers, network, and volume were removed.
