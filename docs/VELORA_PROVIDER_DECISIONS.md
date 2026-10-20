# Velora MERN - Provider Decision Register

Part 10 item 2. The system ships **provider-neutral**: no external service is connected, no key is
present and no clinical data has ever left the machine. This register records, per capability, what
the code already assumes, which candidates were evaluated, and the disclosure the owner must make
**before** any provider is enabled (control #22).

Candidate shortlists come from the Gravity Index catalogue (16 October 2026), not from memory.
Recommendations there are indicative only: the owner selects, and a selection is not evidence of an
integration.

> **Nothing in this register is connected.** Every row below is `NOT SELECTED`.

## The disclosure template (control #22)

Before enabling ANY provider, record all of the following in this file and in the session log:

| Field | Meaning |
|---|---|
| Provider + service | vendor and product name |
| Purpose | the single reason it is being added |
| Key + environment variable | the server-side variable name (never a `VITE_*` value, never in the client) |
| Location | server-side, client-side, or both |
| Data sent | exact fields, with the clinical-content boundary stated |
| Region + retention | storage/processing region and provider retention window |
| Cost | the billing model being accepted |
| Approver + date | the owner who authorised it |

---

## 1. Database

| | |
|---|---|
| Status | **NOT SELECTED** (local replica set in development) |
| Code assumption | `MONGODB_URI` must be a **replica set or mongos** (transactions are required from Part 2 on), TLS is **mandatory in production**, and one URI is the only connection input. Pool size, socket and selection timeouts are bounded from configuration |
| Evaluated | **MongoDB Atlas** (catalogue recommendation): managed replica sets, TLS via `mongodb+srv://`, encryption at rest, scheduled snapshots and region selection; the free M0 tier is explicitly not a production tier |
| Fit | strong: the application already speaks Mongoose and requires exactly the transaction semantics Atlas provides |
| Required before enable | dedicated cluster (not a shared/free tier) in the chosen region, a least-privilege database user (**not** the admin role), IP/private-endpoint access rules, provider backups **enabled**, TLS-only connections confirmed, and the backup cadence recorded here |
| Data sent | the entire application dataset: identities, consent history, episodes, plans, schedules, check-ins, audit trail, retention runs |
| Disclosure | `MONGODB_URI` (server-only) · region **owner decision** (India/EU) · backup retention window **owner decision** |
| Blocks | any pilot with real data; the RPO/RTO commitment in the operations runbook |

## 2. Hosting (API and client)

| | |
|---|---|
| Status | **NOT SELECTED** |
| Code assumption | the API is a **long-running Node process**: it holds a bounded Mongo pool, an in-process bounded document parser, and a graceful drain that reports `draining` on `/api/ready` before the listener closes. The client is a static `dist/` build and can be served anywhere |
| Evaluated | **Vercel** (catalogue recommendation) is a strong fit for the **static client** only. Its own guidance excludes backend-only workloads and long-running servers, which contradicts this API's shutdown, connection-pool and worker assumptions; the local encrypted object store also requires a persistent filesystem unless a storage provider is selected first |
| Fit | client: yes · API: needs a host that support persistent Node processes, custom health probes and a configurable termination grace period |
| Required before enable | a persistent runtime with: env-var secrets, HTTPS termination, `/api/health` + `/api/ready` probes wired to rolling replacement, a termination grace period ≥ `SHUTDOWN_GRACE_MS`, a region matching the database, and a private filesystem (or an approved object-storage provider) |
| Data sent | clinical records and encrypted documents (ciphertext + metadata) to the host and its storage |
| Blocks | deployment of any kind; the operations runbook's probe and rotation sections assume this choice |

## 3. Private object storage

| | |
|---|---|
| Status | **NOT SELECTED** (local encrypted filesystem provider, behind a provider-neutral interface) |
| Code assumption | objects are addressed by opaque UUID keys and are **already encrypted client-side of the store** (AES-256-GCM with `DOCUMENT_ENCRYPTION_KEY`), so a provider only ever sees ciphertext. Nothing public is ever exposed: downloads pass through an authorised API route |
| Evaluated | AWS S3, Google Cloud Storage, Azure Blob, Cloudflare R2, Backblaze B2, Wasabi, Storj, Supabase Storage, Tigris (all S3-compatible or equivalent) |
| Fit | any S3-compatible store behind the existing interface. Region control and private-bucket/block-public-access defaults matter more than brand: the app's own envelope encryption means the provider is a second layer, not the only one |
| Required before enable | private bucket (no public access), region matching the database, server-side encryption enabled **in addition to** the app envelope, no provider-side scanning that would process plaintext, lifecycle rules that never delete before retention allows, and an audit trail of bucket-level access |
| Data sent | encrypted document bytes plus opaque keys only |
| Blocks | the runbook's "restore the object store" step whenever the API host has no persistent filesystem |

## 4. Email / SMS / notification delivery

| | |
|---|---|
| Status | **NOT SELECTED** — the only shipped channel is `in_app` |
| Code assumption | one provider-neutral interface with bounded attempts (`REMINDER_MAX_ATTEMPTS`), de-duplication by recipient + event version + channel, a re-check of episode/plan/task/recipient state immediately before sending, and the invariants that **delivery is not acknowledgement** and a failed reminder is a delivery problem, never a missed dose |
| Evaluated | **Knock** (catalogue recommendation) as an orchestration layer over transactional providers it connects (for example SendGrid/Postmark for email, Twilio for SMS). A clinic in India may prefer a local SMS gateway; the choice is the owner's, and the interface does not change either way |
| Required before enable | the disclosure row above; per-channel consent checked against the recorded consent history; provider delivery-status webhooks (signed) mapped onto the existing `DeliveryAttempt` outcomes; a retention statement for recipient identifiers at the provider; and an explicit decision that SMS/WhatsApp is acceptable for the pilot population |
| Data sent | recipient contact details, reminder type, episode/plan identifiers — **no clinical text** unless the owner approves a message template that carries clinical instructions (not recommended; the shipped design keeps message bodies non-clinical) |
| Blocks | any reminder outside the in-app surface; the closure preflight's `failed_deliveries` evidence quality |

## 5. Job processing and scheduling

| | |
|---|---|
| Status | **NOT SELECTED** — there is no queue, cron or worker in the shipped system |
| Code assumption | every state change is an authenticated HTTP action. Reminder delivery is a bounded batch an authorised person runs; retention `apply` is an explicit operator action behind a dry run |
| Evaluated | Trigger.dev, Inngest, Temporal Cloud, Hatchet, Upstash QStash, Zeplo, AWS SQS, Cloudflare Queues, cron-job.org, Defer, Restate, Prefect Cloud |
| Fit | a scheduler that calls **existing authorised endpoints** is the safe pattern (the work stays inside the app's permission and audit boundary). A queue whose workers write to the database directly would duplicate the authorization logic and is the option to avoid |
| Required before enable | a service identity with the minimum permission for the job it triggers, idempotency keys preserved end to end (already required by the API), dead-letter/failed-run visibility surfaced to an operator, bounded retries, and a signing secret verified on every inbound trigger |
| Data sent | job identifiers and timestamps only |
| Blocks | scheduled retention, scheduled reminder batches and any "runs while nobody is watching" behaviour |

## 6. AI / OCR extraction

| | |
|---|---|
| Status | **NOT SELECTED** — the shipped default is `EXTRACTION_PROVIDER=none` and the product works with AI off; the manual workflow is unaffected |
| Code assumption | a provider-neutral registry validates the provider name and its key at startup and **fails closed** (`PROVIDER_DISABLED`) if anything is missing; job I/O is bounded (`EXTRACTION_MAX_INPUT_CHARS`, `EXTRACTION_MAX_OUTPUT_BYTES`, `EXTRACTION_TIMEOUT_MS`, retries, per-hour and per-day budgets); output is a structured suggestion set that **cannot** approve, publish, prescribe or activate anything; the source page/quote is required for every suggestion |
| Evaluated | the catalogue search for medical document extraction/OCR returned **no suitable candidate**. This is a deliberate finding, not an oversight: the shortlist must be assembled by the owner from vendors whose data-processing terms can be read, and each must be assessed against the requirements below |
| Required before enable | a written no-training-on-our-data guarantee; a stated processing region; a retention window for submitted content; PHI handling terms (BAA-equivalent) if the pilot clinic requires them; a documented failure mode that keeps the manual path working; citation/page fidelity demonstrated on synthetic samples; and an evaluation run using the existing deterministic evaluation harness before any real document |
| Data sent | extracted document TEXT (the minimum window needed) — never a document URL, never the image unless a later decision explicitly allows it |
| Blocks | Part 6's provider selection; the "AI-assisted" wording in any pilot material |

## 7. Monitoring, error tracking and alerting

| | |
|---|---|
| Status | **NOT SELECTED** — observability today is the structured JSON log stream plus `/api/health` and `/api/ready` |
| Code assumption | logs are already redacted (sensitive keys, depth, size) and **clinical content is never logged**; stack traces are suppressed in production; the alert-worthy events are named (`readiness.unavailable`, `dependency.unavailable`, `audit.write_failed`, `shutdown.forced`, `request.unhandled_error`, `process.uncaught_exception`) |
| Evaluated | Sentry, Rollbar, Bugsnag, Airbrake, Honeybadger, Raygun, Highlight.io, Better Stack, UptimeRobot, StatusCake, Pingdom, Checkly (Playwright-based synthetic checks), Grafana Cloud, Axiom, Datadog, Honeycomb, SigNoz, PagerDuty/Opsgenie (on-call) |
| Fit | an error tracker **wired to the redacting logger** (not to raw errors), plus an uptime monitor on `/api/ready`, plus an on-call route for the error-level events. Sentry-style `beforeSend` scrubbing plus the existing redaction is the intended shape; the synthetic-check option suits the Playwright journeys already in CI |
| Required before enable | scrub-before-send verified on a synthetic error containing a token-like value; no session replay, no request-body capture, no screen recording on any authenticated clinical screen; alert routing for the error-level events above; and a decision on whether the log stream is forwarded at all |
| Data sent | error type/message, request id, route, counts — **never** bodies, tokens, document text or patient identifiers |
| Blocks | the "who is paged at 03:00" answer, and therefore any claim of production readiness |

## 8. Optional compliance and code-security tooling

| | |
|---|---|
| Status | **NOT SELECTED** |
| Evaluated | Drata / Thoropass (continuous compliance evidence), Semgrep (SAST + secrets), Snyk (SCA/SAST/IaC). The repository already runs `npm audit --omit=dev` and a gitleaks secret scan in CI |
| Note | these produce evidence; they do not create compliance. No certification, HIPAA/GDPR equivalence or clinical validation is claimed or implied anywhere in this project |

---

## 9. The local-only selection (the configuration this repository actually ships)

The eight rows above answer "which external provider would we use". For the portfolio/development
scope the answer is **none**, and that is a recorded selection, not an absence: every capability
runs locally, with no key and no network dependency.

| Capability | Local selection | What enforces it |
|---|---|---|
| Application hosting | Localhost only: API `:4000`, Vite client `:5173` | no deployment manifest exists; the API is a long-lived Node process with a graceful drain |
| Database | Local MongoDB Community, single-node replica set (`:27019`) | `npm run mongo:test-rs -w server`; production-only TLS rule is not triggered locally |
| Document storage | Encrypted local filesystem | `DOCUMENT_STORAGE_ROOT` absolute + outside the repo; AES-256-GCM, opaque UUID keys, path-traversal guards |
| Notification delivery | In-app only (`REMINDER_PROVIDER=in_app`), plus the `fake` transport for tests | the provider registry REFUSES `email`, `sms`, `whatsapp`, `push` with the disclosure fields they would need |
| Scheduling / jobs | In-process, request-driven materialisation; no daemon, no queue | bounded per-call limits; reminders are computed from stored schedules when a route is called |
| OCR / AI extraction | `EXTRACTION_PROVIDER=none` (shipped) or `fake` (offline, deterministic) | `fake` refuses to run in production; no provider key is required or present |
| Monitoring / alerts | Structured JSON logs with deep redaction, `/api/health`, `/api/ready` | correlation ids on every response; production stack traces suppressed |
| Exports / backups | Encrypted local artifacts under an absolute path outside the repo | separate keys; commands fail closed without their key |

**Control-#22 statement.** Velora is a local-only development and portfolio application. It does
not use cloud hosting, managed databases, external object storage, production notification
services, cloud schedulers, external AI/OCR services or cloud monitoring. Application data,
documents and processing remain on the developer's local machine. Notifications are simulated
through mock providers. OCR runs locally. Only synthetic data is permitted, and no real patient or
clinic data may be entered.

Consequence for this register: rows 1-8 stay `NOT SELECTED` **on purpose**. Selecting a provider is a
deployment decision that the local scope excludes, so the disclosure table above remains the
checklist for anyone who later chooses one - it is not work left undone.

---

## What must NOT happen without an explicit owner decision

1. Any credential in a `VITE_*` value or in the client bundle.
2. Any provider enabled while the extraction or reminder registry would accept it before its
   disclosure row exists.
3. Any clinical content sent to an error tracker, analytics tool or AI provider without a recorded
   disclosure and the corresponding consent state.
4. Any destructive retention `apply` on clinical categories, with or without a provider.
5. Any pilot with real patient data — no real data has entered this system at any point.
