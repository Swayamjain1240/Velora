# Velora — Final Readiness Report (non-functional QA pass)

**Branch:** `test/non-functional-security-qa`
**Environment:** isolated non-production only (loopback API, disposable replica-set database, synthetic data, local fake provider).

## Merge readiness (branch → owner review)

**READY FOR OWNER REVIEW** once CI is green on this branch.

| Gate | Status |
| --- | --- |
| Server suite (unit + integration, replica set, concurrency 1) | **420/420 pass** in 9.2 min on a quiet machine (`npm test -w server`, exit 0) |
| New regressions added by this pass | `httpHardening.test.js` 5/5 · `invitationUniqueness.test.js` 3/3 |
| Client suite | **61/61 pass** |
| Client lint | clean |
| Client production build | clean (368.38 kB JS / 101.34 kB gzip, 13.47 kB CSS) |
| Security probes | **40 checks, 0 FAIL** (33 PASS · 6 NOTE · 1 BLOCKED) |
| Concurrency probes | **6 checks, 0 FAIL** (1 P3 NOTE: TOTP window reuse) |
| Load / stress / spike / soak | **0 5xx** in every phase, bounded run |
| Restore drill + reconciliation | **PASSED** |
| Browser journeys (accessibility + one-viewport) | **37/37 pass** |
| Production dependency audit | **0 vulnerabilities** |
| Secret scan (tree + 85-commit history) | 0 hits |
| GitHub Actions on this branch | **PENDING** — the local run proves the branch here; CI proves it on a clean runner (Docker replica set, fresh install, Playwright browsers). This is the remaining merge gate. |

**One flake observed, resolved:** during a contended run (browser stack running in parallel) `plans.test.js:798` "parallel approval cannot produce two current versions" failed once because the second parallel request was correctly treated as an **idempotent retry** (`200` with `idempotent: true`) instead of a `409`. Re-run alone: **24/24 pass**, and the full quiet suite: **420/420**. The test asserts strict concurrency; the application behaviour is as designed. Logged as D-12 (P3 test-stability), not as a product defect.

## Production readiness

**NOT PRODUCTION READY.** The application-level controls measured here are strong, but the production posture is unverified because no production-like environment exists yet.

### Blocking items (must be closed before any real use)

| # | Blocker | Why it blocks | Owner action |
| --- | --- | --- | --- |
| 1 | No deployment exists (no TLS edge, no reverse proxy, no hosting) | `Secure` cookie flag and HSTS are issued **only in production** (verified absent on plain HTTP); until a real HTTPS edge is exercised, those controls are unproven | Deploy behind TLS, set `TRUST_PROXY`/`PROXY_HOPS` deliberately, then re-run the security probes against the deployed origin |
| 2 | Production MongoDB posture unverified | only a local credential-less replica set was available; credentials, TLS and network boundary were never exercised (D-10) | Require auth + TLS on a private network and prove it with an auth-failure/refused-connection drill |
| 3 | No scheduled backup and no RPO/RTO decision | the restore drill proves the mechanics, not that a backup exists; data loss is unbounded | Choose backup cadence, provider and retention; run the drill against a real snapshot |
| 4 | Client shell has no CSP (D-7) | the API's CSP does not govern the SPA origin | Set a CSP at the hosting layer and verify on the deployed origin |
| 5 | No external provider selected (AI extraction, mail/notifications) | `EXTRACTION_PROVIDER=none` is the shipped default; any vendor requires disclosure and integration testing (control #22) | Complete the provider disclosure and decision; then test the real integration on a staging key |
| 6 | Clinical validation of AI output and language renderings | software tests cannot establish clinical accuracy; the fake provider was used | Commission a labelled clinical evaluation with clinician reviewers, separate from this QA evidence |
| 7 | Privacy/retention operational sign-off | deletion requests are evidence-only; retention holds are modelled, not legally reviewed | Privacy owner review of the retention/export/deletion model |
| 8 | Dev-toolchain advisories (D-5) | 6 advisories (2 critical) in `vitest`/`vite`/`tinypool`/`esbuild`; fixes are semver-major | Schedule the upgrade with a full suite + journey re-run |
| 9 | Observability gap (D-6) | no memory, event-loop, Mongo-pool, queue-depth or per-route latency metrics — an operator cannot see saturation or leaks coming | Expand the metrics surface before running anything under real traffic |
| 10 | No penetration test / external scanner run | this pass was defensive and scoped; a third-party test remains the standard for real-patient data | Commission an independent security assessment before handling real PHI |

### Non-blocking but recommended

- TOTP single-use replay memo (D-4, P3) — currently the RFC 6238 window is reused across sessions.
- Origin/Referer allowlist layer on mutations (D-8, P3) — the double-submit token plus `SameSite=Lax` already block the attack; the extra layer is defence in depth.
- Pin CI actions to commit SHAs (D-9, P3).
- Run the *entire* browser-journey suite (not only the accessibility/viewport subset) on this branch as part of the CI gate — CI already does this.
- Widen the soak from 60 s to hours on a dedicated box before any real pilot.

## What this pass does **not** claim

- No claim of **zero bugs**, **regulatory compliance** (HIPAA/GDPR/DISHA/MDR), **clinical validation** or **real-patient readiness**.
- No performance acceptance: there is no approved SLO, so all numbers are characterization on one developer machine.
- No production or production-like verification: every measurement was taken on an isolated local stack with synthetic data.

## Decision list still open (owner / clinical / privacy / provider)

1. Deployment target, TLS edge and cookie/HSTS verification.
2. Production database posture (auth, TLS, network, backup cadence, RPO/RTO).
3. AI extraction provider disclosure and clinical evaluation plan.
4. Notification/mail provider disclosure (invitations and reminders are in-app/console only today).
5. Privacy/retention operational sign-off, including deletion-request handling policy.
6. Dev-dependency upgrade window.
7. Observability expansion scope.
8. Independent penetration test before real PHI.
