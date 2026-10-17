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

*Append new entries below this line.*
