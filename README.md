# Velora

Velora is an AI-assisted post-discharge care platform that transforms hospital discharge documents into clinician-approved recovery plans. It helps patients and caregivers manage medication reminders, daily tasks and recovery check-ins through secure coordination with care teams.

## Current implementation

Part 1 foundation: FastAPI session authentication, clinic-scoped memberships, staff invitations, administrative settings and a Next.js workspace. Patient records, clinical workflows and AI extraction are not implemented yet. Code 2 (Tests & Follow-ups) remains deferred.

**Synthetic development prototype only.** Invitations are manually shared development links; no email is sent. Staff MFA, password recovery, verified delivery, distributed atomic rate limiting and PostgreSQL integration verification remain pending. Production startup is deliberately disabled until readiness gaps are resolved.

## Local setup (Windows PowerShell)

Prerequisites: Git, Python 3.12+, a supported Node.js version (tested with 24.19), and a local PostgreSQL database. Create a development database/user and substitute your connection string in `backend/.env`. Never commit credentials.

```powershell
git clone https://github.com/Swayamjain1240/Velora.git
cd Velora
git checkout feat/part-1-foundation
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env with your local PostgreSQL connection string.
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m app.bootstrap --email admin@example.com --clinic "Velora Demo Clinic"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Bootstrap prompts for a password, creates a synthetic clinic and admin, and refuses to overwrite existing accounts. It does not grant clinical privileges. `.env.example` credentials are placeholders, not deployed credentials.

In another terminal, from the repository root:

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000. API docs: http://localhost:8000/docs. Use `localhost` consistently (do not mix it with `127.0.0.1`). Frontend and backend use different local ports with explicit credentialed CORS. Mutation requests require the configured Origin and authenticated mutations also require a CSRF token; Swagger alone does not handle this UI session flow automatically.

For a quick **SQLite-only** synthetic smoke run, use `DATABASE_URL=sqlite:///./velora-dev.db` in `.env`. This is not a replacement for PostgreSQL migration/concurrency testing.

## Try the workflow

1. Sign in as the bootstrap admin.
2. Select the clinic, save contact/response hours and load staff.
3. Create a coordinator or unverified reviewer invitation using a synthetic email.
4. Copy the one-time development link into a separate browser profile. Set a 12+ character password and accept.
5. Sign in with that invited email. The user can access their clinic but cannot manage staff.
6. Deactivate the staff membership as admin; subsequent clinic requests must be denied.
7. Sign out; the session is revoked server-side.

An existing invited account must sign in before accepting. Acceptance never overwrites an existing password. A reviewer invitation never verifies clinical eligibility. Admin role alone never grants clinical access. Admin role changes are reserved for a controlled process, not this invitation endpoint.

## How the code fits together

- `backend/app/main.py`: HTTP routes, origin guard and workflow orchestration.
- `backend/app/security.py`: Argon2 password hashing, session lookup and membership policy.
- `backend/app/models.py`: clinic memberships, role grants, sessions, invitations and audit records.
- `backend/app/schemas.py`: input validation and permitted invitation roles.
- `backend/app/bootstrap.py`: controlled initial admin setup.
- `backend/migrations/`: versioned schema, applied explicitly rather than creating tables at server startup.
- `frontend/src/app/page.tsx`: login, acceptance, workspace selection and administrative forms.

Request flow: UI → FastAPI → session validation → clinic membership/role check → database transaction → response. Raw session and invitation tokens are not stored in the database. Clinical-record permission checks will additionally require episode assignment when those models exist.

## Checks

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
cd ../frontend
npm run lint
npm run build
```

Backend tests use isolated SQLite databases with foreign keys enabled. They cover clinic isolation, CSRF/origin denial, logout, expiry, membership deactivation, invitation expiry/revocation/reuse, account takeover prevention, admin-grant denial, sequential throttling and clinical eligibility boundaries. They do not establish PostgreSQL concurrency or real-browser end-to-end behavior.

## Project authority

Read the three baseline PDFs already present at the repository root: `VELORA_MASTER.pdf`, `ARCHITECTURE.pdf` and `SESSION_LOG.pdf`. This branch adds implementation code and setup instructions; it does not publish additional copies of private project documents.

Framework references: [FastAPI password hashing](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/) and [Next.js setup](https://nextjs.org/docs/app/getting-started/installation). Velora uses opaque server-side sessions rather than the JWT example in that FastAPI tutorial.

Verified in this development environment: seven backend tests, frontend lint, TypeScript checking and `npx next build --webpack` passed. Default Turbopack could not run under this environment's port/process restrictions. PostgreSQL integration and browser interaction are still unverified.
