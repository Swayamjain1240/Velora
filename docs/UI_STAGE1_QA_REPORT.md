# Velora UI — stage 1 QA report and readiness

**Branch:** `feat/ui-redesign-dark-purple`
**Date:** 18 October 2026
**Scope:** the dark-purple redesign of the shell, authentication surfaces, landing
page and motion layer, plus the Recovery Network 3D hero.
**Verdict: READY WITH DOCUMENTED LIMITATIONS.** The delivered surfaces pass every
automated check that can run in this environment. The redesign as a whole is **not
complete**: stages 2–5 and 7 of `UI_REDESIGN_DUCK_REVIEW.md` remain.

---

## 1. What was checked, and on what

Everything below ran against this working tree, not an earlier commit. The stack
was the documented local topology: MongoDB single-node replica set on 27019, API
on 4100 (`NODE_ENV=test`, seeded synthetic clinic), Vite on 5173.

| Check | Command | Result |
| --- | --- | --- |
| Client unit/component tests | `npm test -w client` | **70/70 passed**, 13 files |
| Lint | `npm run lint -w client` | **clean** |
| Production build | `npm run build -w client` | **built**, 3 assets |
| Dependency audit (production tree) | `npm audit --omit=dev` (client) | **0 vulnerabilities** |
| Browser: a11y + six-size viewport + auth journeys | `npx playwright test e2e/accessibility.spec.js e2e/viewports.spec.js e2e/auth.spec.js` | **35/35 passed** |
| Six-size route audit, five sessions | `node qa/viewport-audit.js` | **144 checks, 0 failures** |
| 3D hero browser suite | `node qa/hero-browser-test.js` | **18 checks, 0 failures** |
| Visual capture and measurements | `node qa/ui-visual-capture.js` | 14 images + `measurements.json` |

Reproduction requires the seeded stack; the commands are the same ones CI uses
(`.github/workflows/ci.yml`) plus the two `qa/` scripts added here.

## 2. Requirement coverage for this stage

| Requirement | Evidence | Result |
| --- | --- | --- |
| Dark-purple design system with accessible contrast | token table in `UI_DESIGN_SYSTEM.md`; filled controls use 5.7:1 `#7C3AED` | PASSED |
| Fixed shell, one viewport, no document scroll | 144-route audit; 30 viewport tests | PASSED |
| Role-based navigation unchanged | `AppShell` predicates identical; auth journeys | PASSED |
| Sign-in remains immediately usable | 4 auth journeys; login measured at six sizes | PASSED |
| Motion layer with reduced-motion path | `motion.js`; e2e reduced-motion probe; unit tests | PASSED |
| Landing hero with a meaningful 3D scene | `UI_3D_RECOVERY_NETWORK.md`; 18 browser checks | PASSED |
| Static fallback when WebGL is unavailable | browser check with WebGL disabled | PASSED |
| No patient data or medical content in the scene | code review: no API, no text, seeded geometry only | PASSED |
| Memory cleanup across route changes | 6 remounts: one canvas, flat heap after GC | PASSED |
| Bundle and dependency impact documented | `UI_DESIGN_SYSTEM.md` §10–12, `UI_3D_RECOVERY_NETWORK.md` §12 | PASSED |
| Automated and manual test record | this report; three 3D QA scripts | PASSED |
| DUCK log entry | `VELORA_MERN_DUCK_LOG.md`, entries for stage 1 and the hero | PASSED |
| Cross-browser, screen reader, 200 % zoom, axe, Lighthouse | not available in this environment | NOT RUN |

## 3. Defects found and fixed

| ID | Defect | Found by | Fix | Retest |
| --- | --- | --- | --- | --- |
| UI-01 | A signed-in user was sent back to the login form whenever the status check failed for a non-auth reason (network, 429, 5xx) | earlier stage review, reproduced under the dev limiter | `AuthContext` distinguishes 401/403 from unavailable; `Protected` renders a retry panel | `auth-unavailable.test.jsx` (2 tests), PASS |
| UI-02 | Patient and episode lists compressed desktop tables into a 320 px phone | six-size audit | cards below 720 px, table above; same ids, labels and test ids | unit suites + 144-route audit, PASS |
| UI-03 | On 844×390 and 320×400 the login submit button sat below the fold (panel page 559 / 507 px) | this stage's six-size visual capture | `@media (max-height: 620px)` top-aligns and compresses the panel | capture: submit visible at both sizes; panel scrolls 37 / 31 px |
| UI-04 | A landscape phone (844 px wide) received the tablet 3D tier | review against the mobile requirement | short viewports (`max-height: 480px`) force the mobile tier | browser suite asserts tier per size, PASS |

No defect was fixed by weakening an assertion. UI-03 is covered by a measurement,
not a screenshot alone; UI-04 is asserted through `data-tier`, which exists only
for QA.

## 4. Safety and privacy review of this change

- No API call was added by the redesign. `lib/api.js` is untouched.
- No token, session value or patient field is written to storage, logs, DOM
  attributes or the 3D scene.
- The scene is generated from a fixed seed; it consumes no data and renders no text.
- Every new user-facing string is a product claim already present in the reviewed
  copy, or a generic status.
- Admin-only screens keep their controls and confirmations; no destructive action
  gained a shortcut.
- The landing copy still states the four safety boundaries verbatim.

## 5. Performance summary

| Asset | Size | Gzip | Load |
| --- | --- | --- | --- |
| `index-*.js` | 456.43 kB | 134.55 kB | initial |
| `index-*.css` | 40.27 kB | 8.13 kB | initial |
| `RecoveryNetwork-*.js` | 888.75 kB | 238.83 kB | lazy, landing page only, after first paint |

The 3D chunk is 238.83 kB gzip and never reaches `/login` or the application
(verified by request capture). It is larger than the early ≤60 kB gate for a hero
decoration; the trade-off and the alternative (raw three.js without R3F) are
recorded in `UI_3D_RECOVERY_NETWORK.md` §14.

Scene cost at runtime: six draw calls, 15–36 nodes, 5–18 signals, no textures, no
post-processing, DPR capped at 1.25/1.5/1.75, loop paused when hidden or
off-screen. Frame pacing under a 4× CPU throttle at 390×844 was 60.4 fps with a
16.8 ms p95 frame in SwiftShader — reported as an indicative NOTE, not a device
claim.

## 6. Not run, and why

| Check | Why | Consequence |
| --- | --- | --- |
| Firefox, Safari | not installed here | rendering parity unproven |
| Screen reader walkthrough | no NVDA/VoiceOver in this environment | semantics reviewed in code only |
| axe / Lighthouse | no dependency installed; adding one is a separate decision | no automated contrast/a11y score |
| 200 % zoom, text-only resize | not measured this stage | overflow risk at extreme zoom remains |
| Real mobile/tablet hardware | no devices attached | tiers are reasoned, not profiled |
| GPU profiling | no GPU profiler available | no draw-call/GPU-time counter, only static count |
| Visual pixel-diff gate in CI | no baseline diff job yet | regressions are caught by measurement, not pixels |

## 7. Readiness statement

Stage 1 and the 3D hero are **ready for owner review** with the limitations in
`UI_KNOWN_LIMITATIONS.md`. They are **not** a claim that the redesign is finished:

- stages 2 (shared controls), 3 (screen structure), 4 (charts), 5 (mobile
  workflows) and 7 (full QA) are outstanding;
- the authenticated screens use the new tokens and shell but keep their previous
  internal layout;
- the accessibility, browser and device gaps above remain open with named owners.

No merge, deploy or production change is implied by this report.

## 8. After this report — 19 October 2026

The stage-2 and cross-browser pass closed several rows in §6 without editing this
record: the shared overlay primitives (`Dialog`, `Toast`, `Tooltip`) and
`ScrollRegion` shipped with 21 unit checks; axe (WCAG 2.1 A/AA) reports **0
violations across 15 screens** on Chromium, Firefox and WebKit; **200 %/400 %**
zoom reflow passes on all three; and the full journey suite is green on all three
engines (Chromium **76 + 2 by-design skips**, Firefox **76 + 2**, WebKit
**75 + 3**, 0 failures). Still open and unchanged: the screen-reader walkthrough,
real devices, GPU profiling, i18n, a pixel-diff gate and CI matrix legs for
Firefox/WebKit. Current state lives in `UI_KNOWN_LIMITATIONS.md`; the pass itself
is recorded in `VELORA_MERN_DUCK_LOG.md`.
