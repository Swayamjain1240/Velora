# Velora Part 6 - AI-assisted draft extraction and reviewed language

This document is the Part 6 contract: the models, the provider decision, the
mandatory external-API disclosure, the HTTP surface, the security-25 mapping, the
threat model and the evaluation limits. It describes **implemented** behaviour.

> **AI is an untrusted drafting tool.** It has **zero authority** to approve,
> publish, prescribe, change clinical state, activate a task or send a reminder.
> Every AI suggestion is a draft that a person must accept, and the plan still
> requires explicit clinical approval (Part 5) before a patient sees anything.
> Manual authoring always works when AI is unavailable - that is the shipped
> default (`EXTRACTION_PROVIDER=none`).

---

## 1. Where it sits

Part 5 is the manual workflow: a coordinator drafts items by hand, links a source
citation, submits, and an assigned verified reviewer accepts each item and
approves the exact version inside one transaction. Part 6 adds an **optional,
provider-neutral drafting aid** beside it:

- a job reads **one authorized `ready` document** and targets **one draft
  (editable) plan version**;
- the model proposes **candidate items** in a strict JSON schema, each quoting the
  source text it came from;
- the server **validates, verifies and classifies** every field itself, flagging
  anything missing, conflicting or unsupported;
- a person either **applies** one suggestion (an ordinary, actor-attributed draft
  edit that becomes a normal item, still awaiting clinical review) or **dismisses**
  it;
- reviewed Hindi/English renderings are drafted, versioned and **approved by an
  assigned, verified clinical reviewer** - and never become patient-visible.

## 2. Models (`server/src/models/`)

| Model | Purpose |
|---|---|
| `ExtractionJob` | One authorized document + one draft version. State machine, limits, attempts, error code, injection signals, dedupe key. **No clinical authority.** |
| `DraftSuggestion` | One candidate item: kind, original wording, confidence, `needsReview`, applied/dismissed attribution. |
| `ExtractedField` | One field of one suggestion: value, server-decided state, required flag, model's claimed missing/conflict. |
| `SourceCitation` | The evidence for one suggestion: document, page, location, verbatim text, `verified`. |
| `ModelRun` | One provider attempt: provider, model, network flag, status, latency, input chars, output bytes, counts. Never the prompt or source text. |
| `ReviewedLanguageVariant` | A versioned Hindi/English rendering of one item, with review state, fidelity guard result and reviewer attribution. |

## 3. The provider decision (control #22)

**No external AI/OCR provider is selected or called.** No key is required to run
Velora, and the shipped provider is `none`: a job fails closed with
`PROVIDER_DISABLED` and the screen tells the coordinator to draft by hand.

The mandatory external-API disclosure below **must be completed and approved
before any provider is installed or any network request is made**. Until then,
integration stops at the clean adapter boundary.

| Disclosure field | Value |
|---|---|
| Provider | **NONE SELECTED / NOT AUTHORIZED** |
| Purpose | (would be: draft clinical instructions from a discharge document) |
| Model / service | **not selected** - do not name one |
| API-key name | n/a (would be `EXTRACTION_API_KEY`) |
| Environment variable | `EXTRACTION_PROVIDER` (default `none`), `EXTRACTION_API_KEY`, `EXTRACTION_MODEL` - **server-only, never `VITE_`** |
| Exact server module | `server/src/providers/index.js` (registry) and the provider module it loads |
| Key enters React? | **No.** No key is ever read by the client or baked into a `VITE_` value. |
| Data sent | (would be: bounded, delimited **document text as data** only) |
| Data retention / region | **must be reviewed with the owner before selection** |
| Cost / rate limits | bounded by `EXTRACTION_*` limits (below); provider budget must be reviewed |
| Local/test fallback | `EXTRACTION_PROVIDER=fake` - the deterministic, offline provider |

### The provider-neutral interface (`server/src/providers/extractionProvider.js`)

```
extract({ pages, model }) -> { raw, model, usage, providerRequestId }
```

Provider-independent work is complete:

- `extractionProvider.js` - the neutral interface contract.
- `fakeExtractionProvider.js` - a **deterministic** local provider: no network, no
  key, byte-for-byte reproducible, quoting source lines verbatim.
- `server/tests/fixtures/extraction-evaluation.json` + `scripts/evaluate-extraction.js`
  - the synthetic evaluation set and harness (below).

A real provider implements the same interface and is selected by
`EXTRACTION_PROVIDER`; **nothing else changes** - the pipeline, validation,
classification, review UI and evaluation are all provider-independent.

## 4. The pipeline

`server/src/services/extractionService.js` orchestrates; the pure rules live in
`server/src/policies/extractionPolicy.js`.

1. **Create** a job: authorized `ready` document + editable draft version. Writes
   only a `queued` record; reads nothing, calls no provider.
2. **Run**: re-check **access and the target draft revision BEFORE starting**,
   bound the document text, and call the provider **once** within a timeout.
3. **Validate** the raw output server-side (rule 10): size, then JSON, then shape,
   then the strict schema. Reject `INVALID_JSON`, `NOT_AN_OBJECT`, `OVERSIZED`,
   `UNKNOWN_KEY`, `INVALID_TYPE`, `LENGTH_EXCEEDED`, `TOO_MANY_SUGGESTIONS`,
   `TOO_MANY_CITATIONS`, `MISSING_CITATION`.
4. **Verify citations**: each must quote text that really exists on a page that
   was actually supplied; a citation outside the supplied pages is rejected.
5. **Classify** every field itself (rules 8, 9, 11): `suggested`, `missing`,
   `conflicting`, `unresolved`. The model's own `missing`/`conflicts` claims are
   treated as evidence, never as truth. A value that is not in the cited source is
   `unresolved`; ambiguity is never normalized into an invented fact.
6. **Outcome**: `completed` only if every suggestion is clean; otherwise
   `needs_review` - a *successful outcome* that means a human must look.
7. **Apply**: a **separate, actor-attributed draft edit** through the Part 5
   service. It re-checks authority and the **current revision before applying**,
   creates one ordinary item, links the same citation, and leaves it "awaiting
   clinical review".

### The strict JSON schema (rule 6)

`medication`, `dose`, `route`, `frequency`, `duration`, `homeCare`,
`dietActivity`, `followUp`, `warning` - and **nothing else**. Unknown keys anywhere
(top level, suggestion, citation) are a hard rejection.

### Jobs (states + limits)

States: `queued -> running -> completed | needs_review | failed | cancelled`, with
a closed transition table and terminal states. Limits: input chars, output bytes,
timeout, bounded retries with deterministic backoff, per-hour job and per-day run
budgets, max suggestions and max citations. **Deduplication/idempotency**: an
identical (document, version, provider, model) job is reused; an applied
suggestion can never create a second item. **Failure visibility**: a stable,
safe `errorCode` (no prompt, source text, key or provider diagnostic) and a
readable manual fallback.

### Prompt-injection containment (rules 3, 5)

Document text is **quoted as data** inside explicit delimiters, and our own
delimiters are stripped from the text first so a document cannot close the block
and start issuing instructions. Suspicious lines are **detected and counted** as
labels (position only, never the surrounding text) and force `needs_review`. The
model never receives a tool, cannot call a Velora mutation, and its output cannot
change clinical state - there is no code path from a suggestion to approval,
publication, prescription, a task or a reminder.

## 5. Reviewed Hindi / English presentation

`server/src/services/languageVariantService.js`:

- **Linked** to the original instruction (the source wording is captured at
  creation and shown beside the rendering).
- **Versioned**: a revision is a new rendering, never an edit in place.
- **Guarded**: a numeric fidelity check runs on every write (no dose/frequency/
  duration number may be silently lost; an English rendering must keep each stated
  value as written). The guard is a *check*, not a proof of meaning.
- **Reviewer-approved**: only an assigned, verified clinical reviewer may approve,
  and only after stating that the meaning is preserved; the same authority as plan
  approval is re-derived on every decision.
- **Never patient-visible automatically**: no patient route reads variants, and
  approving a rendering changes **no** clinical value or plan approval state.

## 6. HTTP surface

| Method + path | Authority | Purpose |
|---|---|---|
| `POST /api/episodes/:id/extraction-jobs` | drafting (coordinator) | create/queue a job (dedupe) |
| `GET /api/episodes/:id/extraction-jobs` | team read | paginated jobs |
| `GET /api/episodes/:id/extraction-jobs/:jobId` | team read | job + model runs |
| `GET /api/episodes/:id/extraction-jobs/:jobId/suggestions` | team read | paginated suggestions + held revision |
| `POST /api/episodes/:id/extraction-jobs/:jobId/run` | drafting | run once |
| `POST /api/episodes/:id/extraction-jobs/:jobId/cancel` | drafting | cancel |
| `POST /api/episodes/:id/extraction-jobs/:jobId/suggestions/:sid/apply` | drafting | apply (separate draft edit) |
| `POST /api/episodes/:id/extraction-jobs/:jobId/suggestions/:sid/dismiss` | drafting | dismiss |
| `POST /api/episodes/:id/plans/:planId/items/:itemId/variants` | drafting | draft a rendering |
| `GET /api/episodes/:id/plans/:planId/variants` | team read | list renderings |
| `POST /api/episodes/:id/plans/:planId/variants/:vid/submit` | drafting | submit for review |
| `POST /api/episodes/:id/plans/:planId/variants/:vid/approve` | clinical review | approve (fidelity note required) |
| `POST /api/episodes/:id/plans/:planId/variants/:vid/reject` | clinical review | reject with a reason |

Every route re-derives clinic + role + assignment + document + draft/version
access server-side (default deny) and returns the shared safe error envelope.

## 7. Frontend

The AI panels live **beside** the manual tabs, never instead of them
(`client/src/features/extraction/`, in `CarePlanPanel` tabs `Extraction` and
`Language`). The review experience shows:

- **Source** - the verbatim citation and its verification state;
- **AI suggestion** - each field with the server's state (stated / not stated /
  conflicting / unclear);
- **Accepted value** - the box a person types over; a typed value wins;
- **Decision** - apply (one new draft item, still unapproved) or dismiss.

Suggestion lists and field lists are **paginated** and the panels are
**switchable**, so the authenticated review fits one viewport (control #25) at all
six tested sizes. There is no approve, publish, prescribe, task or reminder action
anywhere in the panel - by design.

## 8. Security-25 mapping (Part 6)

| # | Control | Status | Evidence |
|---:|---|---|---|
| 1 | AI/API secrets server-only, redacted logs | VERIFIED | only `EXTRACTION_API_KEY` server env; no `VITE_` secret; logs never carry prompts/source |
| 2 | Provider env validated only when enabled, fail closed | VERIFIED | `EXTRACTION_PROVIDER` default `none`; registry fails closed on unknown; env unit test |
| 3 | All job/result routes protected | VERIFIED | `requireAuth`+clinic+assignment+permission on every route |
| 4 | Secure auth preserved | VERIFIED | unchanged Argon2id/MFA/session/CSRF |
| 5 | Clinic + assignment + document + draft/version access; no AI authority | VERIFIED | access re-checked before start and before apply; suggestions cannot approve/publish/prescribe |
| 6 | Validate prompts, schemas, output, forms | VERIFIED | strict zod schema; bounded model input; server-side classification |
| 7 | No unsafe HTML | VERIFIED | text rendered as text; no `dangerouslySetInnerHTML` |
| 8 | Job/user/provider/concurrency/budget limits | VERIFIED | bounded I/O, timeout, retries, per-hour/per-day budgets, dedupe |
| 9 | Safe errors without prompts/source/keys/diagnostics | VERIFIED | stable `errorCode` + safe message; envelope has no diagnostics |
| 10 | Exact CORS | VERIFIED | unchanged allowlist |
| 11 | CSP + `no-store` | VERIFIED | security middleware; private AI responses no-store |
| 12 | Debug/provider verbose logging off | VERIFIED | production gating; nothing verbose logged |
| 13 | SDK/docs/terms reviewed first | VERIFIED | no SDK added; interface written first |
| 14 | Remove unused SDKs | VERIFIED | no AI/OCR dependency in either manifest |
| 15 | Exclude prompts, fixtures, caches, `.env` | VERIFIED | `.gitignore`; fixtures are synthetic and committed intentionally |
| 16 | `MONGODB_URI`/provider keys server-only | VERIFIED | no client secret surface |
| 17 | Preserve Argon2id | VERIFIED | password service unchanged |
| 18 | Git tree/history secret scan | VERIFIED | see the session log entry |
| 19 | AI threat/security audit | VERIFIED | section 9 + session log |
| 20 | Test/diff/meaningful commit | VERIFIED | server + client + browser journeys green; one Part 6 commit |
| 21 | Continuous security | VERIFIED | design + tests throughout |
| 22 | Provider disclosure before external API | VERIFIED | no provider selected; disclosure table present |
| 23 | Test every state and adversarial output | VERIFIED | integration + unit + evaluation fixtures |
| 24 | Sync docs and evaluation evidence | VERIFIED | this doc, README, session log, harness |
| 25 | AI review fits one viewport | VERIFIED | pagination + tabs; asserted at six viewport sizes |

## 9. AI threat model

| Threat | Mitigation |
|---|---|
| Prompt injection in document text | Text is delimited data; delimiters stripped; injection signals detected as labels and force `needs_review`; no tools, no mutation path |
| Fabricated / inferred clinical value | Anchored fields must appear in the cited source or become `unresolved`; ambiguity is never normalized |
| Wrong or outside-source citation | Citations verified against supplied pages only |
| Malformed / oversized / unknown-key output | Rejected server-side before any persistence |
| Model tries to approve/publish/prescribe | No such code path; the only actions are apply (a draft edit) and dismiss |
| Data minimisation / leakage | Provider receives bounded delimited text only; prompts and source never logged or returned |
| Secret exposure | Key is server-only, never in React, logs or errors |
| Resource abuse | Timeout, bounded retries, per-hour/per-day budgets, dedupe |
| Dangerous rendering | Only reviewed, reviewer-approved renderings exist; none reach the patient automatically |
| Stale draft / revoked access | Access and revision re-checked before start and before apply; denied/stale writes clear the screen |

## 10. Evaluation - and its limits

`npm run evaluate:extraction -w server` runs the deterministic provider over the
synthetic fixtures and measures, separately:

- **field accuracy** (exact value match),
- **missing-field detection**,
- **conflict detection**,
- **citation correctness** (100% required),
- **reviewed-language fidelity** guarding,
- **prompt-injection detection**.

The harness is also a unit gate (`tests/unit/extraction-evaluation.test.js`).

**Passing is software behaviour on invented values. It is not clinical accuracy,
not a validation of any real provider, and not a claim of regulatory compliance.**
A real provider on real documents must be evaluated clinically, with a labelled
clinical set, under owner/clinical/privacy authorization, before any pilot.

## 11. What is still required before a real provider or a pilot

- Owner selection + the completed disclosure table (section 3) for a real provider.
- A labelled **clinical** evaluation set and clinical sign-off on the metrics.
- Privacy/retention/region review and an incident process for the selected provider.
- All the Part 10 production-hardening gates (deployment, backups, restore test,
  onboarding, monitoring). None of that is claimed here.
