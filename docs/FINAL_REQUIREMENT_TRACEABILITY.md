# Velora — Requirement Traceability (QA pass, 16 October 2026)

Revision: branch `test/complete-functional-qa` (base `036c27a`). Status per Duck vocabulary. Evidence = suite/command names; full commands in [FINAL_FUNCTIONAL_QA_REPORT.md](FINAL_FUNCTIONAL_QA_REPORT.md).

## 1. VEL requirements

| ID | Area | Status | Primary evidence |
|---|---|---|---|
| VEL-001 | Accounts, Argon2id, sessions, MFA, invites/resets | VERIFIED | `auth.test.js`, e2e `auth.spec.js`, env-fail probe |
| VEL-002 | Clinic roles & permissions | VERIFIED | `staff.test.js`, `accessMatrix` role rows |
| VEL-003 | Recovery episodes + care team | VERIFIED | `episodes.test.js`, revocation test |
| VEL-004 | Private validated encrypted documents | VERIFIED | `documents.test.js`, quarantine journey, byte-for-byte e2e |
| VEL-005 | Manual source-linked care plans | VERIFIED | `plans.test.js`, plan e2e journeys |
| VEL-006 | Clinical review/approval (verified reviewer only) | VERIFIED | `plans.test.js` eligibility + concurrent-approval tests, admin-refusal tests |
| VEL-007 | Patient/caregiver scoped views | VERIFIED | patient/caregiver suites + e2e patient reads |
| VEL-008 | AI extraction (provider-neutral, never decides, fail-closed default) | VERIFIED | `extractions.test.js`, e2e extraction journey, fail-closed journey (fixed CI gate QA-001) |
| VEL-009 | Reviewed Hindi/English language variants | VERIFIED | `languageVariants.test.js` |
| VEL-010 | Immutable approved plan versions | VERIFIED | `plans.test.js` supersession/pointer tests |
| VEL-011 | Granular caregiver scopes (inert until honoured) | VERIFIED | caregiver scope tests; honoured-scope constant matches code |
| VEL-012 | Approved-version medication schedules + timezone/DST | VERIFIED | `schedules.test.js`, `zonedTime` units |
| VEL-013 | Daily recovery tasks + append-only logs | VERIFIED | `schedules.test.js`, activity-log suites |
| VEL-014 | Notifications (dedup, bounded retry, in-app default) | VERIFIED | `reminders.test.js`, dashboard failed-delivery test |
| VEL-015 | Clinic-defined check-ins (template versions) | VERIFIED | `checkIns.test.js`, `checkInTemplates.test.js` |
| VEL-016 | Clarification queue with clinical/operational authority | VERIFIED | `clarifications.test.js` (incl. admin refusal) |
| VEL-017 | Assigned-team dashboard + one-viewport invariant | VERIFIED | `dashboard.test.js`, viewport 30/30 ×3 |
| VEL-018 | Prescribed follow-ups | VERIFIED | `followUps.test.js` (incl. admin refusal) |
| VEL-019 | Operational closure/reopen, read-only history | VERIFIED | `closures.test.js`, `closurePolicy` units |
| VEL-020 | Privacy requests, audit, export/deletion, retention | VERIFIED | `privacyRequests.test.js`, `retention.test.js`, `audit.test.js` |
| VEL-021 | Workflow metrics without clinical claims | VERIFIED | `metrics.test.js` (admin 200, patient 403, `notAMeasureOf` assertions) |

## 2. Parts 1–10

All ten parts: **VERIFIED** for their implemented scope by their suites above; Part 10 operational gates additionally by startup/ready probes, dependency-outage 503 tests, re-seal and reconciliation suites, and the CI restore drill. Known not-done items remain those the readiness report lists by design (deployment, real providers, backups, clinical validation).

## 3. Roles × workflow states

- Roles: anonymous, patient, caregiver (each scope), coordinator, verified reviewer, unverified reviewer, admin, inactive member, disabled account, assigned/unassigned, same/other clinic — matrix in [FINAL_TEST_MATRIX.md](FINAL_TEST_MATRIX.md) §2.
- Workflow states: episode draft/closed, plan draft→in_review→needs_clarification→approved→superseded, extraction job queued/running/needs_review/completed/failed, document uploading/ready/quarantined/rejected, privacy request open→verified→assigned→decided→executed, retention dry-run/apply, queue item claimed/released — each transition covered by its suite's state-machine tests.

## 4. Security-25

| # | Control | Status | Evidence |
|---|---|---|---|
| 1 | Secrets hidden | VERIFIED | no `.env` tracked; redacting logger; envelope tests |
| 2 | Required env validated, fail-closed | VERIFIED | startup probe exit 1, key-only message; `env.test.js` |
| 3 | Private routes protected | VERIFIED | `apiContract`: all 169 private routes refuse anonymous with 401 |
| 4 | Secure auth architecture | VERIFIED | cookie sessions + CSRF double-submit + session-bound secret (`csrf.js`, auth suites) |
| 5 | Server-side access control (default deny) | VERIFIED | `accessMatrix` + per-surface denials; clinic from own membership only |
| 6 | Inputs validated/sanitized | VERIFIED | strict zod schemas; unknown-field + injection tests |
| 7 | XSS prevented | VERIFIED | React escaping + strict CSP header observed live |
| 8 | Rate limits appropriate | VERIFIED | per-route Mongo buckets; abuse-sensitive limits in auth routes; unit-keyed |
| 9 | Errors safe and consistent | VERIFIED | envelope asserted across sweeps; 5xx generic in production (`errorHandler`) |
| 10 | CORS allowlist exact | VERIFIED | `corsPolicy()` exact origin, credentialed, no wildcard |
| 11 | Security headers | VERIFIED | CSP/COOP/CORP/nosniff/referrer/frame observed live; HSTS production-only by design |
| 12 | Production debug off | VERIFIED | prod-generic 5xx path in `errorHandler`; stack kept server-side |
| 13 | Dependencies reviewed | VERIFIED | `npm audit --omit=dev` 0 vulnerabilities; dev advisories disclosed in README |
| 14 | Unused packages removed | VERIFIED | inventory: 0 unused runtime/dev deps in both workspaces |
| 15 | Private/exposed files checked | VERIFIED | `.env` untracked; storage root validated outside repo |
| 16 | Mongo credentials secure | VERIFIED | URI only in untracked env; test harness derives its own |
| 17 | Argon2id/bcrypt | VERIFIED | `@node-rs/argon2` in `passwordService` |
| 18 | Git tree/history secret scan | VERIFIED (CI) | gitleaks job on every push (not runnable locally) |
| 19 | Security audit completed | VERIFIED (CI + local) | `security` job + local `npm audit` |
| 20 | Test→diff→commit→push discipline | VERIFIED | this branch: tests first, evidence, focused commits |
| 21 | Security continuous | VERIFIED | CI on push/PR; suites include denial tests |
| 22 | External APIs disclosed before use | VERIFIED | provider register; shipped default `none`; zero network calls in tests |
| 23 | Every feature tested | PARTIAL | all modules have suites + journeys; exploratory charter gaps (report §5) |
| 24 | Documentation synchronized | VERIFIED | report/matrix/defect log/traceability/duck log/README count updated |
| 25 | Every authenticated screen fits one viewport | VERIFIED | 30/30 measurements ×3 runs across six sizes |
