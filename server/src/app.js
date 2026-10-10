'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { securityHeaders, corsPolicy, requestContext } = require('./middleware/security');
const { csrfProtection } = require('./middleware/csrf');
const { loadSession } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const clinicRoutes = require('./routes/clinic');

function buildApp() {
  const app = express();

  // Behind a trusted proxy only when explicitly configured (control #12).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(securityHeaders);
  app.use(corsPolicy());
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());

  // Coarse global limiter as a safety net; sensitive routes add their own
  // stricter Mongo-backed limits on top.
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

  // Resolve the session for every request, then enforce CSRF on any
  // cookie-authenticated mutation before it can reach a handler.
  app.use('/api', loadSession, csrfProtection);

  app.get('/api/health', (req, res) => res.json({ ok: true, status: 'healthy' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/clinic', clinicRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { buildApp };
