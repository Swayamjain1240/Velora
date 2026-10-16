'use strict';

const helmet = require('helmet');
const cors = require('cors');
const crypto = require('node:crypto');
const { getEnv } = require('../config/env');

// Security headers (control #11). API responses are JSON; CSP restricts any
// rendered content to the app's own sources.
const isProduction = process.env.NODE_ENV === 'production';

// HSTS is honoured only over HTTPS and yanks a browser onto HTTPS for a year, so
// it is sent in production only: advertising it from a plain-HTTP development
// origin would be a lie about the deployment (control #11).
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
  hsts: isProduction
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
    : false,
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
    // Only the required headers: JSON bodies, the CSRF double-submit value and
    // the Part 4 upload filename header.
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Document-Filename'],
    maxAge: 600,
  });
}

// The single decision for `trust proxy` (control #12). `false` means the socket
// address is the client address and a forged X-Forwarded-For is ignored; behind
// a trusted reverse proxy the operator states the exact hop count to trust. Kept
// as a named function so both branches stay testable.
function resolveTrustProxy(env) {
  return env.TRUST_PROXY ? env.PROXY_HOPS : false;
}

// Attaches a request id plus client ip/user-agent for auditing.
function requestContext(req, res, next) {
  req.id = crypto.randomUUID();
  req.clientIp = req.ip || (req.connection && req.connection.remoteAddress) || '';
  req.clientUserAgent = req.get('user-agent') || '';
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { securityHeaders, corsPolicy, requestContext, resolveTrustProxy };
