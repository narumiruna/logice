# Temporary web layout validation

Run `./scripts/validate-web-layout.sh` with Node 26 and npm on Ubuntu.
The script uses GNU `timeout` with a 300-second limit for each check.

This is a test fixture, not a second production frontend manifest.
The fixture lockfile is the input to `npm ci`. All frontend dependencies
belong to the isolated `web/` directory. The script copies that directory
into a new `/tmp` project and removes the project on exit. It does not
change repository dependencies or install global packages. Install scripts
are disabled; this fixture does not need Husky.

Checks:

- Install from the fixture lockfile and audit all dependencies.
- Typecheck source, unit tests, Playwright tests, and configuration files.
- Run the colocated `web/src/layout.test.tsx` test with Vitest in Node.
  - Explicitly exclude `web/e2e` from Vitest.
  - Render Radix components and execute a TanStack Query function.
- Build the TSX, Radix CSS, and TanStack imports with Vite.
- Run `playwright test --list` with `web/playwright.config.ts` to collect
  `web/e2e/layout.spec.ts` and check Playwright module resolution.
- Assert that the temporary project has no root manifest, root
  `node_modules`, or downloaded browser directory.

No server starts. No browser is downloaded or launched. The Playwright test
is a collection sentinel, not a browser behavior test. No trace interface,
authentication flow, API, or production application is implemented. Browser
behavior, accessibility, and complete application integration remain untested.
The repository root npm migration remains future work.

Verified with Node v26.11.1 and npm 11.20.0:

- `npm ci`: `added 140 packages`.
- `npm audit --audit-level=low`: `found 0 vulnerabilities`.
- `tsc --noEmit`: exit 0, without `skipLibCheck`.
- Vitest: `Test Files  1 passed (1)`; `Tests  1 passed (1)`.
- Vite: `403 modules transformed`; build completed.
- Playwright: `Total: 1 test in 1 file`.
- Isolation assertions passed; the temporary directory was removed.

Vite reports `MODULE_LEVEL_DIRECTIVE` warnings for dependency `"use client"`
directives. These warnings are not suppressed. This is a client bundle;
React Server Components compatibility is not tested. TypeScript requires
`vite/client` types to resolve the Radix side-effect CSS import.

Exact direct pins are in `web/package.json`. npm confirmed TypeScript
`7.0.2` as current, Dialog `1.3.1` as latest, and React/ReactDOM types
`19.3.0` as current when this fixture was created. Audit results can change
when the advisory database changes.
