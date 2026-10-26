---
logice: patch
---

Confirm telemetry receipt when one signal contains stored records even if the other signal cannot be read. Keep read errors when no record is observed and preserve cancellation. Allow Live logs with valid trace IDs to open trace details without a span ID, without inferring a span parent.
