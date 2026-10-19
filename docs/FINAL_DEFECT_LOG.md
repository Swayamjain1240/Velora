# Velora — Final Defect Log (functional QA pass, 16 October 2026)

Branch `test/complete-functional-qa`, base `036c27a`. Severities per P0–P3 definitions.

---

## QA-001 — CI "fails closed" step can never run its journey · **P2** · FIXED

- **Requirement:** control #20/#23, VEL-008 shipped default (`EXTRACTION_PROVIDER=none`) must fail closed and be proven in CI.
- **Preconditions:** CI e2e job (job env `EXTRACTION_PROVIDER: fake`), final step "Extraction fails closed with no provider enabled".
- **Reproduction:** `EXTRACTION_PROVIDER=fake npx playwright test e2e/extractions.spec.js -g "no provider enabled"` → `1 skipped` (the test skips itself when the runner sees `fake`; the step has no env override, so it always inherited `fake`).
- **Expected:** the step asserts the shipped fail-closed default.
- **Actual:** the step reported green while skipping its only test — a vacuous pass.
- **Evidence:** local reproduction (skip observed) + command log in the QA report.
- **Root cause:** journey's self-skip keyed to the runner env; step never overrode it.
- **Fix:** `.github/workflows/ci.yml` — `EXTRACTION_PROVIDER=none npx playwright test …` with an explanatory comment.
- **Retest:** under `fake` the journey still self-skips (guard intact); with API `none` + runner `none` the journey **passes** (4.7 s). Workflow YAML re-parsed (4 jobs).
- **Regression:** workflow-only change; full suites unaffected. CI run on push is the final gate.
- **Commit:** this branch's CI-fix commit.

## QA-002 — `apiContract.test.js` inherited sibling-suite DB rows · **P3** · FIXED

- **Requirement:** a "nothing was written" count assertion must own its baseline.
- **Reproduction:** run `apiContract.test.js` after `accessMatrix.test.js` in one invocation → the unauthenticated-mutation test counted 1 leftover patient and failed despite the 401 refusal.
- **Actual:** test failed for isolation reasons, not product behavior.
- **Fix:** `beforeEach` `resetDb()` added to the suite (test-owned data only).
- **Retest:** 6/6 green solo and inside the full 412-test run.

## QA-003 — first access-matrix draft asserted against requirement evidence · **P3** · FIXED (test-harness)

- **Requirement:** matrix expectations must cite requirement evidence, not assumptions.
- **Actual:** draft asserted denials for dashboard/metrics surfaces whose requirement is *scoped-empty 200*; used a non-existent roster field; revoked the last assignment (guard: 409).
- **Fix:** every cell rebuilt from suite-cited evidence (dashboard suite, metrics suite, `SYSTEM_ROLES`); roster field corrected; revocation scenario now mirrors the documented second-assignee flow.
- **Retest:** 3/3 green; product code unchanged — the product met every corrected expectation as specified.

## OBS-001 — transient login redirect during first E2E run · **P3 (observation, OPEN)**

- **Observed:** in the first full E2E run (against an externally-started API with no `EXTRACTION_PROVIDER`), 8 viewport tests failed with the app bounced to the login page mid-run.
- **Triage:** not reproduced in three subsequent executions on the CI topology (90/90 viewport tests green). Most consistent with a contended/misconfigured stack rather than product auth, but the trigger was not conclusively isolated.
- **Related evidence (19 October, UI wrap-up pass):** a *different* member of the same family was isolated and measured. Against a `development` API the coarse limiter answers **429 after 300 req/min** (87 × 429 out of 320 concurrent requests in 597 ms), and a full browser suite run in that topology failed 4 tests — three snapshots show the designed 429 retry state ("Velora is temporarily unreachable"). All four pass unchanged against `NODE_ENV=test`, where the limiter is skipped (verified by the absence of a `RateLimit` header). This closes the status-check failure mode for the suite, but OBS-001's original symptom — a bounce to the **login** page — follows the 401/403 path (`AuthContext` signs out only on 401/403), so it is *not* claimed closed here.
- **Action:** re-check if it recurs on CI; no product change made on this evidence.

---

**No P0 or P1 product defects were found in this pass.** This states what the suite observed; it is not a claim of zero bugs.

---

# Non-functional QA pass — 17 October 2026 (branch `test/non-functional-security-qa`)

## Fixed and retested in this pass

### NQ-1 — An oversized or malformed request body answered `500`

| Field | Detail |
| --- | --- |
| Category | Security / reliability (error handling) |
| Severity | **P2** (P1 within an outage: the log fills with false crash signals and the caller gets an unactionable response) |
| Requirement | SECURITY-25 #8 (bounded resources), #9 (safe errors), #12 (debug off) |
| Environment | isolated test API, synthetic data |
| Reproduction | `POST /api/auth/login` with a 2 MB JSON body (or `{"email": ` malformed) → `500 INTERNAL_ERROR` |
| Measurement / evidence | `qa/security-probes.js` SEC-19: `2MB JSON body -> 500`; server log line `request.unhandled_error`; also reproduced with a truncated JSON body |
| Expected | `413 PAYLOAD_TOO_LARGE` for an oversized body, `400 BAD_REQUEST` for malformed JSON, with a fixed, non-echoing message |
| Actual | `500` with a development-only message derived from the parser error |
| Root cause | `errorHandler` only recognised `AppError`, duplicate-key and Mongoose errors; body-parser failures (`entity.too.large`, `entity.parse.failed`, `encoding.unsupported`, `charset.unsupported`, `request.aborted`) fell through to the generic 500 branch, and `http-errors` marked `expose:true` was ignored |
| Fix | `server/src/middleware/errorHandler.js`: `BODY_PARSE_ERRORS` map + `isBodyParseError()`; a 4xx branch honouring `expose === true`; a `warn` log line `request.body_rejected` (no stack, no echo) |
| Retest | live: SEC-19 `413`; new integration tests `server/tests/integration/httpHardening.test.js` (5/5 pass, including malformed JSON → 400 and unsupported charset → 415) |
| Residual risk | none identified; the mapping is by stable `err.type`, so a future parser error name falls back to the previous behaviour |
| Commit | `e617abc` — `fix(server): answer a bad body as a client error and never cache an API response` |

### NQ-2 — Authenticated JSON responses could be cached

| Field | Detail |
| --- | --- |
| Category | Security / privacy (cache control) |
| Severity | **P2** (clinical list data retained by a browser or shared cache is a disclosure path) |
| Requirement | SECURITY-25 #9, #15; Part 3 privacy "no clinical data in caches" |
| Environment | isolated test API |
| Reproduction | `GET /api/patients?page=1&limit=1` with a valid session → response carried **no** `Cache-Control` header |
| Measurement / evidence | `qa/security-probes.js` SEC-25: `cache-control=undefined` on an authenticated list read, while `/api/health` and several controllers did set `no-store` |
| Expected | every API response is `no-store` by default, with a controller free to set a stronger value |
| Actual | the header was applied controller-by-controller; `patientController` (and others) omitted it, so a list response was cacheable |
| Root cause | no default cache policy in the shared middleware chain; the policy lived in per-controller helpers such as `noStore(res)` |
| Fix | `server/src/middleware/security.js`: `securityHeaders()` now wraps helmet and sets `Cache-Control: no-store, private` unless a controller already set `Cache-Control` |
| Retest | live SEC-25: `cache-control=no-store, private`; new integration tests in `httpHardening.test.js` assert the default on both an unauthenticated and an authentication-path response (5/5 pass) |
| Residual risk | a future response that deliberately wants caching must set the header explicitly — intended behaviour |
| Commit | `e617abc` — same commit as NQ-1 (both are response-layer hardening in the shared middleware chain) |

### NQ-3 — Parallel invitations for one email created several live tokens

| Field | Detail |
| --- | --- |
| Category | Security / integrity (duplicate state, race) |
| Severity | **P2** (each extra token is a live credential for that address; a confused operator sees several valid invites) |
| Requirement | SECURITY-25 #6 (validate input), #23 (test every path); Part 1 invitation single-use design |
| Environment | isolated test API, synthetic clinic |
| Reproduction | 8 parallel `POST /api/staff/invitations` for the same email (`qa/concurrency-probes.js` CON-1) |
| Measurement / evidence | before fix: `{"201":8}` and `Invitation.countDocuments({email, acceptedAt:null, revokedAt:null}) === 8`; the persisted duplicates also **blocked the new unique index build** (`E11000 ... index: clinic_1_email_1`) — a deployment-relevant consequence |
| Expected | exactly one active invitation per clinic+email; the other calls answered `409 CONFLICT`; accepting or revoking frees the address for a new invite |
| Actual | unlimited active invitations; no uniqueness constraint existed, and the service did not even check for a pending invitation |
| Root cause | `staffService.createInvitation` only rejected an existing clinic member; the invitation model had no unique constraint on a live `(clinic, email)` pair, so concurrent requests all inserted |
| Fix | (1) `Invitation.js`: partial **unique** index on `(clinic, email)` where `acceptedAt: null, revokedAt: null` (equality-to-null, so the row leaves the index once accepted/revoked); (2) `staffService.createInvitation`: explicit pending-invitation check → `409` with a clear message; (3) `server/scripts/dedupe-invitations.js` (dry-run default, `--apply --operator` required, revokes older duplicates without deleting rows) to clear pre-existing duplicates before the index can build |
| Retest | live CON-1: `{"201":1,"409":7}`, active invitations = 1; new integration tests `server/tests/integration/invitationUniqueness.test.js` (3/3 pass: sequential duplicate refused, parallel race leaves one token, revoke-then-reinvite works); the dedupe command was exercised on the disposable DB (dry run → apply 7 revocations → clean dry run) |
| Residual risk | a deployment running the old code must run `dedupe-invitations.js --apply` **before** the index build, otherwise Mongoose's index creation fails loudly (fail-closed, not silent). Recorded in the runbook-facing notes. |
| Commit | `68e3e2f` — `fix(server): keep only one active invitation per clinic and email` |

---

## Open findings (not fixed in this pass)

| ID | Category | Severity | Finding | Evidence | Why it was not fixed | Owner decision / recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| D-4 | Security — MFA | **P3** | A TOTP code is accepted more than once inside its 30 s window (two separate pending sessions, same code) | `qa/concurrency-probes.js` CON-4: `first=200, replay=200` | RFC 6238 defines a time-window token, not a nonce; adding a single-use step memo touches the shared verification path used by several suites and changes documented behaviour | Implement a per-user `lastAcceptedStep` conditional update (NIST 800-63B preference) or explicitly accept the window semantics in the product policy |
| D-5 | Supply chain | **P2 (dev only)** | 6 advisories in the dev toolchain: `tinypool` (critical), `vitest` (critical), `vite` (high), `esbuild`, `vite-node`, `@vitest/mocker` (moderate) | `npm audit --json` (see the security audit §4) | Every fix requires a **semver-major** jump (`vite@8`, `vitest@5`); the project rule is to review compatibility and changelogs instead of forcing an upgrade inside a QA pass | Schedule the upgrade as its own change and re-run server/client suites, browser journeys and the QA probes |
| D-6 | Observability | **P3** | `/api/metrics` exposes no process memory, event-loop delay, Mongo pool state, queue depth or per-route latency histogram | `qa/perf-load.js` had to sample RSS/CPU from the OS and proxy event-loop health with a 1 Hz health round-trip | Adding in-process gauges is a feature change with its own tests | Add a metrics expansion ticket; until then operators cannot see saturation coming |
| D-7 | Security — headers | **P2 (deployment)** | The client shell (Vite dev server / static host) serves no CSP header and `client/index.html` has no CSP meta | `qa/security-probes.js` SEC-26 (client origin not part of the test API) + source review | The API's CSP does not govern the SPA's own origin; the correct place is the hosting layer, which does not exist in this repo | Set `default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'` at the hosting layer and re-verify in a deployed environment |
| D-8 | Security — CSRF depth | **P3** | No Origin/Referer allowlist layer on cookie-authenticated mutations; a foreign `Origin` with a valid token proceeds to validation | SEC-29: `400` (validation) rather than `403` | The double-submit token bound to the server-side session is already enforced (SEC-28 `403`), and a cross-site attacker cannot read the cookie (same-origin policy). Adding an Origin check risks breaking non-browser clients and needs suite-wide threading | Add the check deliberately, with tests, if defence-in-depth is required |
| D-9 | Supply chain | **P3** | CI actions are pinned to major tags (`@v4`, `@v2`), not commit SHAs | `.github/workflows/ci.yml` review | Tag pinning is standard practice; SHA pinning is a hardening step | Pin to SHAs once the workflow is stable |
| D-10 | Security — infrastructure | **P1 (deployment)** | MongoDB authentication, TLS and network boundary were never exercised (only a local disposable replica set with no credentials) | environment inspection | No production-like MongoDB was available in this controlled non-production pass | Production DB must require auth + TLS on a private network; verify with a connection-refused/auth-failure drill before go-live |
| D-11 | Documentation | **P3** | `README.md` metrics/observability description now names the three new tests and the invitation-dedupe step | README sync in this pass | fixed as part of the docs commit | — |
| D-12 | Test stability | **P3** | `plans.test.js:798` ("parallel approval cannot produce two current versions") failed **once** during a contended full-suite run: the second parallel approval was answered as an **idempotent retry** (`200`, `idempotent: true`) instead of `409` | contended full run log; the assertion expects `[200, 409]` and got `[200, 200]`; re-run alone 24/24 pass; full quiet suite 420/420 | The application behaviour matches its documented idempotent-retry design; only the assertion assumes the two requests are strictly concurrent | Give the test a start barrier (or accept the idempotent outcome) so it tests concurrency deliberately instead of depending on scheduling |

---

## Defects deliberately NOT chased (with reason)

- **`GET /api/plans` returned 0 items for an episode whose plan the same session had just created** (observed while wiring the extraction-job timing). Plan listing is a functional surface already walked by the previous functional QA pass and by `plans.test.js`; the perf driver does not depend on it. Recorded here as an observation for the functional backlog rather than re-litigated in a non-functional pass.
- **Post-load `p95` degradation to ~570 ms at C=40** — a property of a single-process deployment, not a defect. Recorded in the performance report as a scaling limit.
- **`qa/security-probes.js` SEC-12** returns NOTE when the first episode has no documents; the download-IDOR assertion is covered by SEC-22b (owner 200 vs foreign 404) and by `documents.test.js`.


---

# Completion pass — 18 October 2026 (branch `feat/ui-redesign-dark-purple`)

Every open finding above was re-examined. Fixes below are code changes with a
regression test; the full suites were re-run afterwards (server 424 tests, client
77 tests, 76 browser journeys plus the provider-disabled journey).

## D-4 — TOTP replay · **P3** · FIXED

- **Finding:** the same six-digit code authenticated two separate pending sessions
  inside its 30 s window.
- **Fix:** `mfaService.verifyTotp` validates the code, derives the counter step it
  belongs to, and claims it with one conditional update on the user
  (`mfa.lastTotpStep: { $lt: step }`). Only one caller can move the step forward.
  Enrollment confirmation passes `consume: false`: MFA is not enabled yet, so a
  code replayed there authenticates nobody, and the code the user just typed must
  still work for the first sign-in.
- **Retest:** `auth.test.js` — "a TOTP code cannot authenticate two sessions, and
  the next code still works" (first 200, replay 403, next step 200). The re-seal
  test now verifies the same code deliberately with `consume: false`, because it
  tests key rotation, not authentication.
- **Residual:** a user who enrolls and signs in on a second device within the same
  30 s window uses a fresh code from the authenticator; that is standard TOTP
  behaviour.

## D-5 — dev-toolchain advisories · **P2 (dev only)** · FIXED

- **Fix:** Vite 8.3.4, Vitest 5.0.5, `@vitejs/plugin-react` 6.1.2, jsdom 30.1.3.
  `npm audit` now reports **0 vulnerabilities** (was 6, including two critical in
  `tinypool`).
- **Retest:** client 77/77, lint clean, production build clean, full browser suite
  against the Vite 8 dev server.

## D-6 — metrics had no process visibility · **P3** · FIXED

- **Fix:** `server/src/services/processMetrics.js` adds a bounded collector:
  process uptime/RSS/heap/CPU, event-loop mean/p95/p99/max, Mongo readyState and
  pool counters, and per-route latency (count, average, approximate p95, max,
  5xx count) in a fixed 60-route map keyed by the route PATTERN. `/api/metrics`
  returns it as `runtime`, beside (never inside) the workflow metrics.
- **Retest:** `metrics.test.js` — shape, `mongo.state`, a `GET /api/patients/:patientId`
  pattern label, no concrete identifier anywhere in the payload, and the same
  permission gate as the metrics themselves.

## D-7 — no CSP for the client shell · **P2 (deployment)** · FIXED

- **Fix:** `client/vite.config.js` injects `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; …` as a meta tag at build time and disables
  Vite's inline module-preload polyfill, so the built shell contains **no inline
  script**. Dev and preview servers send an equivalent header that also allows the
  HMR websocket and the React refresh preamble.
- **Retest:** `dist/index.html` inspected (meta present, one external module
  script); the dev server answers with the header; production preview rendered the
  app with no CSP violation.

## D-8 — no Origin/Referer allowlist · **P3** · FIXED

- **Fix:** `originProtection` middleware runs after session resolution and before
  the double-submit check on cookie-authenticated mutations. A present Origin (or
  Referer when Origin is absent) must equal `CLIENT_ORIGIN`; otherwise 403.
  Requests with neither header carry no ambient browser authority and continue to
  the token check.
- **Retest:** `auth.test.js` — foreign Origin 403, foreign Referer 403, configured
  Origin 201, same-origin Referer 201.

## D-12 — scheduling-dependent concurrency assertion · **P3** · FIXED

- **Fix:** the test now asserts what the product guarantees — exactly one approved
  current version and exactly one `approved` event — and allows the second
  response to be the documented idempotent retry (`200`) or a stale conflict
  (`409`). It is no longer a coin flip on which request wins.
- **Retest:** suite green, including a contended full run.

## Perf observation — "GET /api/plans returned 0 items" · **not reproducible**

A new test mirrors the perf driver exactly (empty draft `POST`, then
`GET …/plans?page=1&limit=1`) and passes with one item whose id equals the created
plan. The observation is recorded as environment contention, not a product defect.

## Still open

`D-9` (pin CI actions to SHAs), `D-10` (production MongoDB auth/TLS drill) and the
UI-level items in [UI_KNOWN_LIMITATIONS.md](UI_KNOWN_LIMITATIONS.md) (full stage-3
structural pass, dialog/toast/tooltip primitives, Firefox/WebKit, real-device 3D,
screen-reader walkthrough, i18n).
