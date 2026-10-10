# Velora MERN - Master

**Product:** Velora - secure, clinician-controlled post-discharge recovery coordination.
**Stack:** JavaScript only - MongoDB + Mongoose, Express.js + Node.js, React.js + Vite, Playwright.
**Owner:** Swayam Jain.
**Document status:** living. It must stay consistent with the code in `server/` and `client/`.
**Authority:** the owner's `VELORA_MERN_MASTER.pdf`, `VELORA_MERN_ARCHITECTURE.pdf` and
`VELORA_MERN_DUCK_LOG.pdf` in this directory remain the source of truth. This file paraphrases
them for terminal/grep use and records what the code actually does.

> A roadmap item, plan or document is **not** evidence a feature exists. Only code, tests and
> observed runs are evidence.

## 1. What Velora is and is not

Velora helps a clinic turn private discharge information into **clinician-approved** recovery
plans. Patients and explicitly authorized caregivers later read only those approved plans,
record recovery activity and ask the assigned care team for clarification.

Velora **does not** diagnose, prescribe, decide clinical urgency, certify recovery, or publish AI
output automatically. AI assistance is deferred until the manual review-and-approval workflow is
built and verified (Part 6). Manual clinical approval always precedes any AI assistance.

Code 2 (diagnostic tests/results) and Code 3 (insurance) are **out of active scope**.

## 2. Clinical and product invariants

1. No automated clinical action. Uploading a document or receiving an AI result can never activate
   patient instructions, tasks or reminders.
2. Every clinical instruction requires an explicitly assigned, verified clinical reviewer's approval.
3. Consent, caregiver grants, review and revocation are append-only or audited; revocation blocks
   future requests immediately.
4. Admin status alone never grants clinical-record browsing or approval.
5. Clinical reviewer eligibility is separately verified and can never be self-granted.
6. Synthetic identities and data only, until an explicit owner authorization for a real pilot.

## 3. Requirements (VEL-001 .. VEL-021)

The numbered requirements below are grouped by delivery part. State values use the Duck evidence
classes: `VERIFIED`, `IMPLEMENTED / UNVERIFIED`, `PARTIAL`, `PLANNED`, `DRIFT`, `BLOCKED`.

| ID | Requirement | Part | State (10 Oct 2026) |
|---:|---|---:|---|
| VEL-001 | Repository, documentation baseline and CI gate | 1 | IMPLEMENTED / UNVERIFIED |
| VEL-002 | Clinic, staff RBAC and reviewer-eligibility boundary | 1 | IMPLEMENTED / UNVERIFIED |
| VEL-003 | Authentication: Argon2id, sessions, MFA, CSRF, reset, invite | 1 | IMPLEMENTED / UNVERIFIED |
| VEL-004 | Patient onboarding, consent history and caregiver grants | 2 | PLANNED |
| VEL-005 | Recovery episodes and care-team assignment | 3 | PLANNED |
| VEL-006 | Private discharge-document intake | 4 | PLANNED |
| VEL-007 | Manual source-linked care-plan drafting | 5 | PLANNED |
| VEL-008 | Clinical review, approval and versioning (completes synthetic M1) | 5 | PLANNED |
| VEL-009 | AI extraction with source citations and reviewed language | 6 | PLANNED |
| VEL-010 | Medication schedules, daily tasks and actor-attributed logs | 7 | PLANNED |
| VEL-011 | Patient/caregiver check-ins and clarification queue | 8 | PLANNED |
| VEL-012 | Staff/patient dashboard and reminders | 8 | PLANNED |
| VEL-013 | Episode closure and history | 9 | PLANNED |
| VEL-014 | Audit, privacy requests, retention and metrics | 9 | PLANNED |
| VEL-015 | Production hardening and isolated restore testing | 10 | PLANNED |
| VEL-016 | Clinical-readiness gate before real-patient pilot | 10 | PLANNED |
| VEL-017 | One-viewport rule for every authenticated screen | all | IMPLEMENTED / UNVERIFIED |
| VEL-018 | Safe error envelope, no tenant-existence leakage | all | IMPLEMENTED / UNVERIFIED |
| VEL-019 | Continuous secret scanning and dependency audit | all | IMPLEMENTED / UNVERIFIED |
| VEL-020 | Documentation synchronized with real code | all | PARTIAL |
| VEL-021 | 50+ meaningful commits without padding | all | PARTIAL |

## 4. Ten-part roadmap

| Part | Deliverable | Milestone |
|---:|---|---|
| 1 | Repository, authentication, clinic permissions | foundation |
| 2 | Patient onboarding, consent, caregiver access | |
| 3 | Recovery episodes and care-team assignment | |
| 4 | Private discharge-document intake | |
| 5 | Manual care plans, review, approval, versioning | completes synthetic M1 |
| 6 | AI extraction, source citations, reviewed language | |
| 7 | Medication schedules, daily tasks, actor-attributed logs | |
| 8 | Check-ins, clarification queue, dashboard, reminders | |
| 9 | Closure, audit, privacy requests, retention, metrics | |
| 10 | Production hardening, restore, clinical-readiness gate | readiness |

## 5. Roles and access boundaries

| Role | Boundary |
|---|---|
| Patient | Own records and current approved plan; no clinical approval |
| Caregiver | Only explicitly active granular scopes; no automatic document access; cannot invite others |
| Care coordinator | Assigned operational coordination and draft preparation; no clinical publication |
| Clinical reviewer | Assigned review and approval, only after separate clinic eligibility verification |
| Clinic admin | Staff and settings administration; admin status alone grants no clinical-record browsing |

Enforcement is **always** on the Express server using identity + clinic + role + ownership/active
assignment/grant + requested action + workflow state, with **default deny**. React route guards are
a user-interface layer only. The clinic scope always comes from the caller's own active membership,
never from a client-supplied id.

## 6. Permanent security contract (25 controls)

1. Hide every API key and secret; never print, expose, commit or send secrets to the browser.
2. Validate required environment variables at server startup and fail closed with safe messages.
3. Protect private routes on both the React router and Express server; the server is authoritative.
4. Proper authentication: Argon2id passwords, revocable secure sessions, MFA, safe reset/invitation.
5. Server-side access control on identity, clinic, role, ownership/assignment/grant and state.
6. Validate and sanitize every body, param, query, header and form; reject unknown fields.
7. Prevent XSS; never render unsanitized HTML or use `dangerouslySetInnerHTML` for model content.
8. Atomic rate limits on login, reset, invitation, MFA and other abuse-sensitive operations.
9. One safe error envelope `{ error: { code, message } }`; never leak stacks, secrets or existence.
10. Exact credentialed CORS allowlist; never a wildcard origin with credentials.
11. Security headers (Helmet) with an explicit CSP suitable for the app.
12. Production debug mode off; verbose error output disabled.
13. Check official compatibility and dependency security before install/upgrade; pin compatible
    versions and document exceptions.
14. Remove unused packages and dead scaffolding.
15. Track `.env.example` only; ignore `.env`, `.env.*`, logs, coverage, build output, private
    storage, keys, editor/OS files and local test artifacts while explicitly allowing `.env.example`.
16. Keep `MONGODB_URI` and all database credentials in the server environment only; never expose
    them through `VITE_` variables, client bundles, logs or Git.
17. Passwords use Argon2id/bcrypt only; never plaintext or reversible encryption.
18. Scan the Git tree and complete reachable history for leaked secrets before each part closes.
19. Perform and document a security audit before marking a part complete.
20. After each coherent feature or ~300 meaningful LOC: run tests, inspect diff, make and push one
    meaningful commit when authorized. Target 50+ meaningful commits; never create fake commit spam.
21. Treat security as continuous design work, not a final patch.
22. Before any external API/service, disclose provider, purpose, API-key name, environment variable
    and exact backend/frontend location. Never silently add a vendor.
23. Test every feature, including denied, invalid, expired, revoked, concurrent and rate-limited paths.
24. Keep README, architecture, structure, master and session documentation synchronized with code.
25. Every authenticated screen fits one viewport without page-level vertical scrolling; never use
    `overflow: hidden` to cut content. The marketing landing page may intentionally scroll.

## 7. One-viewport rule

Every authenticated screen must fit within one viewport without page-level vertical scrolling.

- Long forms use multi-step wizards.
- Long lists/tables use server pagination.
- Many sections use tabs or separate routes.
- Charts use switchable panels; mobile shows one primary panel at a time.
- `overflow: hidden` must never cut required content.

Verification sizes: `1440x900`, `768x1024`, `390x844`, `320x568`, `844x390`, `320x400`.

## 8. Data and readiness boundary

Development uses synthetic identities and documents only. Before any real-patient pilot Velora
requires clinical workflow review, privacy/provider decisions, retention and incident processes,
verified staff onboarding, secure deployment, backup plus isolated restore testing, representative
extraction/language evaluation, and explicit owner authorization.
