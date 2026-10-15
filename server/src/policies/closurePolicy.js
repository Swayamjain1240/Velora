'use strict';

// Closure policy (Part 9, VEL-019).
//
// Pure, testable rules. The single most important one is a WORDING rule: closing
// an episode records that coordination work has ended. It is an operational
// archive state and never means medically recovered, clinically discharged or
// "care complete" - so nothing here computes or stores an outcome.
const { CLOSURE_POLICY_CHECKS, CLOSURE_PREFLIGHT_ITEMS, CLOSURE_STATES } = require('../config/constants');

const CLOSURE_MEANING =
  'Closing an episode ends the coordination workflow and archives its records as read-only. It is an operational state and does not mean the patient has recovered.';

const REOPEN_MEANING =
  'Reopening restores an episode to active coordination. It never revives work that was stopped before, so any future schedule or reminder is created again deliberately.';

const WORDS_NEVER_USED = Object.freeze([
  'recovered',
  'cured',
  'healed',
  'discharged healthy',
  'clinically complete',
]);

function describesClinicalRecovery(text) {
  const value = String(text || '').toLowerCase();
  return WORDS_NEVER_USED.some((word) => value.includes(word));
}

// The catalog of preflight items, in the order the wizard shows them.
function preflightCatalog() {
  return CLOSURE_PREFLIGHT_ITEMS.map((item) => ({ ...item }));
}

function catalogKeys() {
  return CLOSURE_PREFLIGHT_ITEMS.map((item) => item.key);
}

// Evaluate a computed preflight against the caller-supplied overrides.
//
// A BLOCKING item with a non-zero count must either be zero or carry an explicit
// override with a written reason; there is no implicit "close anyway".
function evaluatePreflight(items, overrides = []) {
  const byKey = new Map();
  for (const override of overrides) {
    if (override && override.key) {
      byKey.set(override.key, String(override.reason || '').trim());
    }
  }

  const blocking = [];
  const unresolved = [];
  const clearedByOverride = [];
  const unknownOverrides = [];

  const known = new Set(catalogKeys());
  for (const override of overrides) {
    if (!override || !known.has(override.key)) unknownOverrides.push(override && override.key);
  }

  for (const item of items) {
    if (!item.count) continue;
    unresolved.push(item.key);
    if (!item.blocking) continue;
    const reason = byKey.get(item.key);
    if (reason && reason.length >= 5) clearedByOverride.push({ key: item.key, reason });
    else blocking.push(item.key);
  }

  return {
    canClose: blocking.length === 0 && unknownOverrides.length === 0,
    blocking,
    unresolved,
    clearedByOverride,
    unknownOverrides,
  };
}

// Every catalog check must be explicitly confirmed. A missing check is reported
// by key so the wizard can point at exactly what is outstanding.
function validatePolicyChecks(checks) {
  const supplied = new Map();
  for (const check of checks || []) {
    if (!check || !CLOSURE_POLICY_CHECKS.includes(check.key)) continue;
    supplied.set(check.key, check);
  }

  const missing = [];
  const unconfirmed = [];
  for (const key of CLOSURE_POLICY_CHECKS) {
    const check = supplied.get(key);
    if (!check) {
      missing.push(key);
      continue;
    }
    if (check.confirmed !== true) unconfirmed.push(key);
  }

  const problems = [];
  if (missing.length) problems.push(`Confirm these clinic-policy checks: ${missing.join(', ')}.`);
  if (unconfirmed.length) problems.push(`These checks are recorded as not met: ${unconfirmed.join(', ')}.`);

  return {
    problems,
    normalised: CLOSURE_POLICY_CHECKS.map((key) => ({
      key,
      confirmed: supplied.has(key) ? supplied.get(key).confirmed === true : false,
      note: supplied.has(key) ? supplied.get(key).note : undefined,
    })),
  };
}

module.exports = {
  CLOSURE_MEANING,
  REOPEN_MEANING,
  WORDS_NEVER_USED,
  CLOSURE_STATES,
  CLOSURE_POLICY_CHECKS,
  describesClinicalRecovery,
  preflightCatalog,
  catalogKeys,
  evaluatePreflight,
  validatePolicyChecks,
};
