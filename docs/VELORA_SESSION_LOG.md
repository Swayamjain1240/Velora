# Velora MERN - Session Log

Append-only record of Duck reviews and session outcomes. Newest entry first.
Evidence classes: `VERIFIED`, `IMPLEMENTED / UNVERIFIED`, `PARTIAL`, `PLANNED`, `DRIFT`, `BLOCKED`.

---

## Session - 11 October 2026 - Part 3 (recovery episodes and care-team assignment)

### Duck review (start of session)

**Files read:** the authority PDFs, `VELORA_MERN_10_BUILD_PROMPTS.md`, `README.md`, the `docs/` set,
`.env.example`, and the full `server/`/`client/`/`e2e/` trees.

**Observed repository state:** Parts 1-2 committed and pushed (`dcc63d9`) with the full suite green.
No `RecoveryEpisode`, `CareTeamAssignment` or `EpisodeCorrection` model, route, service or screen
existed. **Classification on entry:** Parts 1-2 `VERIFIED`; Part 3 `PLANNED`.

### Work performed (Part 3)

| Area | Result |
|---|---|
| Models | `RecoveryEpisode` (immutable clinic/patient/reference, draft state, calendar discharge date + IANA timezone, `revision`), `CareTeamAssignment` (intervals, `care_coordinator`/`clinical_reviewer`), `EpisodeCorrection` (append-only) |
| Indexes | unique `(clinic,reference)`; partial unique `(clinic,episode,memberUser)` where `status='active'` |
| Service | `episodeService`: assigned-staff creation, scoped paginated list/detail, atomic draft correction, correction history, eligible candidates, team list/assign/revoke, patient-owned list/detail |
| Access | clinical metadata for active team members or the patient owner; admin explicitly 403; other staff uniform 404; admin may administer the team without clinical fields |
| Client | `features/episodes/{EpisodeList,EpisodeDetail}` (stepped wizard, correction with revision, paginated corrections, team panel) and `features/patient/PatientEpisodes`; staff/patient nav entries |
| Tests | `tests/integration/episodes.test.js` (18) + client `episodes.test.jsx` (3) + the `patients.spec.js` journey extended with episode creation and correction |
| Docs | README, `VELORA_MASTER`, `VELORA_ARCHITECTURE`, `VELORA_STRUCTURE`, `VELORA_SYSTEM_DESIGN` synced |

### Key invariants enforced

- Episode creation requires an ACTIVE **intake** assignment on the patient (clinic role alone is not
  enough) and records the creator as the first care coordinator - there is never an unaccounted
  episode.
- Corrections use `{_id, revision, status:'draft'}`; a stale revision is a 409 and a no-op records no
  history.
- The last active team assignment can never be revoked (409); reassignment opens a new interval and
  keeps every prior one.
- A clinical reviewer can only be assigned while eligibility is currently `verified`.
- Administrators can administer the team but can never read episode clinical metadata.

### Evidence

| Check | Command | Result |
|---|---|---|
| Server tests | `npm test -w server` | **73 pass / 0 fail** (unit + integration on the replica set) |
| Client tests | `npm test -w client` | **12 pass / 0 fail** |
| Client lint | `npm run lint -w client` | clean |
| Client build | `npm run build -w client` | production build succeeds |
| Browser journeys | `npx playwright test` | **17 pass / 0 fail** (episode journey + six viewports on `/app/episodes`) |
| Production audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Secret scan (tree + history) | `git grep` / `git log -p --all` | no real credentials; only `.env.example` tracked |

Viewports asserted: `1440x900`, `768x1024`, `390x844`, `320x568`, `844x390`, `320x400`.

### Security-25 matrix (Part 3)

| # | Control | Status | Evidence |
|---:|---|---|---|
| 1 | Secrets hidden | VERIFIED | no new secret; `.env` untracked |
| 2 | Fail-closed env | VERIFIED | unchanged; env loads locally |
| 3 | Private routes guarded | VERIFIED | episode routes behind requireAuth + clinic context |
| 4 | Argon2id, MFA, sessions, CSRF preserved | VERIFIED | Parts 1-2 tests green |
| 5 | Clinic + role + ownership + episode assignment + state, default deny | VERIFIED | clinic-isolation, unassigned-staff, intake-vs-episode, admin-denial tests |
| 6 | Validate/sanitize, reject unknown fields | VERIFIED | strict schemas; unknown-field test |
| 7 | No unsafe HTML/XSS | VERIFIED | JSON-only responses; client escapes on render |
| 8 | Atomic limits | VERIFIED | Mongo-backed episode create/read/mutate limits |
| 9 | Safe error envelope + scoped 404 | VERIFIED | uniform 404 for non-team staff; 409 conflict envelope |
| 10 | Exact CORS allowlist | VERIFIED | unchanged |
| 11 | Helmet + CSP | VERIFIED | unchanged |
| 12 | Debug off in production | VERIFIED | unchanged |
| 13 | Dependency security | VERIFIED | `npm audit --omit=dev` = 0; no new dependency |
| 14 | No unused packages | VERIFIED | no new dependency |
| 15 | Private-file audit | VERIFIED | unchanged |
| 16 | `MONGODB_URI` server-only | VERIFIED | unchanged |
| 17 | Argon2id only | VERIFIED | unchanged |
| 18 | Tree + history scan | VERIFIED | clean |
| 19 | End-of-part audit | VERIFIED | this matrix |
| 20 | Coherent ~300-LOC commits | VERIFIED | server / client / test+docs commits |
| 21 | Continuous security | VERIFIED | immutable identity, partial unique index, atomic filter |
| 22 | Disclose external providers | VERIFIED | none added |
| 23 | Test every failure/concurrency path | VERIFIED | stale revision, concurrent corrections, parallel assignment, last-assignee |
| 24 | Docs synced | VERIFIED | this session |
| 25 | One-viewport screens | VERIFIED | 17 journeys incl. `/app/episodes` at six sizes |

### Duck verdict: PASS (Part 3, local scope)

All 25 controls are VERIFIED for the Parts 1-3 scope with the full suites, the production audit and
both secret scans green. Evidence is local (development); no production deployment or clinical
validation is claimed. Part 4 was not started.

### Remaining limits

- Episodes stay `draft`; activation/closure and downstream plan workflows arrive in later parts.
- No caregiver episode view yet (`view_episodes` remains inert).
- Discharge dates are corrected one episode at a time; no bulk import.

---

## Session - 11 October 2026 - Part 2 (patient onboarding, consent, caregiver access)

### Duck review (start of session)

**Files read:** the three authority PDFs, `VELORA_MERN_10_BUILD_PROMPTS.md`, `README.md`,
`docs/VELORA_*.md`, `.env.example`, `.gitignore`, the entire `server/`, `client/` and `e2e/` trees.

**Observed repository state:** branch `main`. Parts 1-2 code was present on disk but **uncommitted
and failing**: the Part 2 integration test file did not even parse (an unclosed block), 8 of 18
Patient tests failed, and the Part 2 client UI, e2e journeys and documentation were absent.

**Classification on entry:** Part 1 `VERIFIED`; Part 2 `PARTIAL` (server service layer only, no UI,
no docs, failing tests). Fixing verified in-scope drift was required before extension.

### Defects found and fixed (Part 2)

| # | Defect | Root cause | Fix |
|---:|---|---|---|
| 1 | Integration suite would not load | `patients.test.js` missing a closing `});` on the concurrency test | Restored the block |
| 2 | Orders of tests failed with `429` then `undefined` CSRF | An in-process `express-rate-limit` (300/min) accumulated across one suite run | Skip the coarse global limiter under `NODE_ENV=test`; the durable Mongo-backed per-route limits stay active |
| 3 | Assignment ids were `undefined` in responses | `publicAssignment`/`publicPatient`/`publicGrant` read `.id`, which does not exist on `.lean()` results | Map from `_id` (works for both hydrated and lean) |
| 4 | `listEligibleAssignees` returned `undefined` ids | Same `.id` on lean bug | Same fix |
| 5 | Removed-self test could not re-list | The coordinator revoked their own interval; by design they lose access | Test lists via the still-assigned reviewer |
| 6 | Test used `login.user` before MFA promotion | `login.user` is only set after MFA | Read the email from `/auth/me` |
| 7 | e2e patient creation denied (403) | The seed only wrote the role catalog for a NEW clinic, so an existing synthetic clinic kept Part 1 permissions | Seed now **upserts/refreshes** all system roles every run |
| 8 | e2e create failed with a transaction error | Local dev Mongo was a standalone; Part 2 writes are transactional | Point local dev/e2e at the replica set (`.env`, global-setup reads `.env`) |
| 9 | `global .env` PORT ignored under an exported `PORT=0` | `pick()` returned the literal `'0'` | Treat empty/`'0'` as absent |

### Work performed (Part 2 completion)

| Area | Result |
|---|---|
| Server | `PatientProfile`, `PatientAssignment` (intake), `PatientConsent`, `CaregiverGrant`, `AccessInvitation`; `patientService`, `consentService`, `caregiverService`, `txService`; patients/patient-self/caregiver/access routes; strict schemas |
| Access model | Uniform 404 for out-of-scope patients; staff need an ACTIVE intake assignment; patient ownership; caregiver grant scope; last-assignee 409; append-only consent; activation gated on consent + assignee |
| Client | `features/patients/{PatientList,PatientDetail}`, `features/patient/PatientSelf`, `features/caregiver/CaregiverHome`; stepped creation wizard, tabbed detail, paginated consent/patients; role-scoped nav; denied refresh clears loaded data |
| Tests | `tests/integration/patients.test.js` (18) + client `patients.test.jsx` (3) + `e2e/patients.spec.js` (1) |
| Docs | README, `VELORA_MASTER`, `VELORA_ARCHITECTURE`, `VELORA_STRUCTURE`, `VELORA_SYSTEM_DESIGN` synced |
| Env | `.env.example` corrected (replica-set URIs, test-rs variables, no `[TEMPLATE]` marker); local `.env` created from it with generated secrets (untracked) |

### Evidence

| Check | Command | Result |
|---|---|---|
| Server tests | `npm test -w server` | **55 pass / 0 fail** (unit + integration on `velora_test`, replica set) |
| Client tests | `npm test -w client` | **9 pass / 0 fail** |
| Client lint | `npm run lint -w client` | clean |
| Client build | `npm run build -w client` | production build succeeds |
| Browser journeys | `npx playwright test` | **17 pass / 0 fail** (incl. patient journey + six viewports on `/app/patients`) |
| Production audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Secret scan (tree) | `git grep` | only a synthetic TOTP test secret; no real credentials |
| Secret scan (history) | `git log -p --all` | no keys/tokens/`.env` ever committed |
| Tracked env files | `git ls-files` | only `.env.example` |

Viewports asserted: `1440x900`, `768x1024`, `390x844`, `320x568`, `844x390`, `320x400`.

### Security-25 matrix (Part 2)

| # | Control | Status | Evidence |
|---:|---|---|---|
| 1 | Secrets hidden | VERIFIED | `.env` untracked; only `.env.example` tracked |
| 2 | Fail-closed env | VERIFIED | `config/env.js`; env loads with the workspace `.env` |
| 3 | Private routes guarded | VERIFIED | Express policy + React guard; inactive-membership denial test |
| 4 | Argon2id, MFA, revocable sessions, CSRF preserved | VERIFIED | Part 1 tests still green |
| 5 | Clinic + role + assignment + ownership + grant + state, default deny | VERIFIED | clinic-isolation, unassigned-staff, admin-denial, patient-ownership, scope-denial tests |
| 6 | Validate/sanitize, reject unknown fields | VERIFIED | strict schemas; unknown-field + XSS tests |
| 7 | No unsafe HTML/XSS | VERIFIED | no `dangerouslySetInnerHTML`; JSON-only responses asserted |
| 8 | Atomic limits | VERIFIED | Mongo-backed limits on create/read/mutate/invite/accept |
| 9 | Safe error envelope + scoped 404 | VERIFIED | uniform 404 for out-of-scope patients |
| 10 | Exact CORS allowlist | VERIFIED | unchanged from Part 1 |
| 11 | Helmet + CSP | VERIFIED | unchanged |
| 12 | Debug off in production | VERIFIED | unchanged |
| 13 | Dependency security | VERIFIED | `npm audit --omit=dev` = 0 |
| 14 | No unused packages | VERIFIED | no new dependency added for Part 2 |
| 15 | Private-file audit | VERIFIED | `.env`, `.mongodb-test/`, `e2e/.auth/` ignored |
| 16 | `MONGODB_URI` server-only | VERIFIED | no `VITE_` secret |
| 17 | Argon2id only | VERIFIED | unchanged |
| 18 | Tree + history scan | VERIFIED | both clean |
| 19 | End-of-part audit | VERIFIED | this matrix |
| 20 | Coherent ~300-LOC commits | VERIFIED | see commit list below |
| 21 | Continuous security | VERIFIED | transactional writes, partial unique indexes |
| 22 | Disclose external providers | VERIFIED | none added; invitation links delivered in dev only |
| 23 | Test every failure/concurrency path | VERIFIED | single-use race, expiry, last-assignee, duplicate reference |
| 24 | Docs synced | VERIFIED | this session |
| 25 | One-viewport screens | VERIFIED | 17 journeys; six sizes incl. `/app/patients` |

### Duck verdict: PASS (Part 2, local scope)

All 25 controls are VERIFIED for the Parts 1-2 scope with the full server/client/e2e suites, the
production audit and both secret scans green. Evidence is local (development); no production
deployment or clinical validation is claimed.

### Remaining limits

- Only `view_profile` is honoured for caregivers; other declared scopes are inert until their parts.
- Invitation links remain log/response-delivered in development (no mail provider, control #22).
- The application database must be a replica set from Part 2 on.
- Dev-only tooling advisories in `vite`/`vitest`/`esbuild` remain (excluded from the production gate).

---

## Session - 10 October 2026 - Part 3 Duck review (BLOCKED on Part 2)

### Duck review (start of session)

**Files read:** `docs/VELORA_MERN_{MASTER,ARCHITECTURE,DUCK_LOG}.pdf` (owner authority),
`VELORA_MERN_10_BUILD_PROMPTS.md`, `README.md`, `docs/VELORA_*.md`, the server/client/e2e trees.

**Observed repository state:** branch `main` (clean), 18 commits, `origin/main` up to date at
`86ef6f1`. Local branches are `main` and `part1/foundation`; the remote has only `main`; there are
no stashes. Ten models exist (`User`, `Clinic`, `ClinicMembership`, `MembershipRole`, `Invitation`,
`Session`, `MfaRecoveryCode`, `PasswordReset`, `RateLimitBucket`, `AuditEvent`). Routes are
`auth/`, `staff/`, `clinic/` only. No `RecoveryEpisode`, `CareTeamAssignment`, `EpisodeCorrection`,
patient, consent or caregiver-grant model, route, service or screen exists anywhere in the tree.

### Findings

| Requirement set | State | Evidence |
|---|---|---|
| Part 1 (repository, auth, clinic permissions) | **VERIFIED** | 37 server + 6 client + 16 browser tests pass; pushed to `main` |
| Part 2 (patient onboarding, consent history, caregiver access) | **NOT IMPLEMENTED** | no models/routes/services/UI; `git grep` finds the names only in the prompts document |
| Part 3 (recovery episodes, care-team assignment) | **BLOCKED** | depends on Part 2 |

### Why Part 3 cannot be built on Part 1 alone

Prompt 3 requires that "Parts 1-2 are VERIFIED" before extension, and its own test gate requires
"intake-assignment versus episode-assignment separation". Part 2 supplies precisely that intake
assignment and patient ownership. Building Part 3 now would mean inventing Part 2's patient/consent
model inside the episode work, duplicating it later and breaking the roadmap order - a deliberate
drift, not a fix. Per the Duck contract the correct action is to build Part 2 first, then Part 3.

### Decision required from the owner

Build Part 2 and then Part 3 in order (recommended), or knowingly build Part 3 against the Part 1
baseline with Part 2's data model deferred (not recommended). No Part 3 code was written.

---

## Session - 10 October 2026 - Part 1 implementation

### Duck review (start of session)

**Files read:** `docs/VELORA_MERN_MASTER.pdf`, `docs/VELORA_MERN_ARCHITECTURE.pdf`,
`docs/VELORA_MERN_DUCK_LOG.pdf` (owner authority), `VELORA_MERN_10_BUILD_PROMPTS.md`, `README.md`,
`.env.example`, `.gitignore`.

**Observed repository state before changes:** an authority baseline only - `docs/` (three PDFs + the
ten build prompts) and `README.md`. No `server/`, no `client/`, no code, no CI.

**Classification:** `PLANNED` for all VEL requirements at session start.

### Work performed (Part 1)

| Area | Result |
|---|---|
| Root workspace | `package.json` workspaces (server, client), `.env.example`, `.gitignore`, `scripts/gen-env-values.js` |
| Server config | fail-closed zod env (`config/env.js`), `config/db.js`, `config/constants.js` |
| Models | 10 Mongoose models with compound/unique indexes and UTC timestamps |
| Security services | Argon2id passwords, peppered hashes, AES-256-GCM secret box, opaque revocable sessions |
| Auth flows | login, logout, current-user, sessions list, revoke-all, password reset, invitation accept, TOTP enroll/verify + recovery, forced staff MFA |
| Clinic/staff | admin member management, invitations, reviewer eligibility with last-admin and self-grant invariants |
| Middleware | Helmet + CSP, exact CORS, request context, double-submit CSRF, session/clinic/permission policy, strict zod validation, safe error envelope, Mongo-backed rate limits |
| Client | Vite + React + router, cookie-only API wrapper, auth context, login/MFA/enroll/reset/invite screens, protected one-viewport app shell |
| Tests | server unit + integration (MongoDB test DB) and client Vitest suites |

### Commits (Part 1, in order)

1. `a2e9457` docs: initialize Velora MERN project authority
2. `7dfd5a5` docs: add MERN Duck authority PDFs and secret-safe ignores
3. `a2cc4cf` docs: preserve owner authority set under docs/ (Master, Architecture, Duck Log PDFs + 10 build prompts)
4. `2d02a7c` chore: root workspace scaffolding, env example and secret generator
5. `db68dd6` feat(server): fail-closed env config, 10 Mongoose models and security services
6. `a2ae4f2` feat(server): auth/staff API with RBAC, CSRF, MFA and rate limiting
7. `d870340` test(server): 36 unit + integration tests covering the Part 1 exit gate
8. `7099bb9` feat(client): React/Vite app - login, forced MFA enrollment, staff admin, one-viewport shell
9. `434a603` fix(server): make MFA enrollment setup idempotent
10. `42d1e6d` fix(client): honour server next-step so forced MFA enrollment routes
11. `313777c` docs: add five reference documents synced with the implemented code
12. `3913bb2` ci: add the Part 1 pipeline gate
13. `f776d6f` test(e2e): browser journeys for login, forced MFA and one-viewport
14. `bbab42f` fix(client): keep recovery codes visible and bound the app to one viewport
15. `31f6424` chore(client): add ESLint config and update react-router to a patched v7
16. `b679063` docs: record verified Part 1 setup, commands and evidence

Merged into `main` and pushed: `7dfd5a5..b679063` (fast-forward, 14 commits).

### Defects found and fixed during verification

- **MFA enrollment was not idempotent.** A double-fired setup (React StrictMode) or a mid-enrollment
  refresh minted a second TOTP secret, so the scanned code failed to verify. Fixed by reusing the
  existing unconfirmed secret; regression test added.
- **Client ignored the server `next` step.** Login returned `next=mfa_verify|mfa_enroll` but the auth
  context never recorded `mfaPending`, so the router bounced back to `/login`. Fixed and covered by a
  client flow test.
- **One-time recovery codes were skipped.** After enrollment the context cleared `mfaPending`, so the
  redirect effect navigated to `/app` before the user could save their recovery codes. The redirect is
  now suppressed while codes are on screen. (Found by the browser journey, not the unit tests.)
- **The authenticated screen could still scroll the whole page.** The app grid used `1fr` without
  `minmax(0, 1fr)`/`min-height: 0`, so a tall staff table grew the document instead of scrolling
  inside its panel - a genuine control #25 violation at `320x568`, `844x390` and `320x400`. The shell
  is now pinned (`position: fixed; inset: 0`) with an inner `min-height: 0` scroll region; the
  journeys assert the document does not exceed the viewport and cannot be scrolled.
- **Two production dependency advisories.** React Router 6.28 carried moderate advisories; upgraded
  to `react-router-dom` 7.18.4. `npm audit --omit=dev` now reports **0 vulnerabilities**.

### Evidence

| Check | Command | Result |
|---|---|---|
| Server tests | `npm test -w server` | 37 pass / 0 fail (unit + integration on `velora_test`) |
| Client tests | `npm test -w client` | 6 pass / 0 fail |
| Client lint | `npm run lint -w client` | clean |
| Client build | `npm run build -w client` | production build succeeds |
| Browser journeys | `npx playwright test` | 16 pass / 0 fail (login, MFA enrollment, sign-out, safe error, redirect + six viewports) |
| Production audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Secret scan (tree) | `git grep` for keys/`VITE_` secrets | no real secrets; only synthetic dev passwords |
| Secret scan (history) | `git log -p --all` for key/provider patterns | no private keys, tokens or `.env` files ever committed |

Viewport sizes asserted: `1440x900`, `768x1024`, `390x844`, `320x568`, `844x390`, `320x400`.
Advisory (dev-only, not shipped): `npm audit` still reports dev-tooling advisories in
`vite`/`vitest`/`esbuild`/`tinypool`. They are excluded from the production gate
(`--omit=dev`) and scheduled for a tooling upgrade; they do not affect a production build.

### Security-25 matrix (Part 1)

| # | Control | Status | Evidence |
|---:|---|---|---|
| 1 | Secrets hidden | VERIFIED | `.env.example` only; history/tree scan clean; no secret in client bundle |
| 2 | Fail-closed env | VERIFIED | `config/env.js` + 7 env unit tests |
| 3 | Private routes guarded | VERIFIED | Express policy middleware + React guard; redirect journey |
| 4 | Argon2id, sessions, MFA, reset/invite | VERIFIED | auth integration tests + journeys |
| 5 | Server-side access control | VERIFIED | cross-clinic, admin-alone, reviewer tests |
| 6 | Validate/sanitize input | VERIFIED | strict zod schemas; unknown-field + XSS tests |
| 7 | Prevent XSS | VERIFIED | no `dangerouslySetInnerHTML`; XSS test |
| 8 | Atomic rate limits | VERIFIED | Mongo-backed limiter + login trip test |
| 9 | Safe error envelope | VERIFIED | `{ error: { code, message } }`; 404/forbidden tests |
| 10 | Exact CORS allowlist | VERIFIED | CORS test (no ACAO for foreign origin) |
| 11 | Helmet + CSP | VERIFIED | `middleware/security.js` |
| 12 | Debug off in production | VERIFIED | `NODE_ENV` gating; no stack traces |
| 13 | Dependency security | VERIFIED | `npm audit --omit=dev` = 0; React Router upgraded |
| 14 | No unused packages | VERIFIED | Part 1 dependency set is used |
| 15 | Private files ignored | VERIFIED | `.gitignore`; only `.env.example` tracked |
| 16 | DB creds server-only | VERIFIED | no `VITE_` secret; scan clean |
| 17 | Argon2id passwords | VERIFIED | password unit tests |
| 18 | Tree + history secret scan | VERIFIED | both scans clean |
| 19 | Documented security audit | VERIFIED | this matrix |
| 20 | ~300-LOC commits | VERIFIED | 16 meaningful commits, no padding |
| 21 | Continuous security | VERIFIED | design + tests throughout |
| 22 | Disclose external providers | VERIFIED | none added; invitation delivery is dev-log only |
| 23 | Test every failure path | VERIFIED | denied/invalid/expired/revoked/race/rate-limited tests |
| 24 | Docs synced | VERIFIED | README + 5 docs match the code |
| 25 | One-viewport screens | VERIFIED | 16 journeys assert no page scroll at six sizes |

### Duck verdict: PASS (Part 1, local scope)

All 25 controls are VERIFIED for the Part 1 scope, with the exit-gate tests, client
build, browser journeys, production audit and secret scans all green. Evidence is
local (development environment); no production deployment or clinical validation is
claimed. Scope for clinical-record browsing remains `PLANNED` for Parts 2+.

### Remaining limits

- Invitations/reset links are log-delivered in development only; no mail provider (control #22).
- No production deployment, restore test or clinical validation (Part 10).
- Clinical permission catalog beyond `clinical.review` is declared but not yet wired to routes.
- Dev-only tooling advisories remain in `vite`/`vitest`/`esbuild`/`tinypool` (excluded from the
  production gate; scheduled for a tooling upgrade).
- A stale Vite dependency-optimizer cache after a dependency upgrade can surface a spurious
  `React is not defined` dev error. Clear `client/.vite` and `client/node_modules/.vite` and restart
  the dev server; CI installs fresh so it is unaffected. Both paths are gitignored.
