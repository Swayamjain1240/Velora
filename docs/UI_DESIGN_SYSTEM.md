# Velora UI design system

Describes the interface that exists on branch `feat/ui-redesign-dark-purple`.
Scope of this document: the design system, the application shell, the sign-in
surface, the landing page, and the motion layer — the parts changed so far.
Screens not yet structurally revised still inherit every token and surface rule
here, because the stylesheet is global.

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
| Landing hero and sections | `.landing*` | scroll page, reveal animation |

Not yet built (Stage 2): dialog, drawer, toast, tooltip, skeleton, chart,
breadcrumb, dedicated empty/error illustrations. Where those patterns already
exist inline they are restyled but not yet extracted.

## 6. Motion

`client/src/lib/motion.js` is the only place that creates a tween.

- Tokens: instant 90 ms, fast 150, base 240, slow 380, reveal 450. Only
  `opacity` and `transform` are animated.
- `usePageTransition(ref, routeKey)` fades/raises the screen by 8 px on route
  change, keyed on pathname so rerenders do not replay it.
- `useReveal(ref, { selector })` staggers at most 12 children by 40 ms.
- `gsap.context()` scopes every timeline and `ctx.revert()` runs on unmount.
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
| Cross-browser (Firefox, Safari) | NOT RUN — Chromium only |

## 8. One-viewport evidence

Screens measured at 1440×900, 768×1024, 390×844, 320×568, 844×390 and 320×400
for five role sessions (reviewer, admin, coordinator, patient, caregiver):
**144 route checks, 0 failures** — no document-level vertical overflow, no
horizontal page overflow, no clipping by `overflow: hidden`, Sign out visible,
and no horizontal scrolling of the main pane at rest.

`e2e/viewports.spec.js` (30 tests) + `e2e/accessibility.spec.js` (1 test):
**31/31 passed** against the API in its documented e2e topology
(`NODE_ENV=test`, port 4100, Vite 5173), run on this branch.

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
| Client unit/component | `npm test -w client` | **61/61 passed**, 11 files |
| Lint | `npm run lint -w client` | **clean** |
| Production build | `npm run build -w client` | **built** |
| Browser: viewport + a11y | `npx playwright test e2e/viewports.spec.js e2e/accessibility.spec.js` | **31/31 passed** |
| Six-size audit (all five sessions) | `/tmp viewport-audit.js` (same measurements, all routes) | **144 checks, 0 failures** |
| Reduced motion | Playwright `reducedMotion: 'reduce'` probe | **opacity 1, no inline style** |
| Dependency audit | `npm audit --omit=dev` | **0 vulnerabilities** |

Not run for this stage: server suite (no server change), other Playwright
journeys (unchanged flows, but a full e2e pass belongs to Stage 7), axe,
Lighthouse, cross-browser, screen reader, visual regression.

## 10. Performance

Measured on the same machine, production build:

| Asset | Before | After | Delta |
| --- | --- | --- | --- |
| JS | 368.38 kB / 101.34 kB gzip | 448.69 kB / 132.26 kB gzip | +80.31 kB / **+30.92 kB gzip** |
| CSS | 13.47 kB / 3.02 kB gzip | 36.16 kB / 7.32 kB gzip | +22.69 kB / +4.30 kB gzip |

The JS delta is GSAP 3.15.0 plus the shell, icons and motion module. It is a
known cost, not an accident. Follow-up options if it must shrink: import
`gsap/gsap-core` with CSS plugin registered explicitly, or load the motion module
through a dynamic import on first navigation.

## 11. Dependency decision: GSAP

- **Why:** the request names GSAP as the animation system; it provides context
  scoping and timeline cleanup that a hand-rolled rAF would have to reproduce.
- **Version:** 3.15.0, licence *Standard "no charge" licence* (free for this
  application's use; recorded in `client/package.json` and the lockfile).
- **Audit:** `npm audit --omit=dev` → 0 vulnerabilities.
- **Bundle:** measured above; no plugin imports (no ScrollTrigger).
- **Rejected alternatives:** CSS-only transitions (no timeline control, no
  stagger cleanup), Framer Motion (an overlapping animation library).

## 12. Three.js decision: omitted for now

Three.js is not a dependency of this branch. Reasons, not preferences:

- The only fitting surface is the landing hero or the auth backdrop. A WebGL
  scene there adds a renderer, a context and a GPU wake-up to a page whose job is
  to load fast, for decoration the CSS glow already provides.
- The request explicitly allows omission when the value is not high enough, and
  requires lazy loading, disposal, tab-visibility pausing and a static fallback
  if it is used.
- Revisit criteria: a concrete hero concept, a measured budget (≤60 kB gzip on
  the landing route, loaded after first paint), and a device test showing no
  battery or frame-rate cost on a low-end phone.

## 13. Known limitations (this stage)

1. **Structural redesign is partial.** Shell, sign-in, landing and the overview
   are new. Patients, episodes, plans, documents, queues, today and the admin
   consoles use the new tokens and surfaces but keep their existing layout.
2. **Tables stay tables on phones.** They scroll inside a bounded region rather
   than becoming cards; the request's "no desktop table compressed into a phone
   width" goal is only partly met.
3. **No dialogs, drawers, toasts, skeletons, tooltips or charts yet.** Existing
   confirmations remain inline.
4. **No axe/Lighthouse, screen-reader, zoom, cross-browser or visual-regression
   run.** Contrast is verified by token calculation, not by tooling.
5. **The dev-only global rate limiter can log a user out.** With
   `NODE_ENV=development` the API allows 300 requests/minute per IP; a
   browser-test burst exceeds it, `/api/auth/status` answers 429, and
   `AuthContext` currently treats any non-401 failure as "not signed in",
   rendering the login screen. Observed during this work (OBS-002). It is a
   pre-existing behaviour, reproduced only under the development limiter, and
   not changed here — the redesign must not quietly alter auth semantics.
6. **Initial load carries the motion library.** See §10.
