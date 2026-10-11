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

## 5. Data model (Parts 1-2)

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
- **Browser:** Playwright journeys (login, forced MFA enrollment, staff screens, patient onboarding ->
  consent -> activation -> caregiver invite -> episode creation -> discharge correction) at all six
  viewport sizes, asserting the authenticated pages do not exceed the viewport height.
- **Security:** `npm audit` (production), tree + history secret scan, dependency pin review.
