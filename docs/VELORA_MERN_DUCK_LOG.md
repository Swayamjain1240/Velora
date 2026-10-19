# Velora MERN Duck Log (editable)

Companion to the authoritative `VELORA_MERN_DUCK_LOG.pdf` (v2.0). This file holds appended review entries only; it never rewrites prior entries. Protocol, classification vocabulary and templates live in the PDF.

---

## Entry — 16 October 2026, complete functional QA pass

**DUCK REVIEW — 16 October 2026, Asia/Kolkata**
**Repository / branch / commit / dirty state:** `Swayamjain1240/Velora` · `test/complete-functional-qa` (from `main` @ `036c27a`) · working tree clean apart from this QA branch's own additions.
**Current part and VEL IDs:** post-implementation QA of Parts 1–10, VEL-001–VEL-021, Security-25.
**Verdict: DRIFT FIXED**

**Evidence inspected:** the three authority documents (text extracts), README, all Part 1–10 docs in `docs/`, CI workflow, dependencies/lockfile, environment examples, client and server configuration, the full server/client/e2e source and test tree.

**Requirement findings (summary):** all 21 VEL areas VERIFIED on this revision by observed runs (matrix in `FINAL_REQUIREMENT_TRACEABILITY.md`); the role/tenant matrix and route contract were additionally walked live against the running app (182 routes, 169 private ones all refusing anonymous callers).

**Security-25 findings:** 1–19, 21–22, 24–25 VERIFIED (local evidence); #18/19 via the CI security job plus local `npm audit` (0 production vulnerabilities); #23 PARTIAL (exploratory charter gaps listed in the QA report §5). No blanks.

**Corrections made:** (1) CI's "fails closed" step could never execute its journey (job env made it self-skip) — runner override added to `.github/workflows/ci.yml`; (2) `apiContract.test.js` baseline-reset gap in the QA suite itself; (3) access-matrix draft expectations rebuilt from requirement evidence. No product code required changes.

**Verification:** server 412/412 (`npm test -w server`), client 61/61 + lint + build, E2E 66/66 across verified runs (64 in the CI-topology run plus the two specially-configured journeys run exactly as documented), viewport 30/30 ×3, inventory 182 routes/48 models/0 unused deps, live startup/ready/headers/fail-closed probes — all on this branch's final tree.

**Failed, blocked or not-run checks:** real-provider journeys (none selected, by design), gitleaks (CI-only), GitHub Actions for this branch (local reproduction only), exploratory offline/two-tab themes (open charter). One unreproduced observation (OBS-001, transient login redirect in the first misconfigured E2E run) is logged in `FINAL_DEFECT_LOG.md`.

**External API disclosures:** none required — zero external providers are used; tests ran against fake/local adapters only.

**Documentation updated:** `FINAL_FUNCTIONAL_QA_REPORT.md`, `FINAL_TEST_MATRIX.md`, `FINAL_DEFECT_LOG.md`, `FINAL_REQUIREMENT_TRACEABILITY.md`, this log, README test-count sync.

**Unresolved decisions/risks:** deployment, provider selection, backups, clinical validation and the exploratory charter remain owner decisions; a green CI run on this branch is the remaining gate before merge.

**Next authorized action:** owner review of the QA branch and its five QA documents; merge after CI is green.

---

## Entry — 17 October 2026, complete non-functional QA pass

**DUCK REVIEW — 17 October 2026, Asia/Kolkata**
**Repository / branch / commit / dirty state:** `Swayamjain1240/Velora` · `test/non-functional-security-qa` (from functional-QA tip `4bc1001`) · working tree clean apart from this branch's own additions.
**Current part and VEL IDs:** post-implementation non-functional QA of Parts 1–10, VEL-001–VEL-021, Security-25.
**Verdict: DRIFT FIXED (three defects), residual risk recorded**

**Evidence inspected:** the authority documents, README, all `docs/` reports, CI workflow, dependencies/lockfile/`.env.example`, indexes, session architecture, provider adapters, storage, workers, logging, health/readiness and the backup/restore evidence — plus the source and test tree of every surface re-probed live.

**Requirement findings (summary):** all 21 VEL areas carry forward as VERIFIED on the functional branch; this pass re-verified the non-functional half live — security, privacy/tenant isolation, performance characterization, bounded load/stress/spike/soak, concurrency, recovery, supply chain, observability, configuration, AI and document safety, and the one-viewport rule.

**Security-25 findings:** #1–#19, #21–#22, #24–#25 VERIFIED with local evidence (40 live probes: 33 PASS, 6 NOTE, 1 BLOCKED, 0 FAIL); #18 via a current-tree plus 85-commit scan; #20 satisfied by three focused fix commits; #23 PARTIAL (penetration testing and real-provider journeys remain out of scope). #11 PARTIAL: API headers verified, the static client shell has no CSP at the hosting layer (owner item).

**Corrections made (three code defects fixed and retested):** NQ-1 a malformed/oversized body answered `500` (now `413`/`400`/`415`); NQ-2 authenticated JSON responses had no default `Cache-Control` (now `no-store, private` everywhere); NQ-3 parallel invitations for one email created 8 live tokens (now one active invitation, backed by a partial unique index plus a `dedupe-invitations.js` command for existing data). Two new regression suites were added (`httpHardening.test.js`, `invitationUniqueness.test.js`).

**Verification (this branch's final tree):** server **420/420** (`npm test -w server`, quiet run, exit 0) including the 8 new tests; client **61/61** + lint + build; browser journeys for accessibility + one-viewport **37/37** (6 sizes × 5 sessions); security probes **40 checks, 0 FAIL** (33 PASS, 6 NOTE, 1 BLOCKED); concurrency probes **6/6** (1 P3 note: TOTP window reuse); load/stress/spike/soak with **0 5xx** in every phase and stable RSS in a 60 s soak; restore drill **PASSED** (49 collections / 849 rows / 8 objects byte-identical / indexes identical); reconciliation found 8 orphan objects (QA-run residue), repaired with operator attribution, re-check clean; production dependency audit **0 vulnerabilities**.

**Failed, blocked or not-run checks:** no penetration test, no external scanner, no real provider, no production-like environment, no multi-hour soak, no cross-browser/device matrix, no 200 % zoom or screen-reader walkthrough, no live chaos on shared infrastructure, no clinical evaluation. One contention-induced test flake (`plans.test.js:798`) is logged as D-12 and cleared by an isolated re-run (24/24) and the quiet full run (420/420). A green GitHub Actions run on this branch is the remaining merge gate.

**External API disclosures:** none required — no provider is selected; the local fake extraction provider was used and performs no network I/O.

**Documentation updated:** the eight `FINAL_*` reports of this pass, `FINAL_DEFECT_LOG.md` (appended, functional entries preserved), README status/commands/tree, and this log.

**Unresolved decisions/risks:** deployment and TLS-edge verification, production database posture and backup cadence/RPO, hosting-layer CSP, provider selection plus clinical evaluation, TOTP single-use policy, dev-toolchain upgrade (6 advisories, semver-major), observability expansion, independence of the next security assessment. All are listed with owners in `FINAL_READINESS_REPORT.md`.

**Next authorized action:** owner review of this branch and its reports; run CI green on the branch; then decide the deployment, provider and clinical-evaluation items before any real-patient use.

---

## Entry — 17 October 2026, UI/UX redesign stage 1 (dark-purple system)

**DUCK REVIEW — 17 October 2026, Asia/Kolkata**
**Repository / branch / commit / dirty state:** `Swayamjain1240/Velora` · `feat/ui-redesign-dark-purple` (from `main` @ `036c27a`) · clean after the stage commit.
**Current part and VEL IDs:** presentation pass across Parts 1–10; VEL-017 (one-viewport) holds; Security-25 controls 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 21–25 unaffected.
**Status: ON TRACK — stage 1 of 7 delivered; no requirement drift.**

**Evidence inspected:** the three authority PDFs (text extracts), `README.md`, the full client source (39 feature components, 8,344 JSX lines), `client/src/styles.css` (439 lines, 9 tokens, light theme), the 12 Playwright specs, the 11 client test files, dependencies and lockfile, and the current bundle output. No animation, icon, chart or component library existed.

**Findings that drove the work:** no token layer or dark theme; a single wrapping header that became multi-row on phones; unstyled native controls; one flat card surface; status pills whose light backgrounds cannot survive a dark theme; no motion and no reduced-motion path; a scaffold-grade landing and sign-in.

**Corrections made (presentation only):**
1. New token layer (`client/src/styles/tokens.css`) and layered stylesheet (base/components/screens). White-on-`#8B5CF6` measures 4.22:1, so filled controls use `#7C3AED` (5.7:1) while the brighter accent stays decorative.
2. Rebuilt `AppShell` as a fixed sidebar shell with grouped, role-identical navigation, collapsible icon rail, contextual top bar and a mobile rail. Every role predicate and link is unchanged; Sign out remains visible at all six sizes.
3. Restyled all existing classes (buttons, fields, tables, tabs, pills, wizards, plans, today, threads, check-ins, documents) without renaming a class, id, label or test-id.
4. Added a password-visibility control to `Login` (`aria-pressed`, labelled), and a premium landing/auth surface.
5. Added the GSAP motion layer with `gsap.context()` cleanup, no animation above 450 ms, content never animated from zero opacity, a failsafe that forces visibility, and a reduced-motion path that skips animation entirely.
6. Restructured the Overview into a page header plus information cards so the dashboard is not a large empty panel.

**Two layout defects found and fixed by measurement:**
- `margin-inline:auto` on a flex item stopped the card stretching; a wide tab row expanded it to 759 px inside a 320 px viewport. Fixed with `width:100%; min-width:0` (also on `.panel-scroll`).
- The landing glow used a viewport-fixed pseudo-layer, producing a hard-edged band on a short page; moved onto the page.

**Verification (on this branch):** client 61/61 pass · lint clean · production build clean · `e2e/viewports.spec.js` + `e2e/accessibility.spec.js` 31/31 pass · six-size audit of 144 route/role combinations 0 failures (no vertical overflow, no horizontal page overflow, no clipping, Sign out visible) · reduced-motion probe shows opacity 1 with no inline style · `npm audit --omit=dev` 0 · GSAP 3.15.0 under its standard no-charge licence.

**Failed, blocked or not-run checks:** server suite not run (no server change); other browser journeys not re-run this stage; axe/Lighthouse, screen reader, 200 % zoom, Firefox/Safari and visual regression NOT RUN. The dev-only global limiter (300 req/min) produced login redirects under rapid browser testing; logged as OBS-002 and deliberately not changed, because the redesign must not alter auth semantics.

**External API disclosures:** none added. No new network origin; no web font; GSAP bundles locally.

**Documentation updated:** `docs/UI_REDESIGN_DUCK_REVIEW.md`, `docs/UI_DESIGN_SYSTEM.md`, this log, `README.md`.

**Unresolved decisions/risks:** stages 2–7 (shared dialogs/drawers/toasts/skeletons/charts, structural screen pass, mobile table→card presentation, optional Three.js accent, full QA) remain. Bundle grows 30.9 kB gzip from GSAP; code-splitting is the documented remedy if that must shrink.

**Next authorized action:** owner review of stage 1, then stage 2 (shared controls) on the same branch.

---

## Entry — 18 October 2026, UI stage 1 closure and the Recovery Network (three.js)

**DUCK REVIEW — 18 October 2026, Asia/Kolkata**
**Repository / branch / commit / dirty state:** `Swayamjain1240/Velora` · `feat/ui-redesign-dark-purple` (tip `758906b` plus this change) · working tree carries the stage-1 documentation set, the 3D hero and its QA scripts.
**Current part and VEL IDs:** presentation pass across Parts 1–10; VEL-017 (one viewport) re-verified; Security-25 controls 1, 2, 3, 5, 7, 11, 16, 18, 21–25 unaffected.
**Verdict: READY WITH DOCUMENTED LIMITATIONS (stage 1 + 3D hero). The redesign is not complete.**

**Evidence inspected:** the three authority documents, README, the whole client tree (42 JSX files, 9,020 lines; 5 stylesheets, 2,481 lines), `client/package.json` and the lockfile, the four stage-1 documentation files already committed, the 13 client test files, the 11 Playwright specs, and the production build output.

**What was delivered since the last entry:**
1. A session-status fix: a failed status check (network, 429, 5xx) no longer sends a signed-in user to the login form; `Protected` renders a retry state and only 401/403 signs out. Two regression tests.
2. Phone presentation for the patient and episode lists (cards below 720 px, tables above), with every id, label and test id preserved.
3. The **Recovery Network**: a lazy three.js hero on `/`, with a seeded care core, three tilted orbits of instanced nodes, ring pathways, sparse cross-orbit links, six spokes, signals travelling along real edges, GSAP-coordinated entrance, pointer parallax, hover proximity, mobile/tablet/desktop tiers, DPR caps, tab and viewport pausing, context-loss fallback and a static gradient when WebGL is unavailable. It does not mount on any authenticated screen.
4. Hero copy entrance on the same clock as the scene, and a 260 ms exit fade into the application that is backed by a 420 ms navigation timer (a decorative fade can never block sign-in).
5. Short-viewport auth fix: `@media (max-height: 620px)` top-aligns and compresses the panel. Before the fix the submit button sat below the fold at 844×390 and 320×400.
6. The full stage-1 documentation set: route/screen inventory, component inventory, animation guidelines, accessibility checklist, responsive matrix, visual regression report with 14 committed captures, stage-1 QA report and known-limitations list.

**Dependency decision (recorded, not inferred):** `three@0.186.1` (MIT) and `@react-three/fiber@8.18.0` (MIT) were installed after checking React 18 compatibility (`peerDependencies react >=18 <19`), maintenance, licences, `npm audit --omit=dev` (0 vulnerabilities) and bundle impact (separate 888.75 kB / 238.83 kB gzip chunk; initial bundle +7.68 kB / +2.25 kB gzip). `@react-three/drei` was deliberately **not** installed: nothing from it is used, and its transitive weight would buy helpers this code implements in ~30 lines. GSAP 3.15 was already present. No overlapping animation or 3D library exists.

**Corrections made:** UI-03 (auth panel overflow on short viewports) and UI-04 (landscape phone received the tablet scene tier). Both found by measurement, fixed, and re-measured.

**Verification (this tree, seeded synthetic stack: Mongo replica set 27019, API 4100, Vite 5173):** client **70/70** tests (13 files) · lint clean · production build clean (CSS 40.27 kB / 8.13 kB gzip, JS 456.43 kB / 134.55 kB gzip, scene 888.75 kB / 238.83 kB gzip) · browser journeys **35/35** (viewports 30, accessibility 1, auth 4) · six-size audit **144 route checks, 0 failures** · 3D hero suite **18 checks, 0 failures** (scene paints 4.07 % of the page, tier and DPR cap at all six sizes, WebGL absent, context loss, lazy chunk absent on `/login`, six remounts with one canvas and a flat post-GC heap, reduced motion 0.00 % pixel drift, parallax 1.0 %, orientation resize, keyboard focus, foreground navigation in 366–435 ms) · production dependency audit **0**.

**Failed, blocked or not-run checks:** Firefox/Safari, screen reader, 200 % zoom, axe/Lighthouse, real mobile/tablet hardware, GPU profiling and a CI pixel-diff gate are NOT RUN (no tooling or devices here). The 3D chunk is 238.83 kB gzip, above the ≤60 kB gate the stage-1 document set for a hero decoration; that is recorded as a limitation, not justified away. The frame-pacing figure (60.4 fps at 390×844 under 4× CPU throttle, SwiftShader) is a NOTE, not a device measurement.

**External API disclosures:** none. No new network origin, no web font, no provider; the scene is generated locally and fetches nothing.

**Documentation updated:** `README.md`, `UI_DESIGN_SYSTEM.md`, `UI_REDESIGN_DUCK_REVIEW.md` (stage table), the seven new UI documents, `UI_3D_RECOVERY_NETWORK.md`, and this log.

**Unresolved decisions/risks:** stages 2–5 and 7 remain; the 3D chunk size is a product decision (accept, or drop R3F for raw three.js); real-device performance and cross-browser parity are unproven; the visual baseline has no CI gate; L1–L15 in `UI_KNOWN_LIMITATIONS.md` carry owners and severities.

**Next authorized action:** owner review of stage 1 and the 3D hero; then stage 2 (shared controls) or a device-lab measurement of the scene, whichever the owner prioritises.

---

*Append new entries below this line.*

## 18 October 2026 — completion pass (defects, security depth, accessibility, bundle)

**Scope:** every open defect-log item and the UI limitations that had a concrete
check attached, plus the dev-toolchain advisories.

**Backend**
1. **D-4 TOTP replay** — the accepted counter step is claimed atomically on the
   user, so one code authenticates one session. Enrollment confirmation does not
   consume the step, so the first sign-in still accepts the code just typed.
2. **D-8 Origin/Referer allowlist** — a second CSRF layer on cookie-authenticated
   mutations rejects a foreign origin with `403` before validation runs.
3. **D-6 runtime metrics** — `/api/metrics` now returns process, event-loop, Mongo
   pool and bounded per-route latency gauges keyed by route pattern; no identifier
   can appear in the payload.
4. **D-12** — the concurrent-approval test asserts the invariant instead of a race
   outcome. The "GET /api/plans returned 0 items" observation does not reproduce.

**Client**
5. **L7 hero chunk** — `three` and `@react-three/fiber` removed; the scene is
   hand-written WebGL (7 draw calls, no per-frame allocation). Chunk **4.99 kB
   gzip** (was 238.83), well under the ≤60 kB gate.
6. **L3 tables** — one shared `ResponsiveTable` labels each cell from the rendered
   `<thead>` and keeps explicit ARIA roles; all 26 tables across 18 feature
   screens stack into cards below 720 px.
7. **L9/L12** — zero auth-page scroll at 844×390 and 320×400; forced-colours and
   high-contrast treatments added.
8. **L2 trend** — `Skeleton` and `MiniBars` primitives adopted in the metrics panels.
9. **D-7 CSP** — strict policy injected into the built shell; the inline
   module-preload polyfill is disabled so `script-src 'self'` needs no exception.

**Toolchain** — Vite 8.3.4, Vitest 5.0.5, plugin-react 6.1.2, jsdom 30.1.3;
`npm audit` 0 vulnerabilities (was 6, including two critical). CI runs Node 22.

**Verification (this tree, seeded synthetic stack):** server **424/424** ·
client **77/77** · lint clean · build clean (initial 464.11 kB / 132.60 kB gzip,
scene 13.11 kB / 4.99 kB gzip) · browser journeys **76 passed + 1 opt-in skip**,
plus the provider-disabled journey run separately against
`EXTRACTION_PROVIDER=none` · axe WCAG 2.1 A/AA **0 violations across 15 screens** ·
200 %/400 % reflow passing · phone table stacking and desktop table parity passing ·
forced-colours checks passing · six-size audit **144 route checks, 0 failures** ·
3D hero suite **18/18** · layout snapshot **36/36 surfaces match** · documentation
links **107 checked, 0 broken** · `npm audit` **0**.

**Still not run or not done:** Firefox/WebKit, NVDA/VoiceOver, real mobile/tablet
hardware, GPU profiling, the full stage-3 structural pass (dialogs/toasts/tooltips),
i18n, production MongoDB auth/TLS drill and SHA-pinned CI actions. Each is recorded
with an owner in `UI_KNOWN_LIMITATIONS.md` and `FINAL_DEFECT_LOG.md`.

**Production preview check:** built shell served by `vite preview` — the CSP meta
is present, the page contains **no inline script**, the scene paints, and zero CSP
violations were logged. (The preview server has no API proxy, so its API calls
return 502 in that isolated check; that is expected, not a defect.)

---

## 19 October 2026 — UI stage 2 (overlay primitives), cross-browser closure, CI pinning

**Scope:** the stage-2 shared overlay primitives, the open hardening item D-9, and
the cross-browser gap L6 — verified on Chromium, Firefox and WebKit.

**Client**
1. `Dialog`, `Toast`, `Tooltip` (`client/src/components/`) with overlay styles on
   the reserved z-index tokens. `Dialog` is an `alertdialog` that traps and
   restores focus and always exits on Escape; `Toast` is a bounded polite live
   region that never hides a message on a timer under reduced motion; `Tooltip`
   only ever *describes* its control. Adopted by Profile's "Sign out everywhere",
   which previously fired immediately.
2. `ScrollRegion` — a named, focusable scroll box. Found by the Firefox axe run:
   Profile's session table can overflow a `.panel-scroll` that no keyboard could
   scroll (`scrollable-region-focusable`, WCAG 2.1.1). Adopted on Profile, Audit
   and Metrics — the audited regions whose content is pure text; regions whose
   rows carry controls already satisfy the rule, so they were not changed.
3. Client tests **77 → 98** (overlays 17, scroll-region 4).

**CI (D-9)** — every `uses:` in `.github/workflows/ci.yml` is pinned to a full
commit SHA with a version comment; a moving tag can no longer change a build.

**Cross-browser (L6)** — Firefox and WebKit are installed and each engine runs the
whole suite as its **own** invocation against the documented topology (API
`NODE_ENV=test` on `:4100`, `EXTRACTION_PROVIDER=fake`): Chromium **76 passed +
2 by-design skips**, Firefox **76 + 2**, WebKit **75 + 3**, **0 failures** on all
three, axe **0 violations** on all three, and 200 %/400 % reflow passing on all
three.

**Findings — and what each one actually was:**
1. **Firefox axe `scrollable-region-focusable`** → a real keyboard defect → fixed
   with `ScrollRegion` (above).
2. **Firefox extractions "Needs review" missing** → not a defect. The stack ran
   the shipped `EXTRACTION_PROVIDER=none`, while that journey documents the
   `fake` provider; re-run against the documented topology it passes in 37 s.
3. **Three "Velora is temporarily unreachable" failures** in the first full run →
   the dev-only 300 req/min limiter, not the session layer. Measured: 320
   concurrent `/api/auth/status` requests returned **87 × 429 in 597 ms**, and the
   client renders 429 as its designed retry state. The same suite in the CI
   topology: 0 failures. L14 updated with the measurement; OBS-001 annotated (its
   login-bounce symptom follows the 401/403 path and stays OPEN).
4. **WebKit keyboard journey** → proved engine-level, not product-level. On a
   four-element control page Chromium and Firefox walk `<a> <a> <button> <a>`;
   WebKit lands only on the `<button>` and on elements with an explicit
   `tabindex`. Velora's anchor has the same DOM, styles and `tabIndex=0` in all
   three engines and `.focus()` moves focus to it, so the check is **unrunnable**
   there: skipped for `webkit`+Windows with the proof written into the test, and
   still hard-failing on the other engines.
5. **Three engines in one invocation is invalid** — `globalSetup` seeds once, so
   later engines meet a fixture the first one consumed (symptoms: an
   already-enrolled MFA account, an already-created plan version). Engines run as
   separate invocations; this is now stated in the README and the Playwright
   config.

**Verification (this tree):** server **424/424** · client **98/98** · ESLint clean
· production build clean (CSS 46.83 kB / 9.35 kB gzip, JS 466.52 kB / 133.30 kB
gzip, scene 13.11 kB / 4.99 kB gzip) · journeys **78 per engine, 0 failures** ·
axe **0/0/0** · `qa/layout-snapshot.js` **36/36** · `qa/viewport-audit.js` **144
checks, 0 failures** · `qa/hero-browser-test.js` **18/18** · provider fail-closed
journey **passed** under `EXTRACTION_PROVIDER=none` · `npm audit` **0** · docs
**98 local links + 6 external URLs, 0 broken**.

**Failed, blocked or not-run checks:** no real Safari (the WebKit keyboard gap
needs a real browser to settle), no NVDA/VoiceOver walkthrough, no physical
device, no Lighthouse, no i18n. CI still installs and runs Chromium only — matrix
legs are an owner decision (runtime and runner minutes ×3, and GitHub Actions
cannot be executed from this machine). Production MongoDB TLS, the stage-3
structural pass and the visual pixel gate remain as previously recorded.

**Documentation updated:** `README.md` (status, counts, cross-browser instructions
and the one-invocation caveat), `UI_KNOWN_LIMITATIONS.md` (L2, L6, L14, D-9),
`UI_REDESIGN_DUCK_REVIEW.md` (stage table), `UI_ACCESSIBILITY_CHECKLIST.md`,
`UI_DESIGN_SYSTEM.md`, `UI_RESPONSIVE_MATRIX.md`, `FINAL_DEFECT_LOG.md`
(OBS-001 annotation), and this log.

**Next authorized action:** owner review of this pass, then the stage-3 structural
pass or a real-Safari/AT sweep, whichever the owner prioritises.

---

## DUCK REVIEW — 19 October 2026, Asia/Kolkata

**Repository / branch / commit / dirty state:** `Swayamjain1240/Velora` ·
`feat/ui-redesign-dark-purple` · `287f78d` · clean, pushed (`origin` = same SHA).
**Current part and VEL IDs:** post-Part-10 · UI stage 2 + cross-browser closure ·
VEL-001–VEL-021 · Security-25 1–25.
**Verdict: ACTION REQUIRED** — one repository gate has never been met.

### Evidence inspected

The three authority documents (Master v2.0, Architecture v2.0, Duck Log v2.0 text
extracts), README, `.gitignore`, `server/src/app.js` middleware order,
`server/src/config/env.js`, provider defaults, the client component/test tree,
`.github/workflows/ci.yml`, the GitHub Actions API (runs, jobs, annotations — logs
need auth), `FINAL_REQUIREMENT_TRACEABILITY.md`, `FINAL_SECURITY_AUDIT.md`, and this
pass's own test output on this revision.

### Requirement findings

All **21 VEL areas remain VERIFIED**, carried from the traceability matrix and
re-exercised on this revision by the full suites (server 424/424, client 99/99,
browser 78 per engine). No VEL was downgraded. Nothing contradicted a requirement:
no clinical-invariant change, no approval-path change, no tenant-boundary change.

### Security-25 findings

**23 PASSED · 2 PARTIAL · 0 FAILED · 0 BLANK**, re-checked from code on this
revision: no `.env`/key file is tracked; `.gitignore` covers `.env*`, uploads,
backups, logs, coverage, `dist` and `e2e/.auth`; cookie sessions with no token in
`localStorage`; `loadSession → originProtection → csrfProtection` before every
`/api` router; the coarse limiter is skipped only under `NODE_ENV=test` and was
measured at 300 req/min; provider defaults stay fail-closed (`none` / `in_app`).
- **#11 PARTIAL** — API carries CSP/`nosniff`; the static client shell has no CSP
  at a hosting layer (no host exists yet).
- **#16 PARTIAL** — production Mongo credentials/TLS/network boundary remain
  deployment decisions; the test URI is loopback without credentials.

### Corrections made

The Duck review found CI **red, and never green** (see below). The failing client
job was a machine-dependent assertion, not a product defect: the hero lowers its
quality tier when `navigator.hardwareConcurrency <= 4`, and GitHub's runners report
2–4 cores, so a 1440 px viewport produced `data-tier="tablet"` while the test
expected `desktop`. **Fixed in `287f78d`** by pinning both capability inputs and
adding a second test for the documented low-power downshift (previously untested).
The assertion was strengthened, not relaxed.

### Verification (this revision)

`npm test -w server` → **424/424** · `npm test -w client` → **99/99** (was 98; +1
new) · `npm run lint -w client` → clean · `npm run build -w client` → clean ·
browser journeys per engine → Chromium **76+2**, Firefox **76+2**, WebKit **75+3**,
0 failures · axe 0 violations on all three · `qa/layout-snapshot.js` 36/36 ·
`qa/viewport-audit.js` 144/0 · `qa/hero-browser-test.js` 18/18 · provider
fail-closed journey pass · `npm audit` 0 · docs 99 local + 6 external links, 0 broken.

### Failed, blocked or not-run checks — the ACTION REQUIRED item

- **CI has never passed.** The GitHub Actions API shows **13 runs, all on `main`,
  all `failure`** (oldest 11 Oct failed in *Server tests*; newest, on `1098815`,
  failed in *Client tests → Unit tests* at `hero-visual.test.jsx:80`). The workflow
  triggers only on `push: main` and `pull_request`, so **pushing this branch
  produced no run at all** — the fix in `287f78d` has no CI evidence yet.
- The oldest server-test failure predates several fixes and was not re-triaged
  here; the current server suite passes locally (424/424). It needs a CI run to be
  settled.
- Not run: real Safari, NVDA/VoiceOver, physical devices, Lighthouse, production
  Mongo TLS drill, GitHub Actions logs (annotation-level access only).

### External API disclosures

None. No provider was selected or contacted; the fake extraction provider is local
and performs no network I/O.

### Documentation updated

This entry. The pass's earlier documentation updates (README, register, living UI
docs, accessibility/stage-1 addenda) are recorded in the entry above.

### Unresolved decisions/risks

CI green on this revision (blocking the merge gate); UI stages 3–5; deployment and
hosting-layer CSP; provider selection; scheduled backups/RPO; clinical validation
and privacy sign-off; real-Safari/AT/device verification.

**Next authorized action:** open a pull request from `feat/ui-redesign-dark-purple`
to `main` so CI runs on this revision (owner authorization required), then merge
only on green.

### Session entry — 19 October 2026

Date/time and timezone: 19 October 2026, Asia/Kolkata.
User request and authorization: "first duck" — run the Duck review before further
work; a prior instruction authorized pushing to GitHub.
Repository/branch/commit/working tree: `Swayamjain1240/Velora`,
`feat/ui-redesign-dark-purple`, `287f78d` pushed, clean.
Part, milestone and VEL IDs: post-Part-10 · UI stage 2 · VEL-001–021 · Security-25.
Files/evidence inspected: listed under *Evidence inspected* above.
Changes and commits: `287f78d` (hero test determinism + low-power coverage).
Tests and exact outcomes: server 424/424 (exit 0); client 99/99 (exit 0); lint
clean (exit 0); build clean (exit 0); journeys 78/engine, 0 failures; layout 36/36;
viewport 144/0; hero 18/18; audit 0; links 0 broken.
Security/dependency/secret findings: no tracked secrets; 23 PASSED, 2 PARTIAL
(#11 hosting CSP, #16 production TLS); no dependency finding.
Duck verdict: **ACTION REQUIRED**.
Open decisions/blockers: CI has never been green; no run can occur on this branch
without a PR; deployment, providers, backups and clinical/privacy approvals open.
Next concrete action: open the PR (owner authorization) and merge only on green.

---

## Entry — 19 October 2026, Phase A (CI gate, scheduled backups) adversarial review

**DUCK REVIEW — 19 October 2026, Asia/Kolkata**
**Repository / branch / commit / dirty state:** `Swayamjain1240/Velora` · `feat/ui-redesign-dark-purple` (reviewed at `9ae54bf`; fixes below are the working tree on top of it) · clean before this pass.
**Current part and VEL IDs:** Phase A gates; VEL-016 (recovery), VEL-017 (one viewport), Security-25 #7 (data at rest), #9 (no secret in logs), #16 (database posture), #21–22 (provider boundary).
**Verdict: DRIFT FIXED (four defects in the new backup code); one trust boundary recorded**

**Evidence inspected:** the new `backupService`, both CLI commands, the `BackupRun` model, env schema, the backup tests (13 at review start, 16 after the fixes), the Phase A page, runbook §6–7, the CI workflow diff, and the two CI runs on `b51422d` / `9ae54bf`. Claims were re-tested against a live replica set with a throwaway probe rather than against the tests that assert them.

**What held:** CI is green twice on clean machines (all four jobs, `39237665971` and `39239170957`). Server 437/437, client 99/99, lint, build, layout gate and secret scan all pass there. Encryption-at-rest, key-fingerprint refusal, app-database refusal and object-byte fidelity were confirmed independently of the suite.

**Defects found and fixed:**

1. **The ordering claim was false under concurrent writes.** "Objects before rows" cannot stop a row committed *during* the read window from referencing an object written after the object copy. Fixed with a post-row **sweep** that copies every object referenced by `episodedocuments`, then re-derives the object digest from disk. `objects.swept` and `objects.missingReferenced` make the outcome explicit. Test: `the sweep copies an object referenced by a row written after the object pass`.
2. **A tampered manifest verified as PASSED.** The probe dropped a collection entry and replaced index definitions; `verifySet` still returned true, because it only checked the files the manifest still listed. Fixed with a manifest self-digest, a strict "manifest lists exactly the collection files present" check, a `complete` status check, and a restore that now refuses `RESTORE_SET_TAMPERED`. Tests: `a tampered manifest is caught by verification`.
3. **Row-less collections vanished on restore while the command reported success.** Collections were only created by inserting rows or indexes, and the check compared per-collection counts from the manifest, never the collection set. Fixed by creating the collection set first and comparing it; `collectionMismatches` is part of `ok`. Test: the empty collection now comes back (and `collectionMismatches === 0`).
4. **Retention could evict a good set because the newest one was bad.** The CLI pruned after verification but regardless of its result, and the new set was already marked `complete`. Fixed: a failed set is rewritten as `failed`, retention skips it, and pruning only runs when verification passed. Tests: `a failed set is never restored and never pruned as a recovery point`.

**Observation, not a defect:** the development dataset reports **47 referenced objects already missing at the source** (`objects.missingReferenced`). That is pre-existing metadata drift of the class reconciliation reports; the backup correctly counts it instead of inventing bytes. Recorded in the runbook.

**Trust boundary recorded:** the manifest is plaintext and its digest is not a signature. An operator with write access to the destination can rewrite both, and no index definition is checked against an external authority. The runbook now states that the destination must be access-controlled and immutable (owner decision), and that reconciliation follows any restore.

**Verification after the fixes:** server **440/440** (`npm test -w server`, exit 0) including 16 backup checks (9 unit + 7 integration); a real create → verify → restore on the development database **PASSED** (8,501 documents, 49 collections, 277 objects; create+verify 1,829 ms, restore 11,995 ms, 0 mismatches); the probe that found defects 2 and 3 now reports `RESTORE_SET_TAMPERED` and a recreated row-less collection. Client untouched since its 99/99 run.

**Failed, blocked or not-run checks:** CI on this revision (pushed after this entry; the previous two runs are green); deployment, provider selection and clinical/privacy sign-off remain blocked on owner decisions; NVDA/VoiceOver, real Safari and physical devices unchanged.

**Documentation updated:** runbook §6.1/§7.3 (ordering, manifest trust, measured figures), `PHASE_A_GATES.md`, this log.

**Next authorized action:** push this fix set, confirm CI green on the new revision, then owner review of PR #1.
