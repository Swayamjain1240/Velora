# Velora — Final Defect Log (QA pass, 16 October 2026)

Branch `test/complete-functional-qa`, base `036c27a`. Severities per P0–P3 definitions.

---

## QA-001 — CI "fails closed" step can never run its journey · **P2** · FIXED

- **Requirement:** control #20/#23, VEL-008 shipped default (`EXTRACTION_PROVIDER=none`) must fail closed and be proven in CI.
- **Preconditions:** CI e2e job (job env `EXTRACTION_PROVIDER: fake`), final step "Extraction fails closed with no provider enabled".
- **Reproduction:** `EXTRACTION_PROVIDER=fake npx playwright test e2e/extractions.spec.js -g "no provider enabled"` → `1 skipped` (the test skips itself when the runner sees `fake`; the step has no env override, so it always inherited `fake`).
- **Expected:** the step asserts the shipped fail-closed default.
- **Actual:** the step reported green while skipping its only test — a vacuous pass.
- **Evidence:** local reproduction (skip observed) + command log in the QA report.
- **Root cause:** journey's self-skip keyed to the runner env; step never overrode it.
- **Fix:** `.github/workflows/ci.yml` — `EXTRACTION_PROVIDER=none npx playwright test …` with an explanatory comment.
- **Retest:** under `fake` the journey still self-skips (guard intact); with API `none` + runner `none` the journey **passes** (4.7 s). Workflow YAML re-parsed (4 jobs).
- **Regression:** workflow-only change; full suites unaffected. CI run on push is the final gate.
- **Commit:** this branch's CI-fix commit.

## QA-002 — `apiContract.test.js` inherited sibling-suite DB rows · **P3** · FIXED

- **Requirement:** a "nothing was written" count assertion must own its baseline.
- **Reproduction:** run `apiContract.test.js` after `accessMatrix.test.js` in one invocation → the unauthenticated-mutation test counted 1 leftover patient and failed despite the 401 refusal.
- **Actual:** test failed for isolation reasons, not product behavior.
- **Fix:** `beforeEach` `resetDb()` added to the suite (test-owned data only).
- **Retest:** 6/6 green solo and inside the full 412-test run.

## QA-003 — first access-matrix draft asserted against requirement evidence · **P3** · FIXED (test-harness)

- **Requirement:** matrix expectations must cite requirement evidence, not assumptions.
- **Actual:** draft asserted denials for dashboard/metrics surfaces whose requirement is *scoped-empty 200*; used a non-existent roster field; revoked the last assignment (guard: 409).
- **Fix:** every cell rebuilt from suite-cited evidence (dashboard suite, metrics suite, `SYSTEM_ROLES`); roster field corrected; revocation scenario now mirrors the documented second-assignee flow.
- **Retest:** 3/3 green; product code unchanged — the product met every corrected expectation as specified.

## OBS-001 — transient login redirect during first E2E run · **P3 (observation, OPEN)**

- **Observed:** in the first full E2E run (against an externally-started API with no `EXTRACTION_PROVIDER`), 8 viewport tests failed with the app bounced to the login page mid-run.
- **Triage:** not reproduced in three subsequent executions on the CI topology (90/90 viewport tests green). Most consistent with a contended/misconfigured stack rather than product auth, but the trigger was not conclusively isolated.
- **Action:** re-check if it recurs on CI; no product change made on this evidence.

---

**No P0 or P1 product defects were found in this pass.** This states what the suite observed; it is not a claim of zero bugs.
