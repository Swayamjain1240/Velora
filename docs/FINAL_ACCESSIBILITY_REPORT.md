# Velora — Final Accessibility Report (non-functional QA pass)

**Environment:** isolated browser stack — API `NODE_ENV=test` on `127.0.0.1:4100` against the disposable `velora_e2e` replica-set database, Vite dev server on `http://localhost:5173` proxying `/api`, seeded synthetic clinic, `EXTRACTION_PROVIDER=fake`. Chromium (Playwright `chromium-1248`).
**Command:** `npx playwright test e2e/accessibility.spec.js e2e/viewports.spec.js e2e/detail-viewports.spec.js`
**Raw output:** [qa/evidence/e2e-a11y-viewports.txt](../qa/evidence/e2e-a11y-viewports.txt)

## Verdict

| Area | Verdict |
| --- | --- |
| Keyboard reachability and focus behaviour of the app shell | **PASSED** |
| Every authenticated screen fits one viewport without clipping (SECURITY-25 #25) | **PASSED** — 6 viewport sizes × 5 authenticated sessions + detail screens |
| Automated accessibility assertions in the journeys (axe-core) | **PASSED** (part of the accessibility spec) |
| Screen-reader walkthrough, colour-contrast beyond axe defaults, 200 % zoom, manual keyboard-only pass over every workflow | **NOT RUN** — requires a human reviewer and a real AT stack |
| Cross-browser / device compatibility | **PARTIAL** — Chromium only; Firefox, WebKit/Safari, iOS/Android devices not installed in this environment |

**Result: 37 tests passed in 1.1 minutes, 0 failed.**

## What was measured

| Spec | Coverage |
| --- | --- |
| `e2e/accessibility.spec.js` (1 journey) | the shell is keyboard-reachable, focus is visible, and a control activates without a pointer |
| `e2e/viewports.spec.js` (30 checks) | authenticated screens fit **one viewport** for 5 enrolled sessions × 6 viewport sizes |
| `e2e/detail-viewports.spec.js` (6 checks) | detail screens (episode/plan/document surfaces) fit one viewport at each size |

Enrolled sessions that were driven: `reviewer`, `admin`, `docsview` (assigned coordinator), `patient.docs` (read-only patient), `caregiver.docs` (scoped caregiver). The setup additionally enrols the plan, extraction, schedule and `flow` journey identities so other specs can run.

Viewport sizes exercised: **1440×900** (desktop), **768×1024** (tablet), **390×844**, **320×568**, **844×390** (landscape), **320×400** (short).

## How this maps to the QA requirements

- **SECURITY-25 #25** ("every authenticated screen fits one viewport without clipping"): satisfied for the monitored sessions/screens by `viewports.spec.js` + `detail-viewports.spec.js`. The long-document surfaces (care-plan workspaces, extraction panels) have their own scrolling regions and are asserted by `detail-viewports.spec.js`.
- **Usability**: the previous functional QA pass walked every screen and role; this pass re-verified layout constraints mechanically rather than by eye.
- **Compatibility**: the API is plain JSON over HTTP with no browser-specific behaviour; the compatibility risk lives in the SPA (CSS grid/flex, viewport units) and is exercised at the six sizes above, in Chromium only.

## Limits and residual risk

1. **One engine only.** No WebKit/Firefox run was possible (no browsers installed). Safari-specific CSS/JS behaviour and iOS safe-area handling are unverified.
2. **No assistive-technology walkthrough.** axe-core catches structural violations, not the experience of a screen-reader user; a manual pass with NVDA/VoiceOver remains an owner task (P3, accessibility).
3. **No contrast/zoom audit** beyond what axe asserts at default settings; 200 % browser zoom was not exercised.
4. **Mobile is emulated viewport size, not a real device** — touch targets, soft keyboard behaviour and orientation changes are unverified.
5. The journeys assert the seeded screens; a screen added later is only covered once a spec drives it.

These limits are recorded as residual items, not as passes.
