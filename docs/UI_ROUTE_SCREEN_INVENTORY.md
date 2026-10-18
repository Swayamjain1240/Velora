# Velora UI — route and screen inventory

Describes the interface on branch `feat/ui-redesign-dark-purple` as it exists in
`client/src/app/router.jsx`. Counts are of source declarations, not of screens a
role can reach; a role sees only the routes its server-issued membership allows.

Route definitions: **25** — 7 public, 17 inside the authenticated shell
(1 layout route + 16 children), 1 catch-all.
JSX: **42 files, 9,020 lines** under `client/src/features` + `client/src/components`.
Stylesheets: **5 files, 2,481 lines** (`styles.css` imports `tokens`, `base`,
`components`, `screens`).

| # | Path | Screen component | Entry | Surface |
| --- | --- | --- | --- | --- |
| 1 | `/` | `features/public/Landing` | public | scrolling marketing page; the only deliberate scroll surface |
| 2 | `/login` | `features/auth/Login` | public | single panel, staff credentials |
| 3 | `/login/mfa` | `features/auth/MfaVerify` | public, MFA-pending session | TOTP or recovery code |
| 4 | `/login/enroll` | `features/auth/MfaEnroll` | public, forced enrolment | secret + verification |
| 5 | `/forgot-password` | `features/auth/ForgotPassword` | public | request a reset link |
| 6 | `/reset-password/:token` | `features/auth/ResetPassword` | public | set a new password |
| 7 | `/accept-invite/:token` | `features/auth/AcceptInvite` | public | invitation acceptance |
| 8 | `/app` | `features/app/Dashboard` | any active member | Overview: identity, clinic, scope, safety boundaries |
| 9 | `/app/clinic` | `features/app/ClinicSettings` | admin | members, roles, invitations |
| 10 | `/app/patients` | `features/patients/PatientList` → `PatientDetail` | staff | directory (cards ≤719 px, table above), then profile/consent/caregivers |
| 11 | `/app/episodes` | `features/episodes/EpisodeList` → `EpisodeDetail` | staff | episodes, documents, plans, extraction, schedules, closure |
| 12 | `/app/queues` | `features/queues/AssignedQueues` | staff | queue list, `ThreadView`, `CheckInForm` |
| 13 | `/app/today` | `features/today/TodayView` | patient, caregiver (assigned staff read) | day view, medication/task entries |
| 14 | `/app/me` | `features/patient/PatientSelf` | patient | own record |
| 15 | `/app/me/episodes` | `features/patient/PatientEpisodes` | patient | own recovery, approved plans only |
| 16 | `/app/me/care` | `features/care/MyCare` (`mode="patient"`) | patient | check-ins, questions, follow-ups |
| 17 | `/app/caregiver` | `features/caregiver/CaregiverHome` | caregiver | patients shared with the caller |
| 18 | `/app/caregiver/:patientId/care` | `features/care/MyCare` (`mode="caregiver"`) | caregiver with an active grant | grant-scoped care panel |
| 19 | `/app/metrics` | `features/metrics/MetricsPanel` | staff, admin | workflow metrics |
| 20 | `/app/privacy` | `features/privacy/PrivacyPanel` | staff, admin | privacy request lifecycle |
| 21 | `/app/audit` | `features/audit/AuditPanel` | admin | append-only audit search |
| 22 | `/app/retention` | `features/retention/RetentionPanel` | admin | dry run, apply, holds |
| 23 | `/app/profile` | `features/app/Profile` | any member | profile and active sessions |
| 24 | `/app` (layout) | `features/app/AppShell` | authenticated | fixed sidebar + top bar + `<Outlet />` |
| 25 | `*` | redirect | public | → `/` |

## Nested views (no URL of their own)

`PatientsRoute` and `EpisodesRoute` swap list → detail in component state. The
selection is not in the URL, so the document never grows a second route level and
"back" is a plain state reset. Detail screens therefore remain one viewport tall
by construction, and a reload returns to the list.

## Guards

| Condition | Result |
| --- | --- |
| Session check in flight | `role="status"` "Checking your session…" |
| Status check failed with a network error, 429 or 5xx | retry panel — **not** the login form; the session is not revoked |
| Not authenticated | `/login`, or `/login/mfa` when an MFA step is pending |
| Authenticated but MFA pending | `/login/mfa` |
| Authenticated, no clinic membership | server answers 403 to scoped calls; the shell still renders identity |

The guards are UX only. Every API call is authorised again by the server, and the
navigation links in `AppShell` only hide what the role cannot use.

## Screens outside the shell

The landing page scrolls by design. Every other public screen is a single centred
panel (`.panel-page`), and every screen inside `/app` sits in the fixed shell where
only inner panes scroll. Error and empty states stay inside the same surface, so
no state introduces document scrolling.

## Screen-level notes for the 3D experience

The Recovery Network canvas is mounted on `/` only. No authenticated screen loads
the WebGL scene: it is a dynamic import from
`features/public/recovery/HeroVisual`, and the chunk is therefore only requested
when the landing page renders in a WebGL-capable browser.
