# Velora — Final Local Closure Report

**Date:** 20 October 2026 · **Branch:** `fix/final-local-closure-blockers` (merged to `main`) ·
**Scope:** the four closure areas (accessibility, dependency advisories, secrets/environment,
local/mock providers) **plus the two blockers that still stood**: the L16 mobile admin-width defect
and the non-zero combined E2E result · **Deployment:** none, and none attempted.

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
| API | `NODE_ENV=test PORT=4100`, restarted per phase by the gate: `EXTRACTION_PROVIDER=fake`, then `none` |
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
| **L16 width contract** (new) | `e2e/layout-width.spec.js` | **31/31** |
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
| Real Safari / real Firefox (installed browsers) | **NOT RUN** | only Playwright's engine builds ran; a passing Playwright WebKit run is not Apple Safari |
| Playwright Firefox and WebKit engines | **NOT RE-RUN in this pass** | they ran the whole suite on 19 October (77/77 and 76 passed + 0 failures with 3 skips) and are recorded as such; the final gate executed **Chromium only** |
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
| Browser journeys — fake topology | `npm run test:e2e:fake` | **116 passed, 0 failed, 1 skipped** (5.9 min) |
| Browser journeys — provider-disabled topology | `npm run test:e2e:none` | **1 passed** (14 s) |
| **Combined E2E gate** | `npm run test:e2e:all` | **PASSED — exit code 0** (both phases, one command) |
| ↳ the one skip | `e2e/documents-quarantine.spec.js` | **intentional and opt-in**: it needs `DOCUMENT_PARSER_TIMEOUT_MS=50` plus `E2E_QUARANTINE=1`; reported separately, never counted as a pass |
| L16 width regression | `e2e/layout-width.spec.js` (inside the gate) | **31/31 pass**; measurement moved from 21/60 to 0/60 route×viewport combinations wider than the viewport |
| Layout snapshot gate | `node qa/layout-snapshot.js` | **36/36** against the deliberately re-recorded baseline |
| Startup smoke | `curl /api/health`, `/api/ready`, client `:5173` | `ready`, database `ok`, storage `ok` |
| Restore drill | `npm run restore:drill -w server` | **PASSED** — 49 collections, 8,587 rows, 283 encrypted objects (8,093,652 bytes, byte-identical after restore); dump 496 ms, restore 12,147 ms, object copy 532 ms, verify 655 ms |
| Document reconciliation | `npm run documents:reconcile -w server` | **0 missing, 0 unreadable, 0 integrity mismatches, 0 orphans** (dry run, after the documented repair described in 7.2) |
| Secret scan | `node qa/secret-scan.js` (+ `--history`) | **clean** — 409 tracked files, 851 historical revisions, 2 reviewed synthetic fingerprints (see 5.3) |

Totals: **server 440 + client 105 + browser 117 (two topologies) = 662 automated checks**,
plus the layout gate (36), the L16 width gate (31, counted inside the 117), the drill and the
reconciliation report.

### 7.1 Blocker 1 — L16, the mobile admin width

**Symptom (reproduced first).** A probe over 10 admin/reviewer routes × the six required viewports
measured `main` at **384 px inside a 320 px viewport** (`/app/clinic`) and **409 px inside 390 px**
(`/app/privacy`), while `documentElement.scrollWidth` stayed **exactly** the viewport. The page
therefore reported "no horizontal overflow" and was clipping instead: 21 of the 60 combinations were
wider than the viewport.

**Root cause.** `.shell__body` is a grid that declared only `grid-template-rows`. Its single column was
an **implicit `auto` track**, which sizes to the content's *min-content* width: a five-tab strip and a
stacked table cell whose value (a `<select>` plus a button) could not shrink pushed that track, and the
shell's own `overflow: hidden` clipped the excess. The width assertions could not see it because they
only read document overflow.

**Fix (structural, not a clamp).** `grid-template-columns: minmax(0, 1fr)` on `.shell__body`; the tab
strip now **wraps** instead of scrolling under a hidden scrollbar (`.tabs` had `overflow-x: auto` with
`scrollbar-width: none`, so destinations disappeared with no affordance); stacked table cells wrap,
their label can shrink (`flex: 0 1 auto; max-width: 45%`) and their controls get `min-width: 0`. No
content is hidden, no text is cut, no control is removed, and `overflow-x: hidden` was not used as the
fix.

**After.** All 60 combinations measure `main` = viewport width with `main`'s right edge at the viewport
and no visible descendant past it: clinic **384→320**, privacy **409→390**, audit **365→320**,
retention **364→320**, profile **341→320**. The 320×400 row repeats the same numbers.

**Regression gate.** `e2e/layout-width.spec.js`, 31 tests: 24 session×viewport measurements across
admin, reviewer, patient and caregiver sessions at 1440×900, 768×1024, 390×844, 320×568, 844×390 and
320×400; the tablet bounded-panel contract; the confirmation dialog at three phone sizes; and the
click-reached patient and episode detail screens at three phone sizes. Each measurement asserts
document width, `main` width, `main` right edge, `main` scroll width, no child past the viewport, no
tab hidden inside a strip, and no stacked row wider than its panel. The layout baseline was re-recorded
and the 32 px phone-width allowance removed, because `mainWidth` can no longer depend on the font.

### 7.2 Blocker 2 — the combined E2E gate

**Root cause 1 — two topologies, one process.** The provider-disabled journey asserts that extraction
*fails closed when no provider is configured*; every AI journey needs the deterministic `fake` provider.
A single API process can satisfy only one, so the old one-shot invocation either skipped the assertion
or ran it against the wrong API, and the gate was non-zero.

**Root cause 2 — a fixture that could not be read (found this pass).** Even with the correct topology,
the AI journey failed with `TEXT_LAYER_ERROR`. The seed is idempotent by checksum, so an
`EpisodeDocument` row survives a changed `DOCUMENT_STORAGE_ROOT` while its encrypted object does not;
the job then read a `ready` row whose bytes were gone. That is a fixture defect: `server/scripts/seed.js`
now verifies the stored bytes (`documentBytesReadable`) and replaces the row when they are missing or
unreadable, so the fixture is reproducible on any machine rather than only on the one that created it.

**Solution.** `scripts/e2e-topologies.js` (cross-platform Node, no shell): ensure MongoDB → seed →
start the API with `EXTRACTION_PROVIDER=fake` → wait for `/api/health` → run every journey except the
provider-disabled one → stop the API and wait for the port → seed → start the API with
`EXTRACTION_PROVIDER=none` → run that one journey → stop everything. It refuses to reuse or kill a
process it did not start, gives the run its own document-store root, and exits **0 only when both
phases pass**. Commands: `npm run test:e2e:fake`, `npm run test:e2e:none`, `npm run test:e2e:all`.
CI's browser job now calls `npm run test:e2e:all` instead of starting the API itself and restarting it
by hand.

**Result.**

```text
Fake-provider E2E suite: PASSED   (116 passed, 1 opt-in skip, 0 failed)
Provider-disabled E2E suite: PASSED   (1 passed)
Combined E2E gate: PASSED
Combined exit code: 0
Unexpected failures: 0
```

**Reconciliation residue, stated plainly.** Earlier E2E runs shared the developer's document-store
root, leaving 20 orphan objects that `documents:reconcile` reported. The gate now uses its own root;
the residue was removed with the tool's documented repair (`--apply --operator`), which deleted only
objects with no metadata row and changed no document rows. Reconciliation is now 0/0/0/0.

---

## 8. Known limitations (unchanged or newly stated)

1. **Manual accessibility is NOT RUN**: NVDA, VoiceOver, TalkBack, real Safari, real Firefox, iOS
   Safari, Android Chrome and physical devices. Accessibility is `PARTIAL`; no WCAG conformance is
   claimed.
2. **CI runs Chromium only.** Playwright's Firefox and WebKit *engines* were exercised in an earlier
   pass (they are not installed browsers), and this final gate did not re-run them. Adding CI matrix
   legs remains an owner decision.
3. **No scheduled backup and therefore no RPO/RTO commitment**; the drill is logical, same-host and
   synthetic. No provider snapshot, cross-region or point-in-time restore was exercised.
4. **No deployment** and no production Mongo auth/TLS exercise (D-10).
5. ~~Admin screens measure wider than the phone box (L16)~~ — **resolved and gated** (7.1).
6. **3D scene on real devices** is unmeasured (L8); the fallback path is tested.
7. **No i18n/RTL/locale pass** (L15).
8. **Major dependency migrations deferred** (express 5, mongoose 9, zod 4, react 19, eslint 10) —
   `RISK ACCEPTED FOR LOCAL DEVELOPMENT`, not advisories.
9. **No clinical, legal or production-readiness claim** of any kind.

---

## 9. Duck verdict

**`LOCAL PROJECT COMPLETE WITH DOCUMENTED LIMITATIONS`**

Justification: both blocking items were reproduced first and then closed with evidence. **L16** is
fixed at its cause (an implicit min-content grid column that clipped phone content behind
`overflow: hidden`) and is gated by 31 width tests that measure the real boxes, not document overflow.
**The combined E2E gate** now runs each topology against the API it belongs to, exits **0**, and along
the way exposed and fixed a seeded-document fixture that could be `ready` with no stored bytes.
Every definition-of-done item that can be executed locally was executed on the final commit: server
440/440, client 105/105, lint and build clean, 116 fake-topology journeys plus the provider-disabled
journey, axe 0 violations, layout gate 36/36, two secret scans clean, both audits 0, restore drill and
reconciliation clean, working tree clean after the commit.

The items that cannot be executed here — NVDA, VoiceOver, TalkBack, real Safari/Firefox, physical
devices, a real deployment — are marked `NOT RUN` with reasons rather than claimed. Nothing was
deployed, no provider was added, no secret was committed, and no test was weakened, deleted or
retried into green.
