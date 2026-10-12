# Velora MERN - Session Log

Append-only record of Duck reviews and session outcomes. Newest entry first.
Evidence classes: `VERIFIED`, `IMPLEMENTED / UNVERIFIED`, `PARTIAL`, `PLANNED`, `DRIFT`, `BLOCKED`.

---

## Session - 12 October 2026 - Part 5 (manual care plans, review, approval and versioning)

### Duck review (start of session)

Read before writing code: the three authority PDFs and their markdown mirrors
(`VELORA_MERN_MASTER.pdf`, `VELORA_MERN_ARCHITECTURE.pdf`, `VELORA_MERN_DUCK_LOG.pdf`),
`VELORA_MERN_10_BUILD_PROMPTS.md`, `README.md`, `AGENTS.md`, the Parts 1-4 review entries in this
log and their API contracts (`VELORA_DOCUMENT_STORAGE.md`, the route and validator sources), plus the
current source and tests.

State on entry: branch `main`, working tree carrying the uncommitted Part 5 work, no `gh` on this
host, so PR and CI run state are **not observable locally** - the evidence below is the local gate
(`npm test` in both workspaces, the Playwright journeys, the production audit and both secret scans),
which is also what the CI workflow runs.

Foundations Part 5 depends on were re-verified rather than assumed:

| Foundation | Verification |
|---|---|
| Clinic isolation | every plan query is filtered on `clinic`; a guessed episode id from another clinic is a scoped `404` (integration + browser) |
| Episode assignment | drafting reuses the Part 4 write rule: an **active** `care_coordinator` assignment on a **draft** episode |
| Reviewer eligibility | re-derived from the database on every decision (active membership + `roleKey` + `reviewerEligibility = verified` + role permission + active reviewer assignment); revocation and unverification both lose authority immediately |
| Document readiness | a source must be a `ready` document of the **same** episode: unready is `409`, foreign/unready-episode is `404` |
| Audit | `AuditEvent` and the append-only `ReviewEvent` timeline record actor/transition/bounded reason and **never** clinical text |
| One-viewport | plan screens are asserted at all six sizes inside `plans.spec.js`; the existing list/detail measurements still pass |

### External service gate (control #22)

**No provider selected or called.** Extraction assistance, an LLM, OCR, a drug-interaction database
and a terminology service are all DISCLOSED / NOT SELECTED. Part 5 is entirely local (Express +
Mongoose + MongoDB) and adds **no** environment variable and **no** dependency. AI extraction is not
stubbed, not mocked and not scheduled here - it remains Part 6.

### Work performed (Part 5)

- **Models:** `CarePlanVersion` (version, state, revision, creator/submitter/clarification/approval
  facts plus the acting reviewer, `isCurrent`/`supersededBy`, episode/clinic/patient linkage),
  `CarePlanItem` (verbatim
  `originalWording`, all structured clinical fields, server-computed `unresolvedFields`, review state),
  `SourceReference` (ready document + page + quote + location) and `ReviewEvent` (append-only timeline
  whose model hooks refuse update/delete).
- **States:** `draft -> in_review -> {needs_clarification -> in_review, approved -> superseded}` with a
  pure transition table in `policies/carePlanPolicy.js`; anything else is a `409`.
- **Clinical rules:** a missing, unclear or conflicting dose/frequency/duration stays unresolved and
  blocks approval. `computeUnresolvedFields` treats `?`/`n/a`/`unknown`/`as directed`/… as absent and
  flags alternatives ("5 mg or 10 mg") as `<field>_conflict`. Nothing is ever guessed or defaulted.
- **Authority:** coordinator drafting, reviewer-only approval, explicit admin clinical denial, patient
  and caregiver draft denial, patient-owner approved-plan read.
- **APIs:** draft create/detail, item create/update/delete/reorder and source link/remove (all with
  `expectedRevision`), submit, clarification, resubmit, approve, patient current-approved read and
  authorized version history - with `no-store` on every response.
- **Approval transaction (one session):** claim on state+revision, supersede the previous current
  version, flip the new one current, move the episode's `approvedPlanVersion`/`planState`, write the
  timeline. Retry is idempotent (`idempotent: true`); a parallel approval loses with `409`; the
  DB-level partial unique index on `(episode)` where `isCurrent && state='approved'` makes two current
  versions impossible even for a future code path.
- **Frontend:** draft wizard, paginated item editor, source review panel, review/clarification panel,
  explicit approval confirmation, version history and the patient approved-plan view - presented as a
  tabbed single-panel workspace (Draft / Sources / Review / History) so switching and paging never
  exceed one viewport.
- **No downstream activation:** approving writes no task, reminder, schedule or message and leaves the
  episode's own lifecycle `status` untouched.

### Defects found and fixed during verification (dependent drift)

1. **MFA enrollment could hand the client a secret the server did not keep.** A double-fired
   `POST /auth/mfa/enroll/setup` (React StrictMode, or a refresh) generated a second secret and
   overwrote the first, so every code the user derived from the displayed secret was rejected. Install
   is now a compare-and-set: the first writer wins, a loser re-reads the winner's stored secret, and
   the response always carries the secret that is actually persisted (bounded retry, then a safe
   `503`).
2. **`enroll/setup` could replace the second factor of an already-enrolled account.** A password-only
   (`mfa_pending`) session could install a new secret on an account with MFA enabled, which is a
   second-factor takeover for anyone holding the password. Both enrollment steps now refuse
   first-time-only: an enabled account can only verify. (A deliberate, audited factor reset does not
   exist yet - recorded as a limit.)
3. **A stale in-flight episode load could overwrite what the coordinator had just typed**, leaving the
   discharge-correction button disabled with the old value silently restored. The episode detail now
   ignores a response for a superseded load, so the editor keeps the user's input.
4. **The one-time enrollment browser journeys could not be retried.** `auth.spec.js` and
   `patients.spec.js` drive forced enrollment, which is inherently one-time: a Playwright retry could
   only ever reach the verification screen, and CI's `retries: 1` would have replaced the real failure
   with a confusing timeout. Those two files now configure `retries: 0` and are re-run by re-seeding.

### Key invariants enforced

- At most **one current approved version per episode**, enforced by a partial unique index and by the
  conditional claim - not only by application logic.
- Approved content is **immutable**; changing clinical content means a new draft version, and the
  previous approved version stays current (and patient-visible) until the replacement is approved.
- A copied version resets every item to **unreviewed** - a previous approval never carries over to
  edited clinical content.
- Editing an item clears its review state and note, so an approval cannot survive an edit.
- The patient view is the **approved projection only**: reviewer working state, clarification history
  and unresolved-field diagnostics are absent, and an unapproved episode returns an empty payload
  (never an error that would reveal a draft exists).
- Sources are ready-document-verified server-side, and every item needs a source before submission.

### Evidence (re-run on this working tree)

| Check | Command | Result |
|---|---|---|
| Server suite | `npm test -w server` | **126 pass / 0 fail** (~102 s, replica-set MongoDB test DB) |
| Client suite | `npm test -w client` | **24 pass / 0 fail** (6 files) |
| Client lint | `npm run lint -w client` | clean |
| Client build | `npm run build -w client` | production build succeeds (278.70 kB js, 8.84 kB css) |
| Browser journeys | `PORT=4100 npx playwright test` | **49 pass / 1 skipped / 0 fail** - the skip is the opt-in quarantine journey that needs a 50 ms parser budget |
| Part 5 journey | `plans.spec.js` | manual draft -> items -> sources -> submit -> per-item acceptance -> confirmed approval -> patient approved view -> immutability, plus draft/sources/review/patient screens measured at all six sizes |
| Production audit | `npm audit --omit=dev` (root, server, client) | **0 vulnerabilities** |
| Secret scan (tree) | `git grep` for private keys, provider tokens, credentialed URIs, `VITE_` secrets | clean; only `.env.example` is tracked |
| Secret scan (history) | `git log -p --all` for keys/tokens and credentialed `mongodb://` URIs | clean; `.env.example` is the only `.env*` file ever added |
| Dependencies | `git diff` on `package.json` files | Part 5 adds **no** dependency and no env var |

Advisory (dev-only, unchanged from Part 1): `npm audit` still reports dev-tooling advisories in
`vitest`/`tinypool`/`esbuild`/`vite`. They are excluded from the production gate (`--omit=dev` = 0)
and the only available fix is a breaking Vitest major upgrade, deferred as tooling work.

### Security-25 matrix (Part 5)

| # | Control | Status | Evidence |
|---:|---|---|---|
| 1 | Secrets hidden | VERIFIED | no new secret; `no-store` on plan responses; scans clean |
| 2 | Fail-closed env | VERIFIED | unchanged; Part 5 adds no variable |
| 3 | Private and draft routes protected | VERIFIED | `requireAuth` + clinic context on every plan route; patient route is ownership-only |
| 4 | Argon2id, MFA, sessions, CSRF preserved | VERIFIED | tests + journeys green; the two enrollment defects above fixed |
| 5 | Clinic + role + assignment + reviewer verification + owner + state | VERIFIED | authority matrix tested per role and per state |
| 6 | Strict validation and sanitisation | VERIFIED | strict zod schemas, unknown fields rejected, bounded clinical text |
| 7 | Safe rendering of clinical/user text | VERIFIED | text nodes only, no `dangerouslySetInnerHTML`; XSS strings kept verbatim |
| 8 | Rate limits on draft, review, approval | VERIFIED | durable Mongo-backed buckets 600/240/60 per hour per user |
| 9 | Safe errors, scoped 404, 409 for stale/incomplete | VERIFIED | error matrix in `VELORA_CARE_PLAN.md` section 7 |
| 10 | Exact CORS allowlist | VERIFIED | unchanged |
| 11 | CSP, headers, no-store | VERIFIED | helmet stack plus per-response `no-store, private` |
| 12 | Debug off | VERIFIED | unchanged; no stack traces or Mongo errors in responses |
| 13 | Dependencies reviewed before changes | VERIFIED | no dependency added; `npm audit --omit=dev` = 0 |
| 14 | No unused packages | VERIFIED | dependency set unchanged |
| 15 | Private files audited/ignored | VERIFIED | `.env` ignored at root/server/client; nothing new tracked |
| 16 | `MONGODB_URI` private | VERIFIED | server-only; no credentialed URI in tree or history |
| 17 | Argon2id/bcrypt preserved | VERIFIED | unchanged |
| 18 | Git history/tree scan | VERIFIED | both clean after the Part 5 work |
| 19 | Part 5 security audit completed | VERIFIED | this matrix plus `VELORA_CARE_PLAN.md` |
| 20 | Test, diff, commit after coherent work | VERIFIED | suites and journeys run before the commit |
| 21 | Continuous security | VERIFIED | conditional claim + unique index + append-only timeline + `expectedRevision` on every mutation |
| 22 | External APIs disclosed before use | VERIFIED | none used; gate documented |
| 23 | Every role, transition, denial and race tested | VERIFIED | 24 plan integration cases + 6 client cases + the M1 browser journey |
| 24 | README, authorities, API and review docs synchronised | VERIFIED | README, master, architecture, system design, structure, the new `VELORA_CARE_PLAN.md` and this log |
| 25 | One-viewport screens | VERIFIED | draft, sources, review and patient approved-plan screens measured at all six sizes |

### Duck verdict: PASS (Part 5, local scope)

All 25 controls are VERIFIED for the Part 5 scope with both suites, the full browser gate, the
production audit and both secret scans green. Evidence is local (development) with synthetic data
only; no production deployment, no clinical validation and no AI extraction is claimed or implied.
Part 6 was not started.

### Duck against VEL-005, VEL-006, VEL-007 and VEL-010

| ID | Requirement | Verdict | Evidence / caveat |
|---:|---|---|---|
| VEL-005 | Recovery episodes and care-team assignment (Part 3) | **VERIFIED (local)** - re-verified, not assumed | episode + care-team integration tests, the Part 3 browser journey and the detail measurements all still pass; Part 5 reads episodes only through `resolveClinicalAccess`/`assertEpisodeTeamWrite`, so no new bypass path was introduced |
| VEL-006 | Private discharge-document intake (Part 4) | **VERIFIED (local)** - re-verified, not assumed | document suite and journeys still pass; Part 5 consumes documents strictly as **ready sources** of the same episode, and cannot read bytes or alter a document's status |
| VEL-007 | Manual source-linked care-plan drafting (Part 5) | **VERIFIED (local)** | manual-only drafting with verbatim wording, ready-document citations, unresolved-field blocking and revision-guarded edits; no extraction assistance exists |
| VEL-010 | Medication schedules, daily tasks and actor-attributed logs (Part 7) | **PLANNED - correctly not activated** | no task, reminder, schedule or log model is written by approval; the browser journey asserts no task/reminder control or route appears for the patient, and the episode's own `status` is untouched by the approval transaction |

Ducking VEL-010 was the deliberate guard for this part: the temptation is to "finish" the plan by
creating the schedule it describes. Approval therefore stores clinical intent and **nothing else**;
scheduling stays Part 7.

### Remaining limits

- **Manual only.** No extraction, OCR, AI assistance or drug-interaction checking (Part 6).
- **No downstream activation.** Approval creates no task, reminder, schedule or message (Part 7).
- **Single reviewer.** One assigned verified reviewer decides; there is no multi-signature workflow.
- **Caregiver plan access is not wired.** `view_plan` is declared in the grant catalog but no caregiver
  route honours it, so granting it exposes nothing (fail-closed).
- **No MFA factor reset flow.** An enabled account can only verify; replacing a lost factor needs a
  deliberate audited flow that does not exist yet.
- **No production deployment or clinical validation**; quarantined documents still have no review UI,
  and the opt-in quarantine journey needs a 50 ms parser budget to run.

---

## Session - 11 October 2026 - Duck review: cross-part completeness audit (Parts 1-4)

### What was reviewed

The authority set (the three PDFs' markdown mirrors plus the owner's ten build prompts), `README.md`,
`.env.example`, the CI workflow and the whole `server/`, `client/` and `e2e/` trees, against the
exit gate of every part from 1 to 4 and all 25 security controls.

### Repository state on entry

| Item | Observed |
|---|---|
| Branch / HEAD | `main` at `1b4b302`, identical to `origin/main` |
| Dirty tree | clean; no untracked or ignored-in-error files |
| Commits | 25 meaningful commits across Parts 1-4 (no `fix:`-only padding run) |
| Tracked private files | `.env.example` and `.gitignore` only - no `.env`, key, upload or object file |
| Sessions in the browser gate | 5 enrolled roles (reviewer, admin, document coordinator, patient, caregiver) |
| CI state | **unavailable** - `gh` is not installed on this host, so the Actions/PR state could not be read; no pass is claimed for it |

### Part-by-part verdict

| Part | Deliverable | Verdict | Evidence |
|---:|---|---|---|
| 1 | Repository, authentication, clinic permissions | **COMPLETE (local scope)** | Argon2id only, opaque revocable sessions, forced staff MFA with TOTP + single-use recovery codes, double-submit CSRF bound to the session, invite/reset tokens stored as hashes, RBAC with a separately verified reviewer boundary and admin-without-clinical-access; CI gate present |
| 2 | Patient onboarding, consent and caregiver access | **COMPLETE (local scope)** | `PatientProfile`/`PatientAssignment`/`PatientConsent`/`CaregiverGrant`/`AccessInvitation`; consent append-only enforced **inside the model** (update/delete hooks throw); grants inactive until acceptance, expiring and revocable; intake assignment required for every staff read; caregiver screen scoped to `view_profile` only |
| 3 | Recovery episodes and care-team assignment | **COMPLETE (local scope)** | Immutable episode identity, atomic `{_id, revision, status:'draft'}` correction filter with append-only history, partial unique index on the active assignment, last-assignee protection, reviewer eligibility at assignment time, admin denied clinical metadata |
| 4 | Private discharge-document intake | **COMPLETE (local scope)** | Metadata-only documents, provider-neutral encrypted storage outside the repo, bounded isolated parser worker, authorize-before-read, quarantine/rejected/failed states, scoped mirror for the patient owner, reconciliation command; the live quarantine browser journey was added by this audit |
| 5-10 | Plans, AI, tasks, check-ins, closure, hardening | **PLANNED / not started** | Deliberately out of scope for Parts 1-4 |

### Drift found in this audit and fixed

| # | Drift | Classification | Fix |
|---:|---|---|---|
| 1 | Control #25 / VEL-017 evidence covered the LIST routes but not the detail screens, and nothing measured the caregiver screen | `DRIFT` (evidence gap) | Seeded a scoped caregiver account with an active `view_profile` grant and intake assignments for the document coordinator; enrolled a fifth browser session; added `e2e/detail-viewports.spec.js` (staff patient detail, staff episode detail, caregiver's scoped patient view) at all six sizes; `/app/patients` added to the coordinator session and `/app/caregiver` measured |
| 2 | The exit gate's "browser quarantine journey" had no reproducible live evidence | `PARTIAL` | Added the opt-in `e2e/documents-quarantine.spec.js` and ran it against an API started with `DOCUMENT_PARSER_TIMEOUT_MS=50`: a structurally valid 2,000,273-byte PDF was uploaded through the UI and came back **Quarantined**, with the held-for-operator note and no download offered |
| 3 | `VELORA_MASTER.md` still showed the 10 Oct requirement states (VEL-006 `PLANNED`, VEL-001..005 `IMPLEMENTED / UNVERIFIED`) | `DRIFT` (doc vs code) | Requirement table updated to the 11 Oct states through Part 4, with the honest residual limits inline |
| 4 | CI waited for the stack with an unpinned `npx wait-on` download | `DRIFT` (control #13/#14) | Replaced with a bounded `curl` readiness loop - no extra dependency enters the build |

### Evidence (all re-run on this HEAD, after the repairs above)

| Check | Command | Result |
|---|---|---|
| Server tests | `npm test -w server` | **100 pass / 0 fail**, exit 0 |
| Client tests | `npm test -w client` | **18 pass / 0 fail**, exit 0 |
| Client lint | `npm run lint -w client` | clean, exit 0 |
| Production build | `npm run build -w client` | succeeds, exit 0 |
| Browser journeys | `npx playwright test` | **48 pass / 0 fail / 1 skipped**, exit 0 (the skip is the opt-in quarantine journey) |
| Quarantine journey | `E2E_QUARANTINE=1 npx playwright test e2e/documents-quarantine.spec.js` | **1 pass**, exit 0 |
| Document reconciliation | `npm run documents:reconcile -w server` | clean store (0 missing / 0 unreadable / 0 mismatches / 0 orphans); drift detection and the `--apply` operator guard verified separately |
| Production audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Tree secret scan | `git grep` for key patterns | no matches |
| History secret scan | `git log -p --all` for key patterns | 0 matches |
| Env/template drift | `env.js` keys vs `.env.example` | no missing key; only `TEST_MONGO_*` and `VITE_API_BASE_URL` are extra |
| Unsafe HTML / secret leak into the bundle | grep for `dangerouslySetInnerHTML`/`innerHTML` and server secret names in `client/` | no matches |
| Dead scaffolding | grep for `TODO`/`FIXME`/placeholders in `server/src`, `client/src`, `e2e` | none (one HTML `placeholder` attribute) |

### Requirement coverage (Parts 1-4 scope)

`VEL-001`..`VEL-006` and `VEL-017`..`VEL-020` are `VERIFIED` at local scope. `VEL-007`+ remain
`PLANNED` (Parts 5-10 were not started). `VEL-021` stays `PARTIAL`: 25 meaningful commits against a
50+ target for the *completed* project, with no commit padding.

### Security-25 status for the Parts 1-4 scope

Controls 3, 4, 5, 6, 8, 9, 11, 21, 23 were verified by the part gates above (route protection,
auth/MFA/CSRF, server-side clinic+assignment+state checks, input/byte validation, separated upload and
download limits, safe error envelope, file-response headers, and the adversarial suites). Controls 1,
2, 13, 14, 15, 16, 17, 18, 22 were re-checked directly in this audit (no secret in the tree or
history or the bundle, fail-closed env with storage-root/key pairing, unchanged pinned dependency set
with a 0-vulnerability production audit, private-file ignore rules, server-only `MONGODB_URI`, Argon2id
intact, and no external provider added). Control 7 is structural (no unsafe HTML anywhere). Controls
10, 12 and 24 were checked against the code and documents changed here. Control 19 is this entry;
control 20 was satisfied by the three Part 4 commits and by leaving the restored gates green; control
25 now covers list routes, detail screens, document screens and the caregiver view.

### Duck verdict: PASS (Parts 1-4, local scope)

All four completed parts meet their exit gates on this HEAD, with the four drift items above repaired
and every check re-run afterwards. Evidence remains local: no deployment, no real data, no antivirus
certification and no clinical validation.

### Remaining limits (carried forward)

- CI/Actions and pull-request state cannot be read from this host (`gh` unavailable), and all work has
  been committed directly to `main` with no review PR - a deviation from the Part 2 prompt guidance.
- Quarantined documents have no operator review screen yet (status plus the reconciliation command).
- Validation is structural, not antivirus; no scanning provider is authorized.
- A live parser timeout is only reproducible with a lowered wall-clock budget (documented opt-in spec).
- Caregiver scopes other than `view_profile` remain inert by design; administrator clinical access is
  possible only through an explicit assignment, never through admin status.
- No production deployment, restore drill, retention policy or clinical-readiness gate (Parts 9-10);
  the commit-count target is a whole-project goal.

---

## Session - 11 October 2026 - Part 4 (private discharge-document intake)

### Duck review (start of session)

**Files read:** the three authority PDFs, `VELORA_MERN_10_BUILD_PROMPTS.md`, `README.md`, the `docs/`
set, `.env.example`, `.gitignore`, the CI workflow, and the full `server/`/`client/`/`e2e/` trees.

**Observed repository state:** on `main` at HEAD `6b5ca2a` ("test+docs: Part 3 episode journey and
synced documentation") with a clean tree; Parts 1-3 committed and green (73 server, 12 client, 17
browser journeys). No document model, worker, storage provider, route or screen existed.
**Classification on entry:** Parts 1-3 `VERIFIED`; Part 4 `PLANNED`.

**Drift found and fixed before adding document functionality:**

| Drift | Fix |
|---|---|
| No document environment contract | `env.js` validates `DOCUMENT_STORAGE_ROOT` (absolute, outside the repo) **paired** with `DOCUMENT_ENCRYPTION_KEY` (32-byte base64), plus the bounded-worker limits; `.env.example` documents each one |
| Errors had no saturation code | added `503 SERVICE_BUSY` to the safe error envelope |
| CORS allowlist could not carry an upload filename | added only `X-Document-Filename`, the single header the client sends |
| Seed had no care team for a document journey | synthetic draft/closed/patient-linked episodes with an active assignment |
| Browser sessions were enrolled for two roles only | global-setup enrols the document coordinator and patient accounts as well |

### External service gate (control #22)

**No external provider was selected or called.** AWS S3, Cloudinary, Firebase, an antivirus provider,
an OCR provider and a queue provider are **DISCLOSED / NOT SELECTED**. Storage is a provider-neutral
interface (`put`/`get`/`stat`/`remove`/`listKeys`/`newStorageKey`) whose shipped implementation is a
private encrypted filesystem provider outside the repository. Metadata lives in MongoDB; no public
URL is ever stored or returned.

### Work performed (Part 4)

| Area | Result |
|---|---|
| Model | `EpisodeDocument`: immutable clinic/patient/episode, opaque storage key, display filename, allowlisted media type, byte size, SHA-256, status, safe rejection code, non-clinical technical facts, uploading actor, timestamps |
| Indexes | unique `storageKey`; unique `{episode, sha256}`; list index `{clinic, episode, createdAt}`; `status` |
| Storage | `documentStorage`: opaque UUID keys re-validated against a strict pattern, AES-256-GCM envelope `VD1`, exclusive `wx` writes, `0600`/`0700` permissions, `lstat` before read, no symlinks; root outside the repo |
| Validation | `documentValidator` + `workers/documentParser`: wall-clock timer, heap cap, concurrency + queue limits, environment reduced to `NODE_ENV`, stable codes only; `documentInspector` is dependency-free and secret-free |
| Service | `documentService`: authorize-before-read, bounded body, validation, duplicate short-circuit, metadata-then-object-then-`ready`, quarantine path, failed path, scoped list/detail, download with fresh authorization + decryption + size + SHA-256 verification |
| Access | write = active team member on a `draft` episode; read/download = team member or patient owner; admin 403; everything else uniform 404 |
| Routes | staff `/episodes/:id/documents[...]` (upload/read/download limits) and read-only patient mirrors under `/patient/me/episodes/:id/documents` |
| Client | `features/documents/{DocumentsPanel,DocumentUpload,documentRules}`: `choose -> review -> upload -> result`, paginated list, technical-status summary and notes, authenticated blob download with object-URL cleanup, denied states; wired into the staff episode detail and the patient's own episode |
| Recovery | `scripts/reconcile-documents.js` (dry run by default; `--apply` requires `--operator` and audits every repair) |
| Tests | `tests/integration/documents.test.js` (24, including every adversarial file, the failure paths and the patient-owned mirror) + client `documents.test.jsx` (6) + `e2e/documents.spec.js` (7 journeys) |
| Docs | README plus new [VELORA_DOCUMENT_STORAGE.md](VELORA_DOCUMENT_STORAGE.md) (API contract, storage setup, recovery), and synced architecture/system-design/structure docs |

### Key invariants enforced

- Authorization happens **before** the request body is read, and is re-checked immediately before
  persistence; an unauthenticated or unauthorized caller's bytes are never buffered.
- The body is capped at 10 MiB while streaming: a longer body is destroyed mid-stream and answered
  with `413`, never buffered to completion.
- The validator runs in an isolated worker with a time limit, a memory limit, a concurrency limit, a
  bounded queue and **no application secrets**; only stable codes leave it.
- Encrypted PDFs, PDF scripts/actions/attachments/forms/external references, malformed or truncated
  PDFs, page/object/stream excesses, image pixel bombs and multi-frame images are refused; the
  inconclusive cases are quarantined, never marked ready.
- `ready` means technically accepted for later review and is never presented as clinical approval.
- MongoDB metadata and the encrypted object are not one transaction; the drift window is documented
  and every drift state is reported by the reconciliation command rather than served to a user.
- Reconciliation never repairs anything without an explicit operator attribution, and each repair is
  audited.

### Evidence

| Check | Command | Result |
|---|---|---|
| Server tests | `npm test -w server` | **100 pass / 0 fail** (unit + integration on the replica set) |
| Client tests | `npm test -w client` | **18 pass / 0 fail** |
| Client lint | `npm run lint -w client` | clean |
| Client build | `npm run build -w client` | production build succeeds (63 modules) |
| Browser journeys | `npx playwright test` | **36 pass / 0 fail** at Part 4 close (upload/refusal/download journeys plus the six-viewport suite); **48 pass / 0 fail** once the cross-part audit added the detail-screen and caregiver sessions |
| Document reconciliation | `npm run documents:reconcile -w server` | dry run on the live store: 24 live rows / 24 objects, 0 missing, 0 unreadable, 0 integrity mismatches, 0 orphans. Removing one object of a `ready` row was reported as `missing: <id> key <uuid>`, and an unreferenced object as `orphan: <uuid>`; both were restored afterwards, and `--apply` without `--operator` was refused with exit code 2 |
| Production audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Secret scan (tree) | `git grep` for key patterns | no credentials; only `.env.example` tracked |
| Secret scan (history) | `git log -p --all` for key patterns | clean |

Downloaded `ready` bytes were compared with the uploaded original in the browser journeys
(`Buffer.compare` = 0) and in the integration suite (SHA-256 equality).

### Security-25 matrix (Part 4)

| # | Control | Status | Evidence |
|---:|---|---|---|
| 1 | Secrets hidden | VERIFIED | document key server-only; `.env`/objects untracked and outside the repo |
| 2 | Fail-closed env | VERIFIED | root/key pairing, absolute-and-outside-repo root, worker limits validated at startup |
| 3 | Private routes guarded | VERIFIED | every document route behind session + clinic context + service-side access resolution |
| 4 | Argon2id, MFA, sessions, CSRF | VERIFIED | unchanged; upload requires the CSRF header |
| 5 | Clinic + assignment + episode state, default deny | VERIFIED | authorize-before-read, revoked assignment, other clinic, admin denial, caregiver denial, closed episode |
| 6 | Validate metadata, headers and bytes | VERIFIED | filename/extension/declared type/magic bytes/parsed type/trailing data plus structural rules |
| 7 | No unsafe rendering, attachment handling | VERIFIED | forced `attachment`, `nosniff`, restrictive CSP, no inline rendering |
| 8 | Rate, worker, memory, time, body limits | VERIFIED | separate upload/read/download limits; bounded body; worker time/memory/concurrency/queue caps |
| 9 | Safe errors, no parser diagnostics | VERIFIED | stable codes and a uniform envelope; internal paths never leave the process |
| 10 | Exact CORS allowlist | VERIFIED | only `X-Document-Filename` added |
| 11 | Security and download headers | VERIFIED | helmet + `no-store`, `nosniff`, sandbox CSP, same-origin resource policy |
| 12 | Production debug off | VERIFIED | unchanged; documents expose no parser detail in any environment |
| 13 | Dependency review before install | VERIFIED | no new dependency; `npm audit --omit=dev` = 0 |
| 14 | No unused packages | VERIFIED | dependency set unchanged |
| 15 | Ignore `.env`, uploads, objects, keys | VERIFIED | `.gitignore` covers env files, `*.key`, `uploads/`, private document directories |
| 16 | `MONGODB_URI` server-only | VERIFIED | unchanged |
| 17 | Argon2id/bcrypt preserved | VERIFIED | unchanged |
| 18 | Tree and history scan | VERIFIED | both clean |
| 19 | Document-security audit | VERIFIED | this matrix plus the dedicated storage/recovery doc |
| 20 | Test, diff, meaningful commit | VERIFIED | suites run before the commits |
| 21 | Continuous security | VERIFIED | exclusive writes, unique indexes, verify-on-download, audit on mutation |
| 22 | Disclose external providers first | VERIFIED | none selected; gate documented in README and the storage doc |
| 23 | Happy, denied and adversarial files | VERIFIED | 24 integration cases + 6 client cases + 7 browser journeys |
| 24 | Documentation synchronised | VERIFIED | README, storage/recovery doc, architecture, system design, structure, this log |
| 25 | One-viewport screens | VERIFIED | document screens asserted at all six sizes inside the journeys |

### Duck verdict: PASS (Part 4, local scope)

All 25 controls are VERIFIED for the Parts 1-4 scope with the full suites, the production audit and
both secret scans green. Evidence is local (development) with synthetic files only; no production
deployment, antivirus certification or clinical validation is claimed. Part 5 was not started.

### Remaining limits

- Quarantined documents need an operator decision; no review UI exists for them yet, only the
  metadata status and the reconciliation command.
- A live parser timeout or crash cannot be triggered deterministically from file content on a healthy
  host; those paths are driven by the test-only stall hook and the memory cap in the integration
  suite, and the browser journeys cover the refused/quarantined *presentation* instead.
- No malware scanning: structural validation is not antivirus.
- Documents are never deleted automatically; retention and privacy-request workflows arrive in Part 9.

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
