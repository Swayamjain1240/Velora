# Velora MERN - System Design

Detailed design notes and decision records. Companion to `VELORA_ARCHITECTURE.md`.

## 1. Why opaque server-side sessions (not JWT)

A stateless JWT cannot be revoked without a denylist, and medical coordination requires immediate
revocation (staff offboarding, caregiver grant revocation, "sign out everywhere"). Velora therefore
stores a revocable `Session` document keyed by a peppered hash of an opaque random token, delivered
in an `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie. This satisfies control #4 and the
product's revocation invariant. No authentication token is ever written to `localStorage`.

## 2. Why MFA token rotation on promotion

If the pre-MFA cookie value stayed valid after MFA, it would be a fixation vector: an attacker who
obtained the password-only cookie could replay it. `sessionService.activateSession` mints a **new**
token hash on promotion, so the password-stage cookie is dead the moment MFA succeeds. The CSRF
secret is intentionally retained across promotion so the client's readable cookie stays valid; the
CSRF value is not an authentication credential.

## 3. Why double-submit CSRF bound to the session

Cookie auth alone is vulnerable to cross-site requests. The client sends the readable
`velora_csrf` cookie value in the `x-csrf-token` header. The server checks (a) header equals cookie
and (b) header equals the session's stored `csrfSecret`. Check (a) blocks a cross-origin page that
can cause the browser to send cookies but cannot read them; check (b) blocks an attacker who somehow
sets both. Comparisons are timing-safe. Unauthenticated endpoints carry no ambient authority and are
exempt, but remain `SameSite=Lax` and rate-limited.

## 4. MFA enrollment idempotency

React StrictMode double-invokes effects in development. A naive "generate a new secret on every
setup call" produced two secrets, so the scanned code could mismatch the stored one. The design now
**reuses the existing unconfirmed secret**, returning the same `secretBase32` on repeated calls. This
also makes a mid-enrollment refresh safe: the user sees the same QR/secret and the same code will
verify. Covered by an integration regression test.

## 5. Atomic fixed-window rate limiting

A pure in-memory limiter resets on restart and is per-process. Velora uses a `RateLimitBucket`
document with a unique `(key, windowStart)` index and a conditional `$inc` upsert. Two parallel
first-writes can race the unique index; the code catches duplicate-key (11000) and retries the
increment atomically. This gives a correct count under concurrency without a transaction.

## 6. Regex safety in search

Staff search escapes regex metacharacters before building a `RegExp`, so user input cannot construct
a catastrophic-backtracking or overly broad pattern (control #6, NoSQL/regex injection).

## 7. Fail-closed configuration

`config/env.js` validates the entire environment once with zod at startup. Required values must be
present and well-formed; `CLIENT_ORIGIN` must be an exact URL and must be `https` in production;
`MFA_ENCRYPTION_KEY` must decode to exactly 32 bytes. Empty-string exports are treated as absent so a
missing required value reports as missing instead of coercing to a wrong type. Failures throw a safe
message listing only the offending **field names** - never values.

## 8. Error envelope and non-disclosure

Every error leaves through `{ error: { code, message } }`. Known application errors carry a stable
`code`; unknown errors collapse to a generic message and `INTERNAL` code. Authorization failures
never reveal whether a record exists in another clinic: operations resolve the caller's clinic first
and return 404 for out-of-scope ids.

## 8a. Patient access model (Part 2)

A `PatientProfile` is reachable only by a party the record authorises, and whenever none hold the
answer is a **uniform 404** so cross-tenant existence is never revealed:

1. **Ownership** - the linked patient account (`linkedUserId`).
2. **Staff intake assignment** - an ACTIVE `PatientAssignment` for that user. Holding a clinic role
   is never sufficient; `listPatients` returns only the caller's own assigned set (scoped totals).
3. **Caregiver grant** - an ACTIVE, unexpired `CaregiverGrant` holding the required scope. Part 2
   honours only `view_profile`; other scopes are declared but inert, so a future scope cannot
   silently widen today's access. A missing scope is a 404, not a 403.

Consent is **append-only** (`PatientConsent`); activation requires recorded `care_coordination`
consent AND at least one active assignee, so a profile can never be activated with nobody
accountable. The last active assignee can never be revoked (409). A caregiver grant is created
`pending` and only becomes `active` when its single-use invitation is accepted; revocation and
expiry take effect on the very next request.

## 8b. Episode and care-team model (Part 3)

A `RecoveryEpisode` is one hospitalization. Its `clinic`, `patient` and clinic-scoped `reference`
are immutable, so an episode can never be moved between clinics or patients. Episodes begin as
`draft` (activation is tied to Part 5 approval), store a calendar `dischargeDate` plus an explicit
IANA `dischargeTimezone`, and carry a monotonic `revision`.

Draft discharge corrections are **atomic**: the update is filtered on
`{_id, revision, status:'draft'}` and increments `revision`, so two parallel corrections against the
same revision cannot both succeed - the loser gets a 409 and reloads. A no-op (same value) is not
recorded, so a repeated request never creates duplicate history. Every real correction appends an
`EpisodeCorrection` row (previous/new value, revision before/after) - rows are never updated or
deleted.

`CareTeamAssignment` records intervals, never deletions: responsibilities are `care_coordinator` and
`clinical_reviewer`; revoking ends an interval and re-assigning opens a new one. A **partial unique
index** on `(clinic, episode, memberUser)` where `status='active'` makes parallel duplicate
assignment impossible at the database level, so a repeat request is an idempotent no-op. The last
active assignment can never be revoked (409). A `clinical_reviewer` can only be assigned while their
eligibility is currently `verified`.

Access:

| Caller | Episode clinical metadata | Team administration (roster/candidates/assign/revoke) |
|---|---|---|
| Active care-team member | allow | allow |
| Patient owner | allow (own record) | deny |
| Clinic administrator | **deny (403)** - admin status must not read clinical metadata | allow (no clinical fields returned) |
| Other same-clinic staff | uniform 404 | 403 |

## 8c. Document privacy and storage model (Part 4)

`EpisodeDocument` holds **metadata only**: immutable clinic/patient/episode, an opaque UUID
`storageKey`, the original display filename, an allowlisted media type, byte size, SHA-256, a
technical `status`, a stable `rejectionCode` and non-clinical structural facts (page count / pixel
dimensions). No public URL, filesystem path or object-store bucket is ever stored or returned.

Bytes live behind a **provider-neutral interface** (`put`/`get`/`stat`/`remove`/`listKeys`), whose
shipped implementation is a private local provider: objects addressed by UUID keys that are
re-validated against a strict pattern before a path is built, encrypted with AES-256-GCM under a
**separate** `DOCUMENT_ENCRYPTION_KEY`, written exclusively (`wx`), stored `0600` inside `0700`
directories under a root that must be **outside the repository**. No provider is selected yet
(control #22); a future S3/Cloudinary/Firebase provider implements the same interface and callers do
not change.

Validation is isolated and bounded: the raw body is capped while streaming, and the bytes are parsed
inside a `worker_threads` worker with a wall-clock time limit, a V8 heap cap, a concurrency limit, a
bounded queue and an environment containing **no application secrets**. It answers with one of a
fixed set of stable codes; parser internals, paths and stacks never leave the process. Encrypted
PDFs, PDF scripts/actions/attachments/forms/external references, malformed or truncated PDFs,
page/object/stream excesses, image pixel bombs and multi-frame images are **refused**; an
inconclusive verdict **quarantines** the bytes instead of marking them ready.

Write order is `insert metadata (uploading) -> write encrypted object -> set ready`. MongoDB and the
object store are not one transaction, so the three drift states (row without object, object without
final status, checksum mismatch) are documented and reported by the reconciliation command rather
than served. `ready` means technically accepted for later review, **never** clinically approved, and
the subsystem claims no antivirus certification.

Access:

| Caller | Upload | List / metadata | Download (`ready` only) |
|---|---|---|---|
| Active care-team member, `draft` episode | allow | allow | allow |
| Active care-team member, non-draft episode | deny (409) | allow | allow |
| Patient owner | deny (403) | allow (own record) | allow |
| Clinic administrator | deny (403) | deny (403) | deny (403) |
| Revoked assignment / other clinic / caregiver without a scope | deny | uniform 404 | uniform 404 |

## 9. Decision log (Parts 1-4)

| # | Decision | Alternative rejected | Reason |
|---:|---|---|---|
| D1 | Opaque server-side sessions | JWT | immediate revocation, control #4 |
| D2 | Argon2id | bcrypt | control #17; stronger memory-hard default |
| D3 | AES-256-GCM for TOTP seeds | plaintext/encrypted-at-rest-plain | control #1, key validated at startup |
| D4 | Mongo-backed rate limits | in-memory only | durable across restarts/processes, control #8 |
| D5 | Idempotent enrollment | new secret per call | StrictMode/refresh safety |
| D6 | Reviewer eligibility as a separate flag | admin can verify | VEL-002 boundary, no admin-alone clinical power |
| D7 | Cookie sessions + CSRF, no localStorage | token in localStorage | control #4, XSS blast radius |
| D8 | Playwright for viewport rule | manual checks | reproducible six-size evidence |
| D9 | Synthetic-only seed data | real data | product invariant |
| D10 | No external mail/SMS provider in Part 1 | vendor now | control #22; invitation links logged in dev only |
| D11 | Uniform 404 for out-of-scope patients | 403 | never reveals cross-tenant existence |
| D12 | Intake assignment required for every staff patient read/write | clinic role alone | default deny, control #5 |
| D13 | Consent stored append-only | mutable flag | preserves history for audit and future re-consent |
| D14 | Caregiver grant pending until acceptance | active-on-invite | a token that is never accepted grants nothing |
| D15 | Activation gated on consent + assignee | activate freely | no unaccountable active record |
| D16 | Partial unique index for active assignment | app-level check | parallel requests cannot both create an interval |
| D17 | Episode clinical metadata denied to admins | admin read | admin must not browse clinical records (VEL-002 boundary) |
| D18 | `{_id, revision, status}` atomic correction filter | read-then-write | parallel corrections cannot both win |
| D19 | No-op corrections record nothing | always append | repeat requests must not duplicate history |
| D20 | Calendar discharge date + explicit IANA timezone | datetime-only | a discharge date is never offset-ambiguous |
| D21 | Team assignment of a reviewer requires current verified eligibility | role alone | mirrors the Part 1 eligibility boundary |
| D22 | Provider-neutral storage interface with a local encrypted provider | pick S3/Cloudinary now | control #22; no vendor may be selected silently |
| D23 | AES-256-GCM per object under a separate document key | reuse the MFA key | blast-radius isolation; a leaked MFA key must not open documents |
| D24 | Storage root must be absolute and outside the repository | configurable in-repo root | a web root or a committed directory would expose ciphertext (or worse) |
| D25 | Raw bytes in the body, filename in a header | filename in the URL/query | filenames must never reach logs, history or proxies |
| D26 | Bounded worker-threads parser with reduced env | in-process parsing | no secret exposure, hard time/memory caps, crash isolation |
| D27 | Structural refusal vs quarantine | fail every inconclusive file | a timeout is not evidence of malice, but it is also not `ready` |
| D28 | Record a `rejected` row but store no bytes | store then refuse | keeps a refusal trail without retaining refused content |
| D29 | Metadata row first, then the object, then `ready` | object first | a crash leaves a visible `uploading` row rather than an invisible orphan |
| D30 | Exclusive object writes (never overwrite) | overwrite on retry | a retry can never clobber evidence; reconciliation removes true orphans |
| D31 | `--apply` requires explicit `--operator` and audits every repair | unattended repair | recovery actions must be attributable |

## 10. Known limitations (Parts 1-4)

- Invitations and password-reset links are delivered by **server log only** in development; no mail
  provider is authorized yet. This is deliberate (control #22) and must be replaced before any pilot.
- Devices/sessions are listed and revocable, but there is no per-device naming or push.
- The clinical permission catalog is declared for later parts and is not yet enforced by any route
  beyond `clinical.review` eligibility; Parts 2+ wire the remaining permissions.
- No production deployment, restore test or clinical validation yet (Parts 10).
- Part 2 honours only the `view_profile` caregiver scope; `view_episodes`, `view_documents`,
  `view_plan` and `view_tasks` are declared but deliberately inert until their parts land.
- Patient/caregiver invitation links are still log/response-delivered in development (no mail
  provider, control #22).
- The application database must be a replica set from Part 2 on (transactions).
- Document validation is structural only: it is **not** antivirus and no malware-scanning provider is
  authorized yet. A quarantined document has no operator review screen, only its status plus the
  reconciliation command.
- A live parser timeout/crash is not deterministically reproducible from file content on a healthy
  host; the integration suite drives those paths with the test-only stall hook and the memory cap.
- Documents are never deleted by a retention policy; privacy requests and retention arrive in Part 9.
- Part 3 episodes stay `draft`; activation/closure and downstream plan workflows arrive in later
  parts. There is no caregiver episode view yet (the `view_episodes` scope remains inert).
- Discharge dates are corrected one episode at a time; there is no bulk import.
