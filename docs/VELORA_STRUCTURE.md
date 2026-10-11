# Velora MERN - Structure

The real repository layout. Keep this file synchronized whenever files move.

```
Velora/
  .github/workflows/ci.yml        # CI gate: tests, lint, build, audit, secret scan
  .env.example                    # variable NAMES + safe placeholders only
  .gitignore
  README.md
  package.json                    # root workspace: server + client + e2e
  playwright.config.js            # browser journeys
  scripts/gen-env-values.js       # generates safe dev secrets for .env
  docs/
    VELORA_MERN_MASTER.pdf            # owner authority
    VELORA_MERN_ARCHITECTURE.pdf      # owner authority
    VELORA_MERN_DUCK_LOG.pdf          # owner authority
    VELORA_MERN_10_BUILD_PROMPTS.md   # owner's ten build prompts
    VELORA_MASTER.md                  # <- this set, synced with code
    VELORA_ARCHITECTURE.md
    VELORA_SYSTEM_DESIGN.md
    VELORA_STRUCTURE.md
    VELORA_SESSION_LOG.md
    VELORA_DOCUMENT_STORAGE.md    # Part 4 document API, storage setup and recovery runbook
  e2e/
    auth.spec.js                  # login / MFA / staff journeys
    patients.spec.js              # Part 2-3 onboarding / consent / activation / episode journey
    documents.spec.js             # Part 4 upload / refusal / download journeys per viewport
    documents-quarantine.spec.js  # opt-in live quarantine journey (needs a 50 ms parser budget)
    detail-viewports.spec.js      # six-size one-viewport assertions for the detail screens
    viewports.spec.js             # six-size one-viewport assertions for the list routes
    global-setup.js               # seeds the synthetic clinic; enrols viewport sessions
  server/
    package.json
    scripts/{seed.js,mongo-test-rs.js,reconcile-documents.js}
                                  # synthetic clinic + care teams; local replica set; document dry run/repair
    src/
      app.js                      # express app assembly
      index.js                    # fail-closed startup, listen, graceful shutdown
      config/{env,db,constants}.js
      middleware/{auth,csrf,errorHandler,rateLimit,security,validate,
                  boundedBody,documentAccess,documentLimits}.js
      models/{User,Clinic,ClinicMembership,MembershipRole,Invitation,
              Session,MfaRecoveryCode,PasswordReset,RateLimitBucket,AuditEvent,
              PatientProfile,PatientAssignment,PatientConsent,CaregiverGrant,
              AccessInvitation,RecoveryEpisode,CareTeamAssignment,EpisodeCorrection,
              EpisodeDocument}.js
      validators/schemas.js
      controllers/{authController,staffController,patientController,caregiverController,
                   episodeController,documentController}.js
      services/{authService,sessionService,mfaService,passwordService,
                crypto,staffService,rateLimitService,auditService,errors,txService,
                patientService,consentService,caregiverService,episodeService,
                documentStorage,documentValidator,documentInspector,documentService}.js
      workers/documentParser.js   # isolated, memory- and time-limited byte parser (no secrets)
      routes/{auth,staff,clinic,patients,patientSelf,caregiver,access,episodes,documents}.js
    tests/
      helpers/{setup,documents}.js  # harness: env, db, factories, agents; synthetic file fixtures
      unit/{env,crypto-password}.test.js
      integration/{auth,staff,patients,episodes,documents}.test.js
  client/
    package.json
    vite.config.js                # dev proxy /api -> API (overridable)
    index.html
    src/
      main.jsx
      app/router.jsx              # public routes + protected /app shell
      lib/api.js                  # cookie-session fetch wrapper + CSRF + raw upload/blob download
      features/
        public/Landing.jsx
        auth/{AuthContext,Login,MfaVerify,MfaEnroll,ForgotPassword,
              ResetPassword,AcceptInvite}.jsx
        app/{AppShell,Dashboard,ClinicSettings,Profile}.jsx
        patients/{PatientList,PatientDetail}.jsx
        episodes/{EpisodeList,EpisodeDetail}.jsx
        documents/{DocumentsPanel,DocumentUpload}.jsx, documentRules.js
        patient/{PatientSelf,PatientEpisodes}.jsx
        caregiver/CaregiverHome.jsx
      styles.css
      test/{setup,api.test}.js, auth-flows.test.jsx, patients.test.jsx, episodes.test.jsx,
           documents.test.jsx
```

## Conventions

- CommonJS (`'use strict'`) on the server; ESM + JSX on the client.
- Controllers are thin; business rules and invariants live in `services/`.
- Request validation is declarative zod (`validators/schemas.js` + `middleware/validate.js`).
- Public response shapes come from explicit `public*` mappers; never return raw documents with
  token hashes or secrets.
- Tests use only synthetic identities (`.invalid` domains).
