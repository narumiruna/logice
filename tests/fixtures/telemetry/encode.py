"""Convert disposable browser fixture JSON to OTLP protobuf on standard output."""

import base64
import json
import sys

from google.protobuf.json_format import Parse
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

message = ExportTraceServiceRequest() if sys.argv[1] == "traces" else ExportLogsServiceRequest()
def otlp_ids(value):
    if isinstance(value, dict):
        return {
            key: base64.b64encode(bytes.fromhex(item)).decode()
            if key in {"traceId", "spanId", "parentSpanId"} and isinstance(item, str)
            else otlp_ids(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [otlp_ids(item) for item in value]
    return value


Parse(json.dumps(otlp_ids(json.load(sys.stdin))), message)
sys.stdout.buffer.write(message.SerializeToString())
