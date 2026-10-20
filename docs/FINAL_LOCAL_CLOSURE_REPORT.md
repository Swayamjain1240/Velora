# Velora — Final Local Closure Report

**Date:** 20 October 2026 · **Branch:** `chore/final-local-closure` · **Scope:** local-only closure of the
four remaining areas (accessibility, dependency advisories, secrets/environment, local/mock providers)
· **Deployment:** none, and none attempted.

**Verdict: `LOCAL PROJECT COMPLETE WITH DOCUMENTED LIMITATIONS`.**

Velora runs entirely on one computer. There is no cloud provider, no deployment configuration, no
external API call and no real patient data anywhere in this repository or its history.

---

## 1. Scope statement (control #22)

> Velora is a local-only development and portfolio application. It does not use cloud hosting, managed
> databases, external object storage, production notification services, cloud schedulers, external
> AI/OCR services or cloud monitoring. Application data, documents and processing remain on the
> developer's local machine. Notifications are simulated through mock providers. OCR runs locally.
> Only synthetic data is permitted, and no real patient or clinic data may be entered.

---

## 2. Environment used for every check below

| Item | Value |
|---|---|
| OS | Windows, Git Bash |
| Node / npm | 22.23.1 / 11.18.0 |
| Database | local MongoDB Community 8.3, single-node replica set `rs0` on `127.0.0.1:27019` |
| API | `NODE_ENV=test PORT=4100` (`EXTRACTION_PROVIDER=fake`, and a second run with `none`) |
| Client | Vite dev server on `127.0.0.1:5173`, proxying `/api` to `:4100` |
| Data | synthetic seed only (`npm run seed -w server`) |
| Install | clean `npm ci` — 428 packages, 0 vulnerabilities |

---

## 3. Area 1 — accessibility

### 3.1 Verified automatically (all passing)

| Check | Command | Result |
|---|---|---|
| axe WCAG 2.1 A/AA, 34 screen states | `npx playwright test e2e/axe.spec.js` | **9/9 groups, 0 violations** |
| Deep surfaces (added this pass) | included above | patient detail + Consent/Caregivers/Team, episode detail + Plan/Schedule/Corrections/Team/Documents/Closure, patient self-service (3), caregiver scoped (3), invitation error state |
| Keyboard shell journey | `e2e/accessibility.spec.js` | 1/1 |
| Dialog: focus trap, Escape, focus restore (new) | `e2e/keyboard.spec.js` | 1/1 |
| Tab strip: one Tab stop, arrows, Home/End, wrap (new) | `e2e/keyboard.spec.js` | 1/1 |
| Six viewports × 5 sessions | `e2e/viewports.spec.js` | 36 measurements, all pass |
| 200 % / 400 % reflow | `e2e/zoom.spec.js` | 2/2 |
| Reduced motion, browser-level (new) | `e2e/reduced-motion.spec.js` | 2/2 |
| Forced colours / high contrast | `e2e/forced-colors.spec.js` | 3/3 |
| Phone table stacking | `e2e/tables.spec.js` | pass |
| Detail-screen one-viewport matrix | `e2e/detail-viewports.spec.js` | pass |
| Layout snapshot gate | `node qa/layout-snapshot.js` | 36 surfaces match baseline |

### 3.2 A real defect found and fixed

All ten tab strips declared `role="tablist"` but implemented **no keyboard contract**: every tab was a
separate Tab stop and the arrow keys did nothing. Fixed with a shared `client/src/lib/tabs.js`
(roving tabindex + Left/Right/Home/End with wrapping, focus follows selection, click-path side effects
mirrored) applied to all ten strips, covered by 6 unit checks and the new browser journey.

### 3.3 Manual tests — **NOT RUN** (not claimed)

| Test | Status | Why |
|---|---|---|
| NVDA (Windows) screen-reader walkthrough | **NOT RUN** | needs an interactive assistive-technology session on the developer's machine; cannot be automated here |
| VoiceOver (macOS/iOS) | **NOT RUN** | no macOS or iOS device in this environment |
| TalkBack (Android) | **NOT RUN** | no Android device |
| Real Safari / Firefox user run | **NOT RUN** | CI installs Chromium only; Firefox/WebKit projects exist (`E2E_PROJECTS=`) but were not re-run in this pass |
| Physical phone / tablet | **NOT RUN** | no device attached |
| Windows High Contrast, real OS setting | PARTIAL | emulated via `forced-colors` in the browser, not the real OS setting |

**Overall accessibility status therefore remains `PARTIAL`.** No WCAG conformance claim is made.

---

## 4. Area 2 — dependency advisories

| Check | Before this pass | After | Action |
|---|---|---|---|
| `npm audit` (root, `server/`, `client/`) | 0 vulnerabilities | **0** | none needed |
| `npm audit --omit=dev` | 0 production | **0** | none needed |
| `npm ls --depth=0` | no invalid/extraneous | unchanged | — |

No advisory existed, so **no dependency was upgraded** — an upgrade with nothing to fix would be
unrelated churn against the "smallest compatible change" rule. `npm outdated` reports major-version
drift only (express 5, mongoose 9, zod 4, react 19, eslint 10, `@testing-library/jest-dom` 7,
dotenv 18). These are **not** advisories; they are deferred major migrations, recorded as
`RISK ACCEPTED FOR LOCAL DEVELOPMENT` (they are the current supported majors of the shipped set and
each is covered by the existing suite). The vitest/vite/esbuild advisories recorded on 16 October are
gone from the tree (`npm audit` = 0).

---

## 5. Area 3 — `.env`, keys and Git safety

### 5.1 Tracked-file hygiene

| Check | Result |
|---|---|
| `.env` tracked? | **No** — only `.env.example`; `.env` exists locally and is ignored |
| `.gitignore` coverage | `.env`, `.env.*`, `!.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `.envrc`, `secrets/`, `uploads/`, `private-storage/`, `private-documents/`, `document-storage/`, `exports/`, `backups/`, `logs/`, `coverage/`, `*.log`, `*.vd1`, `*.sqlite*`, `.mongodb-test/`, `e2e/.auth/`, `dist/` |
| Secrets in `.env.example` | placeholders only; the file now documents the NAME MAPPING and the local scope |
| Server-only values in the client | none — no `VITE_*` value carries a secret; the client build has no server variable |
| Hard-coded secrets in code | none found (see 5.3) |

### 5.2 Environment validation (existing, re-verified)

Startup fails closed on: missing required variables, a non-replica-set/TLS production URI, a session
pepper under 16 chars (32 in production), an encryption key that is not base64 of exactly 32 bytes,
a reused key across stores, a `*_PREVIOUS` rotation key equal to its current value, a storage root
inside the repository or relative, and `LOG_LEVEL=debug` in production. Field names are printed;
**values never are**. 15 unit cases in `server/tests/unit/env.test.js`.

### 5.3 Secret scan (new, offline, reproducible)

`node qa/secret-scan.js` (tree) and `--history` (every reachable commit), dependency-free:

| Scan | Result |
|---|---|
| Tracked tree (401 files, lockfiles/build skipped) | **clean** — 2 reviewed fixtures matched the baseline by value fingerprint |
| History (823 file revisions) | **clean** — the same 2 fixtures |
| `--strict` (baseline disabled) | fails on exactly those 2, proving the baseline is doing work rather than masking everything |

Both baseline entries are synthetic by construction and are allowlisted **by SHA-256 of the value**,
not by file, so a real credential pasted into the same file still fails:
`qa/lib/qaEnv.js` (disposable QA key) and `server/tests/unit/env.test.js` (a deliberately too-short
pepper that the schema must reject). No active or historical credential was found.

---

## 6. Area 4 — local/mock providers

| Capability | Local selection | Enforced by |
|---|---|---|
| Hosting | localhost only (`:4000`/`:4100` API, `:5173` client) | no deployment manifest; `TRUST_PROXY=false` |
| Database | local MongoDB Community, replica set `rs0` | transactions required; `npm run mongo:test-rs -w server` |
| Document storage | encrypted local filesystem (AES-256-GCM, opaque UUID keys) | root must be absolute and outside the repo; path-traversal guards |
| Email / SMS / WhatsApp / push | **disabled** | the registry refuses these names and lists the disclosure fields they would need |
| In-app notifications | simulated (`in_app`), plus `fake` for tests | nothing leaves the process; `fake` refuses to run in production |
| Scheduling | request-driven materialisation inside the API; no daemon, no queue | bounded per-call limits |
| OCR / extraction | `none` (shipped) / `fake` (offline, deterministic) | no key required; production refuses `fake` |
| Monitoring | structured JSON logs + `/api/health` + `/api/ready` | deep redaction; request ids; production stacks suppressed |

The brief's conventional variable names (`APP_MODE`, `ALLOW_REAL_PATIENT_DATA`, `STORAGE_PROVIDER`,
`NOTIFICATION_PROVIDER`, `SCHEDULER_PROVIDER`, `OCR_PROVIDER`, `MONITORING_PROVIDER`, `JWT_SECRET`) map
onto existing, validated variables — documented in `.env.example` and `README.md` rather than adding
no-op flags. `ALLOW_REAL_PATIENT_DATA` is deliberately **not** a variable: no code path accepts real
data, so a switch could only imply that one exists.

---

## 7. Full regression

| Suite | Command | Result |
|---|---|---|
| Clean install | `npm ci` | **PASSED** (428 packages, 0 vulnerabilities) |
| Server unit + integration + concurrency | `PORT=4000 NODE_ENV=test npm test -w server` | **440/440 passed**, exit 0 |
| Client unit/component | `npm run test -w client` | **105/105 passed** (18 files) |
| Client lint | `npm run lint -w client` | clean, exit 0 |
| Production build | `npm run build -w client` | built; `index.js` 467.74 kB (133.67 kB gzip), CSS 46.83 kB (9.35 kB gzip), scene chunk 13.11 kB (4.99 kB gzip) |
| Browser journeys (all specs) | `PORT=4100 npx playwright test` | **85 passed, 1 failed, 1 skipped** (5.6 min) |
| ↳ the one failure | `e2e/extractions.spec.js -g "no provider enabled"` | **PASSED 1/1** when the API is restarted with `EXTRACTION_PROVIDER=none` — its documented topology (the same two-step shape CI uses). The full-suite invocation ran that spec against a `fake`-provider API, so the assertion could not hold. No test was changed or skipped to make this pass |
| Layout snapshot gate | `node qa/layout-snapshot.js` | 36 surfaces match the baseline |
| Startup smoke | `curl /api/health`, `/api/ready`, client `:5173` | `ready`, database `ok`, storage `ok` |
| Restore drill | `npm run restore:drill -w server` | **PASSED** — 49 collections, 8,592 rows, 283 encrypted objects (8,093,652 bytes); dump 382 ms, restore 13,144 ms, object copy 737 ms, verify 832 ms |
| Document reconciliation | `node server/scripts/reconcile-documents.js` | 0 missing, 0 unreadable, 0 mismatches, 0 orphans (dry run) |
| Secret scan | `node qa/secret-scan.js` (+ `--history`) | clean (see 5.3) |

Totals: **server 440 + client 105 + browser 86 (in their documented topologies) = 631 automated checks**,
plus the layout gate (36), the drill and the reconciliation report.

---

## 8. Known limitations (unchanged or newly stated)

1. **Manual accessibility is NOT RUN**: NVDA, VoiceOver, TalkBack, real Safari/Firefox, physical
   devices. Accessibility is `PARTIAL`; no WCAG conformance is claimed.
2. **CI runs Chromium only.** Firefox/WebKit projects exist and were exercised in an earlier pass but
   are not part of this gate.
3. **No scheduled backup and therefore no RPO/RTO commitment**; the drill is logical, same-host and
   synthetic. No provider snapshot, cross-region or point-in-time restore was exercised.
4. **No deployment** and no production Mongo auth/TLS exercise (D-10).
5. **Admin screens measure wider than the phone box** (L16) while the page reports no overflow — the
   content is absorbed, not scrolled; open for the stage-3 structural pass.
6. **3D scene on real devices** is unmeasured (L8); the fallback path is tested.
7. **No i18n/RTL/locale pass** (L15).
8. **Major dependency migrations deferred** (express 5, mongoose 9, zod 4, react 19, eslint 10) —
   `RISK ACCEPTED FOR LOCAL DEVELOPMENT`, not advisories.
9. **No clinical, legal or production-readiness claim** of any kind.

---

## 9. Duck verdict

**`LOCAL PROJECT COMPLETE WITH DOCUMENTED LIMITATIONS`**

Justification: every definition-of-done item that can be executed locally was executed and passed;
the two items that cannot (assistive-technology and physical-device testing) are marked `NOT RUN` with
reasons rather than claimed, and one full-suite failure is reported with its topology explanation and
an independent passing run in the correct topology. Nothing was deployed, no provider was added, no
secret was committed, and no test was weakened.
