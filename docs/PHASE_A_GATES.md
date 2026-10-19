# Phase A - blocking gates to completion

Phase A is the five gates that stop the project being called complete. This page states, for each
gate, **what is true today**, the evidence, and the one action that closes it. Nothing here is a
new claim: every number was measured on 19 October 2026 and is reproducible with the command shown.

| # | Gate | Status | Evidence | Closes when |
|---|---|---|---|---|
| A1 | CI green on a branch revision | **GREEN** | PR [#1](https://github.com/Swayamjain1240/Velora/pull/1), run `39237665971` on `b51422d`: Server tests, Client tests/lint/build, Browser journeys and Dependency audit/secret scan all **success** | Merging the PR (owner action) |
| A2 | A real deployment | **Blocked - owner decision** | No host, no production database, no domain. Provider register §2 | A staging deployment answers `/api/ready` over HTTPS with the CSP at the edge |
| A3 | Provider decisions | **Documented, NOT SELECTED** | [Provider decision register](VELORA_PROVIDER_DECISIONS.md); extraction evaluation 1.00 on synthetic data | The owner selects providers (control #22) or explicitly ships without them |
| A4 | Scheduled backups + RPO/RTO | **Mechanism complete; schedule is operations** | §6.1 of the [runbook](VELORA_OPERATIONS_RUNBOOK.md): 13 tests, create+verify 1,495 ms, restore 11,399 ms | A cron/Task Scheduler job runs it against the deployed database and a restore is timed |
| A5 | Clinical + privacy sign-off | **Pending people** | Checklist below; automated a11y 0 violations; synthetic extraction evaluation | Named reviewers sign the items below |

---

## A1 - CI

Why it mattered: thirteen runs on `main` had failed and no run had ever executed a branch revision.
The first pull-request run proved the hero-tier fix on a clean machine (server and client suites
green), and exposed two failures that were **configurations, not flakes**:

1. `gitleaks-action` v2 refuses a `pull_request` without `GITHUB_TOKEN`, so the job failed before
   scanning. The workflow now passes the automatic read-only token.
2. The layout gate compared a Windows baseline. At phone widths the screens reach **min-content**
   width, which follows the font fallback (Segoe UI vs Liberation Sans, ~21 px). `mainWidth` now
   carries a 32 px allowance **at phone widths only**; overflow, headings, tables, cards and nav
   counts stay exact.

After both fixes, run `39237665971` on `b51422d` is **green in all four jobs**.

The gate also surfaced a real finding: `/app/clinic` measures `main` at **412 px inside a 390 px
viewport** while page overflow reports 0 because the document is `overflow-x: hidden`. Recorded as
**L16** - the stage-3 structural pass must remove the cause, not widen the gate.

## A2 - Deployment

The API is a **long-running Node process** (bounded Mongo pool, in-process document parser, graceful
drain that reports `draining` on `/api/ready`). It cannot run on a serverless/edge platform. The
catalogue search found no host that satisfies "long-running process + persistent filesystem +
managed MongoDB" as a single bundle, so this stays an owner choice.

Requirements the host must meet, all already encoded in the app:

- a persistent process with a termination grace period >= `SHUTDOWN_GRACE_MS`
- `/api/health` and `/api/ready` wired to rolling replacement
- server-side environment secrets (never `VITE_*`)
- a persistent private filesystem for `DOCUMENT_STORAGE_ROOT`, outside any web root
- a region matching the database (India or EU, owner decision)
- cron or a scheduled job, for `backup:create`
- **MongoDB as a replica set over TLS** - transactions are required from Part 2 on; the process
  refuses to start in production without TLS

Candidates that match that shape: **Render** (web service + cron + persistent disk), **Fly.io**
(containers, volumes), **Hetzner/DO + Coolify** (self-managed), **Cloud Run** (needs a mounted
volume and a long request timeout). MongoDB: **Atlas** dedicated tier, not the free shared tier.

## A3 - Providers

The register is honest and complete: nothing is connected, and no clinical data has left the
machine. What the code guarantees is that enabling a provider is a **bounded** change behind an
interface, with a refusal when the name or key is unknown.

- **Extraction**: the shipped provider is `fake`, so the evaluation (1.00 field accuracy, 1.00
  citation precision, 1.00 injection detection on 6 synthetic documents) measures **software
  behaviour, not clinical accuracy**. A real provider must be disclosed with region, retention and
  no-training terms before a single clinical page is sent.
- **Messaging**: `in_app` only. Email/SMS needs its own disclosure and consent review.
- **Database, storage, hosting**: not selected (see A2).

## A4 - Backups

What exists now (beyond the restore drill):

```bash
npm run backup:create -w server                  # writes + verifies an encrypted set
npm run backup:verify -w server -- <set id>      # re-checks every file later
npm run backup:restore -w server -- --set <id> --target <uri> --objects-root <path>
npm run backup:prune -w server                   # keeps BACKUP_RETAIN_SETS complete sets
```

A set is encrypted rows, the object store copied verbatim, and a manifest of counts, checksums,
index options and key fingerprints. Objects are copied before rows, so no restored row can reference
a missing object. Every run is recorded in `backupruns`; the newest `complete` row is the recovery
point.

Measured on the seeded database (8,499 documents, 277 objects, 12.3 MB):
**create + verify 1,495 ms**, **restore 11,399 ms** (rows 10,672 ms, objects 633 ms), 0 mismatches.

Still owner decisions: **cadence** (this sets the RPO), off-host/off-region destination,
immutability, backup-access audit, and custody of `BACKUP_ENCRYPTION_KEY`.

## A5 - Clinical and privacy sign-off

Code cannot sign these. Each row needs a named person and a date:

| Item | Who | What they are attesting |
|---|---|---|
| Clinical workflow review | Clinical lead | The episode -> plan -> schedule -> check-in -> closure flow matches real practice; closure never asserts recovery |
| Extraction evaluation | Clinical lead + engineer | Acceptance thresholds on a **real** (or authorized de-identified) document set, not the synthetic one |
| Retention policy | Privacy owner | Per-category retention windows and the hold behaviour are lawful for the pilot jurisdiction |
| DPIA equivalent | Privacy/legal | Lawful basis, data-subject process, breach notification path |
| Incident ownership | Ops owner | Who is paged, hours, and what happens to stored documents on a breach |
| Accessibility acceptance | Product owner | Automated axe 0 violations accepted as the baseline; NVDA/VoiceOver walkthrough still manual (L5) |

## Quick re-check

```bash
npm test                                   # server 437/437, client 99/99
npm run lint -w client
node qa/layout-snapshot.js                 # needs the stack + e2e/.auth
npm run evaluate:extraction -w server      # synthetic, software behaviour only
npm run backup:create -w server            # needs BACKUP_ENCRYPTION_KEY + BACKUP_ROOT
npm run backup:restore -w server -- --set <id> --target <isolated uri> --objects-root <path>
```

Not proved by any of the above: a deployment, provider data handling, real clinical accuracy, a real
screen reader, physical devices, real Safari, or production Mongo TLS. Those remain open.
