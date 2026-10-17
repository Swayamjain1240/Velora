# Velora — Final Non-Functional QA Report

**Branch:** `test/non-functional-security-qa` (created from the functional-QA branch; all existing work preserved)
**Repository:** https://github.com/Swayamjain1240/Velora
**Pass owner:** non-functional QA (security · performance · reliability · accessibility reviewer)
**Environment:** **isolated non-production only** — API `NODE_ENV=test` on `127.0.0.1:4101`, disposable single-node MongoDB replica set `velora_test` on `127.0.0.1:27019`, seeded synthetic identities (`*.synthetic.invalid`), fixture clinic B in the same disposable DB, `EXTRACTION_PROVIDER=fake` (local, no network). Browser journeys ran against a second isolated DB (`velora_e2e`). **No production system, real patient data or live provider was ever contacted.**
**Date:** 2026-10-17

Companion reports: [FINAL_SECURITY_AUDIT.md](FINAL_SECURITY_AUDIT.md) · [FINAL_PERFORMANCE_REPORT.md](FINAL_PERFORMANCE_REPORT.md) · [FINAL_ACCESSIBILITY_REPORT.md](FINAL_ACCESSIBILITY_REPORT.md) · [FINAL_RECOVERY_REPORT.md](FINAL_RECOVERY_REPORT.md) · [FINAL_THREAT_MODEL.md](FINAL_THREAT_MODEL.md) · [FINAL_DEFECT_LOG.md](FINAL_DEFECT_LOG.md) · [FINAL_READINESS_REPORT.md](FINAL_READINESS_REPORT.md) · [VELORA_MERN_DUCK_LOG.md](VELORA_MERN_DUCK_LOG.md)

---

## 1. Area verdicts

| Area | Verdict | Evidence |
| --- | --- | --- |
| Security | **PASSED** (3 defects fixed, 8 open items with owners) | 39 live probes, 0 FAIL · [security audit](FINAL_SECURITY_AUDIT.md) |
| Privacy | **PASSED** | tenant isolation probes, no-store default, redacted logs/audit, export TTL asserted by suite |
| Performance | **CHARACTERIZED — production acceptance BLOCKED** (no approved SLO) | 14 measured operations · [performance report](FINAL_PERFORMANCE_REPORT.md) |
| Load | **PASSED (bounded)** | C=5 20 s: 2 124 req, 105.97 rps, 0 5xx |
| Stress | **PASSED (bounded)** | C=1→40 ramp, graceful latency growth, 0 5xx, throughput plateau ≈110–117 rps |
| Spike | **PASSED (bounded)** | 40-way read burst, 20-way login storm, 0 5xx |
| Soak | **PASSED (bounded, 60 s)** | 6 700 req, RSS +3.3 MB, health RTT p95 19 ms (multi-hour soak NOT RUN) |
| Scalability | **PARTIAL / NOT RUN** | single process + single Mongo node; no horizontal or cluster test |
| Concurrency | **PASSED** (1 defect fixed) | 6 live race probes + transactional workflow races in the suite |
| Reliability | **PASSED** | dependency-outage behaviour, bounded retries and fail-closed paths asserted by suite; no 5xx under load |
| Resilience | **PASSED (suite-level) + PARTIAL (live)** | failure injection for Mongo/storage/parser/provider covered by the integration suite; live-only outage drill limited (see §6) |
| Availability | **PARTIAL** | `/api/health` (liveness) and `/api/readiness` answer without the limiter; no multi-instance/LB availability test was possible locally |
| Recovery | **PASSED (drill)** | [recovery report](FINAL_RECOVERY_REPORT.md) — backup/restore drill + reconciliation dry run on synthetic data |
| Accessibility | **PASSED (automated)** | axe-core journeys + one-viewport checks — [accessibility report](FINAL_ACCESSIBILITY_REPORT.md) |
| Compatibility | **PARTIAL** | Chromium only (single browser available); no Safari/Firefox/mobile device matrix; API is plain JSON over HTTP |
| Usability | **PASSED (previous pass)** | the functional QA pass walked every screen and role; this pass re-verified the one-viewport rule |
| Maintainability | **PASSED** | `npm test` (server+client), client lint, production build, `node --check` on every new script |
| Observability | **PARTIAL** | structured logs with request ids and safe errors; metrics surface lacks memory/event-loop/pool/queue/per-route histograms (D-6) |
| Configuration | **PASSED** | zod-validated env, fail-closed loader, production-only HSTS/verbose diagnostics, bounded JSON/body/parser limits from env |
| Supply-chain security | **PASSED for production** (0 advisories) / **OPEN for dev toolchain** (6 advisories, semver-major fixes) | `npm audit`, `qa/dep-review.js` |
| AI safety and quality | **PASSED (fake provider)** / **NEEDS CLINICAL EVALUATION** | fake provider only; no clinical accuracy claim — separate evaluation required |
| Document-processing safety | **PASSED** | size/magic-byte/filename/traversal/permission probes live; parser isolation, timeouts and reconciliation asserted by suite |
| Production / clinical readiness | **BLOCKED** | see [FINAL_READINESS_REPORT.md](FINAL_READINESS_REPORT.md) §blockers |

Legend: **PASSED** · **FAILED** · **FIXED AND RETESTED** · **BLOCKED** · **NOT RUN** · **NOT APPLICABLE**.

---

## 2. Test environment (safety checklist)

| Requirement | Status |
| --- | --- |
| `NODE_ENV=test` isolated configuration | ✅ `NODE_ENV=test` on port 4101; browser journeys on 4100 + `velora_e2e` |
| Dedicated test MongoDB database | ✅ `velora_test` / `velora_e2e` on the disposable replica set at 27019 |
| Replica-set transaction support | ✅ `npm run mongo:test-rs -w server` → `PRIMARY ready, transactions verified` |
| Synthetic fixtures only | ✅ `seed.js` (`*.synthetic.invalid`) + fixture clinic B; probe-created patients are synthetic |
| Temporary private storage | ✅ `%TEMP%/velora-qa-documents` (env validator rejects an in-repo storage root) |
| Temporary keys | ✅ throwaway CI-identical literals in `qa/lib/qaEnv.js`; real `.env` never read by a probe |
| Fake mail/AI/notification providers | ✅ `EXTRACTION_PROVIDER=fake` (local, deterministic); invitation "delivery" is a console line, no mail provider authorized |
| Safe test rate limits | ✅ limiter thresholds untouched; buckets cleared only as documented test hygiene between throughput phases |
| No live recipients | ✅ no mail/SMS/push provider configured anywhere in the stack |
| No real health data | ✅ every identifier is fabricated; documents are generated PDFs |
| No production credentials | ✅ none present; the QA env uses published throwaway literals |
| Bounded load-test traffic | ✅ ≤40 concurrent, phases ≤60 s, ~5 min total, loopback only |
| Explicit cleanup ownership | ✅ DB + storage root are disposable and owned by this pass; nothing was deleted outside them |
| Secrets never in reports/screenshots | ✅ evidence writer redacts cookie values/headers; `qa/.sessions/` is gitignored |

---

## 3. What was actually run

| Layer | Command | Result |
| --- | --- | --- |
| Server suite (unit + integration, replica set) | `npm test -w server` | **420/420 pass** (9.2 min, quiet machine, exit 0); one contention-induced flake investigated and cleared — see §5 |
| New hardening regressions | `node server/tests/integration/httpHardening.test.js` | **5/5 pass** |
| New invitation-uniqueness regressions | `node server/tests/integration/invitationUniqueness.test.js` | **3/3 pass** |
| Client unit tests | `npm test -w client` | **61/61 pass** (11 files) |
| Client lint | `npm run lint -w client` | clean |
| Client production build | `npm run build -w client` | built (368.38 kB JS / 101.34 kB gzip; 13.47 kB CSS) |
| Security probes | `node qa/security-probes.js` | **39 checks, 0 FAIL** |
| Concurrency probes | `node qa/concurrency-probes.js` | **6 checks, 0 FAIL** (1 NOTE: TOTP window) |
| Performance/load/stress/spike/soak | `QA_API_PID=<pid> node qa/perf-load.js` | **0 5xx in every phase**; numbers in the performance report |
| Dependency/licence review | `node qa/dep-review.js` | 25 direct deps, MIT/Apache-2.0/BSD-2-Clause, no install hooks |
| Production dependency audit | `npm audit --omit=dev` | **0 vulnerabilities** |
| Secret scan | tree + 85 reachable commits | **0 secret-shaped hits** |
| Operational drills | `restore-drill`, `reconcile-documents` (dry run + operator-attributed apply) | **restore PASSED** (49 collections / 849 rows / 8 objects byte-identical / indexes identical); reconciliation found 8 orphan objects (QA-run residue), repaired with `--apply --operator`, re-check clean |
| Browser journeys (a11y + one-viewport) | `npx playwright test e2e/accessibility.spec.js e2e/viewports.spec.js e2e/detail-viewports.spec.js` | **37/37 pass** (1.1 min) across 6 viewport sizes × 5 enrolled sessions |

---

## 4. Found and fixed (FIXED AND RETESTED)

| ID | Severity | Summary | Retest |
| --- | --- | --- | --- |
| NQ-1 | P2 | 2 MB / malformed JSON body answered **500** instead of 413/400 | live `413` + 5 new integration tests |
| NQ-2 | P2 | authenticated JSON responses had **no default `Cache-Control`** | live `no-store, private` + 2 new integration tests |
| NQ-3 | P2 | 8 parallel invitations created **8 live tokens** for one email | live `1×201 + 7×409` + 3 new integration tests + a dedupe command for existing data |

Three focused commits, each with its own tests; no history rewrite, no force push. Full detail, including root cause and residual risk, in [FINAL_DEFECT_LOG.md](FINAL_DEFECT_LOG.md).

## 5. Verification status of the full suites

- **Server suite: 420 tests, 420 pass, 0 fail** (9.2 min, `--test-concurrency=1`, real replica-set MongoDB, quiet machine, exit 0). The eight new tests from this pass are included: `httpHardening.test.js` (5) and `invitationUniqueness.test.js` (3).
- **One failure was observed first and is now explained, not hidden:** an earlier full run executed while the browser stack (Vite + Chromium + a second API) was running in parallel; `plans.test.js:798` "parallel approval cannot produce two current versions" failed once because the second parallel approval was answered as an **idempotent retry** (`200`, `idempotent: true`) rather than `409`. Re-run alone (no contention): **24/24 pass**; the full quiet suite then returned **420/420**. The assertion requires strict concurrency; the application behaviour matches its documented idempotent-retry design. Logged as **D-12 (P3, test stability)** in the defect log — no product change was made.
- **Client suite, lint and build:** 61/61 pass, lint clean, production build clean (see §3).
- **Browser journeys:** the accessibility + one-viewport subset passed 37/37; the complete journey suite is run by CI on the branch.
- **A green GitHub Actions run on this branch is still required** before merge: the local run proves the branch on this machine; CI proves it on a clean runner (Docker replica set, fresh install, Playwright browsers).

## 6. Honest limits of this pass

- **No penetration test, no fuzzing, no external scanner.** Probes were defensive and loopback-only.
- **No production or production-like environment existed.** TLS, proxies, real MongoDB auth, multi-instance deployment and the hosting-layer CSP could not be exercised (D-7, D-10).
- **No performance acceptance**: no approved SLO exists in `docs/`, so all numbers are characterization on one developer machine.
- **Live failure injection was limited to what is safe on a shared local stack.** Dependency-outage behaviour (Mongo down → `503`), parser timeouts, storage tampering, provider failure, retry bounds and rollback paths are asserted by the integration suite rather than by killing shared infrastructure during this pass.
- **Clinical/regulatory validation is out of scope.** Nothing here claims clinical accuracy, HIPAA/DISHA readiness or real-patient safety.
