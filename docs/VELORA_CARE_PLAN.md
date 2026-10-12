# Velora MERN - Manual care plans, clinical review and approval (Part 5)

A care plan is the clinical output of one recovery episode. Part 5 implements **manual** authoring
only: an assigned care coordinator types every instruction by hand and cites the ready document it
came from, an assigned **verified** clinical reviewer accepts each item and approves the version, and
the patient owner then sees that one approved version.

> Nothing in this subsystem is generated. There is no extraction, no inference, no defaulting and no
> auto-completion. A missing, unclear or conflicting dose, frequency or duration is **never guessed**:
> it stays `unresolved` and blocks approval until a human rewrites the wording.

Part 5 completes the first synthetic **M1 vertical slice**:

```
patient -> episode -> ready document -> manual draft -> clinical review -> approval -> patient view
```

Approval activates **no** task, no reminder, no schedule and no message. No task or reminder code path
is touched by this part.

## 1. External service gate (control #22)

**No external provider is selected or called.** Extraction assistance, an LLM, an OCR service, a
drug-interaction database and a terminology service all remain **DISCLOSED / NOT SELECTED**. The
shipped implementation is entirely local: Express routes, Mongoose models and MongoDB.

| Provider | Purpose | API key name | Env var | Location | Data sent | Region / retention | Cost |
|---|---|---|---|---|---|---|---|
| *none* | clinical authoring, review and approval | n/a | n/a | server + browser (this repository) | nothing leaves the host | host disk, operator-controlled retention | none |

AI extraction is explicitly **out of scope for Part 5** and is not stubbed, not mocked and not
scheduled by this part. Adding a provider later requires the disclosure table above to be filled in
first (provider, purpose, key name, env var, backend/frontend location, data sent, region/retention,
cost/rate).

## 2. Environment

Part 5 adds **no** environment variable. It reuses the existing fail-closed set
(`MONGODB_URI`, `SESSION_PEPPER`, `MFA_ENCRYPTION_KEY`, `DOCUMENT_*`) and adds no secret because no
external credential is used. Plan responses are marked `Cache-Control: no-store, private, max-age=0`.

Multi-document atomicity requires a **replica set**: the integration harness asserts it and fails
closed, so a missing transaction is a test failure rather than silent partial writes.

## 3. States and the state machine

`CarePlanVersion.state` is one of:

| State | Meaning | Editable |
|---|---|---|
| `draft` | coordinator is authoring | yes |
| `in_review` | submitted; only a reviewer may act | no |
| `needs_clarification` | reviewer sent it back with a bounded reason | yes |
| `approved` | clinically approved and immutable | **no** |
| `superseded` | was current, replaced by a newer approval | **no** |

Allowed transitions (anything else is a `409`, never a silent rewrite):

```
draft               -> in_review
in_review           -> needs_clarification | approved
needs_clarification -> in_review
approved            -> superseded
superseded          -> (terminal)
```

Each version stores its episode/clinic/patient linkage, monotonic `version` number, `revision`
counter, creator, submitter, clarification actor/reason, approval actor/time, `state` and the
`isCurrent`/`supersededBy` relationship. It also stores **the reviewer who actually worked it**
(`reviewerLabel`/`reviewerAt`, written by the first reviewer decision - an item review or a
clarification request - and refreshed on each one), kept separate from the approving actor, so a
reader never has to join the timeline to answer "who reviewed this". The reviewer's identity is
reviewer working state: the patient projection exposes only the approval actor and time. Editing an approved plan is refused with a `409`; the way to
change clinical content is to create a **new draft version**, which may be copied from an existing
version (`fromVersionId`) with every copied item reset to **unreviewed**.

## 4. Clinical content contract

`CarePlanItem` preserves the **original clinical wording** verbatim in `originalWording` and never
rewrites it. Alongside it the coordinator states the structured fields the reviewer needs:

`medication`, `dose`, `route`, `frequency`, `timing`, `duration`, `condition`, `homeCare`,
`dietActivity`, `followUp`, `warning`, plus `kind`
(`medication | instruction | monitoring | follow_up | warning | diet_activity | home_care`).

On every write the server recomputes `unresolvedFields`, which collects:

- a required medication field that is absent (`dose`, `frequency`, `duration` for `kind: medication`);
- any clinical value that says nothing (`?`, `-`, `n/a`, `unknown`, `unclear`, `unspecified`, `tbd`,
  `to be determined`, `as directed`, `see notes`, …);
- any value offering **alternatives** ("5 mg or 10 mg", "1-2 tabs") — recorded as `<field>_conflict`,
  because choosing one would be a guess.

The list is server-computed, is returned to both the coordinator and the reviewer, and is the stated
reason approval is blocked. The reviewer cannot "accept" an item that still has unresolved fields: the
API refuses with a `409` and points at clarification instead.

## 5. Sources

`SourceReference` ties an item to **one ready document of the same episode and clinic** with the page,
the quoted text and an optional human location hint. The document is validated server-side before the
row is written:

- a foreign/unready-episode document id is a scoped `404`;
- a document of this episode that is **not** `ready` is a `409`;
- the same document + text on the same item twice is a `409`.

Every item needs at least one source before the plan can be submitted, so no instruction ever reaches
a reviewer without a traceable origin. Sources are denormalised (filename, media type) so the patient
view never needs the object store.

## 6. Authority matrix

| Action | Coordinator (assigned, active) | Clinical reviewer (assigned + **verified**) | Clinic admin | Patient owner | Caregiver |
|---|---|---|---|---|---|
| create/edit/delete/reorder items, link sources | yes | no | **no** | no | no |
| submit for review / resubmit after clarification | yes | no | no | no | no |
| accept an item, request clarification | no | yes | **no** | no | no |
| approve | no | yes | **no** | no | no |
| read the version workspace (drafts, history, timeline) | yes | yes | **no** | **no** | no |
| read the current **approved** plan | yes | yes | **no** | yes (own episode only) | **no** |

Drafting authority is an **active** `care_coordinator` care-team assignment on a draft episode
(reusing the Part 4 write rule, so a clinic role alone, an unassigned coordinator, a closed episode or
another clinic is refused). Approval authority is **re-derived from the database on every decision**:
active membership, `roleKey = clinical_reviewer`, `reviewerEligibility.status = verified`, the
`clinical.review` permission in the role catalog, **and** a current active `clinical_reviewer`
assignment. A revoked or unverified reviewer loses approval authority immediately, and a Clinic Admin
is denied explicitly (`403`) rather than falling through to a `404`.

## 7. HTTP contract

All plan routes live under `/api/episodes` and require authentication plus a resolved clinic context.
Rate limits are durable (Mongo-backed) and per user (control #8):

| Bucket | Limit | Applies to |
|---|---|---|
| `plan-read` | 600 / hour | version history, plan detail, item lists |
| `plan-draft` | 240 / hour | create/update/edit/reorder/link/submit/resubmit |
| `plan-review` | 60 / hour | item review, clarification, approval |

| Method | Path | Who | Body | Success |
|---|---|---|---|---|
| `GET` | `/:episodeId/plans` | assigned team | – | `200 { items, total, page, limit }` (version history) |
| `POST` | `/:episodeId/plans` | coordinator | `{ title?, summary?, fromVersionId? }` | `201 { plan }` |
| `GET` | `/:episodeId/plans/:planId` | assigned team | – | `200 { plan, items, blockers, events }` |
| `PATCH` | `/:episodeId/plans/:planId` | coordinator | `{ expectedRevision, title?, summary? }` | `200 { plan }` |
| `GET` | `/:episodeId/plans/:planId/items` | assigned team | – | `200 { items, total, page, limit, planRevision, planState }` |
| `POST` | `/:episodeId/plans/:planId/items` | coordinator | `{ expectedRevision, kind?, originalWording, …clinical fields }` | `201 { item }` |
| `PATCH` | `/:episodeId/plans/:planId/items/:itemId` | coordinator | `{ expectedRevision, …clinical fields }` | `200 { item }` |
| `DELETE` | `/:episodeId/plans/:planId/items/:itemId` | coordinator | `{ expectedRevision }` | `200 { deleted: true }` |
| `POST` | `/:episodeId/plans/:planId/items/:itemId/reorder` | coordinator | `{ expectedRevision, direction: 'up' \| 'down' }` | `200 { moved, items }` |
| `POST` | `/:episodeId/plans/:planId/items/:itemId/sources` | coordinator | `{ expectedRevision, documentId, text, page?, location? }` | `201 { source }` |
| `DELETE` | `/:episodeId/plans/:planId/sources/:sourceId` | coordinator | `{ expectedRevision }` | `200 { deleted: true }` |
| `POST` | `/:episodeId/plans/:planId/submit` | coordinator | `{ expectedRevision }` | `200 { plan }` |
| `POST` | `/:episodeId/plans/:planId/clarification` | reviewer | `{ expectedRevision, reason }` | `200 { plan }` |
| `POST` | `/:episodeId/plans/:planId/resubmit` | coordinator | `{ expectedRevision }` | `200 { plan }` |
| `POST` | `/:episodeId/plans/:planId/items/:itemId/review` | reviewer | `{ expectedRevision, decision: 'accepted' \| 'clarify', note? }` | `200 { item }` |
| `POST` | `/:episodeId/plans/:planId/approve` | reviewer | `{ expectedRevision, confirm: true }` | `200 { plan, superseded, idempotent }` |
| `GET` | `/api/patient/me/episodes/:episodeId/plan` | patient owner | – | `200 { plan, items }` |

Every mutation carries `expectedRevision`, so a stale editor can never overwrite newer work. Errors use
the shared envelope `{ error: { code, message } }` with the **safe** messages only:

| Status | Code | Used for |
|---|---|---|
| `400` | `BAD_REQUEST` | schema validation, unknown fields, missing title/summary |
| `401` | `UNAUTHORIZED` | no session, CSRF failure |
| `403` | `FORBIDDEN` | wrong role, admin clinical denial, unverified/revoked reviewer, unassigned coordinator |
| `404` | `NOT_FOUND` | scoped not-found (other clinic, other episode, unowned episode) |
| `409` | `CONFLICT` | stale revision, illegal transition, incomplete content, unresolved fields, unready source, duplicate source, approval already decided |
| `429` | `RATE_LIMITED` | a plan bucket exhausted |

## 8. The approval transaction

Approval is **one** MongoDB transaction (`withTransaction`), in this order:

1. Claim the version with a conditional update filtered on `_id`, `clinic`, `episode`,
   `state: 'in_review'` **and** `revision: expectedRevision` — the lock.
2. Re-check reviewer eligibility and the reviewer assignment (already done immediately before, from
   the database, not from the request).
3. Validate complete reviewed content: every item must have at least one source and must be
   `accepted`.
4. Reject unresolved clinical fields (missing/unclear/conflicting dose, frequency, duration, …).
5. Set the version `approved` with the approval actor and timestamp.
6. Supersede the previous current version (`isCurrent: false`, `state: 'superseded'`,
   `supersededBy`, `supersededAt`) **before** the new version becomes current.
7. Flip the new version to `isCurrent: true` and move the episode's
   `approvedPlanVersion` pointer plus its `planState`.
8. Write the review timeline (`approved`, `superseded`) — no clinical text, only who/when/which
   transition/a bounded reason.

Concurrency and retries:

- **Parallel approval cannot create two current versions.** The conditional claim lets exactly one
  caller win; the loser gets a `409`. The database additionally enforces it with a **partial unique
  index** on `(episode)` where `isCurrent: true, state: 'approved'`, so a future code path cannot
  violate the invariant even accidentally.
- **Retries are idempotent.** The same reviewer repeating the same approval of the same revision
  receives the approved version with `idempotent: true` instead of a second state change or a second
  history row.
- **Approved content is immutable.** Any later edit attempt is a `409`; the replacement path is a new
  draft version, and the previous approved version stays **current** (and patient-visible) until the
  replacement is itself approved.

## 9. Patient view

`GET /api/patient/me/episodes/:episodeId/plan` resolves ownership from the **profile's linked
account**, never from a client-supplied id. It returns only the current approved version:

- the approved items with their clinical wording and permitted source references;
- the approval actor and time.

It deliberately omits the reviewer's working state (`clinicalReviewState`, `reviewNote`,
`reviewedByLabel`), the clarification history and the unresolved-field diagnostics. With no approved
version yet the answer is an **empty** payload (`{ plan: null, items: [] }`) — never an error, because
a patient must not be able to infer that a draft exists. Caregivers have no path to plan content in
this part: the grant catalog declares `view_plan`, but no caregiver route honours it yet, so a grant
of that scope exposes nothing (fail-closed - see the limits in section 13).

## 10. Screens

| Screen | Files | Behaviour |
|---|---|---|
| Draft wizard | `features/plans/CarePlanPanel.jsx`, `planRules.js` | stepped basis → details → create; shows version, state, blockers |
| Paginated item editor | `features/plans/PlanItemForm.jsx` | item type + wording on step 1, secondary instructions on step 2, per-item unresolved list |
| Source review | `features/plans/PlanSourcePanel.jsx` | cite a ready document, page and quote; lists existing citations |
| Review / clarification panel | `features/plans/PlanReviewPanel.jsx`, `PlanSourcePanel.jsx` | accept or clarify each item, then an explicit approval confirmation |
| Approval confirmation | `PlanReviewPanel.jsx` | publish button disabled until the reviewer ticks the acknowledgement; states that the version becomes immutable and that no task or reminder is created |
| Patient approved view | `features/patient/PatientPlan.jsx` | the approved plan with "Where this comes from" source disclosure |
| Version history | `CarePlanPanel.jsx` | newest-first versions with state, for the drafting/reviewing roles only |

Control #25: the plan workspace is a **tabbed, single-panel** view (Draft / Sources / Review /
History) inside the episode detail. Each tab is scroll-bounded and paginated, so switching tabs and
paging through items keeps the screen inside one viewport; on mobile exactly one primary panel is
shown at a time. `plans.spec.js` measures the coordinator, reviewer and patient plan screens at all
six required sizes (`1440x900`, `768x1024`, `390x844`, `320x568`, `844x390`, `320x400`) and fails on
any page-level vertical scroll or clipped content.

## 11. Reproducing the journey

```bash
# terminal 1 - API on 4100 (needs the replica-set Mongo instance)
cd server && PORT=4100 MONGODB_URI='mongodb://127.0.0.1:27019/velora?replicaSet=rs0' node src/index.js

# terminal 2 - Vite dev server proxying /api
cd client && npm run dev

# terminal 3 - the whole gate: global-setup re-seeds the synthetic clinic first
PORT=4100 npx playwright test
```

The seed creates the Part 5 fixture: episode `EP-PLANJRNY` with an assigned coordinator
(`plan.coordinator@synthetic.invalid`), an assigned **verified** reviewer
(`plan.reviewer@synthetic.invalid`), a linked patient (`plan.patient@synthetic.invalid`), one ready
source document and **no** plan data. `plans.spec.js` then drives: manual draft → item authoring →
source linking → submit → per-item clinical acceptance → approval → patient's current approved view →
immutability of approved content.

## 12. Server test coverage

`server/tests/integration/plans.test.js` exercises the contract through the HTTP API with real
sessions and CSRF: coordinator permissions, reviewer permissions, admin clinical denial, patient and
caregiver draft denial, other-clinic invisibility, revoked reviewer, unready/wrong-episode source,
incomplete and conflicting items, invalid transitions, stale revisions, concurrent approval, the
one-current-version constraint, approved immutability, supersession, the patient current-approved
view, XSS strings rendered as text, audit redaction and stale-UI clearing.

## 13. Limits (documented, not hidden)

- **Manual only.** No extraction, no AI assistance, no OCR and no drug-interaction checking. Those
  stay `PLANNED` for later parts and are not stubbed here.
- **No downstream activation.** Approval deliberately creates no task, reminder, schedule or message;
  the episode's own lifecycle `status` is untouched. Medication schedules and reminders are out of
  scope for Part 5.
- **Single reviewer.** One assigned verified reviewer decides; there is no multi-signature clinical
  workflow.
- **Caregiver plan access is not wired.** `view_plan` is declared in the grant catalog but no
  caregiver route reads plan content, so granting it exposes nothing rather than exposing a draft.
- **No production deployment or clinical validation** is claimed for any of this. Evidence is local.
