# Self-Service Passkey Management

## Goal

Let an authenticated account add a backup Passkey, name its credentials, and remove a credential without exposing credential material, weakening user verification, or losing its last working sign-in method.

## Context

`internal/auth/http.go` currently supports invitation enrollment and Passkey login. `auth_credentials` stores credential bytes and WebAuthn JSON; it has no display-name or usage metadata columns. Ceremony kinds currently allow only `enroll` and `login`. `web/src/account-settings.tsx` describes operator recovery but has no credential controls. Recovery preserves the account UUID and project ownership; see [Passkey operations](../passkey-operations.md).

## Architecture

- Add a self-service credential section to `/account`. Only the authenticated subject can list or modify its credentials. Platform administration grants no access to another account's Passkeys.
- Use opaque management UUIDs in public list/mutation URLs. Never return raw credential IDs, public keys, private ceremony state, or device fingerprints. Expose name and trustworthy timestamps only. Legacy creation/last-used dates remain unknown unless actual evidence exists; a synced Passkey is not a uniquely identifiable physical device.
- Add nullable credential metadata and dedicated ceremony kinds through a new additive migration. Do not reinterpret invitation enrollment as authenticated credential addition.
- Proposed routes under `/api/auth/passkeys`: bounded GET; registration begin/finish; rename; removal. Require session, Origin, CSRF, JSON limits, and rate controls for mutations.
- Require fresh user-verified Passkey authentication before adding or removing credentials. Bind short-lived, single-use authorization to the account, session/browser generation, and intended operation/target. Do not use a client timestamp or ordinary session age as reauthentication evidence.
- Registration must use existing credentials as exclusions and validate challenge, RP ID, Origin, user verification, account binding, and credential uniqueness. Save the new credential and audit event atomically. Do not expose optional attestation/device-discovery features in the first release.
- Serialize credential changes with the existing user-row lock and recovery generation checks. Reject removal of the last credential, including concurrent deletion attempts. After removal, invalidate other account sessions and rotate the current session only on successful commit; record and test this policy explicitly. WebAuthn success alone is not database commit success.

## Plan

- [ ] Specify the credential metadata, management IDs, reauthentication contract, session invalidation policy, and finite credential quota; acceptance: reviewed request/response fixtures expose no credential material and cover legacy rows without invented dates.
- [ ] Add transactional migration and self-only list/rename operations; acceptance: real PostgreSQL tests prove ownership checks, strict input validation, metadata limits, audit atomicity, and migration retry safety.
- [ ] Implement operation-bound reauthentication and backup registration ceremonies; acceptance: authenticators with wrong RP/Origin/challenge, missing UV, stale generation, duplicate credential, expired/reused proof, or another account's session are rejected.
- [ ] Implement locked removal and session rotation; acceptance: race tests prove last-credential protection, simultaneous add/remove safety, recovery serialization, session revocation, and rollback on audit/storage failure.
- [ ] Add credential list, naming, add/remove confirmation, cancellation, and error UI; acceptance: Classic/Studio, keyboard, mobile, unsupported authenticators, cancelled browser prompts, and interrupted ceremonies remain usable without exposing secrets.
- [ ] Add browser workflows with independent authenticators; acceptance: a backup signs in after the original is removed, the removed credential cannot sign in, the last credential cannot be removed, and existing enrollment/login/recovery tests remain enabled.
- [ ] Update operator/user recovery guidance; acceptance: docs distinguish naming, account removal, synced credentials, sign out, and operator recovery.

## Completion Checklist

- [ ] `GOTOOLCHAIN=go1.26.10 sh scripts/check-go.sh`, `GOTOOLCHAIN=go1.26.10 go test -race -tags=integration -count=1 -timeout=8m ./internal/auth/...`, `npm --prefix web run ci`, and `sh scripts/validate-compose-web.sh` pass with negative WebAuthn cases.
- [ ] Verify the flow with a real user-verifying authenticator on the intended HTTPS origin before production release; virtual authenticators alone are not that evidence.
- [ ] Review session/proof replay, account binding, transaction failure, metadata privacy, and concurrent last-key removal.
- [ ] Deliver a verified PR and clearly identify any pending physical-authenticator release gate; delete this plan only after required checks/handoff are complete.

## Rollback / Recovery

Back up PostgreSQL and the encryption key before an approved migration. Roll back self-service routes/UI without deleting newly added credentials or reverting to invitation-based key replacement. A stale backup may resurrect removed credentials and sessions; isolate access and use the existing operator recovery procedure before reopening it. Do not rotate the encryption key or modify live credentials as part of implementation tests.
