# Velora UI design system

Describes the interface that exists on branch `feat/ui-redesign-dark-purple`.
Scope of this document: the design system, the application shell, the sign-in
surface, the landing page, the motion layer and the Recovery Network 3D hero.
Screens not yet structurally revised still inherit every token and surface rule
here, because the stylesheet is global.

Companion documents: `UI_ROUTE_SCREEN_INVENTORY.md`, `UI_COMPONENT_INVENTORY.md`,
`UI_ANIMATION_GUIDELINES.md`, `UI_ACCESSIBILITY_CHECKLIST.md`,
`UI_RESPONSIVE_MATRIX.md`, `UI_VISUAL_REGRESSION.md`,
`UI_3D_RECOVERY_NETWORK.md`, `UI_STAGE1_QA_REPORT.md`,
`UI_KNOWN_LIMITATIONS.md`.

Status vocabulary: **PASSED**, **FAILED**, **FIXED**, **BLOCKED**, **NOT RUN**,
**NOT APPLICABLE**.

---

## 1. Layers

| File | Role |
| --- | --- |
| `client/src/styles/tokens.css` | colour, typography, spacing, radius, elevation, layout, motion, z-index |
| `client/src/styles/base.css` | reset, document defaults, focus, utilities, reduced motion |
| `client/src/styles/components.css` | shell, navigation, buttons, fields, cards, tables, tabs, pills, wizards |
| `client/src/styles/screens.css` | landing, authentication, documents, plans, today, queues |
| `client/src/styles.css` | entry point; imports the four layers in order |

No component hard-codes a colour that exists as a token. Pills are the only
place where a status colour is attached to a status name, and every pill keeps
its text label.

## 2. Colour

Surfaces: `--bg #08070D`, `--surface-1 #100E19`, `--surface-2 #171321`,
`--surface-3 #211A30`, `--surface-inset #0B0912`.

Brand: `--brand-500 #8B5CF6` for graphics, `--brand-action #7C3AED` for filled
controls. The split is deliberate: white text on `#8B5CF6` measures 4.22:1 and
fails AA for body text, while `#7C3AED` measures 5.7:1 and passes.

Text pairs on `--surface-1`: `--text #F8F7FC` 18.9:1, `--text-secondary
#B8B2C7` 9.1:1, `--text-muted #9A93AA` 6.2:1. `--text-faint #7D7690` is
decorative metadata only and never carries information on its own.

Status: success `#3DDC97`, warning `#FBBF24`, danger `#F87171`, info `#7DD3FC`,
each with a translucent wash and border. Status is communicated by **label +
dot + colour**, so it survives greyscale, colour blindness and forced-colours
mode.

## 3. Type, spacing, shape

- Type: `Inter` → `Segoe UI` → system-ui stack; display `clamp(2.25rem, 4vw + 1rem, 3.75rem)`,
  body 0.9375rem, small 0.8125rem, meta 0.75rem. No web-font request, so no
  third-party font origin and no layout shift.
- Spacing: 4 px scale (`--space-1` … `--space-24`).
- Radius: 6 / 8 / 12 / 16 / 22 px and pill.
- Elevation: three shadows plus one brand glow used only on the primary action
  and the brand mark.

## 4. Shell

`AppShell` is fixed to the viewport (`position: fixed; inset: 0`) and never
scrolls the document. Desktop shows a 264 px sidebar that collapses to a 76 px
icon rail; the top bar carries the section title, clinic · role context,
identity and **Sign out** (which stays visible at every size, including phones
and 320 px).

Navigation is grouped (Workspace, Clinical / My care, Operations, Account) but
contains exactly the links the previous shell exposed, under the same role
predicates. It is a single `<nav aria-label="Application">`; below 900 px it
becomes a horizontally scrollable rail rather than a second navigation element,
so the accessible name stays unique.

## 5. Components delivered

| Component | Where | States covered |
| --- | --- | --- |
| Application shell + sidebar + top bar | `features/app/AppShell.jsx` | default, collapsed, mobile rail, active route, focus |
| Inline icon set (22 glyphs) | `components/Icon.jsx` | decorative (`aria-hidden`) and labelled (`<title>`) |
| Page header pattern | `.page-head`, `.page-eyebrow`, `.page-sub` | used by Overview; reusable |
| Cards and information cards | `.card`, `.info-card`, `.info-grid` | default, accent, hover (rows) |
| Buttons | `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--danger` | default, hover, active, focus, disabled |
| Fields, selects, textareas, checkbox/radio | `input`, `select`, `textarea`, `.check` | default, hover, focus, disabled, error colour |
| Password field | `.password-field`, `.password-toggle` + `Login` | hidden/shown, `aria-pressed`, labelled toggle |
| Tabs, pills, tables, pagination, stepper, wizard, panels | existing class names, restyled | default, hover, active, sticky table head |
| Auth layout | `.panel-page`, `.panel`, `.panel__brand` | single column from 320 px up |
| Landing hero and sections | `.landing*` | scroll page, reveal animation, GSAP hero entrance |
| Recovery Network hero | `features/public/recovery/HeroVisual.jsx`, `RecoveryNetwork.jsx` | lazy scene, static fallback, reduced motion, three quality tiers |
| Responsive table | `components/ResponsiveTable.jsx` | columns above 720 px, labelled cards below, explicit ARIA roles, late rows |
| Skeleton | `components/Skeleton.jsx` | static under reduced motion, hidden from AT, real status text beside it |
| Compact comparison bars | `components/MiniBars.jsx` | proportional bars, aria-hidden duplicate of the table, two layouts |

Still not built (Stage 2): dialog, drawer, toast, tooltip, breadcrumb and
dedicated empty/error illustrations. Confirmations stay inline.

## 6. Motion

`client/src/lib/motion.js` is the only place that creates a tween.

- Tokens: instant 90 ms, fast 150, base 240, slow 380, reveal 450. Only
  `opacity` and `transform` are animated.
- `usePageTransition(ref, routeKey)` fades/raises the screen by 8 px on route
  change, keyed on pathname so rerenders do not replay it.
- `useReveal(ref, { selector })` staggers at most 12 children by 40 ms.
- `gsap.context()` scopes every timeline and `ctx.revert()` runs on unmount.
- The hero scene and the hero copy start on the same clock. The scene owns its
  own entrance inside its render loop (no GSAP); the copy uses GSAP. One system
  writes each property — see `UI_ANIMATION_GUIDELINES.md` §5.
- Content starts at **0.6 opacity, never 0**, and a 600/900 ms failsafe sets it
  back to 1 if the ticker never runs (backgrounded tab, paused frame budget).
  Medical information is never withheld by an animation.
- `prefers-reduced-motion: reduce` skips animation entirely: the module checks
  the query and the base layer collapses CSS transitions.

## 7. Accessibility checklist

| Item | Result |
| --- | --- |
| Semantic landmarks (`aside`, `nav`, `main`, `header`) | PASSED — verified in the shell |
| Single navigation landmark with a name | PASSED — one `<nav aria-label="Application">` |
| Keyboard reachability of navigation and Sign out | PASSED — `e2e/accessibility.spec.js` (Tab/Enter, within 40 tabs) |
| Visible focus indicator | PASSED — 2 px `#C4B5FD` ring, offset 2 px; asserted by the same spec |
| Focus order | PASSED — DOM order is sidebar → top bar → main |
| Form labels bound to inputs | PASSED — unchanged `htmlFor`/`id` pairs |
| Password toggle accessible name and state | PASSED — `aria-label`, `aria-pressed` |
| Status not conveyed by colour alone | PASSED — pill text label + dot |
| Touch targets | PASSED — 40 px desktop, 44 px ≤480 px |
| Reduced motion | PASSED — no tween, opacity 1, no inline style (measured in a `reducedMotion: reduce` context) |
| Contrast (AA) | PASSED by token calculation for the pairs above; **no automated axe run** |
| Screen reader pass | NOT RUN |
| 200 % zoom / text resize | NOT RUN |
| Cross-browser (Firefox, Safari) | **PASSED** — full journey suite on all three engines (Chromium 77/77, Firefox 77/77, WebKit 76 passed / 0 failures); the keyboard journey is skipped on WebKit only, where the engine build never focuses implicitly-focusable links |

## 8. One-viewport evidence

Screens measured at 1440×900, 768×1024, 390×844, 320×568, 844×390 and 320×400
for five role sessions (reviewer, admin, coordinator, patient, caregiver):
**144 route checks, 0 failures** — no document-level vertical overflow, no
horizontal page overflow, no clipping by `overflow: hidden`, Sign out visible,
and no horizontal scrolling of the main pane at rest.

`e2e/viewports.spec.js` (30 tests), `e2e/accessibility.spec.js` (1),
`e2e/axe.spec.js` (4), `e2e/zoom.spec.js` (2), `e2e/tables.spec.js` (3) and
`e2e/forced-colors.spec.js` (3) all pass against the API in its documented e2e
topology (`NODE_ENV=test`, port 4100, Vite 5173).

The public auth panel follows the same rule: a second short-viewport rule
(`max-height: 480px`) tightens only the vertical rhythm, so at 844×390 and
320×400 the panel page scrolls by **0 px** and the submit button and reset link
are both visible; see `UI_RESPONSIVE_MATRIX.md` §5.

Two layout defects were found by that audit and fixed in this change:

1. `margin-inline: auto` on a flex item prevented the card from stretching, so a
   wide tab row expanded the card to its min-content width (759 px at 320 px
   viewport) and pushed the page sideways. Fixed with `width: 100%; min-width: 0`.
2. The landing page painted its glow with a viewport-fixed pseudo-layer, which
   produced a visible hard-edged band on a short page. Moved onto the page
   itself.

## 9. Tests and commands (this branch)

| Check | Command | Result |
| --- | --- | --- |
| Client unit/component | `npm test -w client` | **77/77 passed**, 15 files |
| Lint | `npm run lint -w client` | **clean** |
| Production build | `npm run build -w client` | **built** |
| Browser journeys | `npx playwright test` | **76 passed + 1 opt-in skip** |
| Accessibility (axe WCAG 2.1 A/AA) | `npx playwright test e2e/axe.spec.js` | **0 violations on 15 screens** |
| Zoom reflow | `npx playwright test e2e/zoom.spec.js` | **200 % and 400 % pass** |
| Phone tables | `npx playwright test e2e/tables.spec.js` | **3/3 passed** |
| Forced colours | `npx playwright test e2e/forced-colors.spec.js` | **3/3 passed** |
| Six-size audit (all five sessions) | `node qa/viewport-audit.js` | **144 checks, 0 failures** |
| Layout regression gate | `node qa/layout-snapshot.js` | **36/36 surfaces match** |
| 3D hero suite | `node qa/hero-browser-test.js` | **18 checks, 0 failures** |
| Reduced motion | Playwright `reducedMotion: 'reduce'` probe | **0.00 % pixel change**, opacity 1 |
| Visual capture | `node qa/ui-visual-capture.js` | 14 images + measurements |
| Dependency audit | `npm audit` | **0 vulnerabilities** |

Not run: Lighthouse, a real screen-reader walkthrough and real-device 3D
measurement. Pixel baselines are captured but are not a merge gate (the
structural layout gate is).

## 10. Performance

Measured on the same machine, production build:

| Asset | Before the redesign | Stage 1 | With the 3D hero | Load |
| --- | --- | --- | --- | --- |
| JS | 368.38 kB / 101.34 kB gzip | 448.69 / 132.26 | **464.11 / 132.60** | initial |
| CSS | 13.47 kB / 3.02 kB gzip | 36.16 / 7.32 | **43.08 / 8.76** | initial |
| Scene chunk | — | — | **13.11 / 4.99** | lazy, landing only |

The stage-1 delta is GSAP 3.15.0 plus the shell, icons and motion module. The
hero adds ~1 kB to the initial bundle (the host, capability probe and fallback)
and defers the renderer entirely; the scene chunk is now 4.99 kB gzip. Follow-up
options if the initial bundle must shrink further: import `gsap/gsap-core` with
only the CSS plugin, or load the motion module through a dynamic import on first
navigation. No 3D library remains to remove; see `UI_3D_RECOVERY_NETWORK.md` §12.

## 11. Dependency decisions

- **Why:** the request names GSAP as the animation system; it provides context
  scoping and timeline cleanup that a hand-rolled rAF would have to reproduce.
- **Version:** 3.15.0, licence *Standard "no charge" licence* (free for this
  application's use; recorded in `client/package.json` and the lockfile).
- **Audit:** `npm audit --omit=dev` → 0 vulnerabilities.
- **Bundle:** measured above; no plugin imports (no ScrollTrigger).
- **Rejected alternatives:** CSS-only transitions (no timeline control, no
  stagger cleanup), Framer Motion (an overlapping animation library).

## 12. 3D decision: hand-written WebGL, landing hero only

The Recovery Network is implemented directly against WebGL; no 3D library is
installed. `three` and `@react-three/fiber` were removed after they cost
238.83 kB gzip for six draw calls.

- **Lazy:** `HeroVisual` dynamically imports the scene; the chunk is requested on
  `/` and never on `/login` or any `/app` screen (verified by request capture).
- **Measured:** 13.11 kB minified / **4.99 kB gzip**, under the ≤60 kB gate. The
  initial bundle is unaffected apart from the ~1 kB host.
- **Bounded:** seven draw calls, no textures, no post-processing, DPR capped, loop
  paused when the hero is off-screen or the tab is hidden, no per-frame allocation.
- **Disposable:** programs and buffers are deleted explicitly on unmount; six
  landing ⇄ login round-trips keep one canvas and a flat post-GC heap.
- **Graceful:** WebGL absent, shader failure, context loss and render errors all
  fall back to a static gradient with no user-facing error.
- **No dependency:** nothing to audit, licence or upgrade. Full rationale in
  `UI_3D_RECOVERY_NETWORK.md` §12.

## 13. Known limitations (this stage)

The authoritative list is `UI_KNOWN_LIMITATIONS.md`. Summary:

1. **Structural redesign is partial.** Shell, sign-in, landing, overview and the
   two list screens are new; other feature screens use the new tokens and surfaces
   but keep their previous layout (L1).
2. **Tables stack into labelled cards below 720 px** and remain tables above it
   (L3 resolved).
3. **Skeleton and compact bars exist; dialogs, drawers, toasts and tooltips do
   not** (L2 partly resolved).
4. **axe, 200 %/400 % zoom and a structural layout gate run in CI; a screen-reader
   walkthrough, Firefox/WebKit and a pixel-diff gate do not** (L4/L5/L11 partly
   resolved, L6 open).
5. **The 3D chunk is 4.99 kB gzip** and is still not measured on real phones (L8).
6. **The dev-only global rate limiter (300 req/min)** can still cause retry states
   under rapid browser testing. OBS-002 remains open; the client no longer signs a
   user out on a 429.
7. **Initial load carries the motion library.** See §10.
