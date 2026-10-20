# Velora UI — responsive viewport test matrix

Measured on `feat/ui-redesign-dark-purple` with Chromium (Playwright), a seeded
synthetic stack (API 4100, Vite 5173). The six required sizes are the gate; the
authenticated audit ran every size against five role sessions.

## 1. Test matrix

| Size | Class | Landing | Login | Authenticated shell |
| --- | --- | --- | --- | --- |
| 1440 × 900 | desktop | measured, scene desktop tier | measured | 24 routes |
| 768 × 1024 | tablet portrait | measured, scene tablet tier | measured | 24 routes |
| 390 × 844 | phone portrait | measured, scene mobile tier | measured | 24 routes |
| 320 × 568 | small phone | measured, scene mobile tier | measured | 24 routes |
| 844 × 390 | phone landscape | measured, scene mobile tier | measured | 24 routes |
| 320 × 400 | shortest supported | measured, scene mobile tier | measured | 24 routes |

Route sessions: reviewer, admin, assigned coordinator, patient, caregiver.
Authenticated checks: **144 route visits, 0 failures**.

## 2. What is measured

For every authenticated route:

- document `scrollHeight` vs `innerHeight` (no page-level vertical scroll);
- document `scrollWidth` vs `innerWidth` (no horizontal page scroll);
- clipping by `overflow: hidden`;
- `Sign out` visible;
- main pane `scrollWidth` vs `clientWidth`, with any element overflowing an
  unclipped ancestor reported by tag, class and width.

For the public surfaces:

- canvas backing size vs CSS size and the device pixel ratio cap;
- hero, headline block and sign-in link inside the first viewport;
- hero clipping (the canvas may bleed, but only inside a clipped hero);
- login submit button inside the viewport and panel/page height.

## 3. Results — authenticated application

| Size | Vertical overflow | Horizontal overflow | Clipping | Sign out | Main pane |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | none | none | none | visible | no horizontal scroll |
| 768×1024 | none | none | none | visible | no horizontal scroll |
| 390×844 | none | none | none | visible | no horizontal scroll |
| 320×568 | none | none | none | visible | no horizontal scroll |
| 844×390 | none | none | none | visible | no horizontal scroll |
| 320×400 | none | none | none | visible | no horizontal scroll |

The viewport, accessibility, axe, zoom, table and forced-colours specs all pass on
this tree (viewports 30/30, accessibility 1/1, axe 4/4, zoom 2/2, tables 3/3,
forced colours 3/3). The standalone audit that reports every combination printed
**144 route checks, 0 failures**.

> **Measurement limit this table hid (L16, fixed 20 October 2026).** "Main pane: no
> horizontal scroll" compares the pane's own `scrollWidth` with its `clientWidth`.
> When the pane itself is wider than the viewport those two numbers are equal, so
> the table reported a clean result while `main` was **384 px inside a 320 px
> viewport** (`/app/clinic`). The cause was an implicit min-content grid column on
> the shell body; it is now `minmax(0, 1fr)`, the tab strip wraps and stacked cells
> wrap. `e2e/layout-width.spec.js` (**31 tests**) replaces this blind spot by
> measuring the real boxes — `main`'s width and right edge, every visible child
> against the viewport, tab strips against their own box and stacked rows against
> their panel — across four sessions and all six sizes.

## 4. Results — landing page

The landing page is the one screen allowed to scroll (control #25), so a document
taller than the viewport is expected. What matters is that the hero and its only
call to action are in the first viewport, and nothing overflows sideways.

| Size | Document | Canvas (backing / CSS) | Tier | Sign-in link bottom | Horizontal overflow |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | 1440×900 (no scroll) | 1040×486 / 1040 | desktop | 306 | none |
| 768×1024 | 768×1024 | 849×540 / 850 | tablet | 292 | none |
| 390×844 | 390×948 | 563×412 / 451 | mobile | 280 | none |
| 320×568 | 320×1049 | 453×326 / 363 | mobile | 272 | none |
| 844×390 | 844×699 | 939×320 / 939 | mobile | 271 | none |
| 320×400 | 320×1049 | 453×300 / 363 | mobile | 272 | none |

Backing sizes show the DPR cap working: a device pixel ratio of 3 renders the
phone canvas at 1.25×, not 3×.

## 5. Results — authentication panel

| Size | Panel height | Page height | Submit visible | Scroll needed |
| --- | --- | --- | --- | --- |
| 1440×900 | 523 | 900 | yes | no |
| 768×1024 | 511 | 1024 | yes | no |
| 390×844 | 483 | 844 | yes | no |
| 320×568 | 407 | 568 | yes | no |
| 844×390 | 403 | 390 | yes | **no** |
| 320×400 | 407 | 400 | yes | **no** |

Before the short-viewport rules were added, the same measurement showed the submit
button **below** the viewport at 844×390 and 320×400 (panel page 559 / 507 px).
`@media (max-height: 620px)` top-aligns the panel and compresses the vertical
rhythm; a second rule at `max-height: 480px` tightens only the rhythm, so the panel
now fits with **0 px** of page scroll at both sizes. No label, input, control or
link is removed.

## 6. Breakpoints and what changes

| Width | Change |
| --- | --- |
| ≥1100 px | desktop scene tier; 264 px sidebar; tables |
| 901–1099 px | tablet scene tier; sidebar still present |
| ≤900 px | sidebar becomes a horizontal navigation rail; split plan layout stacks |
| ≤720 px | mobile scene tier; patient and episode lists render as cards; landing becomes a scrolling page with a shorter hero band |
| ≤480 px | 44 px touch targets; single-column recovery codes; reduced panel padding |
| ≤620 px **height** | auth panel top-aligned and compressed; hero padding tightened |
| ≤480 px **height** | any viewport gets the mobile scene tier, so a landscape phone is not treated as a tablet; auth panel rhythm tightens to 0 px of scroll |

## 7. Browser coverage

Chromium, Firefox and WebKit (19 October 2026): each engine runs the full
journey suite against the documented topology — **Chromium 77/77, Firefox 77/77,
WebKit 76 passed with 0 failures** — so the layout is no longer Chromium-only
reasoning. The layout uses flex/grid, `clamp()`, `min()`, logical properties
and `mask-image` with a `-webkit-` twin; there is no container query, no
`:has()` dependency and no subgrid.

## 8. Not covered

- Real iOS Safari and Android Chrome, including dynamic browser chrome.
- OS-level text scaling. (200 % and 400 % browser zoom are now covered by `e2e/zoom.spec.js`.)
- Foldables and unusual aspect ratios outside the six listed sizes.
- Print stylesheet (none exists).
- Orientation change is verified for the 3D canvas only; authenticated screens
  are measured in both portrait and landscape sizes but not during a live
  orientation change.

Commands:

```
node qa/viewport-audit.js            # 144-route audit over the five sessions
npx playwright test e2e/viewports.spec.js e2e/accessibility.spec.js
node qa/ui-visual-capture.js         # screenshots + measurements, six sizes
```
