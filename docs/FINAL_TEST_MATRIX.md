# Velora — Final Test Matrix

**Revision:** branch `test/complete-functional-qa` (base `036c27a`) · **Date:** 16 October 2026
Legend: **V** = VERIFIED (observed + passing evidence), **U** = IMPLEMENTED/UNVERIFIED, **P** = PARTIAL, **F** = FAILED→FIXED, **N/A** = not applicable.

## 1. Phase matrix

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 Static/config | syntax, lint, build, startup, env fail-closed, lockfile, routes, indexes, deps, middleware | V | report §2 rows 1–13 |
| 2 Unit/component | server unit suites + 61 React component tests | V | `npm test -w server/client` |
| 3 API/contract | 182-route inventory, anonymous sweep of 169 private routes, envelope, strict schemas | V | `apiContract.test.js` 6/6 |
| 4 MongoDB | transactions, revisions, uniqueness, append-only, tenant scope, indexes built | V | inside 412-test suite |
| 5 Functional A–P | per-module integration suites | V | test files per module (§3) |
| 6 Role/tenant matrix | 7 actors × 9 endpoints, admin writes, revocation | V | `accessMatrix.test.js` 3/3 |
| 7 E2E journeys | 66 journeys across 14 spec files | V | run 2: 64 pass + 2 resolved standalone |
| 8 One-viewport | 6 sizes × 5 sessions = 30 measurements ×3 runs | V | 30/30 ×3 |
| 9 Exploratory/regression | regression after each fix; exploratory charter | P | regression full green; offline/two-tab themes open (report §5) |

## 2. Role × endpoint matrix (observed, printed by `accessMatrix.test.js`)

| Actor | clinical reads (episode, documents, plans, preflight, patient) | dashboard | audit + retention | metrics |
|---|---|---|---|---|
| anonymous | 401 | 401 | 401 | 401 |
| assigned coordinator (creator) | **200** | **200** | 403 (no permission) | 200 (own/aggregate) |
| unassigned same-clinic | 404 (uniform, no existence leak) | 200 with **all counts 0** | 403 | 200 aggregates, no clinical rows |
| other-clinic coordinator | 404 | 200 with **0** | 403 | 200 aggregates, no clinical rows |
| clinic administrator | 403 (explicit) | 403 | **200** (holds these permissions) | 200 aggregates |
| deactivated membership | 403 | 403 | 403 | 403 |
| disabled account | 401 | 401 | 401 | 401 |
| patient (own records) | via `/api/patient/*` mirror, not these routes | 403 (own suite) | 403 | 403 (own suite) |

Admin clinical **writes** also verified: create episode 403, create/list patients 403, plan read 403, plan submit refused with plan state proven unchanged (`draft`).

## 3. Module → suite map (all inside the 412-test server run)

| Module | Suite file(s) |
|---|---|
| Auth/MFA/sessions/invites | `auth.test.js`, `unit/env.test.js` |
| Clinic & staff roles, eligibility | `staff.test.js`, `clinicSettings.test.js` |
| Patients/consent/assignments | `patients.test.js` |
| Caregiver grants/scopes | caregiver suites, `documents.test.js` scope denials |
| Episodes/corrections/team | `episodes.test.js` (+ `accessMatrix`) |
| Documents (validation, quarantine, download, reconcile) | `documents.test.js`, `resealKeys.test.js` |
| Care plans/review/approval | `plans.test.js` |
| Extraction/language (fake provider) | `extractions.test.js`, `languageVariants.test.js` |
| Schedules/tasks/DST | `schedules.test.js` |
| Check-ins/templates | `checkIns.test.js`, `checkInTemplates.test.js` |
| Clarifications | `clarifications.test.js` |
| Dashboard/notifications/metrics | `dashboard.test.js`, `reminders.test.js`, `metrics.test.js` |
| Closure | `closures.test.js`, `unit/closurePolicy.test.js` |
| Privacy/retention/audit | `retention.test.js`, `privacyRequests.test.js`, `audit.test.js` |
| Cross-cutting contract/matrix | `apiContract.test.js`, `accessMatrix.test.js` (new) |

## 4. Viewport matrix (Phase 8)

| Size | reviewer | admin | coordinator | patient | caregiver |
|---|---|---|---|---|---|
| 1440×900 | V | V | V | V | V |
| 768×1024 | V | V | V | V | V |
| 390×844 | V | V | V | V | V |
| 320×568 | V | V | V | V | V |
| 844×390 | V | V | V | V | V |
| 320×400 | V | V | V | V | V |

Assertions: no page-level vertical scroll (±2 px tolerance), no `overflow:hidden` clipping, sign-out control reachable on every route of each session's set.
