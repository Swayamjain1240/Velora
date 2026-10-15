# Velora - closure, audit, privacy requests and retention (Part 9)

This document is the reference for the Part 9 surfaces: episode closure, the audit
trail, privacy requests, retention and operational metrics. It is written to be
read alongside the Master, Architecture and Duck Log PDFs, which remain the
project authority.

## 1. Closure is operational, never clinical

Closing an episode records that **coordination work has ended**. It does not mean
the patient recovered, was discharged "healthy", or is care-complete. The code
enforces that wording:

- `closurePolicy.describesClinicalRecovery` rejects a closure reason containing
  recovery language, and the API returns `400`.
- The closure event (`EpisodeClosure`) has no field that could carry a diagnosis
  or outcome. It stores the action, the resulting state, the reason, the
  operational closure date, the actor, the policy checks and the preflight
  snapshot.
- Closure rows and their history are **append-only**: a reopen appends a new row
  and the earlier closure stays readable.

### Preflight

`GET /api/episodes/:episodeId/closure/preflight` lists six queues. A **blocking**
queue must be empty, or cleared with an explicit written override:

| Item | Blocks | Meaning |
|---|---|---|
| `unresolved_approvals` | yes | plan versions in `in_review` or `needs_clarification` |
| `open_clarifications` | yes | threads not closed |
| `open_tasks` | yes | active recovery tasks |
| `missing_owners` | yes | the episode is missing an active coordinator or reviewer |
| `failed_deliveries` | no | reminders that could not be delivered |
| `pending_checkins` | no | check-in slots still open inside their window |

### Close transaction

`POST /api/episodes/:episodeId/closure` requires `expectedRevision`, a reason,
every clinic-policy check confirmed (`plan_reviewed`, `medications_reconciled`,
`follow_up_arranged`, `patient_informed`, `documents_archived`), any needed
override, and `confirm: true`. In one transaction it:

1. re-derives the caller's **live care-team assignment** (a clinic role is not
   enough, and an administrator is refused);
2. rechecks the episode **revision** and current state, so a concurrent close is
   a `409` and the state changes exactly once;
3. flips `status`/`closureState` to `closed` under the revision guard;
4. stops only **future** work - queued reminders are cancelled, future scheduled
   occurrences are ended, active schedules/tasks are ended. Recorded facts,
   answered check-ins and logs are never touched;
5. appends the closure event and an `episode.closed` audit row.

### Reopen

`POST /api/episodes/:episodeId/closure/reopen` is separate, authorized and
justified (minimum reason length, `confirm: true`), rechecks the revision and
appends a `reopen` event. It **does not revive** stopped work: new schedules and
reminders are created deliberately afterwards.

A closed episode is **read-only for new work** (follow-ups, reminders and
check-ins are refused with `409`) while history stays readable.

## 2. Audit trail

`AuditEvent` is append-only at the model level (every mutation path throws) and is
scoped by clinic, category and optional record (`subjectType`/`subjectId`).

Coverage: sensitive reads/downloads, membership and role changes, caregiver
grants, approvals, AI suggestion application, actor-attributed log writes,
check-in responses, clarification responses, privacy requests, export
downloads, retention runs and closure/reopen. `auditService` infers the category
from the action name, so every recorded action is categorised.

Redaction (`auditService.redactDetail`) runs **before** the row is written. It
replaces forbidden keys (password, token, secret, csrf, key, uri, raw clinical
text) with `[redacted]` and bounds strings and depth, so the trail never holds a
secret, a token or a clinical payload.

`GET /api/audit` is **administrative only** (the `audit.read` permission, i.e.
the Clinic Admin role) and returns a scoped, paginated list with a bounded
window (`AUDIT_SEARCH_MAX_RANGE_DAYS`, default 366). A clinical caller or a
patient is refused with `403`.

## 3. Privacy requests

`DataRequest` implements three kinds: `export`, `correction` and
`deletion_request`. There is **no destructive endpoint**.

State machine:

```
identity_pending -> identity_verified -> in_review -> approved|denied -> executing -> completed|partially_completed|failed
                        (cancellable at most stages)
```

- **Identity** is verified before assignment, and the method/verifier are stored.
- **Decision** requires a reason; a `denied` request is terminal.
- **Ownership** is explicit (`ownerUser`) and the response deadline is stored
  (`dueAt`).
- A patient raising a request has the subject derived from their **own** profile;
  a `patientId` in the body cannot redirect it.

### Export

Approval does not produce a file. `POST .../execute` generates the artifact
**asynchronously** into a separate encrypted store
(`exportStorage`, `PRIVACY_EXPORT_ENCRYPTION_KEY`). The artifact:

- is AES-256-GCM encrypted with its own key and magic header;
- **expires** after `EXPORT_ARTIFACT_TTL_HOURS` (default 72);
- can be **revoked** (`POST .../revoke-export`);
- is bounded by `EXPORT_MAX_BYTES`.

Downloading needs **fresh authorization**: `POST .../export/authorize` mints a
short-lived, single-use token (TTL `EXPORT_DOWNLOAD_TTL_MINUTES`, default 15);
only its peppered hash is stored, and `GET .../export/download?token=...` returns
the bytes with `Content-Disposition: attachment`, `Cache-Control: no-store` and a
download CSP. Every authorization and download is audited.

### Correction

Only the supported contact fields can be corrected automatically
(`fullName`, `contactEmail`, `contactPhone`); anything clinical is refused by the
validator. The applied change and its previous value are recorded.

### Deletion request

A deletion request is **policy-driven**. Execution evaluates the record against
retention holds and the retention windows and records a defensible outcome:

- `completed` when nothing is eligible;
- `partially_completed` (limited) when retention or a hold applies.

**No destructive deletion is performed.** Real destruction of clinical records
requires a separate explicit authorization and a tested backup/restore process
that Part 9 does not claim.

## 4. Retention

Categories are configurable per clinic (`RetentionPolicy`) starting from documented
defaults:

| Category | Default window | Mode |
|---|---|---|
| `sessions_tokens` | 30 days | applied |
| `generated_exports` | 7 days | applied |
| `rate_limit_buckets` | 2 days | applied |
| `operational_logs` | 90 days | applied |
| `documents` | 2555 days | **report-only** |
| `historical_records` | 2555 days | **report-only** |

- **Dry run** (`POST /api/retention/dry-run`) reports the cutoff, eligible counts
  and holds in force, and changes nothing.
- **Apply** (`POST /api/retention/apply`) requires an `operator`, a `reason`
  (≥ 10 characters), `confirm: true` and a `clientRequestId`. It is **idempotent**:
  the same key returns the original run instead of acting twice. It is bounded by
  `RETENTION_APPLY_MAX_ITEMS`.
- **Holds** (`RetentionHold`) freeze a category (or a subject within it) until
  released; a held category reports its eligible count but is never acted on.
- Clinical categories are **report-only**: automated destruction of documents and
  history is deliberately not implemented.

Sessions are global, so the session category is narrowed to the **members of the
requesting clinic** before anything is removed.

### Retention runbook (operator steps)

1. Open **Retention** (admin) and read the current windows.
2. Run a **dry run** and review the eligible counts and any active holds.
3. If a record must be kept, place a **hold** with a reason before applying.
4. Apply with a real operator name and a reason that cites the clinic policy.
5. Record the run id from the response; every run is audited and listed under
   `GET /api/retention/runs`.
6. To resume a held category, release the hold with a reason and re-run the dry
   run before applying again.

## 5. Operational metrics

`GET /api/metrics` returns four operational metrics. Every definition carries a
`notAMeasureOf` line and the response carries an explicit note:

- **approval_time** - hours from a plan version entering review to a decision.
- **clarification_response_time** - hours from a thread opening to its first answer.
- **queue_age** - age of the oldest open item in each assigned queue (scoped to
  the caller's own assignments).
- **coordination_workload** - queue items claimed/released/held per member.

These are workflow durations and counts. They **must not** be read as recovery,
adherence or readmission evidence, and the service cannot compute those: it has
no such input.

## 6. Endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/api/episodes/:episodeId/closure/preflight` | `closure.manage` + assignment |
| GET | `/api/episodes/:episodeId/closure` | `closure.manage` + assignment |
| POST | `/api/episodes/:episodeId/closure` | `closure.manage` + assignment |
| POST | `/api/episodes/:episodeId/closure/reopen` | `closure.manage` + assignment |
| GET | `/api/audit` | `audit.read` (admin) |
| POST/GET | `/api/privacy-requests` | `privacy.request.create` / owner |
| POST | `/api/privacy-requests/:id/{identity,assign,decide,execute,revoke-export,cancel}` | `privacy.request.manage` |
| POST | `/api/privacy-requests/:id/export/authorize` | requester or admin |
| GET | `/api/privacy-requests/:id/export/download` | freshly authorized token |
| GET/PATCH | `/api/retention/categories[/:category]` | `retention.manage` |
| POST | `/api/retention/dry-run` | `retention.manage` |
| POST | `/api/retention/apply` | `retention.apply` |
| GET/POST | `/api/retention/holds[/:id/release]` | `retention.manage` |
| GET | `/api/metrics` | `metrics.read` |

## 7. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PRIVACY_EXPORT_ENCRYPTION_KEY` | none (exports fail closed) | separate 32-byte base64 key for export artifacts |
| `EXPORT_ARTIFACT_TTL_HOURS` | 72 | how long an export stays downloadable |
| `EXPORT_DOWNLOAD_TTL_MINUTES` | 15 | fresh download-link lifetime |
| `EXPORT_MAX_BYTES` | 5242880 | one export's size ceiling |
| `RETENTION_APPLY_MAX_ITEMS` | 5000 | per-run bound |
| `AUDIT_SEARCH_MAX_RANGE_DAYS` | 366 | audit window bound |

## 8. Limits

- No scheduler daemon: retention and export generation run as bounded API calls.
- No automated destruction of clinical records: `documents` and
  `historical_records` are report-only.
- No clinical outcome metric, by design.
- The Part 9 browser journey (`e2e/part9.spec.js`) is deliberately read-only: it
  drives the preflight and policy-check gate, abandons the wizard before
  submitting, reads the archived episode's reopen path, searches the audit trail,
  runs a **dry run** and switches the metric panels. The state CHANGES (close,
  reopen, request transitions, apply) are proven by the API integration suite,
  which owns the transactions and their denials.
- Evidence is local and synthetic: no deployment, restore test, regulatory claim
  or clinical validation.
