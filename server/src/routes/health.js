'use strict';

// Liveness and readiness (Part 10, controls #2, #3, #9, #12).
//
// These endpoints are unauthenticated by necessity (a probe has no session), so
// they are written to disclose nothing: no version, no host, no path, no driver
// message and no configuration value ever appears in the payload or in a log
// line. A failure is a named state, and the process-level detail stays server
// side.

const express = require('express');
const { pingDb } = require('../config/db');
const documentStorage = require('../services/documentStorage');
const readiness = require('../services/readiness');
const { getLogger } = require('../services/logger');

const router = express.Router();

// Liveness: is the process alive and serving HTTP? It deliberately checks NO
// dependency, so a database blip can never cause an orchestrator to restart an
// otherwise healthy process.
router.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, status: 'healthy', uptimeSeconds: readiness.uptimeSeconds() });
});

// Readiness: may this process take clinical traffic? The two dependencies a
// request cannot work without are probed for real, and the answer fails CLOSED
// (503) while draining, when the database cannot be reached, or when the
// encrypted storage root is missing or unusable.
let lastState = 'ready';
router.get('/ready', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const checks = {};
  if (readiness.isDraining()) {
    checks.draining = true;
    lastState = 'draining';
    return res.status(503).json({ ok: false, status: 'draining', checks });
  }
  let database;
  let storage;
  try {
    [database, storage] = await Promise.all([pingDb(), documentStorage.storageHealth()]);
  } catch {
    // A probe must answer, never reject: an unexpected failure is reported as
    // "unavailable" rather than as an unhandled rejection.
    database = { ok: false, detail: 'unreachable' };
    storage = { ok: false, detail: 'unusable' };
  }
  checks.database = database.ok ? 'ok' : database.detail;
  checks.storage = storage.ok ? 'ok' : storage.detail;
  const ok = database.ok && storage.ok;
  const state = ok ? 'ready' : 'unavailable';
  // One alert-worthy event per STATE CHANGE rather than one per probe: a probe
  // running every few seconds must not flood the log with the same line.
  if (state !== lastState) {
    const log = getLogger();
    const fields = { database: checks.database, storage: checks.storage };
    if (ok) log.info('readiness.recovered', fields);
    else log.error('readiness.unavailable', fields);
    lastState = state;
  }
  return res.status(ok ? 200 : 503).json({ ok, status: state, checks });
});

module.exports = router;
