'use strict';

const helmet = require('helmet');
const cors = require('cors');
const crypto = require('node:crypto');
const { getEnv } = require('../config/env');

// Security headers (control #11). API responses are JSON; CSP restricts any
// rendered content to the app's own sources.
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
});

// Exact credentialed CORS allowlist (control #10): never a wildcard origin.
function corsPolicy() {
  const allowed = getEnv().CLIENT_ORIGIN;
  return cors({
    origin(origin, callback) {
      // Same-origin/tools send no Origin header; allow those.
      if (!origin) return callback(null, true);
      if (origin === allowed) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    maxAge: 600,
  });
}

// Attaches a request id plus client ip/user-agent for auditing.
function requestContext(req, res, next) {
  req.id = crypto.randomUUID();
  req.clientIp = req.ip || (req.connection && req.connection.remoteAddress) || '';
  req.clientUserAgent = req.get('user-agent') || '';
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { securityHeaders, corsPolicy, requestContext };
