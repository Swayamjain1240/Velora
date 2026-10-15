'use strict';

// Privacy-request policy (Part 9, VEL-020).
//
// Pure rules for the request state machine plus the wording that keeps a
// deletion request honest: a request is EVALUATED against retention, it is never
// an instant destructive endpoint.
const { DATA_REQUEST_STATES, DATA_REQUEST_TYPES } = require('../config/constants');

const S = DATA_REQUEST_STATES;

const TRANSITIONS = Object.freeze({
  [S.RECEIVED]: Object.freeze([S.IDENTITY_PENDING, S.CANCELLED]),
  [S.IDENTITY_PENDING]: Object.freeze([S.IDENTITY_VERIFIED, S.CANCELLED]),
  [S.IDENTITY_VERIFIED]: Object.freeze([S.IN_REVIEW, S.CANCELLED]),
  [S.IN_REVIEW]: Object.freeze([S.APPROVED, S.DENIED, S.CANCELLED]),
  [S.APPROVED]: Object.freeze([S.EXECUTING, S.CANCELLED]),
  [S.EXECUTING]: Object.freeze([S.COMPLETED, S.PARTIALLY_COMPLETED, S.FAILED]),
  [S.DENIED]: Object.freeze([]),
  [S.COMPLETED]: Object.freeze([]),
  [S.PARTIALLY_COMPLETED]: Object.freeze([]),
  [S.FAILED]: Object.freeze([]),
  [S.CANCELLED]: Object.freeze([]),
});

const TERMINAL = Object.freeze([S.DENIED, S.COMPLETED, S.PARTIALLY_COMPLETED, S.FAILED, S.CANCELLED]);

const DELETION_MEANING =
  'A deletion request is evaluated against the clinic’s retention rules and legal/clinical holds. It may be denied or limited, and no destructive deletion is performed automatically.';

const EXPORT_MEANING =
  'An export is generated asynchronously after approval, stored encrypted, expires automatically and needs a fresh authorization for every download.';

const CORRECTION_MEANING =
  'A correction request records the change that was asked for. Only the supported contact fields can be corrected automatically; anything clinical is routed for review instead of being rewritten.';

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function isTerminal(state) {
  return TERMINAL.includes(state);
}

function meanings() {
  return {
    export: EXPORT_MEANING,
    correction: CORRECTION_MEANING,
    deletion_request: DELETION_MEANING,
    note: 'No request performs instant destructive deletion. Every request keeps a defensible audit record.',
  };
}

// A deletion request is never "completed by deleting": the truthful outcomes are
// a full evaluation that found nothing eligible, or a limited outcome where
// retention applies.
function deletionOutcome({ eligible, held, reportOnly }) {
  if (reportOnly || held > 0 || eligible > 0) {
    return {
      state: S.PARTIALLY_COMPLETED,
      limited: true,
      result: `Evaluated ${eligible} eligible item(s) with ${held} retention hold(s). No destructive deletion was performed and a defensible record was retained.`,
    };
  }
  return {
    state: S.COMPLETED,
    limited: false,
    result: 'Evaluated against the retention rules: nothing is eligible for destruction and nothing was deleted.',
  };
}

function requestKinds() {
  return [...DATA_REQUEST_TYPES];
}

module.exports = {
  STATES: S,
  TRANSITIONS,
  TERMINAL,
  canTransition,
  isTerminal,
  meanings,
  deletionOutcome,
  requestKinds,
  DELETION_MEANING,
  EXPORT_MEANING,
  CORRECTION_MEANING,
};
