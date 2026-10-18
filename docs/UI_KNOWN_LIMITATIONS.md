# Velora UI — known limitations

Register for `feat/ui-redesign-dark-purple` after the completion pass of
18 October 2026. A row marked **resolved** has code and a check that proves it; a
row still open is a real gap, not a preference.

| # | Limitation | Status | Evidence / remaining work |
| --- | --- | --- | --- |
| L1 | **The redesign is partial.** Shell, sign-in, landing, overview and phone lists are new; some interior screens keep their previous internal layout on the new surfaces. | Open (narrowed) | Tables now stack into labelled cards on every screen, and the metrics panels gained charts. A full structural pass (stage 3) is still outstanding. Design owner. |
| L2 | **Shared advanced controls.** | Partly resolved | `ResponsiveTable`, `Skeleton` and `MiniBars` now exist and are adopted (metrics tables and loading state). No dialog, drawer, toast or tooltip primitive yet; confirmations remain inline. Stage 2 frontend. |
| L3 | **Tables on phones.** | **Resolved** | `ResponsiveTable` labels every cell from the rendered `<thead>`, keeps explicit ARIA table roles, and CSS stacks rows below 720 px. Verified by `e2e/tables.spec.js` at 390×844 and at 1440×900. |
| L4 | **No automated accessibility score.** | **Resolved** | `e2e/axe.spec.js` runs axe-core (WCAG 2.1 A/AA) over 15 public, reviewer, administrator and phone screens; any violation fails. Result: **0 violations**. |
| L5 | **No screen-reader walkthrough or extreme zoom.** | Partly resolved | `e2e/zoom.spec.js` proves 200 % and 400 % reflow with no horizontal page scroll and a reachable sign-out. A real screen-reader walkthrough (NVDA/VoiceOver) is still manual and has **not** been run. |
| L6 | **Chromium only.** | Open | Firefox and WebKit are still untested; CI installs Chromium only. |
| L7 | **3D chunk size.** | **Resolved** | The scene is now hand-written WebGL: **13.11 kB minified / 4.99 kB gzip** (was 238.83 kB gzip). `three` and `@react-three/fiber` were removed. Gate was ≤60 kB. |
| L8 | **No real-device 3D measurement.** | Open | Tiers and DPR caps remain reasoned from geometry; the 60 fps figure is desktop SwiftShader. Device lab / owner. |
| L9 | **Auth panel scrolled at 844×390 / 320×400.** | **Resolved** | A `max-height: 480px` rule tightens only vertical rhythm. Measured page overflow is **0 px** at both sizes and at 320×568 / 390×844. |
| L10 | **A lost WebGL context is not restored.** | Accepted | The gradient remains for that visit; reload restores the scene. |
| L11 | **No visual gate in CI.** | Partly resolved | `node qa/layout-snapshot.js` is a blocking CI step comparing 36 route/size snapshots (overflow, main width, heading, table/card/nav counts) against `qa/baselines/layout.json`. Pixel baselines are still captured manually and are not a merge gate. |
| L12 | **Forced-colours / high-contrast.** | **Resolved** | `@media (forced-colors: active)` keeps boundaries as real system-colour borders, uses the system focus colour and hides the decorative scene; `prefers-contrast: more` strengthens borders. Verified by `e2e/forced-colors.spec.js`. |
| L13 | **The scene has no non-visual equivalent.** | Accepted | It conveys no information, so nothing is lost semantically. |
| L14 | **Dev-only global rate limiter (300 req/min/IP).** | Unchanged by design | It can still produce a login redirect during rapid manual testing. CI sets `NODE_ENV=test`, where the limiter is skipped; an expanded local suite must do the same or it will trip itself. |
| L15 | **No i18n, RTL or locale formatting pass.** | Open | Copy is English; dates and numbers use the browser locale. Product decision. |

## Defect-log items closed in this pass

These were open findings in [FINAL_DEFECT_LOG.md](FINAL_DEFECT_LOG.md):

| ID | Finding | Status |
| --- | --- | --- |
| D-4 | A TOTP code was accepted twice inside one 30 s window | **Fixed** — the accepted counter step is claimed atomically on the user; a replay is refused, a newer step still works. |
| D-5 | 6 dev-toolchain advisories (vite, vitest, esbuild, tinypool) | **Fixed** — Vite 8.3.4, Vitest 5.0.5, plugin-react 6.1.2, jsdom 30; `npm audit` reports 0. |
| D-6 | `/api/metrics` exposed no process health | **Fixed** — `runtime` block with process memory/CPU, event-loop delay, Mongo pool state and bounded per-route latency percentiles. |
| D-7 | The client shell served no CSP | **Fixed** — strict policy injected into the built shell, relaxed dev/preview headers, module-preload polyfill disabled so no inline script is needed. |
| D-8 | No Origin/Referer allowlist on cookie mutations | **Fixed** — second CSRF layer checks the configured client origin; foreign origins get 403. |
| D-12 | Concurrent-approval assertion depended on scheduling | **Fixed** — the test now asserts the invariant (one current version) and accepts the documented idempotent retry. |
| — | "GET /api/plans returned 0 items" observation | **Not reproducible** — a read-after-write test in the perf driver's exact shape passes. |
| D-9 | CI actions pinned to major tags | Open — hardening step. |
| D-10 | Production MongoDB auth/TLS never exercised | Open — deployment work, outside this repository. |

## Things that are *not* limitations

- The landing page scrolls. That is the one screen allowed to scroll, and it is
  intentional.
- The 3D canvas does not accept pointer input. That is required, not missing.
- There is no loading spinner over the hero while the scene downloads. The static
  gradient is the loading state by design.
- A context loss, missing WebGL or a scene error shows no error text. That is the
  required behaviour for a decorative element.
- The compact metric bars are `aria-hidden`: the same numbers are in an
  accessible table beside them.
