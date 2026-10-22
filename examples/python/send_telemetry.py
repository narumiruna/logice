"""Generate successful and failed traces with correlated standard-library logs."""

import json
import time

from opentelemetry.trace import Status, StatusCode
from telemetry import Telemetry, configure

SERVICE_NAME = "python-send-example"


def checkout(telemetry: Telemetry, *, fail: bool) -> str:
    with telemetry.tracer.start_as_current_span(
        "checkout", attributes={"example.scenario": "failure" if fail else "success"}
    ) as request:
        telemetry.logger.info("Checkout started")
        with telemetry.tracer.start_as_current_span(
            "reserve_inventory", attributes={"inventory.product": "example-product"}
        ) as inventory:
            time.sleep(0.025)
            if fail:
                # This failure is intentional. The example still exits normally.
                error = ValueError("Example inventory is unavailable")
                inventory.record_exception(error)
                inventory.set_status(Status(StatusCode.ERROR, str(error)))
                request.set_status(Status(StatusCode.ERROR, str(error)))
                telemetry.logger.error(
                    "Inventory unavailable",
                    extra={"example.product": "example-product"},
                )
            else:
                inventory.set_status(Status(StatusCode.OK))
                telemetry.logger.info("Inventory reserved")
        telemetry.logger.info("Checkout finished")
        return f"{request.get_span_context().trace_id:032x}"


def main() -> None:
    with configure(SERVICE_NAME) as telemetry:
        trace_ids = [checkout(telemetry, fail=False), checkout(telemetry, fail=True)]
        # No current span: this record demonstrates an uncorrelated log.
        telemetry.logger.info("Example run complete")
    print(json.dumps({"service": SERVICE_NAME, "traceIds": trace_ids}))


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from None
