"""A loopback HTTP server with manual OpenTelemetry spans and correlated logs."""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from opentelemetry.propagate import extract
from opentelemetry.trace import SpanKind, Status, StatusCode
from telemetry import Telemetry, configure

SERVICE_NAME = "python-http-example"


class ExampleHTTPServer(ThreadingHTTPServer):
    daemon_threads = False


def make_handler(telemetry: Telemetry) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        timeout = 5

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            route = path if path in {"/", "/checkout", "/fail"} else "unmatched"
            with telemetry.tracer.start_as_current_span(
                f"GET {route}",
                context=extract(self.headers),
                kind=SpanKind.SERVER,
                attributes={"http.request.method": "GET", "http.route": route},
            ) as request:
                status = 200
                message = "Use /checkout for success or /fail for an intentional error."
                if route in {"/checkout", "/fail"}:
                    with telemetry.tracer.start_as_current_span(
                        "reserve_inventory"
                    ) as inventory:
                        time.sleep(0.025)
                        if route == "/fail":
                            status, message = 500, "Example inventory is unavailable"
                            inventory.set_status(Status(StatusCode.ERROR, message))
                            request.set_status(Status(StatusCode.ERROR, message))
                            telemetry.logger.error("Inventory unavailable")
                        else:
                            message = "Checkout complete"
                            telemetry.logger.info("Inventory reserved")
                elif route == "unmatched":
                    status, message = 404, "Route not found"
                request.set_attribute("http.response.status_code", status)
                telemetry.logger.info(
                    "HTTP request completed",
                    extra={"http.route": route, "http.response.status_code": status},
                )
                body = json.dumps(
                    {
                        "message": message,
                        "traceId": f"{request.get_span_context().trace_id:032x}",
                    }
                ).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            # Do not duplicate logs or record raw URLs and query-string secrets.
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port", type=int, default=8000, help="Loopback HTTP port (default: 8000)"
    )
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    with configure(SERVICE_NAME) as telemetry:
        # server_close waits for active request threads before provider shutdown.
        with ExampleHTTPServer(
            ("127.0.0.1", args.port), make_handler(telemetry)
        ) as server:
            print(f"Listening on http://127.0.0.1:{args.port}", flush=True)
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from None
