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

## 5. Data model (Parts 1-5)

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

The Part 5 contract for these four collections - states, clinical-field rules, authority matrix, HTTP
endpoints and the single approval transaction - is [VELORA_CARE_PLAN.md](VELORA_CARE_PLAN.md).

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
- A denied refresh or a lost authorization clears the loaded patient/consent/grant state before an
  error is shown, so stale clinical data never remains on screen.
- All server errors surface through a safe envelope; the client never renders unsanitized HTML.
- Every authenticated screen uses the one-viewport pattern (see `VELORA_MASTER.md §7`).

## 8. Errors, logging and observability

- One envelope: `{ error: { code, message } }`. `errorHandler` maps known `AppError`s to codes and
  statuses, and collapses unknown errors to a generic `INTERNAL` message - never a stack trace
  (control #9, #12).
- `X-Request-Id` is set on every response and a request id is available for audit correlation.
- Audit events are append-only and actor-attributed (`auditService.record`).

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
- **Recovery:** `scripts/reconcile-documents.js` dry run is part of the part gate; `--apply` requires
  an explicit operator and audits every repair.
- **Security:** `npm audit` (production), tree + history secret scan, dependency pin review.
