---
logice: patch
---

Match Live response size checks to the active Go JSON encoder when strings contain invalid UTF-8. Preserve exact size limits and bounded allocations with both legacy JSON and jsonv2 encoding.
