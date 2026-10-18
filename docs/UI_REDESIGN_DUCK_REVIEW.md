# Velora — UI/UX redesign: DUCK review

Stage 0 record. Written after reading the code, before changing it. Branch
`feat/ui-redesign-dark-purple`, based on `main` @ `036c27a`.

The redesign is presentation work. Nothing in this document authorises a change
to an API contract, a permission, a validation rule or a security control.

---

## 1. Current frontend architecture

- **Framework:** React 18.3 + `react-router-dom` 7.18, plain JavaScript (JSX). No
  TypeScript, no state library, no CSS-in-JS, no component library.
- **Build:** Vite 5.4 (`client/vite.config.js`), ESLint 8, Vitest 2 + Testing
  Library. Dev server on 5173 proxies `/api` to the Express API, so cookies stay
  same-origin.
- **Entry:** `client/src/main.jsx` → `BrowserRouter` → `AuthProvider` → `App`.
- **State:** one React context (`AuthContext`) mirroring `/api/auth/status`.
  Every screen fetches its own data through `client/src/lib/api.js` (cookie
  session + `X-CSRF-Token` double-submit; no tokens in storage).
- **Authorization:** the server is the boundary. The client only hides
  navigation it knows the role cannot use; the route guard is explicitly UX-only.
- **Screens:** 39 feature components, 8,344 lines of JSX.
- **Tests:** 11 client test files (61 tests), 12 Playwright specs at the repo root.
- **Bundles at baseline:** JS 368.38 kB (101.34 kB gzip), CSS 13.47 kB (3.02 kB gzip).

## 2. Route and screen inventory

26 `<Route>` entries; 7 public, 19 inside the authenticated shell.

| Path | Screen | Roles that reach it |
| --- | --- | --- |
| `/` | Landing | public |
| `/login`, `/login/mfa`, `/login/enroll` | Sign-in, second factor, forced enrolment | public |
| `/forgot-password`, `/reset-password/:token` | Password reset request / completion | public |
| `/accept-invite/:token` | Invitation acceptance | public |
| `/app` | Overview | any signed-in member |
| `/app/patients` (list → detail, state-swapped) | Patient directory, profile, consent, caregivers | staff |
| `/app/episodes` (list → detail) | Recovery episodes, documents, plans, closure | staff |
| `/app/queues` | Assigned queues, threads, check-ins | staff |
| `/app/today` | Day view / medication + task log | patient, caregiver |
| `/app/me`, `/app/me/episodes` | Patient records and recovery | patient |
| `/app/me/care` | Patient self-care (check-ins, questions, follow-ups) | patient |
| `/app/caregiver`, `/app/caregiver/:id/care` | Caregiver home and grant-scoped care | caregiver |
| `/app/metrics` | Operational metrics panels | staff, admin |
| `/app/privacy` | Privacy request lifecycle | staff, admin |
| `/app/audit` | Audit trail | admin |
| `/app/retention` | Retention console | admin |
| `/app/clinic` | Clinic members, roles, invitations | admin |
| `/app/profile` | Profile and active sessions | any member |
| `*` | Redirect to `/` | public |

## 3. Component and design-system inventory

There was **no shared component layer**. Screens composed bare HTML with global
class names: 179 `btn`, 115 `muted`, 26 `table`, 23 `card`, 21 `pill`, 20
`inline-form`, 10 `tabs`, 6 `stepper`, plus feature-specific blocks
(`plans__*`, `today__*`, `thread__*`, `checkin-form__*`, `care-list__*`).
There were **no** dialog, toast, tooltip, drawer, skeleton, chart, icon or
breadcrumb components, and no icon or chart dependency — icons were absent,
confirmations used inline text and buttons.

Roles/status were expressed with `.pill--<status>` classes, always with a text
label. That is the property to preserve: colour decorates, text informs.

## 4. CSS / styling approach

One 439-line `client/src/styles.css`, nine custom properties
(`--bg --surface --border --text --muted --primary --primary-contrast --danger
--focus`), light theme, green primary (`#14532d`), system font stack. Layout was
already one-viewport: `.shell { position: fixed; inset: 0 }` with inner scroll
regions (`.shell__main`, `.panel-scroll`, `.wizard__body`, table bodies).

There were no spacing, radius, shadow, motion, z-index or breakpoint tokens, and
no dark theme. Media queries existed at 900, 720, 640 and 480 px.

## 5. Animation dependencies

None. No GSAP, no Three.js, no animation utility, no CSS keyframes. State
changes were instant. `prefers-reduced-motion` was not referenced.

## 6. Areas that need redesign

1. **Token layer** — no semantic palette, type scale, spacing scale, elevation,
   radius, motion or z-index scale.
2. **Shell** — a single wrapping header with 12+ links; on a phone it became
   several rows tall and consumed most of the viewport.
3. **Navigation** — no grouping, no active-section context, no collapse, no
   icons; identity and role were plain text.
4. **Controls** — inputs/selects/buttons were unstyled browser widgets; no
   password visibility control; no consistent focus treatment.
5. **Surfaces** — one flat white card style; no elevation, no page header
   pattern, tables with no sticky header or zebra, no empty/loading visuals.
6. **Status** — pills had light backgrounds that cannot survive a dark theme.
7. **Motion** — nothing; no page transition, no reveal, no reduced-motion path.
8. **Brand** — landing page and sign-in looked like a scaffold, not a product.
9. **Responsive** — table-heavy screens relied on horizontal squeeze; narrow
   layouts had no compact identity or navigation affordance.

## 7. Functionality that must remain unchanged

Every item on the request's preservation list, restated as testable invariants:

- All API paths, payloads, status codes and the `{ error: { code, message,
  issues } }` envelope.
- Cookie session + CSRF behaviour; no token in client storage.
- Route guards: unauthenticated → `/login`, MFA-pending → `/login/mfa`.
- Role-based navigation visibility (staff / patient / caregiver / admin) exactly
  as `AppShell` expresses it today.
- Clinic scoping and server-side authorization on every request.
- Every form field `id`, `name`, `label`, validation attribute and error copy
  that a journey or test depends on (`#email`, `#password`, `#code`,
  `[data-testid="mfa-secret"]`, `.recovery-codes`).
- One-viewport rule for every authenticated screen.
- The safety copy: no screen may imply diagnosis, prescription, urgency
  decisions, automatic AI publication or declared recovery.

## 8. Security-sensitive components

| Component | Why it is sensitive | Rule for this work |
| --- | --- | --- |
| `AuthContext` | session truth, logout on 401/403 | presentation-only edits; no new storage |
| `lib/api.js` | CSRF header, cookie credentials | untouched |
| `Login`, `MfaVerify`, `MfaEnroll`, `AcceptInvite`, `ResetPassword` | credential handling, generic errors | no copy that reveals account existence; no autofill regressions |
| `AppShell` | what a role is shown | same predicates, still UX-only |
| `DocumentsPanel`, `DocumentUpload` | private discharge files | no preview of active content, no HTML rendering of metadata |
| `ExtractionPanel`, `PlanSourcePanel` | AI suggestions vs approved content | the visual distinction must get stronger, never weaker |
| `AuditPanel`, `PrivacyPanel`, `RetentionPanel`, `ClinicSettings` | admin-only data and destructive actions | same controls, same confirmations |
| All screens | XSS surface | never `dangerouslySetInnerHTML`; React text nodes only |

## 9. Proposed implementation stages

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Tokens, base layer, component surfaces, shell, sign-in, landing, motion system | **delivered in this change** |
| 2 | Shared controls: field wrapper, select/search, dialogs, drawers, toasts, skeletons, empty/error states, breadcrumbs | pending |
| 3 | Screen structure pass: patients, episodes, plans, documents, queues, today, admin (page headers, master-detail, wizards, pagination) | pending |
| 4 | Charts and metric cards from existing metrics payloads | pending |
| 5 | Mobile-specific table→card presentation and per-screen one-panel workflows | pending |
| 6 | Three.js Recovery Network on the landing hero, lazy-loaded and measured | **delivered** — `UI_3D_RECOVERY_NETWORK.md` |
| 7 | Full QA: cross-browser, screen reader, axe, visual regression, animation cleanup, final audit | pending (stage-1 subset delivered: 144-route audit, 35 browser journeys, 18 hero checks, visual baseline) |

Each stage ends with: tests → `git diff` review → secret check → commit → push →
DUCK log entry.

## 10. Risks and rollback

| Risk | Mitigation |
| --- | --- |
| Global stylesheet change breaks a screen not opened in review | class-name inventory taken before editing; every existing class keeps its contract; 144-route viewport audit over all six sizes |
| Layout regression violates one-viewport rule | `e2e/viewports.spec.js` remains the gate (30 tests) plus the 144-check audit |
| Tests depend on labels/ids that the redesign renames | no copy, id, `name` or test-id changes; the one ambiguous query (password field vs "Show password" button) was made specific, not weakened |
| GSAP adds main-bundle weight or leaks | version/licence checked, audit run, bundle measured, timelines created in `gsap.context()` and reverted, content visible at 0.6 opacity and a failsafe |
| Animation hides clinical information | no animation over 450 ms; reduced motion disables it; failsafe clears state |
| Unrelated churn | no server, route, schema, permission or dependency upgrade in this change |

Rollback: the redesign is confined to `client/src/styles*`, `client/src/lib/motion.js`,
`client/src/components/Icon.jsx` and four presentation components
(`AppShell`, `Dashboard`, `Login`, `Landing`). Reverting the branch, or those
files, restores the previous interface with no data or API consequences.

---

## Check against the authority documents

`README.md`, `docs/VELORA_MERN_MASTER.pdf`, `docs/VELORA_MERN_ARCHITECTURE.pdf`
and `docs/VELORA_MERN_DUCK_LOG.pdf` were re-read for this review. Two constraints
from them drive the plan:

- **One-viewport application rule (README §One-viewport):** authenticated
  screens must not scroll the document, and content must never be clipped. The
  new shell keeps `position: fixed` and sized inner scroll regions.
- **Clinician approval and AI boundaries:** AI output is never presented as
  approved content. The redesign strengthens the visual distinction between
  draft/suggested and approved states; it does not merge them.
