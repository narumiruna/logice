---
logice: patch
---

Build API and web Docker images for stable Git release tags. Publish both commit and version image tags without changing latest. Call the same Docker workflow after changenote publication so workflow-token tag pushes also produce release images.
