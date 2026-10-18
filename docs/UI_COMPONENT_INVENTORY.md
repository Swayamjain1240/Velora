# Velora UI — component inventory

Current tree: `client/src` on `feat/ui-redesign-dark-purple`. Every component is
plain JSX (no TypeScript, no component library). Class names in the inventory are
the contract the stylesheets style; ids, `name` attributes and test ids are the
contract the tests and browser journeys depend on.

## 1. Shared layer

| File | Export | Purpose | Notes |
| --- | --- | --- | --- |
| `components/Icon.jsx` | `Icon` | Inline SVG glyph set (22 icons: navigation, status, actions) | `aria-hidden` by default; `title` prop adds an accessible name only when the icon is the sole label |
| `components/ResponsiveTable.jsx` | `ResponsiveTable` | Semantic table above 720 px, labelled cards below | Labels cells from the rendered `<thead>`, adds explicit ARIA roles, labels late rows via `MutationObserver` |
| `components/Skeleton.jsx` | `Skeleton` | Loading placeholder with a known shape | `aria-hidden`; the caller keeps a real `role="status"` message; static under reduced motion |
| `components/MiniBars.jsx` | `MiniBars` | Compact proportional bars beside a table | `aria-hidden` duplicate; the table is the accessible source |
| `lib/api.js` | `api`, `ApiError` | Cookie-session fetch wrapper with `X-CSRF-Token` double submit | No token in storage; `no-store` responses |
| `lib/motion.js` | `MOTION`, `gsap`, `useReducedMotion`, `usePageTransition`, `useReveal`, `pulse` | The only place that creates a tween | See `UI_ANIMATION_GUIDELINES.md` |
| `lib/useMediaQuery.js` | `useMediaQuery` | Reactive media query, initialised during first render | Used by the hero for tiering; jsdom returns `false` so tests keep the desktop branch |
| `features/auth/AuthContext.jsx` | `AuthProvider`, `useAuth` | Session truth: `user`, `memberships`, `loading`, `authenticated`, `mfaPending`, `unavailable`, `refresh`, `login`, `logout` | A failed status check no longer signs the user out |
| `features/public/recovery/HeroVisual.jsx` | `HeroVisual` | Host for the decorative 3D scene: capability probe, lazy import, error boundary, visibility/pause, static fallback | Renders no canvas when WebGL is unavailable |
| `features/public/recovery/RecoveryNetwork.jsx` | `RecoveryNetwork` | The Recovery Network scene itself (lazy chunk) | Loaded only by `HeroVisual` |

## 2. Application shell

| Component | Structure | States |
| --- | --- | --- |
| `features/app/AppShell.jsx` | `<aside>` sidebar (brand, grouped `<nav aria-label="Application">`, clinic chip) + `<header>` (collapse toggle, section title, identity, Sign out) + `<main>` with a keyed transition wrapper | expanded, collapsed rail, tablet/phone horizontal rail, active route, focus, page transition |

Navigation groups: Workspace · Clinical *or* My care *or* Shared with me ·
Operations (staff/admin) · Account. Role predicates (`admin`,
`care_coordinator`, `clinical_reviewer`, `patient`, `caregiver`) are unchanged from
the pre-redesign shell; no link was added or removed.

## 3. Authentication screens

| Component | Controls | States |
| --- | --- | --- |
| `Login` | `#email`, `#password`, `.password-toggle` (`aria-pressed`), submit | idle, busy, error (`role="alert"`), password shown/hidden |
| `MfaVerify` | `#code`, recovery-code toggle | pending, error, recovery mode |
| `MfaEnroll` | `[data-testid="mfa-secret"]`, `.recovery-codes`, `#code` | secret issued, verified, codes shown once |
| `ForgotPassword` | `#email` | idle, sent (generic copy) |
| `ResetPassword` | password + confirmation | idle, invalid token, done |
| `AcceptInvite` | name, password, confirmation | idle, expired invitation, done |

No auth screen reveals whether an account exists; the server's generic message is
rendered verbatim.

## 4. Feature components

| File | Role surface | Composed of |
| --- | --- | --- |
| `app/Dashboard.jsx` | any member | page header, `.info-grid`, `.info-card` |
| `app/ClinicSettings.jsx` | admin | members table, role editor, invitation panel |
| `app/Profile.jsx` | any member | profile form, active sessions, revoke |
| `patients/PatientList.jsx` | staff | search, paginated list (table ≥720 px, cards ≤719 px), onboarding wizard (2 steps) |
| `metrics/MetricsPanel.jsx` | staff/admin | tabbed panels, `ResponsiveTable`, `MiniBars`, `Skeleton` loading state |
| `patients/PatientDetail.jsx` | staff | profile, consent history, caregiver grants, assignment |
| `episodes/EpisodeList.jsx` | staff | filters, paginated list (table ≥720 px, cards ≤719 px), 3-step creation wizard |
| `episodes/EpisodeDetail.jsx` | staff | tabs: documents, plans, extraction, schedules, closure |
| `documents/DocumentsPanel.jsx` + `DocumentUpload.jsx` | staff | upload, validator state, quarantine, download |
| `extraction/ExtractionPanel.jsx` + `LanguagePanel.jsx` | verified reviewer | job state, suggestions, field review, language variants |
| `plans/CarePlanPanel.jsx` + `PlanItemForm.jsx` + `PlanReviewPanel.jsx` + `PlanSourcePanel.jsx` | staff / reviewer | draft items, source links, review actions, approved read-only view |
| `schedules/SchedulePanel.jsx` | staff | schedule preparation, activation, occurrences |
| `closure/ClosurePanel.jsx` | staff | closure wizard, blocking overrides with reasons |
| `queues/AssignedQueues.jsx` + `ThreadView.jsx` + `CheckInForm.jsx` | staff | queue, clarification thread, check-in recording |
| `today/TodayView.jsx` | patient, caregiver | day tabs, medication/task rows, provenance, correction notes |
| `care/MyCare.jsx` | patient, caregiver | approved plan, check-ins, questions, follow-ups |
| `patient/PatientSelf.jsx`, `PatientEpisodes.jsx`, `PatientPlan.jsx` | patient | own record, own episodes, approved plan |
| `caregiver/CaregiverHome.jsx` | caregiver | patients shared with the caller |
| `metrics/MetricsPanel.jsx` | staff, admin | metric cards and tables from the existing payload |
| `privacy/PrivacyPanel.jsx` | staff, admin | request list, export/correction/deletion-request |
| `audit/AuditPanel.jsx` | admin | scoped filters, paginated append-only events |
| `retention/RetentionPanel.jsx` | admin | dry run, apply, holds |
| `public/Landing.jsx` | public | hero with `HeroVisual`, two content sections, footer |

Rule helpers (no JSX) hold state vocabularies and safe copy:
`documents/documentRules.js`, `extraction/extractionRules.js`,
`plans/planRules.js`, `today/todayRules.js`. They keep clinical wording out of
components so a state label is defined once.

## 5. Patterns that exist as CSS, not components

`.card`, `.info-card`, `.panel`, `.panel-page`, `.page-head`, `.page-eyebrow`,
`.page-sub`, `.btn` (`--primary`, `--ghost`, `--danger`), `.pill--<status>`,
`.tabs`, `.table`, `.pagination`, `.stepper`, `.wizard`, `.field`, `.check`,
`.password-field`, `.empty`.

There is **no** shared dialog, drawer, toast, tooltip, skeleton, chart, breadcrumb
or illustration component yet. Confirmations are inline; loading is a text
`role="status"`; errors are inline text or `role="alert"`. Those extractions are
Stage 2 in `UI_REDESIGN_DUCK_REVIEW.md` §9.

## 6. Dependency usage

| Dependency | Used by | Load |
| --- | --- | --- |
| `react`, `react-dom` 18.3 | all | main chunk |
| `react-router-dom` 7.18 | `main.jsx`, `router.jsx`, `AppShell` | main chunk |
| `gsap` 3.15 | `lib/motion.js`, `Landing.jsx` | main chunk (motion layer) |

No other runtime dependency exists, and no 3D library is installed: the scene is
hand-written WebGL in a lazy 4.99 kB gzip chunk. The rationale and measurements
are in `UI_3D_RECOVERY_NETWORK.md`.
