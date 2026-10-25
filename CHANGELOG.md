# Logice

Release notes for the Go application and private React frontend. No application release has been published by this setup.

## 0.2.0

### Minor Changes

- Add reviewed GitOps promotion for tested API/web image digests, ordered Helm rollout, and bounded API readiness. Keep production adoption, physical Passkey validation, and schema-safe recovery under operator approval.

## 0.1.1

### Patch Changes

- Build API and web Docker images for stable Git release tags. Publish both commit and version image tags without changing latest. Call the same Docker workflow after changenote publication so workflow-token tag pushes also produce release images.

## 0.1.0

### Minor Changes

- Add changenote version pull requests and GitHub source releases for Logice. Use one application version for Go and the private React frontend. Do not publish to npm.

