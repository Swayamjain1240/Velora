'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const {
  securityHeaders,
  corsPolicy,
  requestContext,
  resolveTrustProxy,
} = require('./middleware/security');
const { getEnv } = require('./config/env');
const healthRoutes = require('./routes/health');
const { csrfProtection, originProtection } = require('./middleware/csrf');
const { loadSession } = require('./middleware/auth');
const { requestMetrics } = require('./services/processMetrics');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const clinicRoutes = require('./routes/clinic');
const patientRoutes = require('./routes/patients');
const patientSelfRoutes = require('./routes/patientSelf');
const caregiverRoutes = require('./routes/caregiver');
const accessRoutes = require('./routes/access');
const episodeRoutes = require('./routes/episodes');
const documentRoutes = require('./routes/documents');
const planRoutes = require('./routes/plans');
const extractionRoutes = require('./routes/extractions');
const scheduleRoutes = require('./routes/schedules');
const todayRoutes = require('./routes/today');
const checkInTemplateRoutes = require('./routes/checkInTemplates');
const checkInRoutes = require('./routes/checkIns');
const clarificationRoutes = require('./routes/clarifications');
const reminderRoutes = require('./routes/reminders');
const dashboardRoutes = require('./routes/dashboard');
const followUpRoutes = require('./routes/followUps');
const episodeClosureRoutes = require('./routes/episodeClosures');
const auditRoutes = require('./routes/audit');
const dataRequestRoutes = require('./routes/dataRequests');
const retentionRoutes = require('./routes/retention');
const metricsRoutes = require('./routes/metrics');

function buildApp() {
  const env = getEnv();
  const app = express();

  // Proxy trust is a DEPLOYMENT decision, never a default (control #12). With
  // TRUST_PROXY=false the socket address is the client address and a forged
  // X-Forwarded-For is ignored; behind a proxy the operator states how many hops
  // to trust. Trusting an unconditional hop count would let any caller rewrite
  // the address the rate limiters and the audit trail record.
  app.set('trust proxy', resolveTrustProxy(env));
  app.disable('x-powered-by');

  app.use(requestContext);
  // D-6: bounded per-route latency and process gauges for /api/metrics. It is a
  // passive observer: no request data, query string or user identity is kept.
  app.use(requestMetrics);
  app.use(securityHeaders);
  app.use(corsPolicy());
  // Bounded body from the validated environment, so the JSON limit is a
  // deployment budget rather than a literal buried in code (control #8).
  app.use(express.json({ limit: `${env.JSON_BODY_LIMIT_KB}kb` }));
  app.use(cookieParser());

  // Liveness/readiness sit BEFORE the rate limiter, the session resolution and
  // CSRF: a probe must never consume a caller's request budget, must not need a
  // session and must answer even when the auth stack is the thing that is broken.
  app.use('/api', healthRoutes);

  // Coarse global limiter as a safety net; sensitive routes add their own
  // stricter Mongo-backed limits on top. The counter is in-process, so it is
  // skipped under test: one suite legitimately issues hundreds of requests in
  // seconds and the durable, Mongo-backed per-route limits already cover the
  // abuse paths under test.
  if (process.env.NODE_ENV !== 'test') {
    app.use(
      '/api',
      rateLimit({
        windowMs: 60 * 1000,
        limit: 300,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
      })
    );
  }

  // Resolve the session for every request, then enforce two independent CSRF
  // layers on any cookie-authenticated mutation before it can reach a handler:
  // an Origin/Referer allowlist (D-8) and the session-bound double-submit token.
  app.use('/api', loadSession, originProtection, csrfProtection);

  app.use('/api/auth', authRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/clinic', clinicRoutes);
  // Part 2: clinic-scoped staff patient administration, the patient's own
  // account, the caregiver's scoped view, and public invitation acceptance.
  app.use('/api/patients', patientRoutes);
  app.use('/api/patient', patientSelfRoutes);
  app.use('/api/caregiver', caregiverRoutes);
  app.use('/api/access', accessRoutes);
  // Part 3: recovery episodes and care-team assignment.
  app.use('/api/episodes', episodeRoutes);
  // Part 4: private discharge documents (metadata + encrypted object storage).
  app.use('/api/episodes', documentRoutes);
  // Part 5: manual care plans, clinical review and approval. An approval
  // publishes a version to the patient and activates NO task, reminder or
  // message.
  app.use('/api/episodes', planRoutes);
  // Part 6: AI-assisted extraction JOBS and reviewed Hindi/English renderings.
  // A provider is optional; with none selected the manual Part 5 workflow is
  // the only path and these routes answer with a stable "not enabled" code.
  app.use('/api/episodes', extractionRoutes);
  // Part 7: approved medication schedules, recovery tasks and the day view.
  // Preparation reads ONLY the current approved plan version and a medication
  // schedule becomes patient-visible only through an explicit clinical
  // activation; recording an entry is an append-only, actor-attributed fact.
  app.use('/api/episodes', scheduleRoutes);
  app.use('/api/today', todayRoutes);
  // Part 8: the assigned-team dashboard. Every list and count is tenant- AND
  // assignment-scoped, and an administrator cannot browse clinical queues.
  app.use('/api/dashboard', dashboardRoutes);
  // Part 8: clinic-defined check-in templates. Clinic configuration, so an
  // administrator (who holds no clinical permission) is refused, a coordinator
  // drafts and a clinic-verified reviewer activates - the same split as plans.
  app.use('/api/check-in-templates', checkInTemplateRoutes);
  // Part 8: recovery check-in slots for an episode. A slot is materialised when
  // it is due, an answer is append-only, a missing answer is DERIVED rather than
  // stored, and a clinic rule can only ask a person to look.
  app.use('/api/episodes', checkInRoutes);
  // Part 8: the clarification queue. A clinical question is answered only by the
  // assigned, clinic-verified reviewer, an operational one by the assigned
  // coordinator, and every transition appends actor/time/history.
  app.use('/api/episodes', clarificationRoutes);
  // Part 8: in-app reminders. Queueing is de-duplicated by recipient + event
  // version + channel, delivery rechecks the episode, the approved version, the
  // task and the recipient first, retries are bounded, and a delivery is not an
  // acknowledgement.
  app.use('/api/episodes', reminderRoutes);
  // Part 8: BASIC prescribed follow-ups - a date, a location, a contact and an
  // optional in-app reminder. Test results, report matching and referrals are not
  // modelled, and the strict schema leaves them nowhere to arrive.
  app.use('/api/episodes', followUpRoutes);
  // Part 9: episode closure/reopen. Closure is an OPERATIONAL archive state and
  // the close runs one transaction that re-derives the assignment, rechecks the
  // revision, flips the state and stops only FUTURE work.
  app.use('/api/episodes', episodeClosureRoutes);
  // Part 9: the scoped, paginated audit trail, privacy requests, retention and
  // operational metrics. Each surface re-derives the caller's clinic/role scope.
  app.use('/api/audit', auditRoutes);
  app.use('/api/privacy-requests', dataRequestRoutes);
  app.use('/api/retention', retentionRoutes);
  app.use('/api/metrics', metricsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { buildApp };
