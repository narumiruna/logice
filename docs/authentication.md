# Authentication design

## Status

The required methods are password login, passkeys, authenticator-app TOTP as a second factor, and OIDC compatible with Pocket ID. This document specifies their implementation and acceptance tests; none of those application flows is implemented by the stack-validation proof.

The policies below are recommendations for pull-request review. In particular, invitation-only access, session lifetimes, and second-factor rules are not recorded as explicit user approvals.

## Libraries and maintenance

| Responsibility | Validation selection | Evidence |
| --- | --- | --- |
| Password hashing and secret encryption | `golang.org/x/crypto` 0.58.0; Go AEAD APIs | Module release observed 2026-10-09. Use Argon2id for passwords, not reversible encryption. |
| Passkeys | `go-webauthn/webauthn` 0.18.2 | Release observed 2026-09-19; supports current Go 1.26/1.27. |
| OIDC verification | `coreos/go-oidc/v3` 3.21.0 | Release observed 2026-09-01. Nonce and authorized-party checks need explicit application logic. |
| Authorization Code and PKCE | `golang.org/x/oauth2` 0.37.0 | Release observed 2026-08-25; use S256 and a confidential server client. |
| TOTP | `pquerna/otp` 1.5.0 | Release observed 2025-05-16; includes a secret-randomness security fix. Low recent maintenance is a review risk. Its stateless validation is not replay protection. |

The repositories were not archived when inspected. This is maintenance evidence, not a claim that all dependencies are free of vulnerabilities. Pin and scan the actual application lockfiles before adoption.

## Identity, enrollment, and recovery

- Start with invitation-only access. A provider login does not automatically grant organization or project membership.
- Create the first administrator through an explicit local CLI operation, not the first public visitor. Use an atomic transaction to prevent concurrent bootstrap attempts. Refuse repeated initial bootstrap.
- Use short-lived, single-use, high-entropy enrollment/invitation tokens. Store hashes, consume atomically, and transfer raw tokens through the operator's secure channel. Do not put secrets in URLs written to access logs.
- Provide a separate audited local recovery command for the deployment operator. It must not be a remotely accessible authentication bypass.
- Require recent appropriate authentication before adding, linking, removing, or resetting a login method. Preserve at least one usable login/recovery path.
- Store users, identities, credentials, sessions, pending ceremonies, and project memberships in PostgreSQL. Enforce unique external identities by `(issuer, subject)`; never link by matching email alone.

## Password and TOTP

- Hash passwords with Argon2id, a random per-password salt, and encoded parameters. Calibrate the cost on the deployment host; the OWASP minimum is a lower bound, not an application performance measurement.
- Bound password length and concurrent expensive hashing. Use generic login errors and account/client-address throttles. Derive the client address only from a trusted proxy.
- TOTP enrollment is optional initially. Once enrolled, require it for every password login; never let the caller omit it. Do not issue a full session before both factors succeed.
- Hold a password-verified attempt in a short-lived pending-login record with limited operations. Expire and consume it atomically.
- Require recent authentication to generate a pending TOTP secret. Enable it only after a valid verification code. AEAD-encrypt pending and enabled secrets with a versioned key stored outside PostgreSQL.
- Use standard six-digit, 30-second TOTP with a narrowly bounded skew. Determine the accepted counter and atomically reject counters already used; concurrent requests must not both accept the same code. A boolean library validation result alone is insufficient.
- Generate high-entropy single-use recovery codes. Store only hashes and consume them atomically. Recovery must not silently remove MFA or create unlimited sessions.
- Audit factor changes, revoke affected sessions, and never emit QR values, shared secrets, passwords, or recovery codes in application logs or OpenTelemetry data.

Recommended second-factor policy: password plus enrolled TOTP; a user-verified passkey is an alternative login; OIDC uses the configured provider's authentication policy. Do not infer MFA from an unverified `amr`/`acr` value or require local TOTP after every passkey/OIDC login without a separate policy decision.

## Passkeys

- Configure the stable external URL before enrollment. The RP ID is the hostname, without scheme or port; allowed origins include the exact scheme and port. Require HTTPS except for supported localhost development.
- Require user verification for registration and login. Bind each expiring challenge to the user/session and ceremony, and consume it atomically once.
- Persist credential IDs, public keys, user handles, sign counters, backup flags, and transports as required by the library. Save authentication updates after successful login.
- Synced passkeys can have zero counters. Apply the library's counter/backup semantics rather than rejecting every non-increasing counter as a cloned key.
- Do not derive RP IDs or origins from untrusted Host or forwarded headers. A later hostname change requires an explicit passkey migration/re-enrollment plan.

## Pocket ID and OIDC

### Verified protocol feasibility

A new disposable Pocket ID **2.18.0** container was started locally, its public discovery document and JWKS were fetched, and the container and temporary encryption key were removed. Observed metadata includes Authorization Code, PKCE S256, `client_secret_basic`, `client_secret_post`, public-client `none`, and RS256 ID tokens with RSA JWKS.

No administrator, passkey, relying-party client, or login was created. **A complete Pocket ID login is unverified.** Discovery alone does not satisfy the application's Pocket ID compatibility acceptance test.

### Client configuration

- Use an administrator-configured exact issuer. Prefer the same external/internal issuer URL initially. Do not accept an issuer supplied by a login request.
- Register Logice as a confidential client, with PKCE enabled and one exact redirect URI: configured external URL plus `/auth/oidc/callback`. Keep the client secret on the Go backend.
- Select `oauth2.AuthStyleInHeader` explicitly for `client_secret_basic`; the libraries do not automatically map the discovery document's supported authentication methods into this setting.
- Request `openid profile email`; do not request offline access or store provider tokens without a requirement. Use normal TLS certificate validation in deployment.
- Require bounded HTTP timeouts, response sizes, redirects, and administrator-approved endpoint destinations for discovery/JWKS/token calls. The OIDC library does not supply complete SSRF protection by itself. Permit private identity-provider addresses only through explicit operator trust configuration.
- A container's `localhost` is not the host's `localhost`. Solve routing with trusted network configuration, not disabled issuer, certificate, or signature validation.

### Login and account linking

- Generate independent state, nonce, and PKCE verifier values. Store an expiring browser-bound transaction server-side; use S256 and a GET callback compatible with SameSite=Lax correlation cookies.
- Verify and atomically consume state before exchanging the code. Exchange with the original verifier and bind the callback to the selected provider. Check the authorization-response issuer when supported.
- Verify signature, issuer, audience/client ID, expiry, nonempty subject, nonce, and applicable `azp` rules. `go-oidc` does not validate nonce or authorized party for the application. If UserInfo is used, its subject must match the validated ID token.
- Identify the account by exact issuer and subject. Linking requires recent local authentication, a complete external login, a conflict check, and an atomic database write. An email match, including verified email, is not proof that accounts should be linked.
- Local logout revokes the Logice session. It does not claim to end the Pocket ID session or implement provider back-channel logout.

## Browser sessions and deployment

- Use random 256-bit opaque session tokens. Store only SHA-256 token hashes, user identity, authentication strength, and timestamps in PostgreSQL.
- Proposed limits: 24-hour idle expiry and 7-day absolute expiry, enforced server-side. Updating activity must not extend absolute expiry. Cleanup is storage maintenance, not the expiry check.
- Rotate sessions after complete authentication and privilege changes. Revoke them on logout and relevant credential/recovery changes. PostgreSQL failure must fail authentication closed.
- Use a `__Host-` cookie with Secure, HttpOnly, Path=/, no Domain, and an explicit SameSite=Lax policy for HTTPS deployment. Define any localhost-only development exception separately.
- Protect state-changing requests, including login, logout, enrollment, and account linking, with browser-bound CSRF tokens and exact Origin checks as applicable. Do not mutate on GET or rely only on SameSite. Do not enable wildcard credentialed CORS.
- Cloudflare Tunnel terminates public TLS. Keep the origin private and trust forwarded headers only from configured proxy addresses. Derive cookies, redirects, and WebAuthn configuration from the configured external URL.
- Keep browser sessions separate from project ingestion tokens. Redact passwords, session values, OIDC secrets/codes/verifiers, TOTP secrets, invitations, and recovery tokens from application, proxy, audit, and telemetry output.

## Required application acceptance tests

All checks below remain pending until the authentication implementation exists:

- Bootstrap races, repeated bootstrap, invitation expiry/replay, and unauthorized signup rejection.
- Successful and failed password login, generic errors, account/address throttling, bounded hashing work, and session rotation only after all factors pass.
- TOTP pending enrollment, wrong/out-of-window codes, same-code sequential and concurrent replay, factor removal/reset, and single-use recovery. Test external encryption-key recovery separately from database restore.
- Passkey registration/login with user verification; reject missing verification, wrong RP/origin, and expired/reused challenges. Persist credential updates and test synced-passkey counter behavior.
- Actual Pocket ID 2.18.0 login and existing linked-account login with exact callback, Basic client authentication, and S256. Use a new disposable instance and credentials; do not modify an existing operator identity provider.
- OIDC rejection of missing/wrong/replayed state and nonce, invalid signature/issuer/audience/authorized party/expiry, wrong verifier, reused codes, untrusted discovery destinations/redirects, and account-link conflicts. Matching email must not cause automatic linking.
- Session idle/absolute expiry, logout/revocation, CSRF failures, forwarded-header spoofing, database failures, and preservation of a usable recovery path.

## Sources

- [WebAuthn 0.18.2](https://github.com/go-webauthn/webauthn/releases/tag/v0.18.2)
- [go-oidc verifier 3.21.0](https://github.com/coreos/go-oidc/blob/v3.21.0/oidc/verify.go)
- [OAuth2 PKCE 0.37.0](https://github.com/golang/oauth2/blob/v0.37.0/pkce.go)
- [TOTP implementation 1.5.0](https://github.com/pquerna/otp/blob/v1.5.0/totp/totp.go)
- [Pocket ID discovery 2.18.0](https://github.com/pocket-id/pocket-id/blob/v2.18.0/backend/internal/controller/well_known_controller.go)
- [Pocket ID client authentication tests](https://github.com/pocket-id/pocket-id/blob/v2.18.0/backend/internal/oidc/token_handler_test.go)
- [Pocket ID virtual-authenticator test setup](https://github.com/pocket-id/pocket-id/blob/v2.18.0/tests/utils/passkey.util.ts)
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OAuth 2.0 security best current practice](https://datatracker.ietf.org/doc/html/rfc9700)
