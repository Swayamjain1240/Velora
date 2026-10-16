# Velora MERN - Architecture

Companion to `VELORA_MASTER.md`. Describes trust boundaries, the request lifecycle, the data model,
the access policy and the verification strategy for the code in `server/` and `client/`.

## 1. Trust boundaries

| Boundary | Untrusted side | Trusted side | Enforced by |
|---|---|---|---|
| Browser -> API | React app, cookies, all request input | Express app, session store, MongoDB | `server/src/middleware/*`, routes, services |
| API -> database | request bodies/params/queries | Mongoose models and indexes | `server/src/models/*`, validators |
| Tenant -> tenant | any clinic id supplied by a client | caller's own membership only | `loadClinicContext`, `loadSession` |
| Secrets -> bundle | anything reaching the browser | server env only | `config/env.js`, `.env.example`, Vite (no server var import) |
| Admin -> clinical | admin role | verified clinical reviewer | `requireVerifiedReviewer`, `staffService.setReviewerEligibility` |
| Uploaded bytes -> app | any uploaded file (parser input) | the validating process | isolated `worker_threads` parser with a reduced env, time/memory caps (`documentValidator`, `workers/documentParser`) |
| App -> object store | caller-supplied key or path | opaque UUID keys only | `documentStorage.objectPath` regex + exclusive writes |
| Metadata -> bytes | MongoDB document row | encrypted object under a separate key | `documentService` verify-on-download (size + SHA-256) |

Key principle: **the server is the only authorization boundary.** React route guards improve UX and
must never be relied on for security.

## 2. Request lifecycle

```
request
  -> requestContext        (request id, client ip, UA)                       [security.js]
  -> securityHeaders       (Helmet + explicit CSP)                           [security.js]
  -> corsPolicy            (exact credentialed allowlist)                    [security.js]
  -> express.json 32kb     (body size cap)
  -> cookieParser
  -> global /api limiter   (300 req/min safety net)                          [app.js]
  -> loadSession           (attach req.session/req.user/req.memberships)     [auth.js]
  -> csrfProtection        (mutating + cookie -> double submit + session bind) [csrf.js]
  -> route middleware      (requireAuth, requireMfaPendingSession,
                            loadClinicContext, requirePermission,
                            requireVerifiedReviewer, mongoRateLimit)         [auth.js]
  -> validate              (strict zod schemas)                              [validate.js]
  -> controller            (thin: map request -> service, shape response)
  -> service               (business rules, audit, models)
  -> errorHandler          (safe envelope `{ error: { code, message } }`)    [errorHandler.js]
```

### 2a. Document upload and download (Part 4)

```
upload
  -> requireAuth, loadClinicContext
  -> validate(params) + upload rate limit
  -> requireDocumentUploadAccess  (session, clinic, ACTIVE team assignment,
                                  draft episode)  <-- BEFORE any body byte
  -> boundedBody                  (hard 10 MiB cap; longer body destroyed)
  -> documentService.uploadDocument
       -> sha256 + isolated validation worker (time/memory/concurrency/queue caps)
       -> duplicate check on unique {episode, sha256}
       -> insert metadata `uploading` (or reuse a rejected/failed row)
       -> exclusive encrypted object write -> status `ready`
       -> audit `document.uploaded` / `document.rejected` / `document.quarantined`

download
  -> validate(params) + SEPARATE download rate limit
  -> documentService.downloadDocument
       -> fresh access resolution (assignment or patient ownership)
       -> status must be `ready`
       -> decrypt, verify byte size AND SHA-256, else mark `failed` and refuse
       -> audit `document.downloaded`
  -> no-store + nosniff + restrictive CSP + attachment disposition
```

The raw bytes travel in the request body with the declared type in `Content-Type` and the display
filename percent-encoded in `X-Document-Filename`; no filename ever appears in a URL, a query string
or a routine log line. Responses only ever carry the `publicDocument` projection (never the storage
key, a path or a URL).

`loadSession` never throws on a missing/invalid cookie: it simply leaves the request
unauthenticated, and each protected route decides. `csrfProtection` is a no-op for
unauthenticated requests (no session cookie) and for safe methods; it is enforced for any
cookie-authenticated mutation by comparing the `x-csrf-token` header against both the readable
`velora_csrf` cookie and the `csrfSecret` bound to the server-side session (timing-safe).

## 3. Authentication design

- **Passwords:** Argon2id via `argon2` (`services/passwordService.js`). Never stored reversibly.
- **Sessions:** opaque 32-byte random token in an `httpOnly` cookie (`velora_session`). Only a
  peppered HMAC-SHA256 hash is persisted (`Session.tokenHash`). Revocable server-side records with
  `expiresAt`, `lastSeenAt` and `revokedAt`.
- **Fixation defense:** login always creates a fresh session; MFA verification **rotates** the token
  (`sessionService.activateSession`) so a pre-MFA cookie value can never be replayed.
- **CSRF:** double-submit between the readable `velora_csrf` cookie and the `x-csrf-token` header,
  additionally bound to the session's stored secret.
- **MFA (TOTP):** staff must enroll. The secret is generated server-side, stored **encrypted at
  rest** with AES-256-GCM (`services/crypto.js`), shown once over the authenticated channel, and is
  **idempotent** on repeated setup calls (the same unconfirmed secret is reused). Recovery codes are
  10 hex chars, stored only as HMAC hashes, single-use via an atomic conditional update.
- **Reset / invitation tokens:** random, single-use, expiring, stored only as hashes.

## 4. Authorization design

- `loadClinicContext` resolves `req.clinicId`/`req.roleKey`/`req.permissions` from the caller's own
  **active membership** - never from a request id. Cross-tenant access is therefore structurally
  impossible, and a request for another clinic's resource resolves to 404 without revealing existence.
- Roles are stored per clinic in `MembershipRole` with a permission set; `SYSTEM_ROLES` in
  `config/constants.js` is the catalog seeded into every clinic.
- `admin` holds only administrative permissions (`clinic.update`, `staff.invite`, `staff.manage`,
  `audit.read`). Clinical permissions (`clinical.review`) exist solely for the reviewer role.
- Reviewer eligibility is a separate `reviewerEligibility.status` on the membership. It can only be
  set to `verified` by a **different already-verified eligible reviewer** of the same clinic; admin
  role alone never satisfies the check and self-verification is rejected.
- Invariants enforced in `staffService`: a clinic can never lose its last active admin (deactivation
  or demotion of the last admin is a conflict); entering the reviewer role starts as `pending`
  (never auto-verified) and leaving it clears eligibility.
- Part 2 patient access requires an ACTIVE intake assignment (staff), ownership (patient) or an
  ACTIVE scoped grant (caregiver); otherwise a uniform 404.
- Part 3 episode clinical metadata requires an ACTIVE care-team assignment or patient ownership. An
  administrator is EXPLICITLY denied (403) episode clinical metadata, but may perform narrowly
  defined team administration (roster/candidates/assign/revoke) that returns no clinical fields.
  A non-member staff user gets a uniform 404. Team assignment of a clinical reviewer requires the
  reviewer's eligibility to be currently `verified`; the last active assignment can never be
  revoked.
- Part 7 schedules and occurrences inherit Part 5 authority and add none. `POST
  /episodes/:id/schedules/prepare` needs permission `schedule.prepare` on an ACTIVE care-team
  assignment and, in the same request, re-checks that the episode is not closed and that the exact
  `planVersion` is `approved` **and still current**; an administrator without a clinical assignment
  is denied, and a patient or caregiver never reaches the route at all. Activation of a medication
  schedule needs permission `schedule.activate` *and* the assigned, clinic-verified clinical
  reviewer, so preparation can never activate itself. Ending a schedule follows preparation
  authority. No Part 7 route edits clinical content: the schedule is a frozen copy, so this surface
  can never widen what a clinician approved.
- Part 8 (check-ins, clarifications, dashboard, reminders, follow-ups) adds no new way in: the
  clinic still comes from the membership, the episode scope from an ACTIVE care-team assignment, and
  the patient/caregiver surfaces from ownership or an ACTIVE scoped grant (`view_checkins`,
  `log_checkins`, `ask_questions`, `view_tasks`). The dashboard is refused to administrators,
  patients and caregivers outright; a clinical clarification or a triggered check-in review is
  answerable only by the ASSIGNED, clinic-verified reviewer (eligibility alone is never enough),
  while coordinators answer only operational questions; the patient side of a thread may ask, reply,
  close and reopen but never answer, assign or read an internal note.
- Part 7 day view and entry recording (`/today`) deliberately carry **no** clinic-wide permission.
  A patient is recognised by ownership of their own profile (`linkedUserId`), a caregiver by the
  scope of their ACTIVE, unexpired grant (`view_tasks` reads the day, `log_tasks` records an entry,
  and neither is implied by the other or by `view_profile`), and staff by an ACTIVE care-team
  assignment - the clinic is derived from the record or the grant, never from the request. A user
  with no relationship to the patient gets the same uniform 404 as a caller from another clinic, a
  closed episode is exposed as read-only, and a revoked grant or superseded plan version closes the
  surface on the next request (the client keeps no clinical content cached).

## 5. Data model (Parts 1-9)

| Model | Purpose | Notable indexes |
|---|---|---|
| `User` | identity, Argon2id hash, MFA state, status | unique `email` |
| `Clinic` | tenant | unique `code` |
| `ClinicMembership` | user <-> clinic with role, status, eligibility | unique `(clinic,user)`; `(clinic,status)` |
| `MembershipRole` | per-clinic role + permission catalog | unique `(clinic,key)` |
| `Invitation` | staff invite token (hash only) | unique `(clinic,email)` for pending; `tokenHash` |
| `Session` | revocable session, hashed token, csrfSecret | `tokenHash`; TTL/`expiresAt` |
| `MfaRecoveryCode` | hashed single-use recovery codes | `(user,codeHash,usedAt)` |
| `PasswordReset` | reset token (hash only) | `tokenHash`; `expiresAt` |
| `RateLimitBucket` | atomic fixed-window counters | unique `(key,windowStart)` |
| `AuditEvent` | append-only actor-attributed audit trail | `(clinic,createdAt)` |
| `PatientProfile` | clinic-scoped patient record (draft/active) | unique `(clinic,reference)`; `linkedUserId` |
| `PatientAssignment` | intake assignment intervals (active/revoked) | partial unique `(clinic,patient,memberUser)` where `status='active'` |
| `PatientConsent` | append-only consent history | `(clinic,patient,createdAt)` |
| `CaregiverGrant` | scoped, revocable caregiver access | unique `(clinic,patient,granteeEmail)`; `caregiverUser` |
| `AccessInvitation` | caregiver / patient-activation token (hash only) | `tokenHash`; partial unique outstanding `(clinic,email,kind)` |
| `RecoveryEpisode` | one hospitalization; immutable identity + revision | unique `(clinic,reference)`; `(clinic,patient,createdAt)` |
| `CareTeamAssignment` | episode team intervals (active/revoked) | partial unique `(clinic,episode,memberUser)` where `status='active'` |
| `EpisodeCorrection` | append-only discharge-date correction history | `(clinic,episode,correctedAt)` |
| `EpisodeDocument` | private document **metadata** (opaque key, display filename, allowlisted type, size, SHA-256, technical status) | unique `storageKey`; unique `(episode,sha256)`; `(clinic,episode,createdAt)` |
| `CarePlanVersion` | one version of a manual care plan for an episode (state, revision, approval facts, current/superseded) | unique `(episode,version)`; **partial unique `(episode)` where `isCurrent:true, state:'approved'`**; `(clinic,episode,version)` |
| `CarePlanItem` | one clinical instruction (verbatim original wording + structured fields + computed `unresolvedFields` + review state) | `(version,order)`; `(clinic,episode,version)` |
| `SourceReference` | citation of one READY document of the same episode (page, quoted text, location) | `(item,createdAt)`; `(version,createdAt)` |
| `ReviewEvent` | **append-only** plan timeline (actor, transition, bounded reason) | `(clinic,episode,at)`; `(version,at)` |
| `MedicationSchedule` | verbatim copy of ONE approved medication item + generation inputs and lifecycle | unique `(planVersion,item)`; `(clinic,episode,status)` |
| `RecoveryTask` | verbatim copy of ONE approved task item + generation inputs and lifecycle | unique `(planVersion,item)`; `(clinic,episode,status)` |
| `ScheduleOccurrence` | one due slot: UTC instant + local date/time + zone + offset; **no adherence column** | unique `(owner,scheduledAtUtc)`; `(clinic,patient,localDate)` |
| `ActivityLog` | **append-only** attributed entry: subject, actor, role/grant, occurrence time, recorded-at state, correction link | unique `(clinic,clientRequestId)`; `(occurrence,sequence)` |
| `CheckInTemplateVersion` | one immutable version of a clinic check-in template (questions, cadence, window, literal review rules) | unique `(clinic,key,version)`; `(clinic,updatedAt)` |
| `CheckInResponse` | one materialised slot (template key + local date); append-only answers, derived `no_response` | unique `(clinic,episode,slotKey)`; `(clinic,patient,dueAt)` |
| `ClarificationThread` | one question with kind, state machine and append-only transition history | `(clinic,episode,state,lastMessageAt)` |
| `ClarificationMessage` | append-only plain-text message (`question`/`answer`/`note`/`system`), `patientVisible` | `(thread,createdAt)` |
| `QueueAssignment` | explicit dashboard ownership of a queue target (claim/release, history) | partial unique active owner per target |
| `Notification` | one reminder: recipient, event/version, channel, state, attempts, dedupe key | **unique `dedupeKey`**; `(clinic,recipientUser,state)` |
| `DeliveryAttempt` | one bounded attempt: number, outcome, stored recheck verdict, safe reason | `(notification,attempt)` |
| `FollowUpPlan` | prescribed follow-up: date, location, contact, instructions, active/cancelled | `(clinic,episode,scheduledFor)` |
| `EpisodeClosure` | **append-only** closure/reopen event: action, resulting state, bounded reason, operational closure date, actor, policy checks, preflight snapshot | `(clinic,episode,at)`; `(clinic,action)` |
| `DataRequest` | privacy request (export/correction/deletion_request): requester, identity state, owner, deadline, decision + reason, execution evidence, retention hold | `(clinic,status,dueAt)`; `(clinic,requesterUser)` |
| `DataExport` | generated artifact **metadata** (opaque key in a separate store, size, expiry, revocation) | `(request)`; `(clinic,expiresAt)` |
| `ExportDownloadGrant` | short-lived, single-use download authorization (**peppered hash only**) | `tokenHash`; `(request,expiresAt)` |
| `RetentionPolicy` | per-clinic, per-category window + report-only/applied mode | unique `(clinic,category)` |
| `RetentionRun` | one dry run or apply: operator, reason, cutoff, per-category counts, idempotency key | unique `(clinic,clientRequestId)`; `(clinic,createdAt)` |
| `RetentionHold` | a hold that freezes a category (or one subject inside it) until release | `(clinic,category,releasedAt)` |

`AuditEvent` gains a category, a scope (`subjectType`/`subjectId`) and a bounded redacted detail
payload in Part 9; `Session`, `RateLimitBucket` and `EpisodeDocument` gain the retention metadata the
run reads (never rewrites).

The Part 5 contract for the plan collections, the Part 7 contract for these four collections, the
Part 8 contract for the coordination collections and the Part 9 contract for closure, audit, privacy
requests, retention and metrics - states, safety wording, authority matrix, HTTP endpoints,
rate-limit buckets and reconciliation - are [VELORA_CARE_PLAN.md](VELORA_CARE_PLAN.md),
[VELORA_SCHEDULES.md](VELORA_SCHEDULES.md),
[VELORA_CARE_COORDINATION.md](VELORA_CARE_COORDINATION.md) and
[VELORA_PRIVACY_RETENTION.md](VELORA_PRIVACY_RETENTION.md).

Timestamps are UTC. Compound unique indexes enforce clinic-scoped identifiers and active-grant
invariants. Projections keep `tokenHash`, `csrfSecret`, internal audit payloads and unrelated PII
out of API responses (`publicUser`, `publicMember`, `publicPatient`, `publicAssignment`,
`publicGrant`, `publicEpisode`, `publicTeam`, `publicCorrection`).

## 6. Rate limiting

Sensitive operations use a MongoDB-backed **atomic fixed window** (`RateLimitBucket` +
`rateLimitService.consume` with a conditional `$inc` upsert). Because the counter lives in the
database, limits hold across restarts and multiple server processes, unlike in-memory token
buckets. A coarse in-memory `express-rate-limit` sits under `/api` as a safety net.

| Operation | Limit |
|---|---|
| login | 10 / 15 min per ip+email |
| MFA verify | 10 / 15 min per session |
| forgot password | 5 / hour per ip+email |
| reset / accept-invite / create-clinic | 10 / hour |
| staff invite / mutations | 30 / 60 per hour per user |
| patient create / read / mutate | 60 / 600 / 120 per hour per user |
| caregiver invite | 30 / hour per user |
| caregiver / activation acceptance | 10 / hour per ip |
| episode create / read / mutate | 60 / 600 / 120 per hour per user |
| document upload | 20 / hour per user |
| document download | 120 / hour per user |
| document metadata read | 600 / hour per user |
| care-plan read | 600 / hour per user |
| care-plan draft mutation (version/item/source/submit/resubmit) | 240 / hour per user |
| care-plan review mutation (item decision, clarification, approve) | 60 / hour per user |
| schedule read (schedules, occurrences, activity log) | 600 / hour per user |
| schedule prepare / end | 60 / hour per user |
| schedule activation | 120 / hour per user |
| day view (`/api/today`) read | 600 / hour per user |
| day view entry recording | 240 / hour per user |
| check-in / clarification / reminder / follow-up read | 600 / hour per user |
| check-in submit, reminder acknowledge, follow-up write | 120 / hour per user |
| ask/reply/close/reopen a clarification thread | 60 / hour per user |
| answer a clarification thread / close a triggered check-in review | 120 / hour per user |
| reminder delivery batch | 30 / hour per user |
| dashboard read / dashboard claim-release | 300 / 120 per hour per user |

## 7. Client architecture

- Vite + React + `react-router-dom`. Public routes and one protected `/app` shell.
- `AuthContext` mirrors the server's `next` contract (`active`, `mfa_verify`, `mfa_enroll`) so the
  router sends users to the correct MFA screen; the router guard is UX only.
- `lib/api.js` is a thin `fetch` wrapper using **cookie sessions only** - no tokens in
  `localStorage`. It reads the readable `velora_csrf` cookie and attaches it to every mutation.
- Part 2 adds role-scoped feature areas under `/app`: the staff patient list/detail
  (`features/patients`), the patient's own records (`features/patient`), and the caregiver's scoped
  view (`features/caregiver`). Part 3 adds the staff episode list/detail (`features/episodes`) and
  the patient's own episode view. The nav only links a role to the area it can reach.
- Part 4 adds `features/documents` (`DocumentsPanel`, `DocumentUpload`, `documentRules`) inside the
  episode detail: a `choose -> review -> upload -> result` wizard, a paginated list with a technical
  status summary and per-document notes, and an authenticated **blob** download
  (`lib/api.downloadDocument`) whose object URL is revoked after the download starts. `uploadDocument`
  posts raw bytes with the filename in a header. A denied read clears the list and shows a safe
  sentence; nothing in the UI ever presents `ready` as clinical approval.
- Part 5 adds `features/plans` inside the episode detail (`CarePlanPanel`, `PlanItemForm`,
  `PlanSourcePanel`, `PlanReviewPanel`, `planRules`) and the patient's read-only approved plan
  (`features/patient/PatientPlan`). The workspace uses tabs (Draft / Sources / Review / History), a
  multi-step draft wizard, a **two-step item editor** (core clinical fields, then the remaining
  instructions) and server pagination (8 items per page), so it stays inside one viewport; the
  source and review panes sit side by side on wide screens and stack to a single primary panel on
  narrow ones. Every mutation sends the plan revision the screen holds; a 409 clears the stale editor
  and re-reads the plan, and a 403/404 clears the loaded clinical content entirely.
- Part 6 adds `features/extraction` (`ExtractionPanel`, `LanguagePanel`, `extractionRules`) inside
  the same plan workspace as two extra tabs (Extraction / Language), beside - never instead of - the
  manual tabs. `ExtractionPanel` shows the source citation, the AI suggestion, the accepted value
  and the decision as **switchable panels**, with paginated suggestion and field lists; the only
  actions are apply (an ordinary draft edit) and dismiss, and there is no approve/publish/prescribe
  control anywhere. `LanguagePanel` links each Hindi/English rendering to the instruction it renders,
  shows the numeric-guard result, and requires an assigned reviewer's fidelity statement to approve.
- Part 7 adds `features/today` (`TodayView`, `todayRules`) - the one-viewport day screen with a
  Previous/Next/Today switcher, Medication/Task tabs (one category at a time), bounded paginated
  panels, per-row record and correct actions and explicit self-report labels - and
  `features/schedules` (`SchedulePanel`) as a new `Schedule` tab in the episode detail for the staff
  workspace: prepared schedules, a paginated occurrence table showing local **and** UTC values, the
  attributed recorded-entry history and the explicit **Prepare from approved plan** control. The
  client never renders an entry as a missed dose and never calls a self-report a verification.- Part 8 adds `features/queues` (`AssignedQueues`, `ThreadView`, `CheckInForm`) - the staff queue screen with five server-counted tabs, a paginated list inside its own scrolling panel, explicit claim/release/retry actions and a thread/check-in detail pane - and `features/care` (`MyCare`), the patient's own panel (and the caregiver's grant-scoped mirror) with check-ins, questions and follow-ups behind tabs. Counts and lists always come from the server already scoped; a denied read clears the panel and shows a safe sentence.
- Part 9 adds `features/closure` (`ClosurePanel`) as a `Closure` tab in the episode detail - a
  three-step wizard (preflight / checks / confirm) with the history and reopen behind a tab switch -
  plus four standalone screens: `features/audit` (`AuditPanel`, paginated scoped search),
  `features/privacy` (`PrivacyPanel`, request list + workflow detail), `features/retention`
  (`RetentionPanel`, category windows, dry run and the gated apply) and `features/metrics`
  (`MetricsPanel`, switchable operational panels). The wizard never offers a clinical outcome, a
  deletion request is presented as an evaluation against retention rather than an instant delete, and
  an export download is a freshly authorized, short-lived link.
- A denied refresh or a lost authorization clears the loaded patient/consent/grant state before an
  error is shown, so stale clinical data never remains on screen.
- All server errors surface through a safe envelope; the client never renders unsanitized HTML.
- Every authenticated screen uses the one-viewport pattern (see `VELORA_MASTER.md §7`).

## 8. Errors, logging and observability

- One envelope: `{ error: { code, message } }`. `errorHandler` maps known `AppError`s to codes and
  statuses, and collapses unknown errors to a generic `INTERNAL` message - never a stack trace
  (control #9, #12).
- `X-Request-Id` is set on every response and the same id is attached to the structured log line for an
  unhandled error, so a user report can be traced to one server event.
- **Structured logs with redaction (Part 10).** `services/logger.js` writes one JSON object per line
  with a named `event`, filters on `LOG_LEVEL`, replaces sensitive keys at every depth (including
  inside `Error` objects), bounds strings/arrays/depth, and suppresses stack traces in production.
  Clinical text is never logged: callers pass counts, ids and error summaries.
- **Probes.** `/api/health` (liveness) and `/api/ready` (dependency readiness) are mounted before the
  rate limiter, the session resolver and CSRF, disclose no configuration, and are the only
  unauthenticated `/api` surfaces besides the public invitation/landing routes.
- Audit events are append-only and actor-attributed (`auditService.record`); a failed audit write is an
  alert-worthy `audit.write_failed` event rather than a silent `console.error`.

## 9. Verification strategy

- **Unit:** crypto/password helpers, env fail-closed behavior.
- **Integration:** MongoDB test database. Covers login/MFA/logout lifecycle, session fixation
  rotation, CSRF, invitation/reset single-use races, cross-clinic and admin-alone denials, last-admin
  invariant, reviewer self-grant denial, validation/XSS, rate limits, safe errors and MFA enrollment
  idempotency.
- **Client:** Vitest for the API wrapper (CSRF attach, error envelope) and auth flow routing.
- **Integration (Part 2):** clinic isolation, unassigned-staff denial, intake-vs-episode separation,
  inactive/ineligible staff, admin clinical-metadata denial, patient ownership, duplicate-reference
  rejection, consent append-only history, caregiver single-use/expiry/scope/revocation, last-assignee
  protection and scoped pagination totals.
- **Integration (Part 3):** clinic isolation, unassigned-staff denial, intake-vs-episode separation,
  admin clinical-metadata denial with narrow team administration, reviewer eligibility, last-assignee
  protection, duplicate references, future dates, timezone boundaries, stale revision, concurrent
  corrections and parallel assignment.
- **Integration (Part 4):** wrong MIME, wrong extension, traversal filename, empty file, oversize
  file, encrypted PDF, active PDF, PDF attachment/form, page and object limits, malformed PDF, image
  pixel bomb, parser timeout, worker saturation, duplicate concurrency, storage-write failure,
  ciphertext tampering, symlink/path attacks, missing object, revoked assignment, other clinic,
  admin-only denial, caregiver-profile-only denial and closed/read-only episodes - plus a
  downloaded-bytes-equal-uploaded-bytes assertion.
- **Browser:** Playwright journeys (login, forced MFA enrollment, staff screens, patient onboarding ->
  consent -> activation -> caregiver invite -> episode creation -> discharge correction) at all six
  viewport sizes, asserting the authenticated pages do not exceed the viewport height.
- **Browser (Part 4):** one document journey per viewport size - upload a synthetic PDF through
  `choose -> review -> upload -> result`, download it and compare the bytes with the uploaded
  original - plus a refusal journey (active PDF), a closed-episode read-only check and a patient
  read-only check.
- **Integration (Part 5):** coordinator drafting authority, reviewer authority (assigned + verified
  only), admin clinical denial, patient and caregiver draft denial, other-clinic 404s, revoked
  reviewer, unverified reviewer assignment denial, ready-document-only source linking with
  wrong-episode 404s, incomplete items, unclear and conflicting dose/frequency/duration, invalid
  transitions, stale revision (including two parallel writes), parallel approval, the DB-level
  one-current-version constraint, approved immutability, supersession and the episode pointer, the
  patient's current-approved projection, XSS strings kept verbatim, audit redaction (no clinical text
  in `AuditEvent`/`ReviewEvent`) and the append-only review timeline.
- **Browser (Part 5):** `plans.spec.js` runs the whole synthetic M1 slice - manual draft, source
  citation, submit, per-item clinical acceptance, confirmed approval and the patient's approved view
  (including "approval activates no task or reminder") - and measures the draft, sources, review and
  patient plan screens at all six viewport sizes.
- **Browser (one-viewport, cross-part):** `viewports.spec.js` measures every list route for five
  enrolled role sessions (reviewer, admin, document coordinator, patient, caregiver) at all six
  sizes, and `detail-viewports.spec.js` walks into the staff patient detail, the staff episode detail
  and the caregiver's scoped patient detail at all six sizes.
- **Integration (Part 6):** prompt injection in document text, malformed/oversized/unknown-key
  output, wrong and outside-source citations, missing/conflicting dose, timeout, bounded retries,
  deduplication and idempotency, provider failure and the provider-disabled fallback, stale draft,
  revoked assignment, cross-clinic job, the current-approved-version race, translation review and
  manual fallback. `languageVariants.test.js` covers the rendering lifecycle and reviewer authority.
- **Browser (Part 6):** `extractions.spec.js` runs the AI journey with the deterministic local
  provider (create draft -> job -> source/AI/missing/conflict panels -> accept-and-apply -> dismiss ->
  Hindi draft/submit/approve -> prove the patient sees no AI text or rendering) and measures the
  extraction and language panels at all six viewport sizes; a second test proves the **shipped
default** (`EXTRACTION_PROVIDER=none`) fails closed while manual drafting keeps working.
- **Evaluation (Part 6):** `scripts/evaluate-extraction.js` (and its unit gate) measures field
  exact-match, missing-field detection, conflict detection, citation correctness, language-fidelity
  guarding and injection detection on synthetic fixtures. This is **software behaviour on invented
  values, not clinical accuracy**; a real provider requires a labelled clinical evaluation.
- **Integration (Part 7):** unapproved/draft/superseded source rejection, non-accepted items,
  conditional/PRN items producing no occurrences, missing schedule details, unanchored intervals,
  IANA/DST boundaries (spring-forward skip, fall-back earlier instant), duplicate and concurrent
  logging, patient/caregiver/denied-scope/other-clinic/staff attribution, revoked and expired grants,
  an inert (declared but unenforced) scope granting nothing, a field-by-field proof that every
  clinical field - `timing` and `condition` included - is copied verbatim from the approved item and
  cannot be rewritten afterwards, stale plan version, version reconciliation, historical immutability
  and closed-episode read-only.
- **Unit (Part 7):** `schedulePolicy.test.js` covers the kind gate, PRN detection, missing-detail and
  interval rules, occurrence bounds, the five day-view states and the safety wording.
- **Browser (Part 7):** `today.spec.js` records a past-day entry as a patient (asserting the
  self-report label and the absence of any "missed dose" wording), records through a scoped
  `log_tasks` caregiver grant, walks the staff schedule workspace (UTC instant column, recorded-entry
  history, preparation control) and measures the day screen - medication and task tabs - at all six
  viewport sizes.
- **Integration (Part 8):** template versioning and activation authority, idempotent slot
  materialisation, duplicate/late/missing answers, rules meaning workflow attention (never a
  diagnosis), clarification transitions with append-only history, clinical-versus-operational answer
  authority, internal-note isolation, response-hours wording, assignment-scoped queues with the admin
  denial, reminder dedupe/recheck/retry/revocation/stale-plan/closed-episode, delivery-versus-
  acknowledgement separation, follow-up scope, and the durable per-route rate limits (a 60th ask
  returns `RATE_LIMITED` on the patient surface too).
- **Browser (Part 8):** `viewports.spec.js` measures the staff queues and the patient care panel at
  all six sizes; `detail-viewports.spec.js` walks into the caregiver's grant-scoped care panel and
  measures it at all six sizes.
- **Integration (Part 9):** an unresolved preflight blocking a close, closure authorization (assigned
  team only, admin and unassigned staff refused, other clinic `404`), a concurrent close losing on the
  revision, reminders/occurrences/schedules/tasks stopping while recorded facts and answered
  check-ins stay untouched, historical immutability, a closed episode read-only for new work and
  history still readable, explicit justified authorized reopen that revives nothing, audit redaction
  (no secret, token or clinical text), audit scope and pagination with the admin-only gate, export
  access/expiry/revocation/foreign-origin denial, the privacy-request state machine with its denials,
  the retention dry run, apply idempotency, a retention hold, partial-failure recovery, the metric
  definitions, cross-clinic denial and patient-owner boundaries.
- **Unit (Part 9):** `closurePolicy.test.js` (recovery language refused, blocking versus advisory
  preflight, authority), `auditCategories.test.js` (every sensitive action categorised, forbidden keys
  redacted), `dataRequestPolicy.test.js` (request transitions, correction field allowlist, deletion
  outcomes).
- **Browser (Part 9):** `part9.spec.js` drives the closure preflight and its policy-check gate (and
  abandons the wizard before submitting), the archived episode's reopen path, the audit search with
  its filters and pagination, the retention dry run with its gated apply, and the switchable metric
  panels - each with a one-viewport assertion. `viewports.spec.js` additionally measures the metrics,
  privacy, audit and retention routes for the enrolled reviewer and admin sessions at all six sizes,
  and `detail-viewports.spec.js` walks the episode closure tab and its history switch at all six
  sizes.
- **Recovery:** `scripts/reconcile-documents.js` dry run is part of the part gate; `--apply` requires
  an explicit operator and audits every repair. The Part 9 retention dry run is the equivalent gate
  for retention, and an export download is the only artifact a privacy request can produce.
- **Unit (Part 10):** `env.test.js` (production refusals: https/bare origin, debug level, short pepper,
  reused keys, non-TLS database, impossible pool bound, proxy hops), `logger.test.js` (level filtering,
  redaction at depth including `Error` objects, production stacks suppressed, bounded output, circular
  values never throw, child bindings), `restoreDrill.test.js` (connection-string re-pointing keeps host
  and options; index options - partial filter, TTL - are recreated; deterministic checksums).
- **Integration (Part 10):** `health.test.js` - liveness needs no session and discloses no path/host,
  readiness reports each probed dependency, `draining` fails closed while liveness stays `200`,
  unusable encrypted storage fails readiness and names the side without leaking the path, and
  `trust proxy` resolves from the validated environment.
- **Browser (Part 10):** `accessibility.spec.js` tabs through the shell, requires a visible focus
  indicator (2px+ outline) and activates a navigation link with the keyboard, proving keyboard
  reachability and activation without changing any state.
- **Recovery drill (Part 10):** `scripts/restore-drill.js` restores rows, indexes and the encrypted
  objects into an isolated database and verifies by reading back (counts, content checksums, index
  signatures, object bytes, decryption against the recorded hash). CI runs it plus the read-only
  reconciliation report on every push.
- **Security:** `npm audit` (production), tree + history secret scan, dependency pin review. The
  production audit is clean; the six remaining dev-only advisories in the test toolchain are reported
  in the readiness report rather than suppressed.

## 10. Production runtime (Part 10)

```text
  process start
    -> loadEnv(): validate every variable, refuse an unusable PRODUCTION posture
       (https/bare CLIENT_ORIGIN, no debug level, 32+ pepper, distinct encryption keys, TLS database,
        sane pool bounds)
    -> assertProviderConfiguration(): unknown provider name or missing key fails here, not on the
       first clinical request (default: none)
    -> connectDb(): bounded pool, selection/connect/socket timeouts from configuration
    -> listen(): request/header/keep-alive timeouts applied; one non-sensitive config summary logged

  request
    -> requestContext (request id, client ip, user agent)
    -> security headers, exact CORS allowlist, bounded JSON body, cookie parser
    -> /api/health and /api/ready  (before the limiter, session and CSRF)
    -> rate limits: coarse in-process per-IP budget + durable Mongo-backed per-route budgets
    -> loadSession -> csrfProtection -> route

  shutdown (SIGTERM/SIGINT/uncaughtException)
    -> readiness flips to `draining`  -> stop accepting connections -> drain in-flight requests
    -> disconnect MongoDB -> exit 0   (or log `shutdown.forced` and exit non-zero past the grace window)
```

Deployment-shape facts worth stating plainly: the API is designed as a **long-running process** with a
bounded pool and a real drain, so a serverless request/response platform does not match its shutdown,
connection-pool or in-process parser assumptions. Proxy trust, TLS termination, the platform
termination grace period and the client host's own security headers are deployment responsibilities
that no code in this repository can assert; they are listed as owner decisions in the readiness report.
