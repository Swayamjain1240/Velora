# Velora Part 8 — care coordination: check-ins, clarifications, queues, reminders and follow-ups

Part 8 turns the clinic's own coordination work into versioned, scoped, auditable workflow:

- **Clinic-defined recovery check-ins** (VEL-015) with versioned templates, append-only answers and
  a derived *missing* state that is never interpreted.
- **The clarification queue** (VEL-016) with explicit transitions, actor/time/history, and
  clinical-versus-operational answer authority.
- **The assigned-team dashboard** (VEL-017): five queues where every list and count is scoped to the
  caller's active care-team assignments, and administrator status is never a way in.
- **In-app reminders and delivery records** (VEL-014) with dedupe, a pre-delivery recheck, bounded
  retries and a provider registry that refuses any external channel until it is disclosed.
- **Basic prescribed follow-ups** (VEL-018): a date, a place, a contact and the clinic's own
  instructions — never a test-result or referral workflow.

## 1. What this part deliberately does NOT do

- **No diagnosis.** A clinic review rule means *workflow attention for a person*: "a clinician
  should look at this", never normal/abnormal, never a severity score, never AI judgement. The rule
  set is clinic-authored and evaluated literally.
- **A missing response stays missing.** `no_response` is the absence of an answer. It is never
  classified as recovery status, never opens a review by itself, and its wording states
  "nothing is inferred" and "not a normal result, not an abnormal result".
- **No diagnostic-test tracking, no autonomous escalation, no continuous monitoring claim.** The
  clinic's published response hours and emergency guidance are displayed as *the clinic's own
  statement*; an unconfigured clinic says it has not published hours and never implies cover.
- **No external message leaves the application.** The shipped channel is in-app only. Email, SMS,
  WhatsApp and push are refused by the provider registry until a disclosure is recorded
  (control #22).
- **Delivery is not acknowledgement.** Only an explicit action by the recipient sets
  `acknowledgedAt`; nobody acknowledges on someone else's behalf.

## 2. Domain model

| Model | Meaning |
|---|---|
| `CheckInTemplateVersion` | One immutable version of a clinic check-in template: questions (`text/choice/scale/confirm`), cadence, response window and literal review rules. States: `draft → active → superseded`; activation needs the assigned, verified clinical reviewer. |
| `CheckInResponse` | One materialised slot (template key + local date in the episode's timezone). Answers are append-only; state is `open → submitted`, with `no_response` derived for a closed window. |
| `ClarificationThread` | One question with `kind` (`operational`/`clinical`), state (`open → assigned → answered → closed → reopened`) and an append-only `history` of `open/assign/answer/close/reopen/reclassify/note` entries, each with actor, role, time. |
| `ClarificationMessage` | Append-only plain-text message: `question`, `answer`, `note` (team-internal, `patientVisible: false`) or `system`. Markup is refused at write time; rendering is text, never HTML. |
| `QueueAssignment` | Explicit dashboard ownership of one queue target: claim, release with reason, history retained. One active owner at a time. |
| `Notification` | One reminder addressed to one recipient about one event/version on one channel, identified by `dedupeKey`. States: `queued → delivered / failed / cancelled`. |
| `DeliveryAttempt` | One bounded attempt on a notification: attempt number, outcome (`delivered/failed/skipped`), the recheck verdict and safe reason. The attempt chain is the audit trail. |
| `FollowUpPlan` | A prescribed follow-up: date, location, contact, clinic instructions, `active/cancelled`. |

`ActivityLog` entries written by this part reuse the Part 7 append-only, actor-attributed log.

## 3. Check-ins (VEL-015)

1. **Templates are versioned.** Editing a template creates a new version; a materialised slot
   remembers the version that asked it, and an answer is validated against *that* version's
   questions, options and scale — never against current text.
2. **Materialisation is idempotent.** `POST /api/episodes/:id/check-ins/materialise` derives slots
   from the active templates, the discharge date and the episode's IANA timezone; a slot is
   identified by `templateKey@localDate`, so a second run creates nothing. A closed episode refuses
   with `409`.
3. **Answers are append-only.** A duplicate submission is a `409`, not an overwrite; the model
   itself refuses an edit. A **late** answer (after the window) is still an answer and records the
   timing fact; the slot stops being reported as missing.
4. **Review is workflow attention.** A triggered rule sets `reviewState: needs_review` with the
   rule's own label and the note "workflow attention, not a diagnosis". Closing a review requires
   the **assigned, verified** clinical reviewer; a coordinator, a pending reviewer, an unassigned
   reviewer and an admin are all refused (`403`). A response with no triggered rule cannot be
   reviewed (`409`).
5. **Who answers.** The patient answers their own slots; a caregiver needs `log_checkins` on an
   active, unexpired grant (the clinic comes from the grant); assigned staff may record what a
   patient said on the phone. Reading needs `view_checkins`.

## 4. Clarifications (VEL-016)

- **Transitions are explicit and history is append-only.** Reopening is its own audited state with
  a `reopenCount`; a thread that came back is never mistaken for one that was never answered, and
  the earlier answer stays in the conversation.
- **Answer authority is split.** A `clinical` question is answerable only by the **assigned,
  clinic-verified clinical reviewer** for that episode — eligibility alone is not enough, and a
  coordinator cannot answer it even though it was opened at them. An `operational` question belongs
  to the coordinator; a reviewer holds no operational answer permission. A coordinator may
  *reclassify* operational → clinical (which takes coordinators out of the loop), never the reverse.
- **Internal notes never reach the patient.** `note` messages are team-only; the patient surface
  filters them, and the refusal is asserted against the serialised payload.
- **The patient side is ask/reply/close/reopen only** — never answer, assign or reclassify.
- **Every surface carries the clinic guidance**: published response hours, or an explicit "has not
  published response hours", plus emergency guidance whose fallback always states it is not an
  emergency service. Wording never implies 24/7 monitoring.

## 5. Dashboard (VEL-017)

Five queues: `pending_approvals`, `open_questions`, `check_in_reviews`, `failed_reminders`,
`missing_owners`.

- **Scope comes from the server, never from the request.** Every row is derived from the caller's
  `CareTeamAssignment` documents with `status: 'active'` in the caller's clinic; there is no query
  parameter that can widen it, and `mine` only toggles a derived filter over the same set.
- **Administrator status is not access.** Admins get an explicit `403`; patients and caregivers get
  `403` too — the dashboard is for assigned care-team staff.
- **Counts are computed with the same scope as lists**, so a count can never leak another team's
  workload. Each queue item carries `mine` (am I the responsible reviewer?), the active owner (if
  any) and a navigation route.
- **Claim/release are explicit and single-owner.** Claiming validates the target against the queue;
  releasing requires the caller's own assignment and keeps the reason in history. A refused release
  changes nothing.
- **Queue items are workflow facts.** Titles, `requires` and `missing` describe work waiting, never
  clinical findings; the failed-reminder queue shows a *delivery* reason.

## 6. Reminders and delivery records (VEL-014)

The pipeline is `queue → recheck → deliver (bounded) → visible outcome`.

1. **Dedupe by identity.** `dedupeKey = channel : recipientRole : recipientUser : kind :
   v<eventVersion> : eventId : localDate`. The event **version** is part of the identity: a new
   approved plan version or a new template version is a new event; the same version never queues
   twice. A unique index plus `$setOnInsert` makes the race safe.
2. **Recheck immediately before delivery.** Four checks are re-read at delivery time and stored on
   the attempt: `episodeOpen` (not closed), `versionCurrent` (a plan reminder only delivers while
   that exact version is still the current approved one), `taskRelevant` (the source task/occurrence
   is still active), `recipientAuthorized` (the grant/assignment still exists and is unexpired). A
   refusal records a `skipped` attempt with the reason — never a silent drop — and the notification
   is cancelled with the standing note that nothing was sent and no assumption is made about the
   patient.
3. **Bounded retry.** `REMINDER_MAX_ATTEMPTS` defaults to 3 (env-bounded 1..5), with exponential
   backoff (30 s · 4ⁿ, capped at 1 h). Exhaustion leaves the reminder visibly `failed` where the
   care team can see it and retry it from the dashboard; it never retries forever.
4. **Provider gate (control #22).** `REMINDER_PROVIDER` resolves through one registry. `in_app` is
   the shipped provider (nothing leaves the process); `fake` is development/test-only and refuses
   to run in production. Email/SMS/WhatsApp/push are *recognized but refused* with the exact list of
   disclosure fields required (`provider, purpose, keyName, envVar, runsOn, dataSent, retention,
   region, cost`) — there is no silent fallback to another channel.
5. **Delivery batches are bounded** (`REMINDER_BATCH_LIMIT`, default 100) and every attempt is
   recorded (`DeliveryAttempt`), so "delivered", "skipped", "failed" and "retrying" are countable
   facts.
6. **Acknowledgement is separate.** Only the recipient acknowledges; the payload carries the
   standing note "A delivered reminder has not been read or acknowledged by the recipient."
7. **Queueing sources.** Reminders are derived from *due work* (due occurrences/tasks, follow-ups)
   and from an explicit queue call; a closed episode queues nothing and stops what is queued.

## 7. Follow-ups (VEL-018)

A follow-up is exactly: prescribed date, location, contact and the clinic's own instructions, plus
`active/cancelled`. Non-prescribed content is refused at validation: a test result, a report, a
referral or a diagnosis-like payload is a `400`. Only the assigned care team of that episode may
prescribe or cancel; a caregiver reads them only with the `view_tasks` scope on an active grant,
and only for their patient. The in-app reminder for a follow-up appears on the day the clinic chose.

## 8. Authority matrix

| Action | Patient | Caregiver (grant) | Coordinator | Clinical reviewer | Admin |
|---|---|---|---|---|---|
| Answer own check-in | ✔ ownership | ✔ `log_checkins` | ✔ assigned (`staff` attribution) | ✔ assigned | ✘ `403` |
| Read check-ins | ✔ ownership | ✔ `view_checkins` | ✔ assigned | ✔ assigned | ✘ `403` |
| Activate template / review triggered response | ✘ | ✘ | ✘ `403` | ✔ **assigned + verified** | ✘ `403` |
| Ask / reply on a thread | ✔ own | ✔ `ask_questions` | ✔ | ✔ | ✘ |
| Answer `operational` | ✘ | ✘ | ✔ assigned | ✘ `403` | ✘ `403` |
| Answer `clinical` | ✘ | ✘ | ✘ `403` | ✔ **assigned + verified only** | ✘ `403` |
| Internal note | ✘ | ✘ | ✔ | ✘ `403` | ✘ `403` |
| Browse dashboard queues | ✘ `403` | ✘ `403` | ✔ own assignments | ✔ own assignments | ✘ `403` |
| Claim / release queue item | ✘ | ✘ | ✔ | ✔ | ✘ |
| Queue / deliver / retry reminders | ✘ | own inbox reads + `acknowledge` | ✔ episode-scoped | ✔ | ✘ |
| Prescribe / cancel a follow-up | ✘ | read-only with `view_tasks` | ✔ assigned | ✔ | ✘ |

Cross-clinic reads answer `404` (the episode is invisible), never a `403` that reveals existence.

## 9. HTTP contract

All routes require the session + CSRF; every list takes `page`/`limit` and rejects unknown query
fields. Responses are `no-store`.

### Templates — `/api/check-in-templates`

| Method | Path | Authority |
|---|---|---|
| GET | `/` , `/:templateId` | template readers (clinic-scoped) |
| POST | `/` | `checkin.template.draft` (new version on edit) |
| PATCH | `/:templateId` | draft revision guard |
| POST | `/:templateId/activate` | `checkin.template.activate` — assigned, verified reviewer; `expectedRevision` + note |

### Check-ins — `/api/episodes/:episodeId/check-ins` (+ patient/caregiver mirrors)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `view` filter: `due`, `no_response`, `needs_review`, …; summary + guidance |
| GET | `/:responseId` | full response with the questions from its own template version |
| POST | `/materialise` | idempotent slot creation; `409` when the episode is closed |
| POST | `/:responseId/submit` | append-only; `409` duplicate, `400` against the stored version |
| POST | `/:responseId/review` | assigned verified reviewer only; `409` if nothing triggered / already reviewed |
| — | `/api/patient/me/check-ins`, `/api/caregiver/me/patients/:id/check-ins` | ownership / grant-scoped mirrors |

### Clarifications — `/api/episodes/:episodeId/questions`

| Method | Path | Notes |
|---|---|---|
| GET | `/` , `/:threadId` | state filter; guidance travels with every read |
| POST | `/` | patient, caregiver (`ask_questions`), or staff `question_ask` |
| POST | `/:id/assign` | staff `question_assign`; a clinical thread only to a verified reviewer |
| POST | `/:id/answer` | operational → coordinator; clinical → assigned verified reviewer |
| POST | `/:id/notes` | coordinator-only internal note |
| POST | `/:id/close` \| `/reopen` \| `/reclassify` | explicit, audited transitions |
| — | `/api/patient/me/...`, `/api/caregiver/me/...` | ask/reply/close/reopen mirrors; never answer/assign/notes |

### Dashboard — `/api/dashboard`

`GET /` (summary + counts + provider status), `GET /queues/:queueKey?page&limit&mine`,
`POST /queues/:queueKey/:targetId/claim`, `GET /assignments`,
`POST /assignments/:assignmentId/release` (own assignment only, reason required).

### Reminders — `/api/episodes/:episodeId/reminders`

`GET /` , `GET /:id`, `POST /queue`, `POST /deliver` (bounded batch), `POST /:id/retry`;
recipient mirrors `GET /api/patient/me/reminders`, `GET /api/caregiver/me/reminders` and
`POST .../acknowledge`. `GET /api/dashboard` reports the provider status and the pending
disclosure fields.

### Follow-ups — `/api/episodes/:episodeId/follow-ups`

`GET /`, `POST /` (assigned team), `PATCH /:id`, `POST /:id/cancel`; mirrors under
`/api/patient/me/follow-ups` and `/api/caregiver/me/patients/:id/follow-ups`.

## 10. Limits (control #8)

Durable, Mongo-backed, per-caller fixed windows — the same bucket for the staff, patient and
caregiver surfaces of the same operation (the role decides *what* you may do, never *how often*):

| Bucket | Budget / hour |
|---|---|
| `checkin-read` / `clarification-read` / `reminder-read` / `followup-read` | 600 |
| `checkin-write`, `reminder-ack`, `followup-write` | 120 |
| `clarification-ask` (open, reply, close, reopen, assign) | 60 |
| `clarification-answer` | 120 |
| `checkin-review` | 120 |
| `reminder-run` (delivery batch) | 30 |
| `dashboard-read` | 300 |
| `dashboard-write` (claim / release) | 120 |
| `patient-self-invite` | 20 |

The coarse in-process blanket limiter (300/min on `/api`) is a safety net that is switched off
under test; these durable buckets stay active under test and across processes. Exceeding one is
`429 { error: { code: 'RATE_LIMITED' } }`.

## 11. Evidence

- Server: `checkInTemplates.test.js` (9), `checkIns.test.js` (11), `clarifications.test.js` (10),
  `dashboard.test.js` (6), `reminders.test.js` (8), `followUps.test.js` (5), `clinicSettings.test.js`
  (7) integration tests, plus unit tests for `checkInPolicy`, `clarificationPolicy`,
  `reminderPolicy` and the provider registry.
- Client: `queues.test.jsx` and `care.test.jsx` cover the five tabs with server counts, the thread
  action surface, the check-in form and the patient/caregiver panels.
- Browser: the queue and care screens are measured at all six required viewport sizes by
  `e2e/viewports.spec.js` (staff queues, patient panel) and `e2e/detail-viewports.spec.js`
  (caregiver panel).

Passing tests do not establish zero bugs, clinical validation or production readiness.
