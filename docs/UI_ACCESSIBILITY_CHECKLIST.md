# Velora UI — accessibility checklist

Scope: the redesigned client on `feat/ui-redesign-dark-purple`, including the
decorative Recovery Network hero. Status vocabulary: **PASSED**, **FAILED**,
**FIXED**, **BLOCKED**, **NOT RUN**, **NOT APPLICABLE**. Evidence names the check
that produced the result.

## 1. Structure and semantics

| Item | Result | Evidence |
| --- | --- | --- |
| One `<main>` per screen | PASSED | landing uses `<main className="landing">`; the shell puts `<main>` inside the layout and screens render sections |
| Landmarks: `aside`, `nav`, `header`, `main` | PASSED | `AppShell.jsx`; `e2e/accessibility.spec.js` |
| Single navigation landmark with an accessible name | PASSED | one `<nav aria-label="Application">`; the phone rail is the same element |
| Heading order per screen | PASSED | each screen starts at `h1` in the page head; panels use `h2`/`h3` |
| Lists marked up as lists | PASSED | safety boundaries, nav groups, queue rows |
| Tables use `th` with `scope` | PASSED | existing staff tables retained their markup |
| Page title reflects the product | PASSED | `client/index.html` title "Velora" |

## 2. Keyboard and focus

| Item | Result | Evidence |
| --- | --- | --- |
| Every control reachable by Tab | PASSED | `e2e/accessibility.spec.js` reaches navigation and Sign out within 40 tabs |
| Visible focus indicator | PASSED | 2 px `#C4B5FD` ring offset 2 px; asserted by the same spec |
| Focus not trapped by the 3D canvas | PASSED | canvas is `aria-hidden` with `pointer-events: none` and no focusable children |
| Logical focus order | PASSED | DOM order: sidebar → top bar → main |
| Skip-to-content link | NOT APPLICABLE | the app has no long scrolling header; the nav is a fixed rail |
| Password visibility toggle is a button with state | PASSED | `aria-label` + `aria-pressed` in `Login.jsx` |
| Escape/return focus for dialogs | NOT APPLICABLE | no dialog component exists yet (Stage 2) |

## 3. Colour and contrast

| Item | Result | Evidence |
| --- | --- | --- |
| Body text ≥ 4.5:1 on surface | PASSED | `--text #F8F7FC` 18.9:1, `--text-secondary #B8B2C7` 9.1:1 on `--surface-1` |
| Filled control contrast | PASSED | white on `--brand-action #7C3AED` = 5.7:1; the brighter `#8B5CF6` (4.22:1) is decoration only |
| Muted metadata ≥ 4.5:1 when informative | PASSED | `--text-muted #9A93AA` 6.2:1; `--text-faint` is decorative only |
| Status not conveyed by colour alone | PASSED | pill = label + dot + colour; text always present |
| Hero text over the 3D scene | PASSED | headline and tagline carry a 22 px dark text-shadow and sit above a masked canvas whose brightest area is behind the mark |
| Automated contrast audit (axe) | NOT RUN | no axe dependency in the project |

## 4. Forms and errors

| Item | Result | Evidence |
| --- | --- | --- |
| Every input has a programmatic label | PASSED | `htmlFor`/`id` pairs unchanged by the redesign |
| Error announced | PASSED | `role="alert"` on the inline error paragraph |
| Busy state announced by the control | PASSED | submit label changes to "Signing in…" and the button is `disabled` |
| Generic auth errors (no account enumeration) | PASSED | server message rendered verbatim |
| Required-field semantics | PASSED | `required` retained on all credential inputs |

## 5. Motion and animation

| Item | Result | Evidence |
| --- | --- | --- |
| `prefers-reduced-motion: reduce` honoured by the app | PASSED | `motion.js` skips tweens; `base.css` collapses transitions |
| Reduced motion honoured by the 3D scene | PASSED | no entrance, orbit, breathing, parallax or travelling signals; `frameloop="demand"` |
| No essential information inside the canvas | PASSED | scene is decorative and contains no text |
| No animation as the only status signal | PASSED | every status has text; motion is additive |
| No flashing above 3 Hz | PASSED | no flashing exists; breathing is ~0.14 Hz |
| Controls usable while animation runs | PASSED | no tween gates input; content starts at 0.6 opacity |

## 6. Responsive and zoom

| Item | Result | Evidence |
| --- | --- | --- |
| 320 px layout without horizontal page scroll | PASSED | six-size audit, `UI_RESPONSIVE_MATRIX.md` |
| Touch targets ≥ 44 px on phones | PASSED | 40 px desktop / 44 px ≤ 480 px |
| Landscape phone (844×390) usable | PASSED | six-size audit; hero is repositioned, not cropped |
| 200 % zoom | NOT RUN | not measured this stage |
| Text-only resize to 200 % | NOT RUN | uses `rem`/`clamp`, but unverified |

## 7. Assistive technology

| Item | Result | Evidence |
| --- | --- | --- |
| Screen-reader walkthrough (NVDA/VoiceOver) | NOT RUN | not available in this environment |
| Decorative scene hidden from AT | PASSED | `aria-hidden="true"` on the host and the canvas |
| Live regions for async results | PASSED | `role="status"`/`role="alert"` used on notices and errors |
| Accessible names on icon-only controls | PASSED | collapse toggle, password toggle, Sign out carry text or `aria-label` |

## 8. Browser matrix

Chromium is the primary target (`e2e` project), and **Firefox and WebKit now run
the full journey suite as well** (19 October 2026): Chromium **77/77**, Firefox
**77/77**, WebKit **76 passed with 0 failures** (3 by-design skips). Each engine
turned up something real rather than a reason to relax an assertion: Firefox
exposed the scrollable-region keyboard defect (fixed by `ScrollRegion`), and
WebKit showed that Playwright's WebKit build never places sequential focus on
elements that rely on implicit focusability — proved on a four-element control
page — so the keyboard journey skips `webkit`+Windows with that proof in the test
and still hard-fails on the other two engines.

The implementation avoids APIs that would need vendor-specific fallbacks:
`IntersectionObserver`, `ResizeObserver`, `MutationObserver`, `matchMedia` and
`visibilitychange` are all baseline in the supported evergreen browsers.

## 9. Open items

1. No automated axe/Lighthouse pass. Contrast is calculated from tokens.
2. No screen-reader or 200 % zoom walkthrough.
3. Firefox and Safari run the full suite; the keyboard journey alone is unrunnable
   on Playwright's WebKit build (see §8) and needs a real Safari to confirm.
4. `prefers-reduced-transparency` and forced-colours mode are not handled.
5. The 3D hero has no non-visual equivalent beyond the product copy — acceptable
   because it conveys no information, but it means the page's identity is only
   visual for AT users.

Owners and stage placement for each item are in `UI_KNOWN_LIMITATIONS.md`.
