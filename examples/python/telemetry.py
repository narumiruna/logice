"""Shared OTLP/HTTP setup for the local Python examples."""

import logging
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


@dataclass(frozen=True)
class Telemetry:
    tracer: trace.Tracer
    logger: logging.Logger


def settings() -> tuple[str, str]:
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")
    token = os.environ.get("OTLP_TOKEN", "")
    try:
        url = urlsplit(endpoint)
        valid = (
            url.scheme in {"http", "https"}
            and url.hostname
            and url.username is None
            and url.password is None
            and not url.path
            and not url.query
            and not url.fragment
        )
        valid = valid and (url.port is None or 1 <= url.port <= 65535)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(
            "Set OTEL_EXPORTER_OTLP_ENDPOINT to the Collector base URL, "
            "for example http://127.0.0.1:4318 (without /v1/traces or /v1/logs)."
        )
    if not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token):
        raise ValueError(
            "Set OTLP_TOKEN to the Collector token from the protected .env file."
        )
    return endpoint, token


@contextmanager
def configure(service_name: str) -> Iterator[Telemetry]:
    endpoint, token = settings()
    headers = {"Authorization": f"Bearer {token}"}
    resource = Resource.create({"service.name": service_name})
    traces = TracerProvider(resource=resource)
    logs = LoggerProvider(resource=resource)
    traces.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=f"{endpoint}/v1/traces", headers=headers, timeout=5
            )
        )
    )
    logs.add_log_record_processor(
        BatchLogRecordProcessor(
            OTLPLogExporter(endpoint=f"{endpoint}/v1/logs", headers=headers, timeout=5)
        )
    )
    # Attach only to this application's logger, not the SDK's own loggers.
    logger = logging.getLogger(service_name)
    old_level, old_propagate = logger.level, logger.propagate
    handler = LoggingHandler(level=logging.INFO, logger_provider=logs)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        yield Telemetry(traces.get_tracer(service_name), logger)
    finally:
        logger.removeHandler(handler)
        logger.setLevel(old_level)
        logger.propagate = old_propagate
        try:
            logs.force_flush(timeout_millis=10_000)
            traces.force_flush(timeout_millis=10_000)
        finally:
            logs.shutdown()
            traces.shutdown()
            handler.close()
