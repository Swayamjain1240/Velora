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

## 8d. Care-plan model, review and approval (Part 5)

> The full contract - states, clinical-field rules, authority matrix, HTTP endpoints and the approval
> transaction - lives in [VELORA_CARE_PLAN.md](VELORA_CARE_PLAN.md). This section records the design
> decisions behind it.

A plan is a sequence of immutable-in-spirit **versions** for one episode. `CarePlanVersion` holds the
clinic/patient/episode linkage (all three immutable), a per-episode monotonic `version`, the state, an
optimistic-concurrency `revision`, the creator/reviewer/approval facts, and the current/superseded
relationship. `CarePlanItem` holds one clinical instruction; `SourceReference` cites one READY document
of the same episode (page, quoted text, optional location); `ReviewEvent` is an append-only timeline.

States and transitions (anything else is a 409, never a silent rewrite):

```text
draft ──submit──> in_review ──approve──> approved ──(next approval)──> superseded
                     │  ▲
        clarification │  │ resubmit
                     ▼  │
             needs_clarification
```

Only `draft` and `needs_clarification` are editable; `approved` and `superseded` are frozen. Editing an
approved plan is impossible by design - a change starts a NEW draft version (`?fromVersionId` copies
items and citations, and every copied item returns to *awaiting clinical review*), and the approved
version stays the patient's current plan until the replacement is approved.

Clinical completeness is computed by `policies/carePlanPolicy.js`, never by a model or a guess:

- an **unclear** value (`?`, `n/a`, `unknown`, `as directed`, ...) is unresolved;
- a **conflicting** value (two different numbers joined by `or`/`/`/`-`, e.g. `5 mg or 10 mg`) is
  unresolved and the stored string is left exactly as typed;
- a medication item additionally requires `dose`, `frequency` and `duration`;
- every item requires `originalWording` and at least one source citation.

Submit is the lighter gate (at least one item, every item cited, no unresolved *structure*). Approval
re-validates the whole reviewed content server-side, immediately before the claim, and refuses with a
message that names the unresolved fields.

Authority (resolved in the service on every request, from the database):

| Caller | Read version workspace | Draft items / sources | Review, clarify, approve | Patient's approved plan |
|---|---|---|---|---|
| Assigned coordinator (active assignment, draft episode) | allow | allow | deny (403) | deny (403) |
| Assigned + clinic-verified reviewer | allow | deny (403) | allow | deny (403) |
| Same-clinic staff, not on the team | uniform 404 | uniform 404 | uniform 404 | deny (403) |
| Patient owner | deny (403) | deny | deny | allow (current approved only) |
| Caregiver (any grant) | uniform 404 | deny | deny | deny (403) |
| Clinic administrator | **403** | **403** | **403** | deny |

The patient projection (`getPatientCurrentPlan`) is deliberately narrower than the staff one: approved
clinical fields plus the permitted source references and the approval actor/time - never the reviewer's
working state (`clinicalReviewState`, `reviewNote`, `reviewedByLabel`), the clarification history or the
internal unresolved-field diagnostics, and never a draft (before approval it answers `plan: null`).

**Approval is one MongoDB transaction** over the revision- and state-constrained claim:

1. claim the version with `{_id, clinic, episode, state:'in_review', revision}` and increment the
   revision (exactly one parallel caller can win; the loser gets a 409);
2. re-derive reviewer role, verified eligibility, permission catalog and the current assignment inside
   the same request before the claim;
3. validate the complete reviewed content and reject unresolved clinical fields;
4. supersede the previous current version first, conditionally on it still being the approved current
   one;
5. make the new version the single current one;
6. move the episode's `approvedPlanVersion`/`planState`;
7. append the review events (approved, superseded) and the audit record.

A repeated approval by the same reviewer for the same revision is **idempotent** (returns the approved
version, writes no second event). A **partial unique index** on `(episode)` where
`isCurrent:true, state:'approved'` makes "two current versions" impossible at the database level, not
merely in the service - a concurrent approval and a direct driver update are both refused.
Approval activates **no** task, reminder, schedule or message; the episode's own lifecycle status is
untouched.

## 8e. AI-assisted extraction and reviewed language (Part 6)

> The full contract - provider disclosure, models, schema, jobs, limits, threat model and evaluation
> limits - lives in [VELORA_EXTRACTION.md](VELORA_EXTRACTION.md). This section records the design
> decisions behind it.

AI is an **untrusted drafting aid with zero clinical authority**. There is no code path from a model
suggestion to approval, publication, a prescription, a task or a reminder. The shipped provider is
`none`: jobs fail closed with `PROVIDER_DISABLED` and manual drafting (Part 5) is unaffected.

- **Adapter first.** Any provider implements one neutral interface (`extract({ pages, model })`); the
  registry fails closed on an unknown name. The only enabled provider is the deterministic local
  `fake` (offline, no key, byte-for-byte reproducible), so all provider-independent work and tests
  exist before any vendor is chosen (control #22).
- **Document text is data.** It is quoted inside explicit delimiters (which are stripped from the
  text first) and never treated as instruction or tool authorization; suspicious lines are detected
  as position-only labels and force `needs_review`.
- **The server decides.** The model's `missing`/`conflicts` claims are evidence, not truth. The server
  validates the strict schema, verifies every citation against the supplied pages, and classifies each
  field itself (`suggested`/`missing`/`conflicting`/`unresolved`). An anchored value absent from the
  cited source is `unresolved`, never trusted; ambiguity is never normalized into a fact.
- **Apply is a separate draft edit.** It re-checks authority and the current revision, then goes
  through the Part 5 service: one ordinary item, the same citation, still "awaiting clinical review".
- **Language renderings** are linked, versioned, numerically guarded, assigned-reviewer-approved and
  never patient-visible automatically; approving one changes no clinical value or plan state.
- **Why no provider yet:** selecting one requires the completed disclosure (provider, purpose, key,
  env var, data sent, retention/region, cost) and owner/clinical/privacy review. Until then the
  boundary is clean and the product is fully functional without AI.

## 8f. Schedules, occurrences and attributed recording (Part 7)

> The full contract - models, safety wording, authority matrix, HTTP endpoints, reconciliation and
> time rules - lives in [VELORA_SCHEDULES.md](VELORA_SCHEDULES.md). This section records the design
> decisions behind it.

Part 7 is the first part that turns an approved plan into something operational, so every decision
below is about keeping the *clinical* content frozen and the *operational* content explicit.

- **A schedule is a frozen copy, not a live reference.** `MedicationSchedule`/`RecoveryTask` copy
  dose, route, frequency, timing, condition, duration and the original wording verbatim at preparation
  time, and pin the exact `planVersion` + `CarePlanItem` (both immutable, unique per pair). A later
  approval can therefore never mutate an operational schedule; reconciliation supersedes it instead.
- **Preparation is explicit and audited, and activation is a second, independent act.** Approving a
  plan still activates nothing. `POST .../schedules/prepare` reconciles from the **current approved**
  version under a coordinator's assignment; a *medication* schedule additionally needs the assigned,
  clinic-verified clinical reviewer to activate it, so preparation can never activate clinical work
  by itself. Task activation is an operational coordinator act - still explicit, still audited.
- **Nothing clinical is inferred.** A `warning` item maps to nothing; an item that is not `accepted`
  generates nothing and is reported back as unconfirmed; an item whose approved wording does not state
  *when* becomes `needs_details` (an unanchored interval is `interval_without_anchor`) and can never be
  activated. A default day-part time is a non-clinical convenience the reviewer sees before
  activation, never a stored clinical value.
- **Conditional medicine cannot become a repeating dose.** An explicit `condition` or PRN wording
  anywhere in the frequency/timing/original wording marks the item conditional: it is created
  `scheduleKind: 'as_needed'` with no times and **zero** generated occurrences. Conditional items can
  be recorded when they happen; they never expand into an unconditional schedule.
- **Time is UTC; the zone is explicit.** Instants are stored as UTC `Date`s with the IANA zone and the
  local `YYYY-MM-DD`/`HH:MM` that produced them; the zone resolves request value -> episode zone ->
  validated `SCHEDULE_FALLBACK_TIMEZONE`. An invalid zone is a 400, never a silent fallback.
  `zonedTime.js` owns all conversion: a local time in a **spring-forward gap** produces *no* instant
  and is reported as `dst_gap` rather than shifted, a **fall-back** duplicate resolves to the earlier
  instant, and day arithmetic runs on the calendar string, never on the server's own zone.
- **Generation is bounded.** At most 400 occurrences per schedule, a 30-day default horizon and a
  1-60 day clamp, so no approved wording can produce an unbounded list.
- **A day state is a recorded fact, and absence is not adherence.** `ScheduleOccurrence` has no
  adherence column; `taken`, `skipped`, `reported_done`, `needs_help` and `not_recorded` are derived
  by joining logs. `not_recorded` means no entry exists, and the shared safety wording (one constant in
  `schedulePolicy`, used by server and client) states that nothing recorded is not a missed dose and
  never implies an extra or replacement dose.
- **Logging is attributed and append-only.** `ActivityLog` records the subject (from the record), the
  acting user and role, the caregiver grant id when one applies, the instant the entry is *about* and
  the instant it was *recorded*. The model refuses every update/delete operation and non-new `save()`;
  a correction is a new row naming the row it corrects. Idempotency comes from a unique
  `(clinic, clientRequestId)` index, so a retry or a concurrent duplicate resolves to one row.
- **The patient's clinic is derived, never supplied.** `/api/today` carries no clinic-wide permission:
  ownership (patient), grant scope (caregiver) or active assignment (staff) decide, and a revoked
  grant, closed episode or superseded version closes the surface on the next request.
- **History survives an approval.** Re-preparing after a new approval supersedes the previous
  version's owners and only its *future* occurrences; past occurrences and every log row are untouched
  and stay visible in the day view as earlier-plan history.

## 8g. Coordination: check-ins, clarifications, queues and reminders (Part 8)

> The full contract - models, states, authority matrix, HTTP endpoints, rate-limit buckets and the
> reliability rules - lives in [VELORA_CARE_COORDINATION.md](VELORA_CARE_COORDINATION.md). This
> section records the design decisions behind it.

Part 8 is the first part that makes the *clinic's own workflow* explicit, so every decision below is
about keeping absence, attention and delivery as the plain facts they are:

- **A missing answer is an absence, not a value.** `no_response` is derived from a closed response
  window and is never classified, never opens a review, and carries the standing wording that
  nothing is inferred - not a normal result, not an abnormal result. There is no code path that
  turns silence into a recovery judgement.
- **A clinic rule is data, evaluated literally.** `reviewRules` are stored per template version and
  matched field-by-field (`at_least`, etc.); a match sets `needs_review` with the rule's own label
  and "workflow attention, not a diagnosis". No model, no score and no severity is produced, and
  closing the review requires the assigned, verified clinical reviewer.
- **Templates are versioned so answers stay answerable against what was asked.** A slot pins its
  template version; validation reads that version's questions, so editing a template can never
  re-interpret a stored answer or block a historical read.
- **Thread authority is split by kind, not by seniority.** `clinical` questions are answerable only
  by the assigned, clinic-verified reviewer (eligibility alone is insufficient; a coordinator who
  merely receives the question cannot answer it), `operational` answers belong to coordinators, and
  reclassification only moves operational -> clinical. Reopening is an explicit, audited state so a
  thread that came back is never mistaken for one that was never answered.
- **The dashboard derives scope, it never accepts it.** Queue rows and counts are computed from the
  caller's active `CareTeamAssignment` set; there is no query parameter that widens it, and admin
  status is an explicit refusal because admin is not clinical work.
- **Reminder identity includes the event version.** `dedupeKey` = channel : recipient role :
  recipient : kind : v<version> : event : localDate under a unique index, so a new approved plan or
  template version is a *new* event while the same version never queues twice - the race is closed
  by the database, not by a check-then-insert.
- **Delivery re-reads the world it is about to act on.** Immediately before delivery the episode
  state, the current approved plan version, the source task's relevance and the recipient's
  authorization are re-checked and the verdict is stored on the attempt; a refusal is a visible
  `skipped` attempt and a cancellation with the standing note that nothing was sent and no
  assumption is made about the patient.
- **Retry is bounded and visible; delivery is not acknowledgement.** Exponential backoff capped at
  one hour, at most `REMINDER_MAX_ATTEMPTS` (default 3), then a `failed` state a human can see and
  retry. Only the recipient can acknowledge.
- **One registry gates every external channel.** The shipped provider is in-app (nothing leaves the
  process); email/SMS/WhatsApp/push are recognized but refused until a disclosure fills every
  required field - there is no silent fallback to a different channel.
- **Rate budgets are shared per operation, not per role surface.** The patient's ask and the
  coordinator's ask consume the same `clarification-ask` bucket (keyed by caller), so a role can
  never buy a larger budget by using its own endpoint.

## 8h. Closure, audit, privacy requests, retention and metrics (Part 9)

> The full contract - models, states, authority matrix, HTTP endpoints, configuration and the
> retention runbook - lives in [VELORA_PRIVACY_RETENTION.md](VELORA_PRIVACY_RETENTION.md). This
> section records the design decisions behind it.

Part 9 is where coordination work ends and where a patient can ask about their own record, so the
recurring decision is to make every one of those acts **explicit, attributable and reversible by
policy rather than by destruction**:

- **Closure is an operational state, never a clinical one.** `closurePolicy` refuses a reason that
  describes recovery, the `EpisodeClosure` event has no clinical field to put one in, and the API, the
  client copy and the docs all say coordination work has ended - nothing more.
- **The preflight is the authority, and an override is written down.** Blocking items (unresolved
  approvals, open clarifications, open tasks, missing owners) must be empty or cleared with a bounded,
  recorded override reason; advisory items (failed deliveries, pending check-ins) are reported, not
  hidden.
- **Closing is one transaction over a revision guard.** Live assignment is re-derived, the revision is
  rechecked (a concurrent close loses with `409`), the state flips once, future work stops, and the
  closure event plus audit row are appended. Recorded facts, answered check-ins and logs are never
  touched: history becomes read-only, it does not become empty.
- **Stopping work stops only the future.** Queued reminders are cancelled, future occurrences are
  ended and active schedules/tasks are closed out - a stored answer or a logged entry is evidence and
  is not rewritten to look like it never happened.
- **Reopen is a separate, justified, audited act that revives nothing.** The earlier closure stays
  readable and stopped work stays stopped until a human creates it again, so a reopen can never
  resurrect a cancelled reminder or an ended occurrence behind everyone's back.
- **The audit trail is append-only, categorised and redacted before it is written.** Every sensitive
  read/download, membership/role change, caregiver grant, approval, AI-suggestion application, log,
  check-in or clarification response, privacy request, export download, retention run and
  closure/reopen is recorded with a category; forbidden keys (secrets, tokens, URIs, raw clinical
  text) are replaced with `[redacted]` and strings/depth are bounded, so the trail cannot become a
  second copy of the record it describes.
- **Audit search is administrative and bounded.** `audit.read` is the Clinic Admin permission, the
  result is clinic-scoped and paginated inside a bounded date window, and a clinical caller or a
  patient is refused outright - admin is the purposes-of-use role here, not a clinical one.
- **There is no destructive deletion endpoint.** A `deletion_request` is an evaluation against
  retention holds and windows that records a defensible outcome (`completed` when nothing is eligible,
  `partially_completed` when retention applies); real destruction needs separate authorization and a
  tested backup/restore process that Part 9 does not claim.
- **An export is generated, not handed over.** Approval does not produce a file: execution writes an
  AES-256-GCM artifact into a **separate** store under its own key, with a TTL and an explicit
  revocation; downloading needs a fresh, short-lived, single-use authorization whose peppered hash is
  what is stored. Nothing about an export is world-readable, permanent or implicit.
- **Retention is a report before it is an action.** Every category has a window and a mode; the dry
  run is the default gate, apply needs an operator name, a reason, an idempotency key and is bounded,
  holds freeze a category without hiding its eligible count, and clinical categories (`documents`,
  `historical_records`) are **report-only** so automation can never destroy a clinical record.
- **Metrics describe the workflow, and say so in the payload.** Approval time, clarification response
  time, queue age and coordination workload each carry a `notAMeasureOf` line, and the service has no
  input from which recovery, adherence or readmission could be computed even if someone asked.

## 8i. Production hardening, readiness and recovery (Part 10)

- **Configuration production gate.** `server/src/config/env.js` refuses (never warns about) a
  production posture that cannot be secured: a non-HTTPS or non-bare `CLIENT_ORIGIN`, `LOG_LEVEL=debug`,
  a session pepper under 32 characters, any encryption key reused across the MFA/document/export stores
  or equal to the pepper, a `MONGODB_URI` without TLS, and a pool minimum above its maximum. Body,
  request, pool, keep-alive and shutdown budgets are validated numbers with bounded defaults.
- **Proxy trust is a deployment decision.** `resolveTrustProxy(env)` returns `false` unless the operator
  opts in, in which case the exact hop count is used. With it off, `req.ip` is the socket address, so a
  forged `X-Forwarded-For` cannot influence the rate limiters or the audit trail; one warning line
  names the consequence at startup.
- **Liveness vs readiness.** `/api/health` answers without touching any dependency (a database blip must
  not restart a healthy process). `/api/ready` performs a real database `ping` and checks the encrypted
  storage root for existence and writability, fails CLOSED with `503`, names the failing side
  (`database`/`storage`) and reports `draining` while shutting down. Both are mounted before the rate
  limiter, the session resolver and CSRF, and neither payload contains a version, host, path,
  credential or driver message. Readiness only logs on a STATE CHANGE, so a probe every few seconds
  cannot flood the log.
- **Graceful shutdown.** Drain (readiness flips first) → stop accepting connections → close the
  listener → disconnect MongoDB → exit `0`; exceeding `SHUTDOWN_GRACE_MS` logs `shutdown.forced` and
  exits non-zero. A fatal `uncaughtException` takes the same path; an `unhandledRejection` is recorded
  and the process continues, because the request path already fails closed.
- **Structured logging with redaction.** One JSON object per line with a named `event`, level filtering
  from `LOG_LEVEL`, sensitive keys replaced at every depth (including inside `Error` objects), bounded
  strings/arrays/depth, and no stack trace in production. The logger is hand-written over the standard
  library: Part 10 added no dependency.
- **Recovery is exercised, not assumed.** `scripts/restore-drill.js` restores rows, indexes (with their
  options) and the encrypted objects into an isolated, drill-suffixed database, then verifies by
  reading back: collection set, counts, per-collection content checksums, index signatures, object
  bytes, and real decryption of stored documents compared with their recorded `sha256`. It proves the
  source was untouched and drops the copy unless `--keep` is passed. `scripts/reconcile-documents.js`
  remains the drift report/repair path for a partial restore, and each drift class it can repair
  (lost/tampered/mismatched object, orphan) is created and repaired under test. `scripts/reseal-keys.js`
  completes the recovery story for the OTHER disaster a restore cannot fix: a key that must be retired.
  Through a two-key window it re-seals every TOTP seed and every stored object from the previous key to
  the current one, dry run by default, operator-attributed, compare-and-set per record, and verified
  against the recorded `sha256`. The drill, the reconciliation report and the re-seal dry run all run
  locally on the seeded database; the drill and reconciliation also run in CI on every push.
- **A dependency outage is answered honestly.** A driver-level connectivity error becomes a retryable
  `503 SERVICE_UNAVAILABLE` with a generic body in every environment (logged as
  `dependency.unavailable`) instead of a misleading `500`, so a client, a load balancer and an operator
  read the same thing the readiness probe reports. Storage tampering and other defects still return
  `500`, so the two are never conflated. Verified by closing the real connection rather than stubbing
  it.
- **What is still absent.** No backup schedule exists (so no RPO can be quoted), the object-store and
  database providers are unselected, monitoring/on-call routing is unselected, and no deployment,
  penetration test or load test has happened - see
  [VELORA_READINESS_REPORT.md](VELORA_READINESS_REPORT.md) and
  [VELORA_OPERATIONS_RUNBOOK.md](VELORA_OPERATIONS_RUNBOOK.md).

## 9. Decision log (Parts 1-10)

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
| D32 | Unresolved dose/frequency/duration blocks approval | default/guess a value | a guessed dose is a dosing error; never guess |
| D33 | New draft version replaces an approved one | edit the approved version in place | approved content must stay immutable for the audit trail |
| D34 | Old version stays current until the replacement is approved | supersede at draft time | a patient must never lose their only approved plan |
| D35 | Partial unique index for one current approved version | service-only invariant | parallel approvals and direct writes must both be refused |
| D36 | Reviewer decision needs `in_review` as an allowed write state | reuse the draft-only guard | the reviewer path was invisible to the draft guard (found by test, fixed) |
| D37 | Patient projection omits reviewer working state | return one shared mapper | reviewer notes and clarification history are internal |
| D38 | Harness-owned HTTP listener for tests | supertest's own server | supertest closes its server on settle; sequential agent requests could race that close and fail flakily |
| D39 | Provider-neutral extraction interface + deterministic local fake | pick an LLM/OCR vendor now | control #22; all provider-independent work and tests exist before any vendor |
| D40 | Document text quoted as delimited data, delimiters stripped | pass text as a prompt | document text must never be instruction or tool authorization |
| D41 | Server classifies every field; model claims are evidence | trust the model's missing/conflicts | a fabricated dose is a dosing error; anchored values absent from the source become `unresolved` |
| D42 | Applying a suggestion is a separate Part 5 draft edit | write clinical state from the job | AI output must never change clinical state, approve or publish |
| D43 | Reviewed renderings never patient-visible automatically | show an approved rendering to the patient | presentation approval must not bypass plan approval |
| D44 | A `needs_review` suggestion is still decidable | disable apply/dismiss on flagged suggestions | a flagged suggestion is exactly the one a human must decide (found by the browser journey, fixed) |
| D45 | Schedules copy approved fields verbatim and pin `(planVersion, item)` | reference the live item | an approval after preparation must never rewrite operational content |
| D46 | No adherence column on occurrences; states are derived from logs | store a status/score per slot | `not_recorded` is the absence of a fact, not a value that can become a nonadherence metric |
| D47 | A DST spring-forward gap occurrence is skipped and reported | shift the dose an hour | shifting a dose is a clinical change; the reviewer is told instead |
| D48 | A fall-back duplicate resolves to the earlier instant | later instant/split dose | an extra clock hour must never push a dose later |
| D49 | Conditional/PRN items are `as_needed` with zero occurrences | treat them as a fixed repeat | a PRN medicine must never become an unconditional repeating dose |
| D50 | Medication activation needs the assigned verified reviewer | prepare implies activation | clinical activation is a reviewer act, distinct from operational preparation |
| D51 | Unanchored intervals become `needs_details` | pick a default first-dose time | a detail is requested, never invented |
| D52 | Idempotent logging via unique `(clinic, clientRequestId)` | rely on client dedupe | a retried or concurrent submission must not duplicate patient history |
| D53 | Corrections append a new row that names the corrected row | edit the entry in place | recorded history must stay verifiable |
| D54 | `/api/today` has no clinic-wide permission; authority comes from the record or grant | reuse a clinical permission | a patient and caregiver hold none, so the record and grant must decide |
| D55 | Safety wording lives in one shared policy constant | duplicate the copy in each screen | server test and client screen can never drift apart |
| D56 | Reminder dedupe key includes the event **version** under a unique index | check-then-insert / content hash | a new plan or template version is a new event; the race is closed by the database |
| D57 | Recheck episode/version/task/recipient immediately before delivery and store the verdict | check only at queue time | authorization and relevance can change between queueing and delivery |
| D58 | The reminder provider registry refuses undisclosed channels with the exact disclosure list | default to email when configured | control #22; a silent channel fallback is worse than not sending |
| D59 | Admin is explicitly refused the dashboard queues | reuse admin read permissions | admin is administration, not assigned clinical work (VEL-002 boundary) |
| D60 | Durable rate buckets are shared per operation across staff/patient/caregiver surfaces | separate budget per endpoint | a role must not buy a larger budget by choosing its own endpoint |
| D61 | Closure is an operational archive state with recovery language refused at validation | a recovered/discharged outcome | VEL-019: a workflow state must never read as a clinical claim |
| D62 | Blocking preflight items need a bounded written override; advisory ones are reported | hard block on everything | a failed delivery is not a reason to keep coordination open forever, but it must be visible |
| D63 | Close is one transaction over `expectedRevision` with future work stopped | read-then-write close | a concurrent close must lose, and state may change exactly once |
| D64 | Reopen appends a new event and revives no stopped work | restore cancelled reminders/occurrences | history stays readable and nothing returns without a human act |
| D65 | Append-only `EpisodeClosure` with no clinical field | reuse an episode status field only | the closure reason must be impossible to misread as an outcome |
| D66 | Audit detail is redacted and bounded before the row is written | store the payload and redact on read | the persisted trail must never hold a secret, token or clinical text |
| D67 | Audit search is admin-only, clinic-scoped, paginated and window-bounded | any clinical caller may search | VEL-002 boundary plus control #6; admin owns purposes-of-use work |
| D68 | Export artifacts live in a separate encrypted store with their own key, TTL and revocation | reuse the document store/key | blast-radius isolation; a leaked document key must not open exports |
| D69 | Download needs a fresh single-use authorization (peppered hash stored) | long-lived signed URL | control #15/#8; a leaked link expires and cannot be replayed |
| D70 | Clinical retention categories are report-only; deletion requests are policy evaluations | automated destruction on request | no untested destructive path may exist in the product |
| D71 | Retention apply is idempotent via `clientRequestId` and requires operator + reason | best-effort apply | a retry must not act twice and every run must be attributable |
| D72 | Metrics carry `notAMeasureOf` and the service has no outcome input | expose derived quality scores | VEL-021: workflow durations must never become clinical inference |
| D73 | Every retention DRY RUN gets its own `dry-run:` idempotency key | leave the key empty on a report | a stored null collides on the unique `(clinic, idempotencyKey)` index, so the second read-only report in a clinic was refused with 409 (found by the Part 9 browser journey, fixed) |
| D74 | One `isClosed()` answers for `closureState` OR `status` on every closure surface | read `closureState` alone | an episode archived before Part 9 carries `status` only; two definitions showed it as open and offered a second close (found by the Part 9 browser journey, fixed) |
| D75 | Production configuration is REFUSED, not warned about | log a warning and start | a warning nobody reads is not a control; an unusable posture (debug on, reused keys, plaintext database, weak pepper) must stop the boot |
| D76 | `trust proxy` follows `TRUST_PROXY`/`PROXY_HOPS` explicitly | hardcode one trusted hop | a deployment that said "no proxy" still trusted a forwarding header, so callers could rewrite the address used by rate limits and the audit trail |
| D77 | Liveness and readiness are separate, and both are mounted before the limiter and the session resolver | one `/api/health` that needs a session | a probe must never spend a caller's budget, must never disclose configuration, and a database blip must not restart a healthy process |
| D78 | Readiness reports `draining` before the listener closes; a shutdown that overruns the grace window exits non-zero | close first, exit 0 | a load balancer must be able to drain the instance, and an unclean stop must be visible rather than silent |
| D79 | The restore drill verifies by READING the restored copy back (including AES-GCM decryption against the recorded hash) | compare counts only | counts cannot catch a wrong key or a mistranslated index; the drill found a partial-unique-index rebuild defect on its first run |
| D80 | Index options (partial filter, TTL, collation, sparse) are recreated AND compared during a restore | recreate keys and uniqueness only | a partial unique index restored as a full one rejects legitimate rows (the exact defect found in D79) |
| D81 | An encryption key is rotated through a two-key window (`*_PREVIOUS` + `scripts/reseal-keys.js`), and a previous key equal to the current one is refused at startup | swap the key and hope, or migrate with an offline dump | the data is sealed per record; rotating in place strands every authenticator and every document, and a same-value "rotation" would silently change nothing |
| D82 | A dependency outage answers a retryable `503 SERVICE_UNAVAILABLE`, matching what the readiness probe reports | let the driver error surface as a `500` | a client, a load balancer and an operator must read "dependency is down" the same way; a 500 means "the code is broken" and is neither retryable nor accurate. Found by closing the real connection in a test |

## 10. Known limitations (Parts 1-10)

- No external AI/OCR provider is selected or called; a real provider needs the completed disclosure
  and owner/clinical/privacy review first (control #22). The evaluation is **software behaviour on
  invented values, not clinical accuracy**.
- Invitations and password-reset links are delivered by **server log only** in development; no mail
  provider is authorized yet. This is deliberate (control #22) and must be replaced before any pilot.
- Devices/sessions are listed and revocable, but there is no per-device naming or push.
- The clinical permission catalog is declared for later parts and is not yet enforced by any route
  beyond `clinical.review` eligibility; Parts 2+ wire the remaining permissions.
- No production deployment or clinical validation yet, and **no scheduled backup**: a logical,
  same-host restore is verified on every push (Part 10), but it is taken live, so RPO is unbounded and
  no provider-level, off-host or point-in-time restore has been exercised.
- Key rotation is implemented for all three: the session pepper (which deliberately invalidates every
  session and every MFA recovery code) and, through the two-key window plus `scripts/reseal-keys.js`,
  `MFA_ENCRYPTION_KEY` and `DOCUMENT_ENCRYPTION_KEY`. Rotation is proven locally by re-sealing real
  data and checking it back; the keys do not yet live in a managed key store, which is an owner
  decision.
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
- Documents are never deleted: the `documents` retention category is **report-only** and a deletion
  request that reaches clinical content is evaluated against retention and reported as limited rather
  than executed.
- Part 3 episodes stay `draft`; activation/closure and downstream plan workflows arrive in later
  parts. There is no caregiver episode view yet (the `view_episodes` scope remains inert).
- Discharge dates are corrected one episode at a time; there is no bulk import.
- Part 5 fulfils VEL-007/VEL-008 for **manual** authoring only: there is no extraction assistance, no
  medication schedule and no reminder (Parts 6-7), and `carePlanPolicy` is a documented, deliberately
  simple text analysis (it flags ambiguity, it does not understand clinical language).
- The patient's caregiver `view_plan` scope is still inert: a caregiver cannot read a plan yet.
- Plans are never deleted; a deletion request touching a plan is reported as limited by retention.
- Part 9 executes no destructive deletion of clinical records at all: there is no restore test, and
  real destruction would need separate authorization plus a proven backup/restore process.
- Items are authored and reviewed page by page (8 per page); there is no bulk edit or item import.
- A plan is not versioned by a content hash, so two identical drafts are two versions.
- Part 7 delivers VEL-012/VEL-013 at local scope only: it produced no notification or reminder -
  Part 8 now ships **in-app** reminders and delivery records (VEL-014), still with no scheduler
  daemon: queueing and delivery are explicit bounded API calls, and occurrences are materialised by
  explicit preparation over a bounded horizon (400 slots, 30-day default), not by a recurring job.
- Derived day-part times are a non-clinical convenience; an approved instruction with no stated
  timing stays `needs_details` and is never made schedulable by guessing.
- `not_recorded` is deliberately not aggregated into any adherence percentage, and the day view is a
  one-day view (bounded pagination per category, no weekly/monthly rollup).
- The caregiver surface honours only the four declared scopes it needs (`view_medications`,
  `log_medications`, `view_tasks`, `log_tasks`); a caregiver still cannot read the plan or episodes.
- Scheduling evidence is local (development, synthetic data). No clinical validation, regulatory
  claim or production readiness is implied.
- Part 8 ships **in-app delivery only**: no email/SMS/WhatsApp/push provider is selected, disclosed
  or called, and the reminder pipeline runs on explicit bounded API calls (no scheduler daemon), so
  a deployment that needs unattended delivery must add a disclosed job runner first.
- Check-in review rules are literal, clinic-authored conditions (`at_least`, etc.): there is no
  scoring, trend detection or diagnostic interpretation, and none is claimed.
- The Part 8 screens are covered by client unit tests and six-size viewport measurement; there is no
  dedicated end-to-end browser journey fixture for check-ins/clarifications yet (the flows are
  exercised through the API integration suite).
- There is no per-thread attachment, no file sharing inside a clarification and no structured
  clinical response inside a thread message: messages are bounded plain text.
