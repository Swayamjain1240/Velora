# Velora MERN - Part 10 Readiness Report

Final review of the ten-part build: what is **PASSED**, what is **FAILED**, what is **BLOCKED** and
what is **NOT APPLICABLE**, with the evidence behind each verdict. Evidence classes stay the Duck
set: `VERIFIED`, `IMPLEMENTED / UNVERIFIED`, `PARTIAL`, `PLANNED`, `DRIFT`, `BLOCKED`, `NOT
APPLICABLE`.

> This report does **not** claim zero bugs, regulatory compliance, clinical validation or
> real-patient readiness. No deployment happened, no external provider is connected, no real patient
> data ever entered the system, and no destructive deletion or real restore has been performed. The
> exact owner decisions still required are listed in §7.

Date: 16 October 2026 · Branch: `main` · Repository: `Velora` · Part 10 landed in **eight commits**
(§1), each verified on its own before the next began.

---

## 1. Gate evidence (local, synthetic data only)

| Check | Command | Result |
|---|---|---|
| Server unit + integration + concurrency | `npm test -w server` (replica-set MongoDB) | **403 passed / 0 failed**, exit 0 (includes the reconciliation repair path, the key-rotation re-seal and a real database outage) |
| Client unit tests | `npm test -w client` | **61 passed / 0 failed** (11 files), exit 0 |
| Client lint | `npm run lint -w client` | clean, exit 0 |
| Client production build | `npm run build -w client` | built in ~1.5 s: `index.js` 368.38 kB (101.34 kB gzip), `index.css` 13.47 kB (3.02 kB gzip) |
| Browser journeys (Chromium, six viewport sizes) | `EXTRACTION_PROVIDER=fake npx playwright test` against `EXTRACTION_PROVIDER=fake NODE_ENV=test` API | **64 passed / 0 failed / 2 skipped** of 66, exit 0 |
| Provider fails closed with no provider | restart API with `EXTRACTION_PROVIDER=none`, `npx playwright test e2e/extractions.spec.js -g "no provider enabled"` | **1 passed**, exit 0 |
| Restore drill | `npm run restore:drill -w server` | **PASSED** - 48 collections, 5071 rows, 192 encrypted objects (6 063 933 bytes), 25/25 stored documents decrypted from the restored copy with matching hashes, source unchanged, drill database dropped. Observed timings on this host: dump 286 ms, restore 9 498 ms, object copy 398 ms, verify 526 ms (**~10.7 s** end to end for this synthetic volume) |
| Document reconciliation | `node server/scripts/reconcile-documents.js` | 192 metadata rows / 192 stored objects, **0** missing, unreadable, mismatched or orphan; dry run changed nothing |
| Key-rotation re-seal | `npm run keys:reseal -w server` (no rotation staged) | report: targets `none (nothing to do)`, 0 scanned, exit 0 - the command is wired into the package scripts and refuses to invent work |
| Database outage, for real | `tests/integration/health.test.js` closes the actual connection | `/api/ready` → 503 naming `database`, `/api/health` still 200, an authenticated clinical read → 503 `SERVICE_UNAVAILABLE` with **no** data, no stack and no endpoint, and everything recovers when the connection returns |
| Production dependency audit | `npm audit --omit=dev` | **0 vulnerabilities** |
| Full dependency audit (incl. dev tooling) | `npm audit` | **0 vulnerabilities** in root, `server/` and `client/` (re-measured 20 October 2026, exit 0); the 6 dev-only advisories recorded here on 16 October are no longer present in the tree |
| Secret scan (tree) | pattern scan for provider keys, private keys and credentialed URIs | clean |
| Secret scan (reachable history, all commits) | `git grep` over `git rev-list --all` | clean |

Two skipped journeys are deliberate: the opt-in live quarantine journey (`E2E_QUARANTINE=1`) and the
provider-disabled journey when the provider IS enabled (it runs in its own step, above).

The gate was re-run on the frozen final tree after every repair; earlier passing runs are not used as
evidence for later changes.

---

## 2. Part 10 work items

| # | Item | Verdict | Evidence / note |
|---:|---|---|---|
| 1 | Production configuration schema | **PASSED** | `NODE_ENV=production` now refuses: non-HTTPS or non-bare `CLIENT_ORIGIN`, `LOG_LEVEL=debug`, a pepper under 32 chars, any reused encryption key, a non-TLS `MONGODB_URI`, and an impossible pool bound. Body, request, pool and shutdown budgets are all configurable and bounded. 15 unit cases in `tests/unit/env.test.js` |
| 2 | Provider-neutral production decisions | **PASSED (register written, nothing selected)** | [VELORA_PROVIDER_DECISIONS.md](VELORA_PROVIDER_DECISIONS.md): seven capabilities with candidates evaluated from the Gravity Index catalogue, the control-#22 disclosure template, and what each selection blocks. Every row is `NOT SELECTED` |
| 3 | Health/readiness, graceful shutdown, pool, request ids, redacted logs | **PASSED** | `/api/health` (liveness, dependency-free) and `/api/ready` (real DB `ping` + storage writability, 503 with a named failing side, `draining` before the listener closes); bounded pool/timeouts; `X-Request-Id` on every response; structured JSON logger with deep redaction and production stack suppression; one-per-state-change alert events. 5 unit + 6 integration cases, including a **real database outage** (the connection is closed, not stubbed) proving the probe names the failing side, liveness survives, and a request that needs the database answers 503 instead of a misleading 500 |
| 4 | Session/cookie/proxy/CSRF/CORS/CSP/HSTS hardening and rotation strategy | **PASSED (rotation proven locally)** | Proxy trust is now an explicit operator decision (a hardcoded hop was a real drift); HSTS is production-only and explicit; cookie/token handling re-verified (host-only, httpOnly, sameSite, secure in production, peppered hashes, revocable, MFA). Key rotation now exists for **both** encrypted stores: a two-key window plus `scripts/reseal-keys.js`, proven by a real rotation that keeps the authenticator working and the document byte-identical (§6). `SESSION_PEPPER` rotation deliberately invalidates every session and every recovery code, and says so |
| 5 | Backup/restore runbooks + isolated synthetic restore test | **PARTIAL** | Runbook written with the four-asset backup set, the ordered restore procedure, observed drill timings and the honest RPO/RTO boundary. The drill runs and passes. **A provider backup schedule/cadence does not exist**, so RPO is not bounded and no provider-level or point-in-time restore was exercised |
| 6 | Storage integrity, retention dry run, queue/version reconciliation, disaster behaviour | **PASSED (local)** | Reconciliation reports 0 drift on the seeded set, and its **repair path** is now exercised: each drift class (lost object, tampered envelope, valid envelope whose plaintext no longer matches its recorded hash, orphan with no metadata row) is created deliberately, asserted to be untouched in a dry run, and then repaired with an operator attribution. Retention dry run verified repeatable; plan-version reconciliation supersedes future occurrences while leaving history untouched; reminder retries stay bounded with the failure kept visible; per-dependency failure behaviour exercised, including a closed database connection |
| 7 | Threat model | **PASSED** | [VELORA_THREAT_MODEL.md](VELORA_THREAT_MODEL.md): eleven scenarios (tenant escape, BOLA, credential stuffing, session theft, stored XSS, NoSQL injection, malicious uploads, prompt injection/data leakage, supply chain, insider/admin misuse, availability) each with the implemented mitigation, the residual risk, and the deployment-dependent gaps marked BLOCKED |
| 8 | CI protections | **PASSED** | Lockfile + `npm ci`, production dependency audit, gitleaks tree/history scan, server/client/browser gates, and on every push against the seeded database: the restore drill, the read-only reconciliation report **and the key-rotation re-seal in its no-rotation default mode** (so the command cannot rot unnoticed). Branch-protection recommendations recorded; no gate was weakened |
| 9 | Accessibility, keyboard, responsive, empty/error/loading states | **PARTIAL** | Six-size one-viewport assertions cover every authenticated screen; a new keyboard journey proves shell traversability, a visible focus indicator (2px+ outline) and keyboard activation of a navigation control; journeys address controls by role/name, which requires accessible names. State coverage is explicit rather than implied: **loading** and **empty** states are asserted in the browser journeys (`today` — "not recorded yet", `plans`/`extractions` — an empty slot, `part9` — a non-empty trail, `AuditPanel` — "No events match this search"), **error** states in the client suites (a failed load renders a message, not a blank screen) and **denied** states in the client suites plus per-surface integration denials (a scoped caregiver sees the scoped view, never an empty error). Automated coverage now includes an **axe WCAG 2.1 A/AA audit** (`e2e/axe.spec.js`, fails on any impact, across public, reviewer and admin routes) and the 200 %/400 % **zoom reflow** journeys, both run in CI. **BLOCKED**: no screen-reader run, no real Safari/Firefox run (Chromium project only), no physical device |
| 10 | Readiness report with explicit gates | **PASSED** | This document |

---

## 3. Security-25 control matrix (final)

| # | Control | Verdict | Evidence |
|---:|---|---|---|
| 1 | Secrets hidden; keys rotated | **PASSED (rotation proven locally)** | No secret in the client bundle, logs, responses, fixtures or Git; separate 32-byte keys + pepper, reuse refused in production; `MFA_ENCRYPTION_KEY` and `DOCUMENT_ENCRYPTION_KEY` are now **rotatable and re-sealable** (`scripts/reseal-keys.js`, dry run by default, operator-attributed, compare-and-set per record, verified against the recorded hash), and the session pepper's consequences are stated rather than assumed. **BLOCKED** on a managed key store: who may rotate, how often, and provider-side rotation behaviour are owner decisions |
| 2 | Required env validated, fail closed | **PASSED** | Startup refuses a bad configuration (field names only); production-only rules; provider gate fails closed; new runtime budgets validated |
| 3 | Protect every private route/file/job | **PASSED** | Every `/api` surface requires authentication + scope except the two probes (which disclose nothing) and the public invitation/landing routes; documents are never served from a public path; with the database gone a request is refused (503, no data) rather than served stale |
| 4 | Argon2id, mandatory staff MFA, revocable sessions, recovery, CSRF | **PASSED** | Verified unchanged in Part 10; MFA enrollment is a compare-and-set and cannot be replaced during a password-only session; step-up for sensitive actions |
| 5 | Server-side clinic/role/assignment/ownership/grant/state on reads, writes, lists, counts, exports, jobs | **PASSED** | Re-derived per request; cross-clinic/unauthorized cases asserted per surface; admin holds no clinical read |
| 6 | Validate/sanitize input; prevent NoSQL injection | **PASSED** | Strict zod schemas per route, ObjectId validation, primitive-only queries, generic 400s |
| 7 | Prevent XSS / unsafe rendering | **PASSED (API) / BLOCKED (client host)** | JSON-only API with `default-src 'none'` CSP; no `dangerouslySetInnerHTML` in the client; documents are never rendered inline. The client host's own headers/TLS are a deployment task |
| 8 | Distributed/atomic rate and resource limits | **PASSED** | Durable Mongo-backed limiter, bounded bodies/timeouts/pool/export/retention/audit ranges, per-IP coarse limiter (measured: request 301 in a window → 429) with its NAT caveat documented |
| 9 | Consistent safe errors, redacted logs | **PASSED** | One error envelope; production 5xx messages generic; new structured logger redacts sensitive keys at depth, suppresses production stacks, and never logs clinical text; audit-write failure is an alert event |
| 10 | Exact CORS allowlist | **PASSED** | Single exact origin, credentialed, no wildcard, no ACAO for a foreign origin; `CLIENT_ORIGIN` must now be a bare origin |
| 11 | CSP/Helmet/HSTS and attachment headers | **PARTIAL** | Helmet CSP/`nosniff`/frame/referrer policies on the API; HSTS now explicit and production-only; downloads are attachment-typed behind authorization. Client-origin headers remain a deployment responsibility |
| 12 | Production debug off | **PASSED** | Non-production stack/diagnostic messages; `LOG_LEVEL=debug` refused in production; x-powered-by disabled; trust proxy is explicit rather than defaulted |
| 13 | Dependency advisories checked before upgrades | **PASSED** | `npm audit --omit=dev` = 0 and a full `npm audit` is 0 as well (re-measured 20 October 2026), so no dev-toolchain exception has to be carried |
| 14 | Remove unused packages | **PASSED** | No unused dependency in `server`/`client`; Part 10 added **no** dependency (logger and readiness are hand-written over the standard library) |
| 15 | Find exposed keys/uploads/exports/backups/source maps | **PASSED (local)** | Tree and full-history scans clean; `.env` never committed; exports/backups/keys ignored; drills and reconciliation operate on synthetic data |
| 16 | Secure Mongo credentials/TLS/network boundaries | **PARTIAL** | TLS mandatory in production, credentials server-only, pool bounded, private access rules. Region/network boundary and provider DB audit logs are **BLOCKED** on the database selection |
| 17 | Argon2id/bcrypt only, no plaintext | **PASSED** | Argon2id via `@node-rs/argon2`; no plaintext or reversible password storage anywhere |
| 18 | Scan reachable history and tree for secrets | **PASSED** | Pattern scans over the tree and every reachable commit are clean (a synthetic credentialed-URI fixture found during Part 10 was removed from the tree **and** from history by rewriting the unmerged commit before it could reach CI) |
| 19 | Final security audit / threat model | **PASSED** | Threat model + this matrix; every UNVERIFIED/PARTIAL/BLOCKED item is named rather than implied |
| 20 | Coherent fix → test → diff → meaningful commit; 50+ real commits | **PASSED** | **Eight** Part 10 commits, each coherent and independently verified (runtime hardening, restore drill, accessibility journey, CI drill step, Part 10 records, reconciliation repair, key re-seal, closing outage semantics + records); 82 commits total, no padding |
| 21 | Security continuously maintained | **PASSED** | CI gate on push/PR; new runtime log/readiness surfaces include their own tests; no gate disabled |
| 22 | Disclose every external provider before integration | **PASSED** | No provider connected; the register carries the required disclosure fields, and the extraction and reminder registries still fail closed on any undisclosed name |
| 23 | Test every feature and failure/recovery path | **PASSED (local)** | Failure paths exercised: bad configuration, disabled provider, unusable storage, readiness states, **a real database outage**, reconciliation drift AND its repair, key rotation including an object the previous key cannot open, restore verification, cross-clinic denials, concurrency collisions |
| 24 | Synchronize README, docs, runbooks and evidence | **PASSED** | README, structure, architecture, system design and the session log updated with this part; new runbook/register/threat-model/report added |
| 25 | Every authenticated screen fits one viewport; six sizes | **PASSED** | 64 browser journeys including six-size measurement of every authenticated screen across five role sessions (session-sharing interaction found and fixed while adding the keyboard journey) |

---

## 4. Requirement traceability (VEL-001 .. VEL-021)

| ID | Requirement | Verdict | Part 10 addition |
|---:|---|---|---|
| VEL-001 | Account and invitation security | VERIFIED (local scope) | Readiness/shutdown changes do not alter auth; session cookie/proxy assumptions re-verified |
| VEL-002 | Clinic and record isolation | VERIFIED (local scope) | Tenant scoping unchanged; probes deliberately disclose no tenant data |
| VEL-003 | Recovery episodes and assigned team | VERIFIED (local scope) | Failure behaviour documented |
| VEL-004 | Private validated document intake | VERIFIED (local scope) | Storage readiness probe added; reconciliation re-run with 0 drift **and its repair path tested**; the document key is now rotatable with the bytes proven unchanged over HTTP; no antivirus provider (unchanged) |
| VEL-005 | Manual draft and source review | VERIFIED (local scope) | Unaffected; still the shipped default with AI off |
| VEL-006 | Clinical approval gate | VERIFIED (local scope) | Approval transaction unchanged |
| VEL-007 | Patient current-approved plan view | VERIFIED (local scope) | Unaffected |
| VEL-008 | AI extraction with source evidence | VERIFIED (local scope) | Provider gate re-verified fail-closed on the final tree; provider selection still an owner decision |
| VEL-009 | Reviewed Hindi/English presentation | VERIFIED (local scope) | Unaffected |
| VEL-010 | Immutable care-plan versioning | VERIFIED (local scope) | Reconciliation rule documented: superseded versions keep history |
| VEL-011 | Granular caregiver sharing | VERIFIED (local scope) | Grant immutability/partial-unique index surfaced by the restore drill (index fidelity) |
| VEL-012 | Medication schedules and actor logs | VERIFIED (local scope) | Reconciliation behaviour documented |
| VEL-013 | Daily recovery tasks | VERIFIED (local scope) | Unaffected |
| VEL-014 | Notifications and delivery records | VERIFIED (local scope) | Delivery failure → operator visibility documented; no provider selected |
| VEL-015 | Clinic-defined recovery check-ins | VERIFIED (local scope) | Unaffected |
| VEL-016 | Clarification queue and history | VERIFIED (local scope) | Unaffected |
| VEL-017 | Assigned team dashboard | VERIFIED (local scope) | Six-size measurement re-run |
| VEL-018 | Basic prescribed follow-up | VERIFIED (local scope) | Unaffected |
| VEL-019 | Operational closure and history | VERIFIED (local scope) | Unaffected |
| VEL-020 | Privacy, audit, export/deletion and retention | VERIFIED (local scope) | Destructive deletion still not implemented by policy; retention operator gate unchanged |
| VEL-021 | Workflow metrics without clinical inference | VERIFIED (local scope) | Metric definitions unchanged; metrics screens re-measured at six sizes |

### 4.1 Role/access boundaries and clinical invariants (re-checked, not re-asserted)

Every boundary below was re-run against the frozen tree rather than trusted from an earlier part. The
suites re-derive authority from the database on each request, so a passing test means the live code
path refused, not that a fixture was remembered.

| Boundary / invariant | Where it is asserted |
|---|---|
| Clinic isolation on reads, lists, counts, exports, jobs | per-surface integration suites: a foreign `ObjectId` is a scoped 404, never a 403 that confirms existence |
| Role permission on every mutating surface | `staff`, `clinic`, `plans`, `schedules`, `checkIns`, `closures`, `retention`, `audit` suites |
| Active care-team assignment (or ownership / scoped grant) | episodes, documents, plans, schedules, check-ins, clarifications, reminders, dashboard |
| Caregiver grant scope (`view_*`) and revocation taking effect immediately | `caregiver` + `patientSelf` suites and the caregiver browser journey |
| Admin holds no clinical read | admin sessions in every clinical suite |
| Review eligibility (`clinical_review`) is clinic-verified | plan/check-in/schedule review paths; a pending reviewer is refused |
| Immutability: delivery attempts, consent history, approved plan versions, audit rows | model-level guards plus restore-drill index checks |
| One current approved plan version; retries idempotent | `plans` suite (concurrent approval race) |
| A missing check-in stays MISSING (never normal/abnormal) | `checkIns` suite plus the today/queue journeys |
| Metrics never infer clinical success | `metrics` suite plus the six-size metric screens |
| AI output never reaches the patient view; drafting works with AI off | `extractions` suite and the provider-disabled journey |
| Documents are never served from a public path, keys never disclosed | `documents` suite (download gating, opaque keys) |

---

## 5. Readiness by area

| Area | Verdict | Why |
|---|---|---|
| Software correctness (local, synthetic) | **PASSED** | 403 server + 61 client tests, 64 browser journeys, lint and build all green on the frozen tree |
| Security controls (design + local verification) | **PASSED with named gaps** | No open unresolved finding in code; key rotation, provider-side controls and client-host headers remain |
| Data durability | **PARTIAL** | A restore is proven possible and verifiable; no backup schedule exists, so RPO is unbounded and no off-host/point-in-time restore was exercised |
| Operations | **PARTIAL** | Probes, shutdown, logging, failure behaviour and runbooks exist; on-call routing, alerting and monitoring provider are not selected |
| Clinical readiness | **BLOCKED** | Clinical workflow review, procedure selection, authorized datasets and a labelled clinical evaluation have not happened |
| Privacy/legal readiness | **BLOCKED** | DPIA-equivalent assessment, lawful basis, notification obligations, retention windows and data-subject process are owner/DPO decisions |
| Regulatory compliance | **NOT APPLICABLE / NOT CLAIMED** | No certification, HIPAA/GDPR equivalence or clinical validation is claimed |
| Deployment | **BLOCKED** | No provider selected, no environment provisioned, no penetration test, no load test |

---

## 6. Defects found and fixed during Part 10

1. **Production could start with an unusable security posture.** Debug logging, one key reused across
   the MFA, document and export stores, a development-strength pepper, an unencrypted database
   connection and an impossible pool bound were all accepted. They are now refusals with tests.
2. **`TRUST_PROXY` was validated but never used, and `trust proxy` was hardcoded to 1.** A deployment
   that explicitly said "no proxy" still trusted a forwarding header, so a caller could rewrite the
   address that rate limits and the audit trail record. Proxy trust is now the operator's explicit
   decision, and a startup warning names the misconfiguration.
3. **`npm run seed` failed on a host that exports `PORT=0`.** Diagnosed as an environment artefact of
   the developer shell (the value is exported by the host process), not a code defect; the documented
   procedure (explicit `PORT`) works and the validator still rejects a literal `0` by design.
4. **The restore drill rejected its own restore.** A *partial* unique index (at most one ACTIVE
   caregiver grant) was rebuilt as a *full* unique index, so legitimately repeated rows from revoked
   grants were refused. Index options are now recreated and compared; the failure is reported as a
   finding. This is the kind of defect only a restore test can find.
5. **A synthetic credentialed-URI fixture could have tripped the CI secret scan.** Removed from the
   tree and rewritten out of the unmerged commit's history.
6. **The new keyboard journey signed out a shared session**, failing seven later journeys that reuse
   it. The journey now proves activation on a navigation link and makes no state change. Found only
   because the whole browser suite was re-run after adding the spec.
7. **A database outage answered 500 where the readiness probe answers 503.** Exercising the outage
   by closing the real connection showed the probe and the request path disagreeing: a client, a
   load balancer and an operator would read "the code is broken" during a dependency outage. A
   driver-level connectivity error now becomes a retryable 503 `SERVICE_UNAVAILABLE` with a generic
   body in every environment, logged as `dependency.unavailable`; storage tampering still returns
   500, so the two are not conflated.
8. **Key rotation stranded data.** Rotating either encryption key left every enrolled authenticator
   and every stored document sealed with the retired key. The two-key window and re-seal command
   close this, and the rotation is proven end to end rather than described (§2 item 4).
9. **The reconciliation repair path had no test.** A command could report drift it had never been
   shown repairing. Each drift class is now created and repaired under test.

---

## 7. Owner / clinical / privacy decisions still required

**Nothing below is a code task.** No pilot, no deployment and no real patient data may follow until
items 1-8 are decided by their owner and recorded where the operator will find them; item 9 is an
acceptance decision that does not block a technical deployment but must be closed before a clinical
one (item 10 closed itself on re-measurement).

A phased plan that closes these, with the deployment deliberately last, is
[VELORA_GO_LIVE_PLAN.md](VELORA_GO_LIVE_PLAN.md).

1. **Provider selection** for hosting, managed MongoDB, private object storage, notification delivery,
   scheduling/jobs, AI/OCR and monitoring — each with its control-#22 disclosure
   ([register](VELORA_PROVIDER_DECISIONS.md)).
2. **Backup cadence, location, encryption, retention, access audit**, and therefore the real RPO/RTO
   commitments the runbook must state.
3. **A managed key store and a rotation cadence**: where the keys live, who may rotate them, how
   often, and how a provider's own rotation/versioning interacts with the re-seal command.
4. **Retention windows and scheduling** per clinic, and the legal basis for each clinical category.
5. **Clinical governance**: which procedure(s) are in scope, who reviews the clinical workflow, which
   authorized datasets may be used, and what the clinical acceptance criteria are.
6. **Privacy/legal**: DPIA-equivalent, lawful basis, data-subject process, incident/notification
   obligations and timelines.
7. **Incident ownership and response hours**, on-call escalation, and a break-glass policy for
   infrastructure access.
8. **Partner clinic and pilot cohort**, plus an explicit authorisation before any real patient data is
   introduced.
9. **Accessibility acceptance**: screen-reader (NVDA/VoiceOver), real Safari/Firefox and one physical
   device, plus the target conformance level. The mechanical part - structural/contrast rules via axe
   and 200 %/400 % zoom reflow - already runs in CI and is no longer part of this decision.
10. ~~**Dev-toolchain advisories**~~ **CLOSED, 20 October 2026**: `npm audit` reports 0
    vulnerabilities across root, `server/` and `client/`, so the vitest/vite upgrade question is moot.
    Re-check `npm audit` before every release; a fresh advisory reopens this item.

## 8. Claims that must not be made

- "Production ready", "deployed", "monitored" or "backed up on a schedule".
- Any RPO or RTO figure: the drill measures how long a logical copy took **on this host**, and the
  recovery point is whatever happened to be present when the copy started, because no backup runs
  on a schedule.
- "Restore tested end to end" beyond the logical, same-host, synthetic drill described above.
- "Clinically validated", "diagnosis", "recovery certified", "adherence measured" or "readmission
  reduced" — the metrics and AI surfaces exist precisely to prevent that inference.
- "Compliant" with HIPAA, GDPR, DPDP or any certification.
- "Zero known bugs" — this report enumerates what is verified, what is partial and what is blocked.
