# Velora MERN - Go-Live Plan (points 2-7, deploy last)

Date: 20 October 2026 · Branch: `feat/ui-redesign-dark-purple` @ `b681b89` · Status: **PLANNED**
Scope: close the seven remaining items in [VELORA_READINESS_REPORT.md](VELORA_READINESS_REPORT.md) §7.
Deployment is the **last** phase, on purpose: five of the seven items are inputs a deployment consumes,
so deploying first means deploying twice.

---

## 0. Re-measure before planning (done - two items shrank)

The readiness report was written on 16 October. Two of its seven open items were re-measured today:

| Item | Report said (16 Oct) | Measured now (20 Oct) | Verdict |
|---|---|---|---|
| Dev-toolchain advisories | 6 advisories (3 moderate, 1 high, 2 critical) | `npm audit` = **0 vulnerabilities** in root, `server/` and `client/` (exit 0) | **CLOSED** - the toolchain moved; nothing to upgrade |
| Automated contrast/axe audit | "BLOCKED: no automated contrast/axe audit" | `e2e/axe.spec.js` runs the WCAG 2.1 A/AA rule set over public + reviewer + admin routes and **fails on any impact**; CI line 135 runs it together with the 200 %/400 % zoom reflow | **CLOSED** |

Consequence: item 6 is no longer work, and item 5 loses "no axe audit" and "no extreme-zoom test".
The accessibility gap is now exactly three things, all manual: **screen reader**, **real
Safari/Firefox**, **physical device**. The report's §1, §2, §3 and §7 were corrected to the measured
values rather than left to drift.

---

## 1. What is an owner decision and what is engineering

The plan fails if these are mixed. Three of the seven items cannot be closed by code at all:

| Only the owner can decide | Can be prepared or executed by engineering |
|---|---|
| Which providers, which region, which retention windows (§2 provider selection, §3 backup cadence, §4 key store) | Everything that turns a decision into a wired, tested configuration |
| Clinical scope, privacy/legal basis, incident ownership, pilot authorisation (§7) | The templates that make those decisions recordable and auditable |
| Accessibility acceptance level (§5) | The manual test script, and the fixes it produces |

So the plan is: **build the decision packs first** (engineering, no waiting), then hold **one**
decision meeting, then wire the choices (engineering), then deploy.

---

## 2. Phases

| Phase | Work | Owner | Evidence that it is done | Effort |
|---|---|---|---|---|
| **P0. Re-baseline** | Correct the stale claims; publish this plan | engineer | report matches measurement; this file linked | **done** |
| **P1. Decision packs** | Four documents, below, each ending in a one-page pick | engineer | owner can answer every row without asking a question | 1-2 days |
| **P2. Decision meeting** | Pick providers, region, retention, key store, incident owner, clinical scope | clinic owner + clinical lead + privacy + ops | every register row has `Approver + date` | 1 meeting |
| **P3. Wire the selections** | Provider adapters, scheduled backup + monitor, key-store loader, ops runbook finalisation | engineer | the gates in §3 pass against the chosen provider | 3-5 days |
| **P4. Accessibility close-out** | Screen-reader pass, Safari/Firefox pass, device pass, fix what they find | engineer + a11y tester | signed script per surface, defects closed | 1-2 days |
| **P5. Staging dry run** | Deploy to a staging environment with synthetic data only | engineer | the §4 checklist passes end to end, twice | 1 day |
| **P6. Sign-off** | Clinical, privacy, incident, pilot authorisation recorded | owners | four signatures on one page | 1-2 days (waiting) |
| **P7. Production deploy** | The last task | engineer | §4 checklist on production + first 24 h watch | 0.5 day |

Critical path: **P1 → P2 → P3 → P5 → P6 → P7**. P4 runs parallel to P1-P3; P6 can start as soon as P2
records the clinical scope.

---

## 3. P1 decision packs (what the owner actually receives)

### Pack A - Providers (capability → one recommendation + one alternative)

For each of the seven capabilities in [VELORA_PROVIDER_DECISIONS.md](VELORA_PROVIDER_DECISIONS.md)
(hosting, managed MongoDB, private object storage, notification delivery, scheduling/jobs, AI/OCR,
monitoring): the recommendation, the alternative, the monthly cost at pilot volume, the region, the
exact data fields that leave the machine, the provider retention window, and the control-#22
disclosure **pre-filled except for approver and date**.

Two constraints the packs must respect, because the code already assumes them:

- hosting must run a **long-lived Node process** with `/api/health` + `/api/ready` probes and a
  termination grace period ≥ `SHUTDOWN_GRACE_MS` - a static-only or serverless-only host cannot
  take the API as written, and the `/api/ready` `draining` contract exists precisely for this;
- the database must be a **replica set** (transactions) with TLS, so a single-node or free tier is
  excluded by the code, not by preference.

### Pack B - Backup cadence (three concrete options, not a question)

Each option states: frequency, retention, location, who can restore, expected RPO, expected RTO and
cost. The measured drill (logical copy, same host, synthetic volume) gives the floor for RTO; the
pack must say plainly that a **provider snapshot** is a different mechanism with a different RTO.

Options to table: hourly / 24 h retention; 6-hourly / 30 days; daily / 90 days + monthly archive.
Whatever is picked becomes the numbers the runbook is allowed to print.

### Pack C - Key store

Two viable shapes, with the trade-off written out:

- **env-file + encrypted offline escrow**: no new provider, but rotation is a manual ceremony and the
  escrow is only as safe as the operator's storage;
- **managed KMS/Vault**: rotation policy enforceable and auditable, but the re-seal command
  (`scripts/reseal-keys.js`) then has to read through the KMS, which is additional work in P3.

Pack C must also fix the cadence (90 days is the defensible default) and name who may rotate.

### Pack D - Accessibility close-out script

A per-surface checklist for screen reader (NVDA on Windows, VoiceOver on macOS/iOS), real Safari and
Firefox, and one physical phone: what to announce, what must be reachable by keyboard, what "pass"
looks like, and a defect log format. The automated gate already covers structure and contrast; this
script covers what axe cannot see.

---

## 4. P5 / P7 deployment checklist (the mechanical part)

Once P2-P3 are done, deployment is a checklist, not a design task:

1. Environment: production variables set from the decision packs; `NODE_ENV=production` accepted by
   the startup schema (it refuses non-TLS Mongo, a short pepper, reused keys, a non-bare origin).
2. Probes: `/api/health` (liveness) and `/api/ready` (DB + storage) wired to the host's checks;
   termination grace period ≥ `SHUTDOWN_GRACE_MS`.
3. Client: static `dist/` build served over HTTPS; `CLIENT_ORIGIN` set to the bare exact origin.
4. Secrets: in the platform's secret store, never in the image, the repo or the client bundle.
5. Backups: provider snapshot enabled **and** the application dump on its chosen cadence; one restore
   from the *provider* copy (not the drill copy) performed and recorded.
6. Monitoring: the alert events the logger already emits are routed to whoever Pack/sign-off names.
7. First 24 h: watch `/api/ready`, 5xx rate, rate-limit 429s, delivery failures; record the window.

---

## 5. Definition of "go live" (and what it still will not mean)

Go live = P1-P7 complete **and** every §7 row in the readiness report has an approver and a date.

It still will not mean: clinically validated, certified compliant, zero known bugs, or an RPO/RTO
figure beyond the one the chosen cadence actually delivers. Those claims stay off the page.

---

## 6. Risks that would change the plan

| Risk | Effect | Mitigation |
|---|---|---|
| Owner picks a serverless-only host | the API's pool, parser and drain contract do not fit | Pack A states this up front; the alternative is a container host |
| No managed KMS approved | rotation stays a manual ceremony | Pack C option 1 keeps rotation possible, with the ceremony documented |
| Screen-reader pass finds structural defects | P4 grows, P5 slips | run P4 early and parallel to P1 |
| Region choice contradicts retention obligations | backup + storage plans change | decide region before Pack B is signed |
