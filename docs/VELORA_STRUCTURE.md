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
    VELORA_CARE_PLAN.md           # Part 5 care-plan API contract, states, authority and approval transaction
    VELORA_EXTRACTION.md          # Part 6 AI contract, provider disclosure, threat model, evaluation limits
    VELORA_SCHEDULES.md           # Part 7 schedule/task/log contract, safety wording, authority and time rules
    VELORA_CARE_COORDINATION.md   # Part 8 check-in/clarification/dashboard/reminder/follow-up contract and limits
    VELORA_PRIVACY_RETENTION.md   # Part 9 closure/audit/privacy-request/retention contract, runbook and metric definitions
  e2e/
    auth.spec.js                  # login / MFA / staff journeys
    patients.spec.js              # Part 2-3 onboarding / consent / activation / episode journey
    documents.spec.js             # Part 4 upload / refusal / download journeys per viewport
    documents-quarantine.spec.js  # opt-in live quarantine journey (needs a 50 ms parser budget)
    plans.spec.js                 # Part 5 M1 journey: draft -> review -> approve -> patient read,
                                  # plus six-size measurement of the plan screens
    extractions.spec.js           # Part 6 journey: source/AI/missing/conflict/apply/dismiss +
                                  # Hindi review + patient isolation, and the provider-disabled fallback
    today.spec.js                 # Part 7 journeys: patient/self-report recording, scoped caregiver
                                  # logging, the staff schedule workspace and six-size measurement
    part9.spec.js                 # Part 9 journey: closure wizard gating, archived-episode reopen,
                                  # audit search, retention dry run, switchable metric panels
    detail-viewports.spec.js      # six-size one-viewport assertions for the detail screens
    viewports.spec.js             # six-size one-viewport assertions for the list routes
    global-setup.js               # seeds the synthetic clinic; enrols viewport sessions
  server/
    package.json
    scripts/{seed.js,seedScheduleJourney.js,mongo-test-rs.js,reconcile-documents.js,
             syntheticPdf.js,evaluate-extraction.js}
                                  # synthetic clinic + care teams; Part 7 schedule journey fixture;
                                  # local replica set; document dry run/repair;
                                  # synthetic PDF builder; deterministic extraction evaluation harness
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
              EpisodeDocument,CarePlanVersion,CarePlanItem,SourceReference,ReviewEvent,
              ExtractionJob,DraftSuggestion,ExtractedField,SourceCitation,ModelRun,
              ReviewedLanguageVariant,MedicationSchedule,RecoveryTask,
              ScheduleOccurrence,ActivityLog,CheckInTemplateVersion,CheckInResponse,
              ClarificationThread,ClarificationMessage,Notification,DeliveryAttempt,
              QueueAssignment,FollowUpPlan,EpisodeClosure,DataRequest,DataExport,
              ExportDownloadGrant,RetentionPolicy,RetentionRun,RetentionHold}.js
      policies/{carePlanPolicy,extractionPolicy,schedulePolicy,checkInPolicy,
                clarificationPolicy,clinicHoursPolicy,reminderPolicy,followUpPolicy,
                closurePolicy,dataRequestPolicy}.js
                                  # plan states/transitions, clinical fields, completeness rules;
                                  # strict extraction schema, classification, injection detection, job limits;
                                  # item->schedule mapping, PRN/missing-detail gates, UTC/DST occurrence rules;
                                  # operational (never clinical) closure rules and the privacy-request state machine
      validators/schemas.js
      controllers/{authController,staffController,patientController,caregiverController,
                   episodeController,documentController,carePlanController,
                   extractionController,scheduleController,todayController,
                   checkInTemplateController,checkInController,clarificationController,
                   dashboardController,reminderController,followUpController,
                   closureController,auditController,dataRequestController,
                   retentionController,metricsController}.js
      services/{authService,sessionService,mfaService,passwordService,
                crypto,staffService,rateLimitService,auditService,errors,txService,
                patientService,consentService,caregiverService,episodeService,
                documentStorage,documentValidator,documentInspector,documentService,
                documentTextLayer,carePlanService,extractionService,languageVariantService,
                zonedTime,scheduleService,todayService,activityLogService,
                checkInTemplateService,checkInService,clarificationService,
                dashboardService,reminderService,followUpService,clinicService,
                closureService,dataRequestService,exportStorage,retentionService,
                metricsService}.js
      providers/{extractionProvider,fakeExtractionProvider,notificationProvider}.js
                                  # provider-neutral interface + deterministic local fake, with the
                                  # registry that fails closed on an unknown provider exported from
                                  # extractionProvider.js
      workers/documentParser.js   # isolated, memory- and time-limited byte parser (no secrets)
      routes/{auth,staff,clinic,patients,patientSelf,caregiver,access,episodes,documents,plans,
              extractions,schedules,today,checkInTemplates,checkIns,clarifications,
              dashboard,reminders,followUps,episodeClosures,audit,dataRequests,
              retention,metrics}.js
    tests/
      helpers/{setup,documents}.js  # harness: env, db, factories, agents; synthetic file fixtures
      fixtures/extraction-evaluation.json  # synthetic extraction evaluation set (no real data)
      unit/{env,crypto-password,extraction-policy,document-text-layer,extraction-evaluation,
            schedulePolicy,checkInPolicy,clarificationPolicy,reminderPolicy,
            notificationProvider,closurePolicy,auditCategories,dataRequestPolicy}.test.js
      integration/{auth,staff,patients,episodes,documents,plans,extractions,languageVariants,
                   schedules,checkInTemplates,checkIns,clarifications,clinicSettings,
                   dashboard,reminders,followUps,closures,audit,privacyRequests,
                   retention,metrics}.test.js
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
        plans/{CarePlanPanel,PlanItemForm,PlanSourcePanel,PlanReviewPanel}.jsx, planRules.js
        extraction/{ExtractionPanel,LanguagePanel}.jsx, extractionRules.js
        schedules/SchedulePanel.jsx  # staff workspace: schedules, occurrences, recorded entries
        today/{TodayView,todayRules}.jsx  # one-viewport day screen, tabs, bounded panels
        queues/{AssignedQueues,ThreadView,CheckInForm}.jsx  # Part 8 staff queues, thread, answer form
        care/MyCare.jsx          # Part 8 patient/caregiver panel: check-ins, questions, follow-ups
        closure/ClosurePanel.jsx  # Part 9 closure preflight wizard, policy checks, history and reopen
        audit/AuditPanel.jsx     # Part 9 scoped, paginated audit search
        privacy/PrivacyPanel.jsx  # Part 9 export/correction/deletion-request workflow
        retention/RetentionPanel.jsx  # Part 9 category windows, dry run and gated apply
        metrics/MetricsPanel.jsx  # Part 9 switchable operational metric panels
        patient/{PatientSelf,PatientEpisodes,PatientPlan}.jsx
        caregiver/CaregiverHome.jsx
      styles.css
      test/{setup,api.test}.js, auth-flows.test.jsx, patients.test.jsx, episodes.test.jsx,
           documents.test.jsx, plans.test.jsx, extractions.test.jsx, today.test.jsx,
           queues.test.jsx, care.test.jsx, part9.test.jsx
```

## Conventions

- CommonJS (`'use strict'`) on the server; ESM + JSX on the client.
- Controllers are thin; business rules and invariants live in `services/`.
- Request validation is declarative zod (`validators/schemas.js` + `middleware/validate.js`).
- Public response shapes come from explicit `public*` mappers; never return raw documents with
  token hashes or secrets.
- Tests use only synthetic identities (`.invalid` domains).
