# Velora MERN - Operations and Restore Runbook

Part 10 operations reference: how the service behaves in production, how to probe it, how to back it
up, how to restore it and what still requires an owner decision. Every claim below is either
**verified in this repository** (with the command that verifies it) or explicitly marked
**NOT IMPLEMENTED / BLOCKED**. Nothing here is a promise about a deployment that has not happened.

Authority for scope remains the three owner PDFs; this runbook does not extend them.

| Evidence class | Meaning here |
|---|---|
| VERIFIED | the behaviour is implemented and exercised by the local gate |
| NOT IMPLEMENTED | named deliberately: the code path does not exist yet |
| BLOCKED | needs an owner decision, a provider, or a real environment |
| OWNER DECISION | a product/privacy/clinical choice that code must not infer |

---

## 1. What actually runs

| Component | Runtime | Notes |
|---|---|---|
| API | Node 20+ / Express | `server/src/index.js`; fail-closed startup, graceful shutdown |
| Database | MongoDB **replica set** (or mongos) | transactions are required from Part 2 on; a standalone mongod is not supported |
| Object store | Encrypted files on the local filesystem behind a provider-neutral interface | AES-256-GCM per object with `DOCUMENT_ENCRYPTION_KEY`; no external object-store provider is selected (see the provider decision register) |
| Client | Static React build served anywhere (Vite dev server in development) | the browser receives only `VITE_*` values; **no secret is ever a Vite value** |
| Providers | **none selected** | extraction ships `none` (AI off) or the local deterministic `fake`; reminders ship `in_app` only |

There is no queue daemon, no scheduler and no mail transport in the shipped system. Every
state-changing operation is an explicit HTTP action performed by an authenticated actor.

---

## 2. Configuration

Required server variables and their production rules are validated once at startup in
`server/src/config/env.js`. The process **refuses to start** on a violation and prints the offending
FIELD NAMES only (never a value):

```text
[startup] Invalid server environment configuration. Check: LOG_LEVEL, MONGODB_URI. See .env.example.
```

Production-only refusals (each has a unit test):

| Refusal | Why |
|---|---|
| `CLIENT_ORIGIN` not `https://`, or not a bare origin (path/query/trailing slash) | an allowlist entry that can never match a real `Origin` is a broken control, and plain HTTP in production is not acceptable |
| `LOG_LEVEL=debug` | production diagnostics stay off |
| `SESSION_PEPPER` shorter than 32 characters | the pepper protects every stored session-token hash |
| `MFA_ENCRYPTION_KEY`, `DOCUMENT_ENCRYPTION_KEY`, `PRIVACY_EXPORT_ENCRYPTION_KEY` reusing a value, or equal to the pepper | key separation: one leaked key must never open another store |
| `MONGODB_URI` without TLS (`mongodb+srv://` or `tls=true`) | clinical records in transit |
| `MONGO_MIN_POOL_SIZE > MONGO_MAX_POOL_SIZE` | a pool that cannot exist |

Bounded runtime budgets (defaults; all overridable, all validated):

| Variable | Default | Effect |
|---|---|---|
| `JSON_BODY_LIMIT_KB` | 32 | JSON body ceiling for ordinary API calls |
| `REQUEST_TIMEOUT_MS` | 30000 | server request timeout; also the Mongo socket timeout |
| `SHUTDOWN_GRACE_MS` | 15000 | how long a drain may take before it is forced |
| `MONGO_MAX_POOL_SIZE` / `MONGO_MIN_POOL_SIZE` | 10 / 0 | bounded connection pool |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | 5000 | fail a request instead of queueing forever |
| `TRUST_PROXY` + `PROXY_HOPS` | false / 1 | see below |

**Proxy trust is an operator decision, never a default.** With `TRUST_PROXY=false` the socket
address is the client address and a forged `X-Forwarded-For` is ignored by `req.ip`. Turning it on
requires stating the exact hop count; the process logs one warning line
(`server.proxy_not_trusted`) when it is off, because behind a proxy that deployment would key its
rate limits and audit trail on the proxy address instead of the caller.

`TRUST_PROXY=false` is also the safe setting for a direct-exposure deployment: the Express rate
limiter and every Mongo-backed limiter key on `req.ip`, so an unverified forwarding header would be
an unauthenticated input to a security control.

---

## 3. Health and readiness

Both endpoints are unauthenticated (a probe holds no session) and therefore disclose nothing: no
version, host, path, credential or driver text. They are mounted **before** the rate limiter, the
session resolver and CSRF, so a probe never consumes a caller's budget and answers even when the
auth stack is broken. Integration coverage: [health.test.js](../server/tests/integration/health.test.js).

| Endpoint | Meaning | Success | Failure |
|---|---|---|---|
| `GET /api/health` | **liveness**: is the process serving HTTP? Checks no dependency. | `200 {"ok":true,"status":"healthy","uptimeSeconds":N}` | — |
| `GET /api/ready` | **readiness**: may this process take clinical traffic? Probes the database with a real `ping` and the encrypted storage root for existence and writability. | `200 {"ok":true,"status":"ready","checks":{"database":"ok","storage":"ok"}}` | `503` with `status` `draining`, or `checks.database`/`checks.storage` naming the failing side (`not_connected`, `unreachable`, `missing`, `unusable`, `not_a_directory`) |

Probe guidance:

- Liveness: never restart on a 503 from `/api/ready` alone — check readiness, not liveness, for
  dependency trouble.
- Readiness: remove the instance from rotation while it answers 503. During shutdown the process
  reports `draining` **before** it stops accepting connections, so a load balancer drains it first.
- Both responses are `Cache-Control: no-store`.

**Rate-limit shape (verified).** A coarse in-process limiter allows **300 requests per minute per
client IP** under `/api`; the two probes are mounted before it, so a probe never spends that budget
(measured: request 301 in one window returns 429). Sensitive routes add durable MongoDB-backed limits
keyed by action and actor, which survive restarts and span processes. Three consequences for
operations:

1. Many users behind one NAT/proxy share the per-IP budget. Budget for a clinic's whole egress, and
   make sure `TRUST_PROXY`/`PROXY_HOPS` are correct — otherwise every caller collapses onto the
   proxy's address and the budget is spent by the first heavy user.
2. Heavy automation against a **development-mode** API can trip the coarse limiter and show up as
   intermittent sign-in screens; the browser gate runs the API with `NODE_ENV=test`, where the coarse
   limiter is skipped and the durable per-route limits still apply.
3. The production limit values are deployment budgets, not clinical controls: raise them only with a
   load test, and never disable the durable per-route limits (password, MFA, export, AI budgets).

Alert-worthy operational events (structured log lines; one per STATE CHANGE, not per probe):

| Event | Level | Meaning |
|---|---|---|
| `readiness.unavailable` | error | database or encrypted storage is not usable; requests will fail |
| `readiness.recovered` | info | back in service |
| `server.proxy_not_trusted` | warn | `TRUST_PROXY=false`: rate limits and audit IPs are the socket address |
| `shutdown.begin` / `shutdown.complete` | info | graceful drain started / finished |
| `shutdown.forced` | error | in-flight requests exceeded `SHUTDOWN_GRACE_MS`; process exits non-zero |
| `audit.write_failed` | error | the audit trail could not record an action — **treat as an incident**, the action itself already succeeded |
| `request.unhandled_error` | error | an unexpected error reached the error handler (request id attached) |
| `process.uncaught_exception` | error | fatal: the process drains and exits non-zero |
| `process.unhandled_rejection` | error | recorded and the process continues; the request path already fails closed |

---

## 4. Startup and shutdown

**Startup order** (any failure exits non-zero; the process never runs partially configured):

1. Load and validate the environment (field names only on failure).
2. Resolve and validate the extraction provider (`none` by default); an unknown provider or a
   missing key fails here, not on the first clinical request.
3. Connect to MongoDB with the bounded pool.
4. Build the app, apply request/header/keep-alive timeouts, listen, and log one non-sensitive
   configuration summary (`server.listening`).

**Graceful shutdown** (`SIGTERM`/`SIGINT`, or a fatal `uncaughtException`):

1. Mark the process draining (`/api/ready` → `503 draining`).
2. `server.close()` — stop accepting new connections; in-flight requests keep their sockets.
3. After the listener closes: disconnect MongoDB and exit `0`.
4. If the drain exceeds `SHUTDOWN_GRACE_MS`: log `shutdown.forced` and exit `1` (the orchestrator
   should treat this as an unclean stop and investigate).

There is **no** in-flight request draining beyond the grace window and no connection draining
tuning knob beyond the above. Adjust `SHUTDOWN_GRACE_MS` and the platform's termination grace
period together so the platform does not `SIGKILL` before the drain completes.

---

## 5. Logging

One JSON object per line on stdout, level-filtered by `LOG_LEVEL`:

```json
{"ts":"2026-10-16T07:14:54.824Z","level":"warn","event":"server.proxy_not_trusted","note":"TRUST_PROXY is false: req.ip is the socket address. ..."}
```

Rules the implementation enforces (unit coverage: [logger.test.js](../server/tests/unit/logger.test.js)):

- Every line carries `ts`, `level` and a **named** `event`; free text is never interpolated.
- Fields whose KEY looks sensitive (`password`, `token`, `secret`, `pepper`, `key`, `cookie`,
  `authorization`, `otp`, `mfa`, `hash`, …) are replaced with `[redacted]` at every depth,
  including inside `Error` objects.
- Strings are truncated and arrays/depth are capped, so one log line cannot be an exfiltration path
  and a circular value cannot hang the process.
- **Stack traces are never written when `NODE_ENV=production`.**
- Clinical content is never logged: the audit trail stores redacted detail server-side, and the
  logger receives counts, ids and error summaries only.
- Request correlation: every response carries `X-Request-Id`, and the same id appears on
  `request.unhandled_error` lines.

Log retention is an owner decision; the retention engine can report operational-log eligibility
(`operational_logs` category) but automated destruction is **not** enabled.

---

## 6. Backup

A backup of this system is **four assets, not one**. Restoring a subset produces the drift the
reconciliation command exists to detect.

| Asset | Where it lives | Why it must be in the same backup set |
|---|---|---|
| MongoDB data | the replica set | episodes, plans, schedules, check-ins, audit trail, privacy requests |
| Encrypted objects | `DOCUMENT_STORAGE_ROOT/objects` (and `.../exports` for generated exports) | stored documents, encrypted per object |
| Keys | `DOCUMENT_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `PRIVACY_EXPORT_ENCRYPTION_KEY`, `SESSION_PEPPER` | **without the document key the object store is unusable data**; without the MFA key no staff member can complete MFA |
| Configuration | the deployment's environment (names in [.env.example](../.env.example)) | a restore that cannot start is not a restore |

Backup cadence, provider, encryption-at-rest, off-host/off-region storage, immutability and audit of
backup access are **OWNER DECISION / BLOCKED**: no external provider is selected, so no schedule
and no retention window can be claimed. What the code can state honestly is its **recovery point
requirement**: MongoDB metadata and the object store are not written in one transaction, so a
backup must capture both at (or near) the same instant, or accept a bounded reconciliation step
after restore.

Backups must never include `.env`, keys in plaintext, or a copy of this repository; keys belong in a
secret manager the owner selects.

---

## 7. Restore

Recommended order (any other order leaves the system with either metadata without bytes, or bytes
without a key):

```text
1. Restore the configuration and the three keys (+ the session pepper) into the target environment.
2. Restore the encrypted object store to the configured DOCUMENT_STORAGE_ROOT.
3. Restore the MongoDB data.
4. Start the API (it fails closed if any of the above is inconsistent).
5. Verify: /api/ready → ready, then reconcile and re-run the drill below.
```

### 7.1 The synthetic restore drill (VERIFIED)

```bash
node server/scripts/restore-drill.js                 # drills MONGODB_URI, then cleans up
node server/scripts/restore-drill.js --keep           # leave the restored copy for inspection
node server/scripts/restore-drill.js --source <uri> --target <uri>
```

What it does: copies every collection into an isolated drill database, recreates **every index with
its options**, copies the encrypted objects into a scratch directory, then verifies the restored
copy by READING it back — collection set, row counts, deterministic per-collection content
checksums, index fidelity (name, key, uniqueness, partial filter, TTL), object bytes, and a real
AES-GCM decryption of stored documents (compare with the recorded `sha256`). It also re-checks the
source to prove the drill changed nothing, never restores over the live or application database,
and drops the target unless `--keep`.

Observed on the seeded synthetic database (16 October 2026, this host):

```text
PASS  collections restored                    48 of 48
PASS  row counts identical                    4176 rows across 48 collections
PASS  content checksums identical             0 mismatch(es)
PASS  indexes identical                       name/key/uniqueness/partial filter/TTL
PASS  object store bytes identical            162 objects, 6054128 bytes restored
PASS  restored documents decrypt + match hash 25 of 25 ready documents
PASS  source unchanged by the drill           read-only
observations: dump 220 ms, restore 8001 ms, object copy 348 ms, verify 396 ms
```

**The drill found a real defect in itself on its first run**, which is the point of running it: a
*partial* unique index (the "at most one ACTIVE caregiver grant" rule) was rebuilt as a *full*
unique index, so the restore rejected legitimately repeated `(clinic, patient, caregiver)` rows from
revoked grants. Index options are now recreated and compared as part of the drill, and a failure to
rebuild an index is reported as a finding instead of crashing.

What this proves: the rows, indexes, objects and key are sufficient to reconstruct a working copy on
the same host, and stored documents decrypt from that copy.
What it does **not** prove (**BLOCKED**): provider-level durability, cross-region or point-in-time
recovery, a bounded RPO (the copy is taken live; there is no scheduled backup) or a production RTO
(the timings above are synthetic).

### 7.2 Reconciliation after a partial restore

```bash
node server/scripts/reconcile-documents.js                            # dry run (default)
node server/scripts/reconcile-documents.js --apply --operator you@clinic.example
```

Reports metadata rows whose object is missing/unreadable/tampered (verified by re-decrypting and
re-hashing) plus orphan objects, and requires an explicit operator attribution to repair, auditing
every repair. Never run `--apply` as the first step of a restore: report first.

The report is read-only by default and the repair path has its own integration test, which creates
each drift class deliberately (lost object, tampered envelope, validly encrypted object whose
plaintext no longer matches its recorded hash, orphan with no metadata row) and asserts the dry run
changes nothing before asserting the repair.

---

## 8. Rotation runbooks

| Secret | Rotation | Status |
|---|---|---|
| Provider API key (none selected today) | set the new value, restart, confirm the provider gate passes | **NOT IMPLEMENTED** (no provider selected) |
| `SESSION_PEPPER` | replacing it invalidates every stored session-token hash AND every MFA recovery-code hash, so every user is signed out and every recovery code becomes useless. Deploy the new value, then sign everyone out and re-issue recovery codes; confirm `GET /api/auth/me` returns 401 with an old cookie and a fresh login succeeds | **VERIFIED** (sessions and recovery codes are peppered hashes; there is nothing to re-seal) |
| `MFA_ENCRYPTION_KEY` | re-sealed by `scripts/reseal-keys.js`: same seed, new key, so existing authenticator entries keep working. Verified by re-reading the stored seed with the new key and by driving a real TOTP verification after the rotation | **VERIFIED (local drill)** |
| `DOCUMENT_ENCRYPTION_KEY` | re-sealed by `scripts/reseal-keys.js`, one object at a time, each verified against the hash the database recorded before the old key is removed | **VERIFIED (local drill)** |
| `PRIVACY_EXPORT_ENCRYPTION_KEY` | generated exports are short-lived (`EXPORT_ARTIFACT_TTL_HOURS`); the practical procedure is to revoke outstanding exports, rotate, and let existing artifacts expire rather than re-sealing them | PARTIAL |
| `MONGODB_URI` credentials | rotate at the database, then restart; the process refuses to start if the new URI lacks TLS in production | **VERIFIED** (startup gate) |

### 8.1 Rotating the MFA or document key (`scripts/reseal-keys.js`)

A rotation is a **two-key window**, not a single edit. The process must be able to read with the old
key and write with the new one, so both are present for exactly one run.

```bash
# 1. Generate the new key (`npm run gen:env` prints a 32-byte base64 value).
# 2. In the secret store: set the NEW value as the current variable and move the OLD
#    value into its *_PREVIOUS variable.
#    MFA_ENCRYPTION_KEY=<new>       MFA_ENCRYPTION_KEY_PREVIOUS=<old>
#    DOCUMENT_ENCRYPTION_KEY=<new>  DOCUMENT_ENCRYPTION_KEY_PREVIOUS=<old>
# 3. Restart. Startup refuses a *_PREVIOUS value that equals its current key
#    (that rotation would silently change nothing) or that reuses another store's key.
# 4. Report first - this writes nothing:
npm run keys:reseal -w server
# 5. Re-seal, attributed:
npm run keys:reseal -w server -- --apply --operator you@clinic.example
# 6. Verify: the report lists documents resealed, documents verified (read back with the NEW
#    key and compared to the stored sha256), MFA seeds verified, and every failure per id.
# 7. Remove the two *_PREVIOUS variables and restart.
```

Properties of the pass, all asserted by `server/tests/integration/resealKeys.test.js`:

- **Dry run by default**; `--apply` refuses without `--operator` and exits non-zero.
- **No plaintext outside the process**: each object is decrypted in memory only to be re-encrypted
  under the new key.
- **Crash-safe per object**: the new envelope is written to a sibling temp file, verified by
  decrypting it back, and only then renamed over the original, so an interrupted run leaves the
  original object intact. A temp file left by a killed run is swept on the next one.
- **No loss**: after the pass, every object is read back with the NEW key and compared against the
  hash recorded in MongoDB. A mismatch is reported, never assumed away.
- **No clobbering**: an MFA re-seal is a compare-and-set on the old sealed value, so a user who
  re-enrols mid-rotation keeps their new secret and is reported as skipped.
- **One audit event per run** (`key.rotation.resealed`) with counts and outcome - no key, no secret
  and no filename ever reaches the trail.
- **Nothing is rewritten that the previous key cannot open**: such an object (an older generation, or
  a botched earlier rotation) is reported as `previous-key-cannot-open` and left exactly as it was,
  so the correct key can still rescue it.

After a document-key rotation, run the restore drill and the reconciliation report again: a rotation
is a data-handling event, and the drill is what proves the store is still consistent with it.

**Still BLOCKED for a real deployment:** this drill is local and synthetic. Nothing has been rotated
against a managed key store or an object-storage provider with versioning, so provider-specific
rotation behaviour (versioned objects, server-side re-encryption, key-store audit logs) is unverified.

---

## 9. Retention and destructive operations

- Configuration, dry run and gated apply: `POST /api/retention/dry-run`, `POST /api/retention/apply`
  (operator + reason, idempotent by key, capped by `RETENTION_APPLY_MAX_ITEMS`, audited).
- **Clinical categories (`documents`, `historical_records`) are report-only**: no automated run
  deletes them, at any setting.
- Holds freeze a category or a single subject until explicitly released.
- There is **no scheduler**: apply is an explicit operator action, and the dry run is the documented
  gate before it. Scheduling it (cron/platform timer) is an **OWNER DECISION**.
- No destructive deletion has ever been performed; Part 10 does not change that.

---

## 10. Failure behaviour by dependency

| Failure | Behaviour |
|---|---|
| MongoDB unreachable at startup | process exits non-zero with `startup.database_unreachable` |
| MongoDB unreachable while running | `/api/ready` → 503 (`database`); requests fail closed with a safe error; pool selection timeout bounds the wait |
| Encrypted storage root missing/unwritable | `/api/ready` → 503 (`storage`); uploads and downloads fail closed; no metadata row is written for a failed upload |
| Extraction provider selected but misconfigured | process exits non-zero at boot; if a provider is disabled at runtime the job fails closed with `PROVIDER_DISABLED` and the manual drafting path stays available |
| Reminder delivery failing | bounded attempts (`REMINDER_MAX_ATTEMPTS`), the failure is a delivery FACT (never a missed dose); failed deliveries surface in the `failed_reminders` queue and in the closure preflight (advisory, not blocking) |
| Storage tampering / corruption | decryption fails authentication on read; the reconciliation command reports it and can mark the document `failed` with an operator attribution |
| Slow client (dribbled body/headers) | `REQUEST_TIMEOUT_MS` / `headersTimeout` cut it off |
| Grace window exceeded during shutdown | `shutdown.forced`, exit code 1 |

---

## 11. Incident response

1. **Contain**: unpublish/stop the API, or block at the proxy; the platform is the only place a
   global switch exists today.
2. **Preserve**: the audit trail is append-only and the logs are structured JSON. Do not edit rows;
   export the audit range for the incident window (administrative, range-bounded search).
3. **Revoke**: sessions are revocable individually and per user; MFA recovery codes can be reissued;
   caregiver grants can be revoked immediately (they are re-read from the database per request).
4. **Assess**: intake of a suspected privacy event is the existing privacy-request workflow
   (`export` / `correction` / `deletion_request`) with identity verification and decisions.
5. **Notify**: who must be told, and within what window, is an **OWNER DECISION** (DPO/legal and the
   partner clinic). The code cannot and does not define a legal notification obligation.
6. **Learn**: append a session-log entry with evidence class, and re-run the restore drill if
   backups or keys were touched.

---

## 12. Verification commands

```bash
npm run mongo:test-rs -w server     # disposable single-node replica set (transactions)
npm test                            # server suite + client tests
npm run lint -w client
npm run build -w client
npm run e2e                         # Playwright journeys (needs API + client running and seeded)
npm audit --omit=dev                # production dependency audit
node server/scripts/restore-drill.js
node server/scripts/reconcile-documents.js
node server/scripts/reseal-keys.js          # dry run; "nothing to do" unless a rotation is staged
```

CI runs the same gate (`.github/workflows/ci.yml`): server tests against a replica set, client
tests/lint/build, the browser journeys, the provider-disabled fail-closed restart, the **restore
drill and the read-only reconciliation report on the seeded database**, the production dependency
audit and a secret scan over tree and history.

Recommended repository protections (a settings change, not code): require the `Server tests`,
`Client tests, lint and build`, `Browser journeys` and `Dependency audit and secret scan` checks
before merge, and require a review on `main`; no direct pushes to `main`.

---

## 13. Decisions still required before any pilot or deployment

1. **Provider selection** for hosting, managed MongoDB, private object storage, notification
   delivery, job processing, AI/OCR and monitoring — each with its control-#22 disclosure
   ([provider decision register](VELORA_PROVIDER_DECISIONS.md)).
2. **Backup cadence, location, encryption, retention and access audit** (and therefore the actual
   RPO/RTO commitments).
3. **A managed key store and rotation cadence**: the re-seal command exists and is proven locally
   (§8.1), but WHERE the keys live, WHO may rotate them, and HOW OFTEN is still an owner decision —
   and a provider's own rotation behaviour (versioned objects, key-store audit logs) is unverified.
4. **Retention scheduling** and the legal retention windows per clinic.
5. **Clinical governance**: who reviews the clinical workflow, which procedure(s) are in scope, and
   which authorized datasets may be used.
6. **Privacy/legal**: DPIA equivalent, lawful basis, notification obligations, data-subject process.
7. **Incident ownership and response hours**, plus the on-call escalation path.
8. **Partner clinic and pilot cohort** — no real patient data has ever entered this system.
