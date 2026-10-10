# Velora MERN - 10 Production-Grade Build Prompts

Repository: https://github.com/Swayamjain1240/Velora  
Stack decision: JavaScript MERN - MongoDB, Express.js, React.js, Node.js.  
Verified repository state on 10 October 2026: the GitHub repository is empty, with no branch or commit. Part 1 must therefore initialize the repository carefully. If local files exist, inspect and preserve them before creating anything.

These prompts rebuild Velora in MERN. Use them in order. Each prompt is standalone and repeats the permanent security, documentation, Git and viewport contract.

---

## Prompt 1 - Repository foundation, authentication and clinic permissions

```text
Act as Velora's senior MERN architect, security engineer and implementation owner. Work directly in https://github.com/Swayamjain1240/Velora using JavaScript only: MongoDB + Mongoose, Express.js, React.js with Vite, and Node.js. Do not introduce TypeScript, Python, FastAPI or SQL. The GitHub repository was observed empty on 10 October 2026, but recheck it and all available local files before changing anything.

START WITH DUCK
Before implementation, perform a Duck review. Read VELORA_MASTER.md, VELORA_ARCHITECTURE.md, VELORA_SYSTEM_DESIGN.md, VELORA_STRUCTURE.md and VELORA_SESSION_LOG.md if present, plus README.md, AGENTS.md and repository instructions. Inspect the branch, remote, Git status, files, history, open work and dependency manifests. Report the actual state as VERIFIED, PARTIAL, PLANNED, DRIFT or BLOCKED. Preserve every existing user file. If the repository is truly empty, initialize it; if it is not empty, adapt the plan and never overwrite working code. Record the Duck result in VELORA_SESSION_LOG.md before closing the part.

note for duck:- if any file missing you have to review this three file 1. VELORA_MERN_MASTER 2. VELORA_MERN_ARCHITECTURE 3.VELORA_MERN_ARCHITECTURE

PRODUCT BOUNDARY
Velora coordinates post-discharge recovery. It does not diagnose, prescribe, decide urgency, certify recovery or auto-publish AI output. Build Code 1 first. Code 2 diagnostic tests/results and Code 3 insurance remain deferred. Use synthetic identities/data only.

PART 1 SCOPE
1. Create a clean monorepo structure: client/, server/, docs/, .github/workflows/ and root scripts where useful.
2. Create/update the five reference Markdown documents named above, README.md, .env.example and .gitignore. Never copy real values into documentation or examples.
3. Build React routing with public routes and a protected authenticated application shell.
4. Build Express application boundaries: config, middleware, models, validators, controllers, services, policies, routes, errors, audit and tests.
5. Implement User, Clinic, ClinicMembership, MembershipRole, Invitation, Session, MFA/recovery-code, PasswordReset, RateLimitBucket and AuditEvent models with useful compound indexes and timestamps.
6. Use Argon2id for passwords. Use opaque, hashed, revocable server-side sessions in httpOnly cookies. Do not store authentication tokens in localStorage. Use Secure cookies in production, SameSite policy, expiry, rotation/revocation and CSRF protection for cookie-authenticated mutations.
7. Implement login, logout, current-user, revoke-all sessions, password reset, staff invitation acceptance, TOTP MFA enrol/verify/recovery codes and clinic staff administration. Staff must complete MFA. Invitation/reset/recovery tokens are random, single-use, expiring and stored only as hashes.
8. Implement server-side RBAC plus clinic scope. Admin manages membership but admin role alone must never grant future clinical-record browsing. Clinical-reviewer eligibility is separately verified and cannot be self-granted.
9. Create accessible login/MFA/staff screens. Every authenticated screen must fit one viewport through steps, tabs and pagination.
10. Add an automated CI gate for server tests, client tests/lint/build, browser journeys, dependency/runtime audit and secret scanning.

PERMANENT SECURITY-25 CONTRACT - VERIFY THROUGHOUT THIS PART
1. Hide every API key and secret. Never print, expose, commit or send secrets to the browser.
2. Validate required environment variables at server startup and fail closed with safe messages.
3. Protect private routes on both the React router and Express server; the server is authoritative.
4. Use proper authentication: Argon2id passwords, revocable secure sessions, MFA and safe reset/invitation flows.
5. Enforce access on the server using identity, clinic, role, ownership/assignment/grant and workflow state. Default deny.
6. Validate and sanitize every body, param, query, header and form; reject unknown fields where practical.
7. Prevent XSS. Do not render unsanitized HTML or use dangerouslySetInnerHTML for user/model content.
8. Apply appropriate atomic rate limits to login, reset, invitation, MFA and other abuse-sensitive operations.
9. Use one safe response/error envelope such as { error: { code, message } }; never leak stack traces, secrets or existence across tenant boundaries.
10. Configure an exact CORS allowlist; never use wildcard origins with credentials.
11. Apply security headers with Helmet and an explicit CSP suitable for the app.
12. Keep production debug mode off and disable verbose error output.
13. Check official compatibility and dependency security before installing/upgrading; pin compatible versions and document exceptions.
14. Remove unused packages and dead scaffolding.
15. Check exposed/private files. Track .env.example only. .gitignore must cover .env, .env.*, logs, coverage, build output, uploads/private storage, keys, editor/OS files and local test artifacts while explicitly allowing .env.example.
16. Keep MONGODB_URI and all database credentials in the server environment only. Never expose them through VITE_ variables, client bundles, logs or Git.
17. Passwords use Argon2id/bcrypt only and never plaintext or reversible encryption.
18. Scan the current Git tree and complete reachable history for leaked secrets before every part closes.
19. Perform and document a security audit before marking the part complete.
20. After each coherent feature or about 300 meaningful LOC: run relevant tests, inspect git diff and staged diff, then make and push one meaningful commit when authorized. Preserve history, target 50+ meaningful commits across all ten parts and never create fake commit spam.
21. Treat security as continuous design work, not a final patch.
22. Before any external API/service, tell the owner: provider, purpose, API-key name, environment variable and exact backend/frontend location. Do not silently add a vendor.
23. Test every feature after implementation, including denied, invalid, expired, revoked, concurrent and rate-limited paths.
24. Keep README.md, architecture, structure, master and session documentation synchronized with real code.
25. Every authenticated application screen must fit one viewport without page-level vertical scrolling. Never use overflow:hidden to cut content. Use wizards for long forms, pagination for lists/tables, tabs/routes for sections, switchable chart panels and one primary mobile panel. Test desktop, tablet, mobile and short-height/landscape sizes. The marketing landing page may intentionally scroll.

TEST AND EXIT GATE
Test config failure, password hashing, session fixation/revocation, CSRF, CORS, MFA, invitation/reset token races, cross-clinic/admin denials, validation/XSS, rate limits and safe errors. Run MongoDB integration tests against a test database, React tests, production build and at least login/MFA/staff Playwright journeys at 1440x900, 768x1024, 390x844, 320x568, 844x390 and 320x400. Assert required controls remain reachable and document height does not exceed the viewport on authenticated pages. Confirm secret scans and runtime audits. Fix failures; do not weaken tests.

Finish with: exact commits, commands/results, security-25 matrix, Duck verdict, limitations and next authorized part. Push meaningful commits to a feature branch and open/update a review PR when GitHub access is available. Do not start Part 2 automatically.
```

---

## Prompt 2 - Patient onboarding, consent and caregiver access

```text
Continue Velora as a senior JavaScript MERN engineer. Implement only Part 2: clinic-scoped patient onboarding, consent and caregiver access. Do not start episodes, documents, care plans, AI, tasks or reminders.

START WITH DUCK
Read all five Velora reference documents, README, AGENTS instructions, Part 1 review and actual code. Verify branch, Git status, remote/main/PR state, database models/indexes, authentication, MFA, policies, tests and dependencies. Classify Part 1 evidence. If a security or isolation regression exists, repair and verify it before dependent work. Append the Duck evidence to VELORA_SESSION_LOG.md. Preserve user changes.

PART 2 USER FLOW AND DATA
Derive user action -> entity -> permission -> API -> service/transaction -> UI -> failure path -> tests.
Implement PatientProfile, PatientAssignment, PatientConsent, CaregiverGrant and AccessInvitation in Mongoose. Clinic scope is immutable. A patient profile may link to a verified User, but never auto-merge people by name, phone or email. Consent is append-only history with actor/time/purpose. Caregiver access is explicit, granular, expiring/revocable where appropriate and inactive until invitation acceptance. Revocation blocks future requests immediately. A caregiver cannot invite others or receive clinical approval rights.

Implement staff patient-create/search/list/detail/assignment flows; patient activation and own-profile view; consent update/history; caregiver invite/accept/list/revoke; granular scopes such as view_profile and permitted future categories without silently granting episode or document access. Require current clinic intake assignment for staff reads/writes. Patient owner controls their grants. Return scoped counts and use server pagination. Avoid exposing whether a record exists in another clinic.

Build compact React panels using a multi-step patient form, paginated lists and one primary mobile panel. Clear stale sensitive data after 401/403/404 or scope changes. Never show a previously loaded patient's data after a denied refresh.

PERMANENT SECURITY-25 CONTRACT
1 hide keys/secrets; 2 validate required env at startup; 3 protect private React and Express routes; 4 preserve Argon2id, MFA, revocable secure cookie sessions and CSRF; 5 enforce server-side clinic + role + assignment/ownership/grant + state with default deny; 6 validate/sanitize bodies, params, queries, headers and forms; 7 prevent XSS/unsafe HTML; 8 add atomic rate limits to patient search/create, invitations, acceptance and revocation; 9 use the shared safe error envelope without tenant-existence leakage; 10 exact credentialed CORS allowlist; 11 Helmet/CSP/security headers; 12 production debug and stack responses off; 13 check official compatibility/security before dependency changes; 14 remove unused packages; 15 audit ignored/tracked private files; 16 keep MONGODB_URI server-only; 17 preserve Argon2id/bcrypt and never plaintext passwords; 18 scan Git tree/history for secrets; 19 document a security audit before completion; 20 test -> diff -> meaningful commit -> push after coherent work/~300 meaningful LOC, target 50+ whole-project commits without padding; 21 apply security continuously; 22 disclose provider/purpose/key/env/location before any external API; 23 test every feature and failure path; 24 sync README and all project docs; 25 authenticated pages fit one viewport without page scroll or clipping: wizards, pagination, tabs/routes and mobile single-panel; test desktop/tablet/mobile/short/landscape. Landing page may intentionally scroll.

MONGODB DESIGN REQUIREMENTS
Use compound unique indexes for clinic-scoped identifiers and active-grant/invitation invariants. Use transactions where multiple documents must change atomically; tests must use a replica-set-capable MongoDB. Prevent operator injection and unsafe dynamic query construction. Apply projection so internal token hashes, audit payload internals and unrelated PII never enter API responses. Store timestamps in UTC.

TEST AND EXIT GATE
Test two clinics, unassigned staff, inactive membership, wrong patient owner, pre-acceptance caregiver denial, scope denial, revoked access, expired/single-use invitation race, duplicate identities, patient activation, append-only consent and safe pagination totals. Test CSRF, validation, rate limits, XSS strings and stale UI clearing. Run full Part 1 regression, client build and browser journeys at all six viewport sizes. Run dependency/runtime audits and tree/history secret scans. Fix every in-scope failure.

Update API documentation, architecture/structure if code changed, README setup, Part 2 review and session log. Finish with observed evidence, security-25 status, Duck verdict and remaining limits. Use a feature branch, meaningful commits and review PR. Do not start Part 3.
```

---

## Prompt 3 - Recovery episodes and care-team assignment

```text
Implement Velora Part 3 in the existing JavaScript MERN repository: recovery episodes and care-team assignment. Preserve Parts 1-2. Do not add document intake, care-plan instructions, AI, schedules or reminders.

START WITH DUCK
Read the five reference documents, README, AGENTS, prior part reviews and current source. Inspect Git/PR state, Mongo indexes, tenant policies, authentication, patient access, frontend routes and full tests. Establish whether Parts 1-2 are VERIFIED. Fix verified in-scope drift before extending it. Record Duck evidence in VELORA_SESSION_LOG.md.

PART 3 DESIGN
Implement RecoveryEpisode, CareTeamAssignment and EpisodeCorrection. Every hospitalization gets a distinct immutable clinic/patient identity and clinic-scoped reference. Episode states begin conservatively (draft; activation will be tied to Part 5 approval). Store discharge date plus an explicit IANA timezone. Preserve revision numbers for optimistic concurrency.

Implement APIs and services for assigned-staff episode creation, staff paginated list/detail, draft discharge-date correction with expected revision, correction history, patient-owned list/detail, eligible team-candidate listing, team listing, assignment and revocation. Responsibilities are care_coordinator and clinical_reviewer. Reviewer candidates require current verified eligibility. An administrator may perform narrowly defined team administration but cannot use admin status to read episode clinical metadata. Ending the last eligible assignment must fail. Reassignment creates a new interval; never erase history.

Use Mongoose sessions/transactions and atomic filters such as {_id, revision} so parallel updates against the same revision cannot both succeed. Use unique/partial indexes to protect active assignment and episode reference invariants. Repeat no-op requests should not create duplicate history. Audit every creation, correction, assignment and revocation without clinical content.

Build staff and patient episode panels with stepped creation/correction, paginated episode/team/correction lists and compact actions. Clear loaded data after authorization loss or denied refresh.

PERMANENT SECURITY-25 CONTRACT
1 secrets hidden; 2 required env validated; 3 private React/Express routes protected; 4 existing Argon2id/MFA/revocable sessions/CSRF preserved; 5 backend clinic + role + patient assignment/ownership + episode assignment + state checks, default deny; 6 validate/sanitize all input and reject unknown fields; 7 no unsafe HTML/XSS; 8 atomic limits for episode creation/team mutations/reads as appropriate; 9 shared safe error envelope and scoped 404; 10 exact CORS allowlist; 11 security headers/CSP; 12 production debug off; 13 dependency compatibility/security check first; 14 remove unused packages; 15 private-file audit; 16 MONGODB_URI server-only; 17 Argon2id/bcrypt only; 18 full Git tree/history secret scan; 19 end-of-part security audit; 20 coherent feature/~300 LOC -> test, inspect diff, meaningful commit and push; 50+ whole-project target, no fake commits; 21 continuous security; 22 disclose every external provider/purpose/key/env/backend-or-frontend location before use; 23 test every feature/failure/concurrency path; 24 docs/README match code; 25 every authenticated screen fits one viewport without page-level vertical scroll or clipped overflow; use wizards/pagination/tabs/routes/single mobile panels and test six sizes. Landing page may scroll.

TEST AND EXIT GATE
Test clinic isolation, unassigned staff, intake-assignment versus episode-assignment separation, inactive/ineligible staff, admin metadata denial, patient ownership, duplicate references, future dates, timezone/date boundaries, stale revision, concurrent corrections, parallel assignment, revocation history, last-assignee protection and safe scoped totals. Run full Parts 1-2 regression, Mongo replica-set integration, client checks/build and Playwright journeys across all six viewports. Secret scans and runtime audits must pass or an exact documented non-runtime exception must be approved; never hide it.

Synchronize README, API docs, system design, project structure, Part 3 review and session log. Finish with exact commands/results, commits/PR, Security-25 matrix, Duck verdict and known limits. Do not start Part 4.
```

---

## Prompt 4 - Private discharge-document intake

```text
Implement Velora Part 4 in JavaScript MERN: private, technically validated discharge-document intake. Preserve Parts 1-3 and clinical boundaries. Ready means technically accepted for later review; it never means clinically approved.

START WITH DUCK
Read all five project references, README, instructions, prior part API/review docs and actual code. Verify Git/PR/branch/dirty state, current CI, access policy, episode state, dependencies and storage configuration. Fix in-scope drift before building documents. Record the Duck findings. Use synthetic files only.

EXTERNAL SERVICE GATE
Do not silently choose S3, Cloudinary, Firebase, antivirus, OCR or another service. Before any external API, tell the owner its provider, purpose, API-key name, environment variable and server/client location. Until explicitly selected, implement a private encrypted development storage adapter outside the repository/web root and a provider-neutral interface. Store document metadata in MongoDB, not public URLs.

PART 4 DESIGN
Implement EpisodeDocument with episode/clinic relationship derived server-side, opaque storage key, original display name, allowlisted media type, byte size, SHA-256, technical status, uploader and timestamps. Enforce unique episode+checksum and opaque-key indexes.

Allow PDF, JPEG and PNG only with a conservative 10 MiB limit. Validate filename, declared media type, extension and magic bytes. Parse in an isolated bounded worker process/thread with time/memory/concurrency limits. Reject encrypted PDFs, active content/JavaScript/actions, attachments/forms/external references, malformed/truncated files, excessive pages/objects/decoded content and image pixel bombs/multiple frames. Do not claim antivirus certification.

Implement authenticated upload, paginated list, metadata detail and ready-only download. Authorize before reading the upload, then recheck session, owner/current eligible episode assignment and episode state before persistence. Use streaming size bounds, never buffer unlimited bodies. Upload/download limits must be separate. Return private attachments through the API after a fresh authorization check, integrity/decryption verification, audit, no-store/nosniff and restrictive CSP. Do not put filenames in URLs or normal logs.

Encrypt originals at rest using an independently configured server key. Use UUID object keys, exclusive writes and restrictive directory/file permissions where supported. Implement visible failed/rejected/quarantined states, duplicate behavior and safe retry. Document database/file atomicity limits. Add an offline dry-run reconciliation command; destructive apply requires explicit operator attribution and audit. Backups must treat Mongo metadata, encrypted objects and key as one set.

Build a staged choose -> review -> upload -> result React flow, paginated document list and authenticated blob download. Clear rows/blobs after access denial and revoke object URLs.

PERMANENT SECURITY-25 CONTRACT
1 hide keys, Mongo URI and document key; 2 validate all required env and storage pairing at startup; 3 protect private routes/files; 4 preserve secure auth/MFA/sessions/CSRF; 5 server-side clinic + owner/assignment + state authorization; 6 validate/sanitize all metadata, headers and bytes; 7 prevent unsafe rendering and force attachment behavior; 8 rate/concurrency/resource limits; 9 shared safe errors with no parser paths/diagnostics; 10 exact CORS allowlist including only required headers; 11 security headers plus file-response controls; 12 production debug off; 13 dependency security/official docs checked before parser/storage packages; 14 remove unused packages; 15 .env/uploads/private objects/keys ignored and tracked files audited; 16 MONGODB_URI server-only; 17 preserve Argon2id/bcrypt; 18 scan Git tree/history; 19 documented security audit; 20 test -> diff -> meaningful commit/push after coherent work/~300 LOC, 50+ project target without spam; 21 continuous security; 22 provider disclosure before any external API; 23 test every happy/denied/adversarial path; 24 sync README/docs; 25 authenticated upload/list/status screens fit one viewport using steps/pagination/tabs and one mobile panel, no overflow clipping; test all six sizes.

TEST AND EXIT GATE
Use adversarial synthetic fixtures: wrong MIME/extension, traversal filename, empty/oversized upload, encrypted/active/malformed/huge PDF, image pixel bomb, timeout, worker saturation, duplicate concurrency, write failure, ciphertext tamper, symlink/path attack, missing object and revoked assignment. Test owner/assigned staff/other clinic/admin-only/caregiver-profile denial and closed/read-only state. Downloaded ready bytes must equal the uploaded original. Run full regression, production client build, Mongo integration and browser upload/quarantine/download journeys at six viewports. Audit dependencies and Git secrets.

Update docs with exact API limits, storage setup, recovery boundary, tests and Duck verdict. Do not start Part 5.
```

---

## Prompt 5 - Manual care plans, clinical review, approval and versioning

```text
Implement Velora Part 5 in JavaScript MERN: manual source-linked care plans, clinical review, approval, patient approved-plan view and immutable versioning. This completes the first synthetic M1 vertical slice. Do not add AI extraction, automatic schedules or reminders.

START WITH DUCK
Read the five reference documents, README/instructions, Parts 1-4 reviews/contracts and actual code. Verify Git/PR/CI state, clinic/episode/document policy, reviewer eligibility, document readiness, audit and viewport behavior. Fix in-scope drift and record the Duck result before implementation continues.

PART 5 DOMAIN AND STATE
Implement CarePlanVersion, CarePlanItem, SourceReference and ReviewEvent with explicit episode/clinic linkage, version number, revision and states such as draft, in_review, needs_clarification, approved and superseded. Store original clinical strings, units, conditions and source page/quotation/location. A missing, conflicting or unclear dose/frequency/duration must remain unresolved and block approval; never guess.

Care coordinators assigned to the episode can create/edit manual drafts. Only a current assigned, active, clinic-verified clinical reviewer can request clarification and approve. Clinic admin alone cannot read/approve. Patients and caregivers cannot see drafts. Patient owner sees only the current approved version plus approval actor/time and allowed source references. Existing approved content is immutable. Editing after approval creates a new draft version while the old approved version remains current.

Implement APIs for draft create, item CRUD/reorder with expected revision, source linking only to ready authorized documents, submit-for-review, reviewer clarification, resubmit, approve and patient current-approved read/version history as permitted. In one Mongo transaction and with revision/current-version constraints, approval must validate completeness, approve the new version, supersede the old current version, update the episode's current approved pointer/state and audit the event. Parallel approval cannot create two current versions. Repeated retries must be safe/idempotent.

Build compact source-and-draft review using tabs or split switchable panels, not a tall page. Use item pagination/step editing and one primary mobile panel. Make approval consequences explicit and keyboard accessible.

PERMANENT SECURITY-25 CONTRACT
1 hide secrets; 2 validate env; 3 protect private and draft routes; 4 preserve Argon2id/MFA/revocable sessions/CSRF; 5 enforce server clinic + role + current episode assignment + verified reviewer + state + owner/grant; 6 strict validation/sanitization/unknown-field rejection; 7 render all clinical/model/user text as text, no unsafe HTML; 8 rate-limit draft mutations, review and approval; 9 shared safe error envelope, scoped 404, 409 stale/incomplete; 10 strict credentialed CORS; 11 headers/CSP/no-store; 12 production debug off; 13 check dependency security/compatibility first; 14 remove unused packages; 15 private file audit; 16 MONGODB_URI server-only; 17 Argon2id/bcrypt only; 18 Git history/tree secret scan; 19 end security audit; 20 test/diff/meaningful commit/push after coherent work/~300 LOC, 50+ total without padding; 21 continuous security; 22 disclose any external API before use; 23 test all features, denials, state and races; 24 synchronize README and five docs; 25 every authenticated plan/review screen fits one viewport via steps, paginated items, tabs/routes and mobile single-panel; never clip content; test all six viewports.

TEST AND EXIT GATE
Test coordinator/reviewer/admin/owner/caregiver/other-clinic boundaries; unready/wrong-episode source; incomplete/conflicting items; invalid transitions; stale edit; concurrent approvals; immutable approved version; supersession/current pointer; patient draft denial; revoked reviewer; audit without raw clinical text; XSS strings; pagination and stale UI clearing. Run Mongo replica-set transactions, full Parts 1-4 regression, client build and full synthetic browser journey from patient -> episode -> document -> manual draft -> review -> approve -> patient read at six viewport sizes. No reminder/task is created by approval in this part.

Perform Duck against VEL-005, VEL-006, VEL-007 and VEL-010 plus all 25 controls. Update README, API/system docs, traceability, Part 5 review and session log with exact evidence. Do not claim clinical validation or start Part 6.
```

---

## Prompt 6 - AI draft extraction, source citations and reviewed language services

```text
Implement Velora Part 6 in JavaScript MERN: AI-assisted, source-linked draft extraction and reviewed Hindi/English presentation. AI is an untrusted drafting tool with zero approval/publication authority. Manual Part 5 flow must continue to work when AI is unavailable.

START WITH DUCK
Read all reference/project docs, instructions, current source, Part 5 state/approval rules and test evidence. Verify Git, CI, dependency and secret state. Confirm the manual M1 flow is still verified. Fix drift first and append the Duck review.

MANDATORY EXTERNAL-API DISCLOSURE GATE
Before installing an AI/OCR SDK or making a network request, present a concrete disclosure: provider, purpose, model/service, API-key name, environment-variable name, exact server module, confirmation that no key enters React, data sent, retention/region terms to review, cost/rate implications and local/test fallback. Do not invent a provider. If the owner has not selected one, implement a provider-neutral adapter, deterministic fake provider and evaluation fixtures; stop vendor integration at that clean boundary while completing all provider-independent work.

PART 6 DESIGN
Implement ExtractionJob, ExtractedField/DraftSuggestion, SourceCitation, ModelRun and ReviewedLanguageVariant. Jobs attach to an authorized ready document and target a new/unapproved plan draft. Treat document content as data, never instructions or tool authorization. The model receives the minimum needed data and cannot call Velora mutation tools.

Define a strict JSON schema for medication names, dose, route, frequency, duration, home care, activity/diet, written follow-up and warning instructions. Preserve original text. Every suggested field needs page/location/text evidence or an explicit missing/conflict flag. Validate model output server-side; reject unknown keys, unsafe sizes and citations outside the supplied source. Do not normalize ambiguous abbreviations into invented facts.

Implement queued job states, bounded input/output, timeouts, retries with dedupe/idempotency, cancellation/failure visibility and manual fallback. Recheck current access and document/draft version before starting and before applying suggestions. Applying a suggestion is a separate actor-attributed draft edit; it never approves. Translation/simplification is versioned, source-linked and must be explicitly reviewed by an assigned eligible reviewer before appearing to the patient.

Build review UI that compares original source, extracted suggestion and accepted manual value through tabs/switchable panels. Display AI status and uncertainty plainly. Keep one viewport with paginated fields and one mobile panel.

PERMANENT SECURITY-25 CONTRACT
1 secrets/API keys server-only and redacted; 2 validate env only when selected provider is enabled, fail closed; 3 protect all job/result routes; 4 preserve secure auth; 5 server clinic/assignment/document/draft/version access and no AI authority; 6 validate/sanitize prompts, schemas, outputs and forms; 7 no unsafe HTML from documents/model; 8 job/user/provider/concurrency limits and budget bounds; 9 safe consistent errors without prompts, source text, keys or provider diagnostics; 10 exact CORS; 11 headers/CSP/no-store; 12 debug off and provider logging redacted; 13 official docs/data terms/dependency audit before SDK; 14 remove unused SDKs; 15 exclude prompts/fixtures with private data, .env and caches; 16 MONGODB_URI/provider keys server-only; 17 preserve Argon2id; 18 Git tree/history secret scan; 19 AI threat/security audit; 20 test/diff/meaningful commit/push per coherent feature/~300 LOC, 50+ total and no spam; 21 continuous security; 22 complete provider disclosure before any external API; 23 test every state/failure/adversarial output; 24 sync README/five docs/model contract/evaluation record; 25 authenticated AI review fits one viewport via pagination/tabs/routes/mobile one-panel, no clipped overflow; test six sizes.

TEST AND EXIT GATE
Use synthetic authorized examples. Test prompt injection text, malformed/oversized JSON, wrong citation, missing/conflicting dose, timeout, retry/dedupe, provider failure, stale draft, revoked assignment, cross-clinic job, new approved/current version race, translation review and manual fallback. Evaluate extraction separately with field precision/recall or exact-match plus citation correctness and missing/conflict detection; do not call software-test success clinical accuracy. Run full prior regression, production build, browser journeys and secret/runtime audits.

Update AI architecture, provider disclosure/decision, threat model, API docs, evaluation limits, Part 6 review and session log. Finish with Duck status and do not start Part 7.
```

---

## Prompt 7 - Medication schedules, daily tasks and actor-attributed logs

```text
Implement Velora Part 7 in JavaScript MERN: patient/caregiver daily tasks, approved medication schedules and actor-attributed logs. Only approved clinician-confirmed plan items may generate schedules. Do not create diagnostic judgments or recommend substitute/extra doses.

START WITH DUCK
Read five reference docs, instructions, current code and Parts 1-6 evidence. Inspect Git/CI, approved-version invariants, caregiver scopes, timezones and AI/manual boundaries. Repair drift first and append a Duck record.

PART 7 DESIGN
Implement MedicationSchedule, RecoveryTask, ScheduleOccurrence and ActivityLog. Link every generated schedule/task to the exact approved CarePlanVersion and item. Preserve original dose/route/timing/condition. Conditional/PRN medicine must not become an unconditional repeating dose. Store occurrence instants in UTC with episode/user scheduling timezone and DST-safe generation.

Implement reviewer/coordinator-authorized schedule preparation from approved items, explicit review/activation where required, patient Today view, and log states taken, skipped, reported_done, needs_help and not_recorded as distinct facts. Every log stores subject, acting user, role/grant, occurrence time and recorded-at time. Caregiver can log only with an active granular permission. Duplicate retries are idempotent. Corrections append history; do not silently rewrite a medication record.

When a plan version changes, prepare reconciliation that ends/supersedes affected future occurrences and creates only appropriate new ones. Never change historical logs. Episode closure will be completed later but read-only state must stop new activity where already defined.

Build a compact Today screen with date switching, tabs for medication/tasks and pagination/virtual bounded panels. Mobile shows one category at a time. Do not imply that no entry means nonadherence or that a self-report is clinician verified.

PERMANENT SECURITY-25 CONTRACT
1 hide secrets; 2 validate env/timezone config; 3 protect routes; 4 preserve authentication/MFA/sessions/CSRF; 5 server-side clinic + owner/assignment + caregiver scope + approved-version/state access; 6 validate/sanitize inputs, enums, timestamps and IDs; 7 safe text rendering; 8 limits for logging/schedule generation/list reads; 9 shared safe errors; 10 strict CORS; 11 security headers/no-store; 12 production debug off; 13 dependency security first; 14 remove unused packages; 15 private file audit; 16 MONGODB_URI private; 17 Argon2id/bcrypt only; 18 Git secret scans; 19 security audit; 20 coherent feature/~300 LOC -> tests, diff, meaningful commit/push, 50+ total no spam; 21 continuous security; 22 disclose external APIs before use; 23 test every feature/failure/race/time boundary; 24 sync README/docs; 25 every authenticated Today/schedule screen fits one viewport via tabs/pagination/routes/mobile single panel, no overflow clipping; test six viewports.

TEST AND EXIT GATE
Test unapproved/draft source rejection, conditional medicine behavior, missing schedule details, timezone/DST boundaries, duplicate logging, concurrent log, patient/caregiver/denied-scope/other-clinic/staff attribution, revoked grant, stale plan version, version reconciliation and historical immutability. Test that missed/not-recorded never creates double-dose advice. Run full regression, Mongo integration, client build, browser journeys at six sizes, audits and secret scans.

Update domain/system design, API docs, safety wording, Part 7 review and session log. Duck against VEL-010 through VEL-014. Do not start Part 8.
```

---

## Prompt 8 - Check-ins, clarification queue, dashboard and safe reminders

```text
Implement Velora Part 8 in JavaScript MERN: recovery check-ins, clarification queue, assigned team dashboard, in-app reminders and basic prescribed follow-up. Do not build diagnostic-test tracking, autonomous escalation or continuous monitoring claims.

START WITH DUCK
Read all reference docs/instructions, inspect Git/CI/source and Parts 1-7 evidence. Verify approval/version, caregiver, task, timezone and assignment rules. Fix regressions before dependent work and record Duck.

PART 8 DOMAIN
Implement CheckInTemplateVersion, CheckInResponse, ClarificationThread, ClarificationMessage, QueueAssignment, Notification and DeliveryAttempt. Clinic-defined check-in templates and review rules are versioned. Missing response remains missing; it is not interpreted as normal or abnormal recovery. Rule-triggered review means clinic-configured workflow attention, not AI diagnosis.

Clarifications have open, assigned, answered, closed and explicitly reopened transitions with actor/time/history. Patients or authorized caregivers can ask within scope. Clinical answers require an assigned eligible clinical reviewer; coordinators can answer only operational questions within their authority. Display clinic response hours and emergency instructions without implying 24/7 monitoring.

Build assigned dashboard queues for pending approval, questions, check-in reviews, failed reminders and missing owners. Every list/count must be tenant- and assignment-scoped. Admin alone cannot browse content.

Implement in-app reminders first. Dedupe by recipient, event/version and channel. Before delivery recheck current episode state, approved version, task relevance and active recipient authorization. Retry with bounded attempts and visible failure; delivery is not acknowledgement. Basic follow-up contains only prescribed date/location/contact and reminders, never test-result or referral workflow.

If email/SMS/WhatsApp/push or a queue provider is proposed, first disclose provider, purpose, API key, env variable and server/client location. Use a provider-neutral fake/in-app implementation until authorized.

Build dashboard, check-in and clarification screens with tabs, routes, pagination and one mobile queue/panel at a time.

PERMANENT SECURITY-25 CONTRACT
1 hide secrets; 2 env validation; 3 protected routes/queues; 4 preserve secure auth; 5 backend clinic + assignment/owner/grant + message type/state access; 6 validate/sanitize templates/responses/messages/queries; 7 no unsafe HTML; 8 limits for check-ins/messages/reminders/dashboard; 9 safe shared error envelope; 10 exact CORS; 11 headers/CSP/no-store; 12 debug off; 13 dependency/vendor security review; 14 remove unused packages; 15 private file audit; 16 MONGODB_URI private; 17 Argon2id/bcrypt only; 18 Git secret scans; 19 end security audit; 20 tests/diff/meaningful commit/push per feature/~300 LOC and 50+ total without spam; 21 continuous security; 22 external API disclosure first; 23 test every happy/denied/failure/retry path; 24 sync README/docs; 25 authenticated dashboard/check-in/thread pages fit one viewport using paginated queues, tabs/routes and mobile one-panel; no clipped overflow; test six sizes.

TEST AND EXIT GATE
Test template versions, duplicate/late/missing responses, clinic rules without diagnostic language, caregiver scope, cross-clinic/unassigned/admin denial, clinical versus operational response authority, assignment/reopen history, response hours wording, notification dedupe/retry/revocation/stale plan/closed episode, acknowledgement separation and follow-up scope. Run full regression, Mongo transaction tests, client build, browser journeys and audits/secret scans.

Update API, notification/reliability design, Part 8 review, traceability and session log. Duck against VEL-014 through VEL-018. Do not start Part 9.
```

---

## Prompt 9 - Closure, archive, audit, privacy requests, retention and metrics

```text
Implement Velora Part 9 in JavaScript MERN: episode closure/archive, comprehensive audit, workflow metrics, export/deletion-request handling and retention controls. Closure is an operational workflow state and never means medically recovered.

START WITH DUCK
Read the five reference docs, instructions, all part reviews and current code. Inspect Git/CI, existing audit quality, episode/plan/task/reminder states, storage reconciliation and privacy boundaries. Fix drift first and record Duck.

PART 9 DESIGN
Implement explicit close preflight that lists unresolved approvals, clarifications, failed deliveries, open tasks/check-ins and ownership gaps. Authorized assigned staff records closure reason/date; required clinic policy checks must be explicit. Closure atomically changes the episode state, stops future schedules/reminders by policy, preserves historical read-only data and writes audit. Reopening, if supported, is separate, authorized, justified and reconciles only allowed future work.

Implement immutable/append-only AuditEvent coverage for sensitive reads/downloads, role/grant changes, approval, AI application, logs, responses, export/deletion requests and closure. Avoid raw clinical text, secrets and unnecessary PII in audit payloads. Add scoped audit search with pagination and strict role/record access.

Implement privacy-request workflows rather than immediate destructive endpoints: DataRequest with export, correction and deletion-request types, identity verification state, owner, deadlines/status, approval/execution evidence and legal/clinical retention holds. Export is generated asynchronously, encrypted/private, time-limited and freshly authorized. Deletion is policy-driven and may be denied/limited when retention is required; preserve a defensible audit record. Do not execute real destructive data deletion without explicit authorization and tested backup/restore.

Implement configurable retention categories and a dry-run report. Apply requires explicit operator, reason and idempotent audited plan. Include documents, generated exports, sessions/tokens and operational logs. Add operational metrics such as approval time, clarification response time, queue age and coordination workload. Do not infer clinical success, adherence or reduced readmission.

Build closure preflight, history, privacy request and metric screens using steps, paginated tables and switchable chart panels.

PERMANENT SECURITY-25 CONTRACT
1 secrets hidden; 2 validate retention/export env; 3 protect archive/audit/export/admin routes; 4 preserve secure auth/step-up checks where appropriate; 5 backend record/role/purpose/state access; 6 validate/sanitize filters/reasons/requests; 7 safe rendering/export encoding; 8 rate/job/download limits; 9 safe shared errors; 10 exact CORS; 11 headers/no-store/download CSP; 12 debug off; 13 dependency security first; 14 remove unused packages; 15 private exports/backups/keys ignored and audited; 16 MONGODB_URI private; 17 Argon2id/bcrypt only; 18 history/tree secret scans; 19 privacy/security audit; 20 feature/~300 LOC -> tests/diff/meaningful commit/push; 50+ total no spam; 21 continuous security; 22 disclose storage/job/external API providers before use; 23 test every transition/denial/dry run/failure; 24 sync README/five docs/retention runbook; 25 every authenticated closure/audit/privacy/metric screen fits one viewport using wizards, pagination, tabs and switchable charts/mobile panel; test six sizes, never clip.

TEST AND EXIT GATE
Test unresolved preflight, authorization, concurrent close, reminders/tasks stopped, history immutable, read-only behavior, reopen if present, audit redaction/scoping, export access/expiry/revocation, request state machine, retention dry-run/idempotency/hold, failure recovery and metrics definitions. Test cross-clinic/admin-only/owner boundaries. Run full regression, replica-set transactions, client build, browser journeys, dependency audit and secret scans. Use synthetic data only.

Update privacy/retention/audit documentation, incident implications, Part 9 review and session log. Duck against VEL-019 through VEL-021 and all 25 controls. Do not start production deployment or Part 10 automatically.
```

---

## Prompt 10 - Production hardening, recovery and clinical-readiness gate

```text
Complete Velora Part 10 as a senior MERN security/reliability engineer. Prepare and verify production hardening, backup/restore, provider/privacy review and clinical-readiness evidence. Do not deploy, purchase services, send external messages or process real patient data unless the owner explicitly authorizes those actions.

START WITH DUCK
Read the five project reference documents, README, AGENTS, all Part 1-9 reviews, current source, dependencies, CI, Git/PR history and open findings. Re-run traceability for VEL-001 through VEL-021 and all 25 controls. Inspect actual behavior rather than accepting documentation claims. Fix ordinary in-scope reversible drift, verify it and append the final Duck record.

PART 10 WORK
1. Validate production configuration schema: NODE_ENV=production, exact HTTPS origins, secure cookies, trusted proxy settings, Mongo TLS/credentials, key separation, log level, timeouts, body limits and disabled debug/source diagnostics.
2. Create provider-neutral production decisions for hosting, MongoDB, private object storage, email/notification, job processing, AI/OCR and monitoring. Before connecting any provider, disclose provider, purpose, key, env variable, server/client location, data sent, region/retention and cost. Never place secrets in React/VITE values.
3. Implement health/readiness endpoints without sensitive configuration; graceful shutdown; bounded connection pools; request IDs; safe structured logs with redaction; alert-worthy operational events; dependency failure behavior.
4. Harden sessions, cookie/domain/proxy assumptions, CSRF/CORS/CSP/HSTS, account/MFA recovery, key rotation strategy and secret rotation runbooks.
5. Create backup and restore runbooks covering MongoDB, encrypted objects, encryption keys and configuration. Perform an isolated synthetic restore test and record recovery point/time observations. Never claim restore readiness from backup creation alone.
6. Exercise document-storage integrity and reconciliation, retention dry runs, queue retry/dead-letter handling, current-version/reminder reconciliation and disaster scenarios.
7. Complete threat modeling for tenant escape, broken object authorization, credential stuffing, session theft, stored XSS, NoSQL/operator injection, malicious files, prompt injection/model data leakage, supply chain and insider/admin misuse.
8. Add/verify CI protections: pinned lockfiles, runtime dependency audit, secret tree/history scanning, tests/build/browser gate and branch/PR recommendations. Do not weaken a gate to make it green.
9. Verify accessibility, keyboard reachability, responsive one-viewport behavior and safe empty/error/loading states. Perform real-browser coverage; document Safari/physical-device/extreme-zoom gaps honestly if unavailable.
10. Produce a readiness report separating PASSED, FAILED, BLOCKED and NOT APPLICABLE. Clinical workflow review, privacy/legal decision, incident ownership, response hours, partner clinic, selected procedure and authorized datasets are explicit gates, never inferred from code.

PERMANENT SECURITY-25 CONTRACT
1 hide/rotate keys and secrets; 2 validate required env and fail closed; 3 protect every private route/file/job; 4 verify Argon2id, MFA, revocable sessions, recovery and CSRF; 5 verify server-side clinic/role/assignment/ownership/grant/state on reads, writes, lists, counts, exports and background jobs; 6 validate/sanitize every input and prevent NoSQL injection; 7 prevent XSS/unsafe model/document HTML; 8 verify distributed/atomic rate and resource limits appropriate to deployment; 9 consistent safe response/errors and redacted logs; 10 exact CORS allowlist; 11 CSP/Helmet/HSTS and attachment headers; 12 production debug off; 13 check dependency advisories/official compatibility before upgrades and document remaining risks; 14 remove unused packages; 15 find exposed .env, keys, uploads, exports, backups, source maps and private files; 16 secure Mongo credentials/TLS/network boundaries; 17 Argon2id/bcrypt only, no plaintext; 18 scan reachable Git history and tree for secrets; 19 final security audit/threat model; 20 after each coherent fix/~300 LOC test, inspect diff, meaningful commit/push; preserve 50+ real whole-project commits, no padding; 21 security continuous; 22 disclose every external provider before integration; 23 test every feature and failure/recovery path; 24 synchronize README, five core docs, API/runbooks and evidence; 25 every authenticated screen fits one viewport without page scroll or clipping, using steps/pagination/tabs/routes/switchable charts/mobile one-panel and testing desktop/tablet/mobile/short landscape. Marketing may scroll.

FINAL VERIFICATION
Run complete server unit/integration/concurrency/security suites against replica-set Mongo, complete React tests/lint/build, all Playwright journeys at six viewports, dependency/runtime audits, software-bill/lockfile review and Git secret scans. Run synthetic backup/restore, outage and permission-revocation exercises. Verify no real health data or production secret entered fixtures/logs/history. Recheck every original failure after fixes.

Create the final Part 10 review, security matrix, threat model, operations/restore runbook, provider decision register, requirements traceability and session entry. Open/update the review PR with meaningful preserved commits. Do not claim zero bugs, regulatory compliance, clinical validation or real-patient readiness. State the exact owner/clinical/privacy decisions still required before any pilot or deployment.
```

---

## Usage rule

Run one prompt at a time. Review and merge one completed part before giving the next prompt. Say **Duck** whenever you want an additional alignment and security checkpoint. If a later requirement changes, update the five reference documents and session log before allowing code and documentation to diverge.
