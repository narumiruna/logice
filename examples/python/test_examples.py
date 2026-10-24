"""Check real SDK exports with an in-process OTLP/HTTP receiver."""

import contextlib
import io
import json
import logging
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from queue import SimpleQueue
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import http_server
import multi_service
import send_telemetry
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from telemetry import configure, settings


class ExampleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.requests = SimpleQueue()
        captured = self.requests

        class Collector(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                captured.put(
                    (
                        self.path,
                        self.headers,
                        self.rfile.read(int(self.headers["Content-Length"])),
                    )
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/x-protobuf")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.collector = HTTPServer(("127.0.0.1", 0), Collector)
        self.collector_thread = threading.Thread(
            target=self.collector.serve_forever, kwargs={"poll_interval": 0.01}
        )
        self.collector_thread.start()
        self.addCleanup(self.stop_collector)
        self.environment = patch.dict(
            os.environ,
            {
                "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{self.collector.server_port}",
                "LOGICE_PROJECT_TOKEN": "unit-test-token",
            },
            clear=True,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def stop_collector(self) -> None:
        self.collector.shutdown()
        self.collector.server_close()
        self.collector_thread.join(timeout=2)
        self.assertFalse(self.collector_thread.is_alive())

    def exported(self) -> tuple[list, list]:
        spans, logs = [], []
        self.span_services = {}
        self.log_services = set()
        while not self.requests.empty():
            path, headers, body = self.requests.get_nowait()
            self.assertEqual(headers["Authorization"], "Bearer unit-test-token")
            self.assertEqual(headers["Content-Type"], "application/x-protobuf")
            if path == "/v1/traces":
                request = ExportTraceServiceRequest.FromString(body)
                for resource in request.resource_spans:
                    self.assertTrue(
                        any(
                            item.key == "service.name"
                            for item in resource.resource.attributes
                        )
                    )
                    service = next(
                        item.value.string_value
                        for item in resource.resource.attributes
                        if item.key == "service.name"
                    )
                    for scope in resource.scope_spans:
                        spans.extend(scope.spans)
                        for span in scope.spans:
                            self.span_services[(span.trace_id, span.span_id)] = service
            elif path == "/v1/logs":
                request = ExportLogsServiceRequest.FromString(body)
                for resource in request.resource_logs:
                    self.log_services.add(
                        next(
                            item.value.string_value
                            for item in resource.resource.attributes
                            if item.key == "service.name"
                        )
                    )
                    for scope in resource.scope_logs:
                        logs.extend(scope.log_records)
            else:
                self.fail("Unexpected OTLP signal path")
        return spans, logs

    def test_send_traces_and_correlated_logs(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            send_telemetry.main()
        result = json.loads(output.getvalue())
        spans, logs = self.exported()
        self.assertEqual(result["service"], "python-send-example")
        self.assertEqual(len(spans), 4)
        self.assertEqual(len(result["traceIds"]), 2)
        self.assertEqual(
            {span.trace_id.hex() for span in spans}, set(result["traceIds"])
        )
        roots = {span.span_id for span in spans if not span.parent_span_id}
        self.assertEqual(len(roots), 2)
        self.assertTrue(
            all(span.parent_span_id in roots for span in spans if span.parent_span_id)
        )
        self.assertEqual(sum(span.status.code == 2 for span in spans), 2)
        self.assertEqual(len(logs), 7)
        self.assertEqual(sum(bool(record.trace_id) for record in logs), 6)
        self.assertEqual(sum(record.severity_number >= 17 for record in logs), 1)
        pairs = {(span.trace_id, span.span_id) for span in spans}
        self.assertTrue(
            all(
                (record.trace_id, record.span_id) in pairs
                for record in logs
                if record.trace_id
            )
        )
        self.assertNotIn("unit-test-token", output.getvalue())

    def test_multiple_services_share_trace_context_and_correlated_logs(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            multi_service.main()
        result = json.loads(output.getvalue())
        spans, logs = self.exported()
        services = set(multi_service.SERVICE_NAMES)
        self.assertEqual(set(result["services"]), services)
        self.assertEqual(set(self.span_services.values()), services)
        self.assertEqual(self.log_services, services)
        self.assertEqual(len(spans), 20)
        self.assertEqual(len(logs), 36)
        self.assertEqual(len(result["traceIds"]), 4)
        self.assertEqual(sum(span.status.code == 2 for span in spans), 6)
        self.assertEqual(sum(record.severity_number == 17 for record in logs), 2)
        self.assertEqual(sum(record.severity_number == 13 for record in logs), 2)
        self.assertEqual(sum(not record.trace_id for record in logs), 4)
        roots = [span for span in spans if not span.parent_span_id]
        self.assertEqual(len(roots), 4)
        for trace_id in result["traceIds"]:
            trace_spans = [span for span in spans if span.trace_id.hex() == trace_id]
            self.assertEqual(
                {
                    self.span_services[(span.trace_id, span.span_id)]
                    for span in trace_spans
                },
                services,
            )
        for span in spans:
            if span.parent_span_id:
                self.assertIn((span.trace_id, span.parent_span_id), self.span_services)
            else:
                self.assertEqual(
                    self.span_services[(span.trace_id, span.span_id)], "api"
                )
        for record in logs:
            if record.trace_id:
                self.assertIn((record.trace_id, record.span_id), self.span_services)
        self.assertNotIn("unit-test-token", output.getvalue())

    def test_http_routes_and_trace_context(self) -> None:
        with configure(http_server.SERVICE_NAME) as telemetry:
            with http_server.ExampleHTTPServer(
                ("127.0.0.1", 0), http_server.make_handler(telemetry)
            ) as server:
                thread = threading.Thread(
                    target=server.serve_forever, kwargs={"poll_interval": 0.01}
                )
                thread.start()
                try:
                    for path, expected in [
                        ("/checkout?secret=do-not-export", 200),
                        ("/fail", 500),
                        ("/missing", 404),
                    ]:
                        request = Request(
                            f"http://127.0.0.1:{server.server_port}{path}",
                            headers={
                                "traceparent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01"
                            },
                        )
                        try:
                            response = urlopen(request, timeout=5)
                        except HTTPError as error:
                            response = error
                        with response:
                            self.assertEqual(response.status, expected)
                            self.assertEqual(
                                json.load(response)["traceId"],
                                "1234567890abcdef1234567890abcdef",
                            )
                finally:
                    server.shutdown()
                    thread.join(timeout=2)
                    self.assertFalse(thread.is_alive())
        spans, logs = self.exported()
        self.assertEqual(len(spans), 5)
        self.assertEqual(len(logs), 5)
        self.assertEqual(sum(span.status.code == 2 for span in spans), 2)
        self.assertTrue(
            all(
                span.trace_id.hex() == "1234567890abcdef1234567890abcdef"
                for span in spans
            )
        )
        self.assertNotIn(
            b"do-not-export", b"".join(span.SerializeToString() for span in spans)
        )
        self.assertNotIn(
            b"do-not-export", b"".join(record.SerializeToString() for record in logs)
        )

    def test_configuration_rejects_missing_or_unsafe_values(self) -> None:
        for endpoint in [
            "",
            "file:///tmp/data",
            "http://user:secret@localhost:4318",
            "http://localhost:4318/v1/traces",
            "http://localhost:bad",
            "http://localhost:0",
            "http://@localhost:4318",
            "http://localhost:4318?token=secret",
        ]:
            with (
                self.subTest(endpoint=endpoint),
                patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": endpoint}),
            ):
                with self.assertRaises(ValueError) as error:
                    settings()
                self.assertNotIn("unit-test-token", str(error.exception))
        for token in ["", "contains space", "bad\r\nheader", "non-ascii-秘密"]:
            with (
                self.subTest(token=token),
                patch.dict(os.environ, {"LOGICE_PROJECT_TOKEN": token}),
            ):
                with self.assertRaises(ValueError):
                    settings()

    def test_logger_configuration_is_restored_after_failure(self) -> None:
        logger = logging.getLogger("python-restore-test")
        logger.setLevel(logging.WARNING)
        original = (logger.level, logger.propagate, list(logger.handlers))
        with self.assertRaisesRegex(RuntimeError, "example failure"):
            with configure(logger.name):
                self.assertEqual(logger.level, logging.INFO)
                raise RuntimeError("example failure")
        self.assertEqual((logger.level, logger.propagate, logger.handlers), original)


if __name__ == "__main__":
    unittest.main()
