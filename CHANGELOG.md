# Logice

Release notes for the Go application and private React frontend. No application release has been published by this setup.

## 0.3.0

### Minor Changes

- Add web UI translations for Traditional Chinese, Japanese, Korean, Spanish, French, German, Portuguese, and Italian. Add language selectors before sign-in and in the workspace, with a browser-local preference and English fallback.

### Patch Changes

- Make the project Dashboard easier to investigate with unified query controls, compact linked metrics, visible trace activity, earlier recent records, and role-aware empty-state actions. Retain exact query windows, full metric definitions, bucket data, and separate aggregate and sample error states in all supported languages.

- Match Live response size checks to the active Go JSON encoder when strings contain invalid UTF-8. Preserve exact size limits and bounded allocations with both legacy JSON and jsonv2 encoding.

- Improve mobile navigation with a labeled dialog and keyboard focus return. Increase Live control text and touch areas, and collapse telemetry filters into an applied-filter summary so trace results appear sooner. Preserve desktop navigation and exact query windows.

- Confirm telemetry receipt when one signal contains stored records even if the other signal cannot be read. Keep read errors when no record is observed and preserve cancellation. Allow Live logs with valid trace IDs to open trace details without a span ID, without inferring a span parent.

- Clarify UI wording across all supported languages. Use readable audit and alert labels, metric-specific duration and sample-count fields, consistent ingestion-token terminology, column-header and saved-view actions, and project setup guidance without development-only assumptions. Keep API values, permissions, and telemetry behavior unchanged.

## 0.2.1

### Patch Changes

- Keep Live follow state synchronized before restoring keyboard focus. This keeps keyboard navigation in the rendered window after a large snapshot.

## 0.2.0

### Minor Changes

- Add reviewed GitOps promotion for tested API/web image digests, ordered Helm rollout, and bounded API readiness. Keep production adoption, physical Passkey validation, and schema-safe recovery under operator approval.

## 0.1.1

### Patch Changes

- Build API and web Docker images for stable Git release tags. Publish both commit and version image tags without changing latest. Call the same Docker workflow after changenote publication so workflow-token tag pushes also produce release images.

## 0.1.0

### Minor Changes

- Add changenote version pull requests and GitHub source releases for Logice. Use one application version for Go and the private React frontend. Do not publish to npm.

