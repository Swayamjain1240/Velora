# Velora Part 7 - Medication schedules, recovery tasks and actor-attributed logs

Part 7 turns the **current approved care-plan version** into operational schedules and gives the
patient, a scoped caregiver and the assigned team one bounded day view of them.

Nothing in this part decides anything clinical. It copies approved wording, computes instants and
records what a named person said happened. It creates no message, no reminder and no delivery
attempt (those belong to Part 8), it never diagnoses, and it never tells anyone to take an extra or
replacement dose.

## 1. Where it sits

```text
approved CarePlanVersion (immutable, Part 5)
        └── CarePlanItem (clinically accepted, one per instruction)
                  └── MedicationSchedule | RecoveryTask   (verbatim clinical copy)
                                └── ScheduleOccurrence      (UTC instant + local parts)
                                              └── ActivityLog  (append-only, attributed)
```

- An approval still activates **no** task, reminder or message. Preparation is a separate, explicit,
  audited action by an assigned staff member.
- Only the current, approved, clinically confirmed plan version can produce a schedule. Draft,
  in-review, needs-clarification and superseded versions produce nothing.

## 2. Models (`server/src/models/`)

| Model | Holds | Key guarantees |
|---|---|---|
| `MedicationSchedule` | dose, route, frequency, timing, condition, duration, original wording, times, zone, lifecycle | `planVersion` + `item` are **immutable**; unique per `(planVersion, item)` |
| `RecoveryTask` | title, item kind, timing, frequency, condition, duration, original wording, times, zone, lifecycle | same two rules |
| `ScheduleOccurrence` | `scheduledAtUtc` + local date/time + zone + offset + status | unique per `(owner, scheduledAtUtc)`; **no adherence column** |
| `ActivityLog` | subject, actor, role/grant, occurrence time, recorded-at, state, correction link | append-only; unique per `(clinic, clientRequestId)` |

Every schedule, occurrence and log row is stamped with the **exact** `planVersion` and
`CarePlanItem` it came from, plus clinic, patient and episode, so scope checks and reconciliation
never depend on a client-supplied identifier.

`ActivityLog` refuses `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`, every delete and a
`save()` that is not a new document: a correction can only be a **new** row that names the row it
corrects (`correctsLog`), so patient history cannot be silently rewritten.

## 3. What may become a schedule (`server/src/policies/schedulePolicy.js`)

The policy is a pure module - no database, no clock, no request context.

- **Kind gate.** `medication`, `instruction`, `monitoring`, `home_care`, `diet_activity` and
  `follow_up` map to a schedule or a task. A `warning` item maps to nothing: a caution is read, never
  scheduled.
- **Confirmation gate.** An item whose `clinicalReviewState` is not `accepted` is reported back as
  `unconfirmedItems` and generates nothing.
- **Conditional / PRN gate.** An explicit `condition`, or PRN wording (`prn`, `as needed`, `as
  required`, `if needed`, `sos`, ...) anywhere in the frequency/timing/original wording makes the item
  **conditional**. A conditional item is created with `scheduleKind: 'as_needed'`, `timesOfDay: []` and
  **zero generated occurrences**. It can be activated and recorded when it happens; it can never
  become an unconditional repeating dose.
- **Missing-detail gate.** If the approved wording does not state when, the item becomes
  `needs_details` with `needsDetailsReason` and generates nothing. An unanchored interval
  ("every 6 hours" with no stated first dose) is `interval_without_anchor` - a detail is requested,
  never invented. `needs_details` can never be activated.
- **Derivation.** Explicit 12-/24-hour clock times win; otherwise a whole-day frequency phrase
  (once/twice/three times/four times daily, `od`, `bd`, `tds`, `qds`) or a named day-part
  (morning/noon/evening/night) supplies the times. The derived list and its reason are shown to the
  reviewer before activation.

## 4. Time (controls #2, #5, #6)

- Occurrence instants are stored as **UTC** `Date`s. The IANA scheduling zone and the local
  `YYYY-MM-DD` / `HH:MM` that produced each instant are stored alongside it.
- The zone is resolved per request: explicit request value → the episode's stored IANA zone →
  `SCHEDULE_FALLBACK_TIMEZONE` (validated with `Intl` at startup, default `UTC`). An invalid zone is
  a `400`, never a silent fallback.
- All conversion happens in `server/src/services/zonedTime.js`, with deterministic DST rules:
  - a local time inside a **spring-forward gap** converts to *no* instant; generation **skips and
    reports** the slot (`{ localDate, localTime, reason: 'dst_gap' }`) rather than shifting a dose;
  - a **fall-back** duplicate resolves to the **earlier** instant, so an hour of extra clock never
    pushes a dose later;
  - day arithmetic (`addDays`, `daysBetween`, `todayInTimezone`) runs on the calendar string, never on
    the server's own zone.
- Generation is bounded: at most 400 occurrences per schedule, a default 30-day horizon and a horizon
  clamped to 1–60 days.

## 5. Authority matrix (control #5)

| Action | Requirement (all re-checked server-side, per request) |
|---|---|
| Read the staff schedule workspace | assigned care-team member, non-admin; admin denied |
| `POST .../schedules/prepare` | `schedule.prepare` + **active care-coordinator assignment** + non-closed episode + a **current approved** version |
| `POST .../schedules/:id/activate` (medication) | `schedule.activate` **and** the assigned, clinic-verified **clinical reviewer**; current approved version; not closed |
| `POST .../schedules/:id/activate` (task) | `schedule.prepare` + assigned coordinator (operational, still an explicit audited action) |
| `POST .../schedules/:id/end` | `schedule.prepare` + assigned coordinator |
| `GET /api/today` (patient) | the record is their own patient profile |
| `GET /api/today` (caregiver) | active `CaregiverGrant`, unexpired, for that patient, holding **`view_tasks`** |
| `POST /api/today/entries` (caregiver) | the same grant, holding **`log_tasks`**, and the grant id is stored on the row |
| `GET /api/today` (staff) | active assignment to that episode |
| Any action on a **closed** episode | refused with `409` (`episode closed`); history stays readable |

Denials use a scoped `404`/`403` so a cross-clinic caller cannot confirm that an id exists. The
clinic is always derived from the record or from the caller's grant - never from the request body.

## 6. HTTP contract

All routes are under a session, CSRF-checked, rate-limited server.

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/episodes/:id/schedules` | paginated staff list: schedules, tasks, counts |
| `POST` | `/api/episodes/:id/schedules/prepare` | idempotent prepare/reconcile from the current approved version |
| `GET` | `/api/episodes/:id/schedules/:sid` | one schedule with its verbatim copy |
| `GET` | `/api/episodes/:id/schedules/:sid/occurrences` | paginated occurrence page (UTC instant + local parts) |
| `POST` | `/api/episodes/:id/schedules/:sid/activate` | `expectedRevision` optimistic-concurrency guard |
| `POST` | `/api/episodes/:id/schedules/:sid/end` | ends a schedule; past occurrences are untouched |
| `GET` | `/api/episodes/:id/activity-logs` | read-only, paginated, attributed history (no edit/delete route exists) |
| `GET` | `/api/today?date=&episodeId=&tab=&page=&limit=&timezone=` | one bounded day panel |
| `POST` | `/api/today/entries` | record/correct an entry; `clientRequestId` makes retries idempotent |

Durable Mongo-backed limits (`server/src/middleware/rateLimit.js`): schedule reads 600/h, preparation
60/h, activation 120/h, day reads 600/h, entry logging 240/h per user, on top of body size, enum and
timestamp validation. The in-process blanket limiter stays off under `NODE_ENV=test` so a suite
legitimately issuing hundreds of requests still exercises every per-route limit.

## 7. The day view and its safety wording

Five states exist and they are **distinct recorded facts**, not a score:

| State | Meaning |
|---|---|
| `taken` | the actor recorded that it was taken |
| `skipped` | the actor recorded that it was not taken |
| `reported_done` | the actor reported the task done (not a clinician's confirmation) |
| `needs_help` | the actor recorded that they need help |
| `not_recorded` | **no entry exists for this slot** |

`not_recorded` is the absence of a log, never a value that can be counted as nonadherence. The UI and
the API both state:

> An entry with nothing recorded is not a missed dose and never means you should take an extra or
> replacement dose. Follow the approved plan and contact your care team with any question about a
> dose.

and, next to every patient/caregiver entry:

> A patient or caregiver entry is a self-report and is never clinical verification.

The two notes live in `schedulePolicy.SAFETY_NOTE` / `SELF_REPORT_NOTE`, so the wording cannot drift
between the server's test and the client's screen. An automated test asserts that no rendered text
matches `missed a dose`.

## 8. Logging contract (controls #6, #8)

Every entry stores:

- **subject** → the `patient` profile, derived from the record, never from the body;
- **acting user** → `actorUser` + `actorLabel` (server-side session identity);
- **actor role/grant** → `actorRole`, plus `actorGrant` (the caregiver grant id) for a caregiver;
- **occurrence time** → `occurrenceTimeUtc`, the instant the entry is *about*;
- **recorded-at time** → `recordedAtUtc`, the instant it was *recorded*.

Duplicate retries are idempotent through the unique `(clinic, clientRequestId)` index: the original
row is returned instead of a second one. Concurrent duplicate submissions resolve to one row because
the second insert loses the unique-index race and is re-read.

Corrections append a new row carrying `correctsLog` and `correctionReason`, and the day view shows the
whole chain. Nothing rewrites, reorders or deletes an earlier row.

## 9. Version reconciliation

When a newer version is approved and preparation runs again, inside one transaction:

1. Every schedule/task of the episode belonging to a **different** plan version becomes `superseded`;
2. its **future** `scheduled` occurrences become `superseded` with `supersededByVersion` and `endedAt`;
3. one new owner per clinically accepted item of the current version is created (or its derived
   fields are refreshed, with `revision` incremented - the verbatim clinical copy is never overwritten);
4. new occurrences are generated for the new owners.

**History is never touched**: past occurrences and every `ActivityLog` row survive unchanged, so a
recorded week cannot be rewritten by an approval that happened afterwards. Past occurrences of a
superseded schedule keep their original `scheduledAtUtc` and remain visible in the day view marked
`Earlier plan (history)`.

## 10. Screens

- `client/src/features/today/TodayView.jsx` - the one-viewport day screen: a Previous/Next/Today date
  switcher, `Medication` and `Tasks` tabs (one category at a time on mobile), bounded panels with
  Previous/Next pagination, per-row record and correct actions, and explicit self-report labels.
- `client/src/features/schedules/SchedulePanel.jsx` - the staff workspace inside the episode detail
  `Schedule` tab: prepared schedules with times/status/occurrence counts, a paginated occurrence table
  showing local *and* UTC values, the attributed recorded-entry history, and the explicit
  **Prepare from approved plan** control.
- `client/src/features/today/todayRules.js` - the shared state/pill/permission rules the two screens
  and the tests use.

Every authenticated Part 7 screen is asserted to fit one viewport with no page-level scroll and no
clipped overflow at `1440x900`, `768x1024`, `390x844`, `320x568`, `844x390` and `320x400`.

## 11. Reproducing the journeys

```bash
npm run mongo:test-rs -w server
npm run seed -w server                 # synthetic clinic + the Part 7 journey fixture

# terminal 1 - API. NODE_ENV=test switches off only the in-process blanket limiter;
# the durable per-route limits stay active. EXTRACTION_PROVIDER=fake is needed so
# the Part 6 journey in the same suite can run.
EXTRACTION_PROVIDER=fake NODE_ENV=test PORT=4100 node server/src/index.js

# terminal 2 - Vite, proxying /api to the API above
VITE_API_PROXY=http://127.0.0.1:4100 npm run dev -w client

# terminal 3 - the whole gate; global-setup re-seeds first
PORT=4100 npx playwright test
```

The provider-disabled journey is separate: run the API with `EXTRACTION_PROVIDER=none` and
`npx playwright test e2e/extractions.spec.js -g "no provider"`.

## 12. Test coverage

- `server/tests/unit/schedulePolicy.test.js` - kind gate, PRN detection, missing-detail and interval
  rules, occurrence bounds, the five states and the safety wording (13 tests).
- `server/tests/integration/schedules.test.js` - draft/unapproved source rejection, conditional
  medicine, missing schedule details, time zone and DST boundaries, duplicate and concurrent logging,
  patient / caregiver / denied-scope / other-clinic / staff attribution, **revoked and expired**
  grants, an inert (declared but unenforced) scope granting nothing, stale plan version, version
  reconciliation, historical immutability, closed-episode read-only, and a field-by-field proof that
  every clinical field - including `timing` and `condition` - is copied verbatim from the approved
  item while an attempt to rewrite it does not take effect (25 tests).
- `client/src/test/today.test.jsx` - the day screen states, no-missed-dose wording, tab/panel
  bounding, caregiver attribution and the append-only correction flow (18 tests).
- `e2e/today.spec.js` - patient recording, caregiver `log_tasks` recording, the staff workspace and
  six-size one-viewport measurement (9 journeys).

## 13. Limits (documented, not hidden)

- No notification, reminder or delivery record exists yet; Part 8 adds them. Part 7 generates no
  message of any kind.
- Wall-clock defaults for a frequency phrase are a **non-clinical convenience** shown to the
  reviewer before activation; a medication schedule still needs the assigned, verified clinical
  reviewer to activate it.
- `not_recorded` is deliberately not reported as an adherence metric and never becomes one.
- An unknown/unsupported timing stays `needs_details`; the wording is never embellished to make an
  instruction schedulable.
- Evidence is local (development, synthetic data). No clinical validation, regulatory claim or
  production readiness is implied.
