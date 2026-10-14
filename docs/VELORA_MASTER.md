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
output automatically. AI assistance (Part 6) is an **untrusted drafting aid**: it cannot approve,
publish, prescribe, change clinical state, activate a task or send a reminder, and manual clinical
approval always precedes any AI assistance. The manual workflow runs unchanged when AI is
unavailable, which is the shipped default (`EXTRACTION_PROVIDER=none`).

Code 2 (diagnostic tests/results) and Code 3 (insurance) are **out of active scope**.

## 2. Clinical and product invariants

1. No automated clinical action. Uploading a document or receiving an AI result can never activate
   patient instructions, tasks or reminders.
2. Every clinical instruction requires an explicitly assigned, verified clinical reviewer's approval.
   A missing, unclear or conflicting dose/frequency/duration is never guessed: it stays unresolved
   and blocks approval until a human states it.
3. Consent, caregiver grants, review and revocation are append-only or audited; revocation blocks
   future requests immediately.
4. Admin status alone never grants clinical-record browsing or approval.
5. Clinical reviewer eligibility is separately verified and can never be self-granted.
6. Synthetic identities and data only, until an explicit owner authorization for a real pilot.

## 3. Requirements (VEL-001 .. VEL-021)

The IDs, names and targets below are the **authority numbering** from the owner's
`VELORA_MERN_MASTER.pdf` (§03/§04). State values use the Duck evidence classes: `VERIFIED`,
`IMPLEMENTED / UNVERIFIED`, `PARTIAL`, `PLANNED`, `DRIFT`, `BLOCKED`.

> **Renumbering correction (Part 7 Duck).** Through Part 6 this file used a *local* numbering that
> shifted from the authority at VEL-004 and renumbered the later requirements. The authority set is
> now restored verbatim; every guarantee that the local table attached to VEL-004 .. VEL-021 is
> mapped to its real ID below, and nothing was dropped or weakened. The mapping also records where
> the deleted local IDs were really Security-25 controls rather than VEL requirements.
>
> | Local (Part 1-6) ID | Authority ID / control |
> |---|---|
> | local VEL-001 repository + CI | foundation (no VEL ID); control 20/24 |
> | local VEL-002 clinic + RBAC | VEL-002 (clinic and record isolation) + VEL-001 (accounts) |
> | local VEL-003 authentication | VEL-001 |
> | local VEL-004 onboarding/consent/caregiver | VEL-011 (granular caregiver sharing) |
> | local VEL-005 episodes | VEL-003 |
> | local VEL-006 documents | VEL-004 |
> | local VEL-007 manual drafting | VEL-005 |
> | local VEL-008 approval + versioning | VEL-006 + VEL-010 |
> | local VEL-009 AI extraction + Hindi/English | VEL-008 + VEL-009 |
> | local VEL-010 schedules/tasks/logs | VEL-012 + VEL-013 |
> | local VEL-011 check-ins/clarification | VEL-015 + VEL-016 |
> | local VEL-012 dashboard/reminders | VEL-017 + VEL-014 |
> | local VEL-013 closure/history | VEL-019 |
> | local VEL-014 audit/privacy/retention/metrics | VEL-020 + VEL-021 |
> | local VEL-015..016 hardening/readiness | before-real-patient-use gate (no VEL ID) |
> | local VEL-017 one viewport | control 25 |
> | local VEL-018 safe errors | control 9 |
> | local VEL-019 audits/secret scans | controls 13/18 |
> | local VEL-020 docs sync | control 24 |
> | local VEL-021 50+ commits | control 20 |

| ID | Requirement | Target | Part | State (14 Oct 2026, through Part 7) |
|---:|---|---|---:|---|
| VEL-001 | Account and invitation security | M1 / pilot | 1 | VERIFIED (local scope) |
| VEL-002 | Clinic and record isolation | M1 | 1 | VERIFIED (local scope) |
| VEL-003 | Recovery episodes and assigned team | M1 | 3 | VERIFIED (local scope) |
| VEL-004 | Private validated document intake | M1 | 4 | VERIFIED (local scope; no antivirus provider, quarantine has no review screen yet) |
| VEL-005 | Manual draft and source review | M1 | 5 | VERIFIED (local scope; hand-authored items only) |
| VEL-006 | Clinical approval gate | M1 | 5 | VERIFIED (local scope; approval alone still activates nothing) |
| VEL-007 | Patient current-approved plan view | M1 | 5 | VERIFIED (local scope) |
| VEL-008 | AI extraction with source evidence | M2 | 6 | VERIFIED (local scope; synthetic data, deterministic local provider only, **no external provider selected or called**; the manual Part 5 workflow is the shipped default) |
| VEL-009 | Reviewed Hindi/English presentation | M2 | 6 | VERIFIED (local scope; reviewer-approved renderings only) |
| VEL-010 | Immutable care-plan versioning | M1 / later scheduling | 5 | VERIFIED (approved versions immutable, one current version per episode, superseded history retained; Part 7 schedule preparation reads the current approved version and never mutates it) |
| VEL-011 | Granular caregiver sharing | Code 1 | 2 | VERIFIED (local scope; the honoured non-profile scopes are `view_tasks`/`log_tasks` (Part 7) and `view_checkins`/`log_checkins`/`ask_questions` (Part 8), each enforced server-side per request; `view_episodes`/`view_documents`/`view_plan` stay deliberately inert) |
| VEL-012 | Medication schedules and actor logs | M3 | 7 | VERIFIED (local scope; only the current approved, clinically accepted items produce a schedule, a medication schedule activates only through the assigned verified reviewer, occurrences are UTC with an explicit IANA zone, and entries are append-only and attributed with idempotent retries) |
| VEL-013 | Daily recovery tasks | M3 | 7 | VERIFIED (local scope; task items use the same occurrence engine, an explicit audited activation and the same day view) |
| VEL-014 | Notifications and delivery records | M3 / M4 | 8 | VERIFIED (local scope; in-app only: dedupe by recipient/event/version/channel under a unique index, a stored recheck immediately before delivery, bounded retry with a visible failure and delivery-is-not-acknowledgement; **no external provider selected or called** - email/SMS/WhatsApp/push stay refused until disclosed) |
| VEL-015 | Clinic-defined recovery check-ins | M4 | 8 | VERIFIED (local scope; versioned templates, activation by the assigned verified reviewer only, idempotent slot materialisation, append-only answers, `no_response` never classified, clinic rules = workflow attention never a diagnosis) |
| VEL-016 | Clarification queue and history | M4 | 8 | VERIFIED (local scope; open/assigned/answered/closed/explicitly-reopened with append-only actor-time history, clinical answers need the assigned verified reviewer, coordinators operational only, internal notes never patient-visible, response hours never imply 24/7 cover) |
| VEL-017 | Assigned team dashboard | M4 | 8 | VERIFIED (local scope; five queues and counts derived from active care-team assignments only, administrator refused outright, explicit claim/release with history) |
| VEL-018 | Basic prescribed follow-up | M4 | 8 | VERIFIED (local scope; prescribed date/location/contact/instructions only - results, reports and referrals refused at validation; caregiver reads require `view_tasks` on an active grant) |
| VEL-019 | Operational closure and history | Code 1 | 9 | PLANNED - Part 7 already blocks new activity on a closed episode and never rewrites history |
| VEL-020 | Privacy, audit, export/deletion and retention | foundation..M5 | 9 | PARTIAL - append-only audit history exists (Parts 1-7); export/deletion/retention are Part 9 |
| VEL-021 | Workflow metrics without clinical inference | Code 1 | 9 | PLANNED (Part 7 exposes counts of recorded states only, and never an adherence judgement) |

## 3a. Foundation items carried as Security-25 controls, not VEL IDs

The table above no longer carries the old local VEL-017..VEL-021 rows. Their guarantees are live and
covered by the controls named in section 6: one-viewport screens (25), the safe error envelope (9),
dependency audit plus tree/history secret scans (13, 18), documentation synchronized with code (24)
and meaningful commits without padding (20).

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
