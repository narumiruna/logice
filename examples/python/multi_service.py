"""Export sample cross-service traces without calling databases or external APIs."""

import json
import time
from contextlib import ExitStack

from opentelemetry.propagate import extract, inject
from opentelemetry.trace import SpanKind, Status, StatusCode
from telemetry import Telemetry, configure

SERVICE_NAMES = ("api", "worker", "postgres", "openai")


def request(services: dict[str, Telemetry], *, fail: bool) -> str:
    api, worker, database, model = (services[name] for name in SERVICE_NAMES)
    scenario = "failure" if fail else "success"
    with api.tracer.start_as_current_span(
        "POST /api/chat",
        kind=SpanKind.SERVER,
        attributes={"http.route": "/api/chat", "example.scenario": scenario},
    ) as root:
        api.logger.info("Request received")
        # Demonstrate W3C propagation across a simulated service boundary.
        # The service operations below run locally; no remote requests are made.
        carrier: dict[str, str] = {}
        inject(carrier)
        with worker.tracer.start_as_current_span(
            "agent.run", context=extract(carrier), kind=SpanKind.CONSUMER
        ) as agent:
            worker.logger.info("Loading conversation context")
            with database.tracer.start_as_current_span(
                "db.lookup", attributes={"db.system.name": "postgresql"}
            ) as lookup:
                time.sleep(0.02)
                database.logger.info("Conversation context loaded")
                lookup.set_status(Status(StatusCode.OK))
            with model.tracer.start_as_current_span(
                "llm.generate", attributes={"example.operation": "simulated-completion"}
            ) as completion:
                model.logger.info("Sending simulated completion request")
                time.sleep(0.08)
                if fail:
                    message = "Example rate limit exceeded; retry budget exhausted"
                    for span in (completion, agent, root):
                        span.set_status(Status(StatusCode.ERROR, message))
                    model.logger.error(message)
                else:
                    model.logger.info("Simulated completion received")
                    completion.set_status(Status(StatusCode.OK))
            if fail:
                worker.logger.warning("Request failed with upstream error")
            else:
                with worker.tracer.start_as_current_span("tool.execute") as tool:
                    with database.tracer.start_as_current_span(
                        "db.search", attributes={"db.system.name": "postgresql"}
                    ) as search:
                        time.sleep(0.03)
                        database.logger.info(
                            "Knowledge search returned relevant documents"
                        )
                        search.set_status(Status(StatusCode.OK))
                    worker.logger.info("Tool execution complete")
                    tool.set_status(Status(StatusCode.OK))
                worker.logger.info("Agent run complete")
                agent.set_status(Status(StatusCode.OK))
        root.set_attribute("http.response.status_code", 500 if fail else 200)
        if not fail:
            root.set_status(Status(StatusCode.OK))
        api.logger.info("HTTP request completed")
        return f"{root.get_span_context().trace_id:032x}"


def main() -> None:
    with ExitStack() as stack:
        services = {
            name: stack.enter_context(configure(name)) for name in SERVICE_NAMES
        }
        trace_ids = [
            request(services, fail=fail) for fail in (False, True, False, True)
        ]
        for telemetry in services.values():
            telemetry.logger.info("Multi-service example complete")
    print(json.dumps({"services": list(SERVICE_NAMES), "traceIds": trace_ids}))


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from None
