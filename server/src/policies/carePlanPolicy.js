'use strict';

// Care-plan domain policy (Part 5). Pure functions only: no database, no
// request context. The state machine, the clinical-field catalog and the
// completeness rules live here so the service, the API and the tests all agree
// on exactly one definition of "ready for approval".
//
// Governing rule: a missing, unclear or conflicting dose/frequency/duration is
// NEVER guessed. It stays unresolved and blocks approval until a human fixes the
// wording.

const STATES = Object.freeze({
  DRAFT: 'draft',
  IN_REVIEW: 'in_review',
  NEEDS_CLARIFICATION: 'needs_clarification',
  APPROVED: 'approved',
  SUPERSEDED: 'superseded',
});

const ALL_STATES = Object.freeze(Object.values(STATES));

// Only these states may be edited. `approved` and `superseded` are frozen: an
// approved version is immutable, and editing happens on a NEW draft version.
const EDITABLE_STATES = Object.freeze([STATES.DRAFT, STATES.NEEDS_CLARIFICATION]);

// Allowed transitions. Anything else is a 409, never a silent rewrite.
const TRANSITIONS = Object.freeze({
  [STATES.DRAFT]: Object.freeze([STATES.IN_REVIEW]),
  [STATES.IN_REVIEW]: Object.freeze([STATES.NEEDS_CLARIFICATION, STATES.APPROVED]),
  [STATES.NEEDS_CLARIFICATION]: Object.freeze([STATES.IN_REVIEW]),
  [STATES.APPROVED]: Object.freeze([STATES.SUPERSEDED]),
  [STATES.SUPERSEDED]: Object.freeze([]),
});

const ITEM_KINDS = Object.freeze([
  'medication',
  'instruction',
  'monitoring',
  'follow_up',
  'warning',
  'diet_activity',
  'home_care',
]);

// Every clinical string an item can carry. The coordinator supplies these;
// nothing is derived, inferred or auto-completed.
const CLINICAL_FIELDS = Object.freeze([
  'originalWording',
  'medication',
  'dose',
  'route',
  'frequency',
  'timing',
  'duration',
  'condition',
  'homeCare',
  'dietActivity',
  'followUp',
  'warning',
]);

// For a medication item these three must be present AND unambiguous: they are
// the fields where a guess would be a dosing error.
const MEDICATION_REQUIRED_FIELDS = Object.freeze(['dose', 'frequency', 'duration']);

const ITEM_REVIEW_STATES = Object.freeze({
  PENDING: 'pending',
  CLARIFY_REQUESTED: 'clarify_requested',
  ACCEPTED: 'accepted',
});

// Values that mean "the coordinator did not actually state this" - they are
// treated as missing, never interpreted.
const UNCLEAR_VALUES = Object.freeze([
  '',
  '?',
  '-',
  '--',
  'n/a',
  'na',
  'unknown',
  'unclear',
  'unspecified',
  'tbd',
  'tba',
  'to be determined',
  'to be decided',
  'as directed',
  'see notes',
]);

const CONFLICT_SEPARATORS = Object.freeze([',', '/', ' or ', ' and ', ' to ', '-', '–', '—']);

function normalize(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase();
}

function isUnclear(value) {
  return UNCLEAR_VALUES.includes(normalize(value));
}

function distinctNumbers(value) {
  const matches = String(value || '').match(/\d+(?:\.\d+)?/g) || [];
  return [...new Set(matches)];
}

function hasConflictSeparator(value) {
  const lower = String(value || '').toLowerCase();
  return CONFLICT_SEPARATORS.some((sep) => lower.includes(sep));
}

// A value that offers several alternative amounts ("5 mg or 10 mg", "1-2 tabs")
// is a conflict unless the ranges agree on a single number. We never pick one.
function isConflicting(value) {
  if (isUnclear(value)) return false;
  const numbers = distinctNumbers(value);
  if (numbers.length < 2) return false;
  return hasConflictSeparator(value);
}

// The unresolved-field list for one item: missing required medication fields,
// unclear values anywhere and conflicting values anywhere. This list is the
// reason approval is blocked, and it is shown to both coordinator and reviewer.
function computeUnresolvedFields(item = {}) {
  const unresolved = [];
  const kind = item.kind || 'instruction';

  for (const field of CLINICAL_FIELDS) {
    const value = item[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (isUnclear(value)) unresolved.push(field);
    else if (isConflicting(value)) unresolved.push(`${field}_conflict`);
  }

  if (kind === 'medication') {
    for (const field of MEDICATION_REQUIRED_FIELDS) {
      const value = item[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        if (!unresolved.includes(field)) unresolved.push(field);
      }
    }
  }

  if (!String(item.originalWording || '').trim()) {
    if (!unresolved.includes('originalWording')) unresolved.push('originalWording');
  }

  return unresolved;
}

function assertTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

// Approval blockers. Every blocker is a stable code plus a human sentence; the
// API surfaces them so an incomplete plan is refused with a reason instead of a
// generic failure. `items` are plain objects with `unresolvedFields`,
// `clinicalReviewState` and `sourceCount`.
function approvalBlockers({ items = [], summary } = {}) {
  const blockers = [];

  if (!items.length) {
    blockers.push({ code: 'no_items', message: 'A plan needs at least one item.' });
  }

  for (const item of items) {
    const label = String(item.order ?? '').length ? `Item ${item.order}` : 'An item';
    // A stored list (possibly empty) is authoritative: it was computed from the
    // item's own clinical text on its last write. Only a caller that passes no
    // list at all (a raw item object) gets a fresh computation.
    const unresolved = Array.isArray(item.unresolvedFields)
      ? item.unresolvedFields
      : computeUnresolvedFields(item);
    if (unresolved.length) {
      blockers.push({
        code: 'unresolved_fields',
        message: `${label} has unresolved clinical fields: ${unresolved.join(', ')}.`,
        itemId: item.id,
        fields: unresolved,
      });
    }
    if (!item.sourceCount) {
      blockers.push({
        code: 'item_without_source',
        message: `${label} has no source reference from a ready document.`,
        itemId: item.id,
      });
    }
    if (item.clinicalReviewState !== ITEM_REVIEW_STATES.ACCEPTED) {
      blockers.push({
        code: 'item_not_reviewed',
        message: `${label} has not been clinically accepted by the reviewer.`,
        itemId: item.id,
      });
    }
  }

  if (summary !== undefined && summary !== null && String(summary).trim() === '') {
    // An empty summary is allowed; only a stated-but-blank value is a problem.
    blockers.push({ code: 'empty_summary', message: 'The plan summary is blank.' });
  }

  return blockers;
}

// Submit-time requirements are lighter than approval: the reviewer needs
// something real to review, but unresolved fields are exactly what review and
// clarification are for.
function submitBlockers({ items = [] } = {}) {
  const blockers = [];
  if (!items.length) {
    blockers.push({ code: 'no_items', message: 'Add at least one item before submitting.' });
  }
  for (const item of items) {
    if (!item.sourceCount) {
      blockers.push({
        code: 'item_without_source',
        message: `Item ${item.order} needs a source reference from a ready document.`,
        itemId: item.id,
      });
    }
  }
  return blockers;
}

module.exports = {
  STATES,
  ALL_STATES,
  EDITABLE_STATES,
  TRANSITIONS,
  ITEM_KINDS,
  CLINICAL_FIELDS,
  MEDICATION_REQUIRED_FIELDS,
  ITEM_REVIEW_STATES,
  UNCLEAR_VALUES,
  isUnclear,
  isConflicting,
  computeUnresolvedFields,
  assertTransition,
  approvalBlockers,
  submitBlockers,
};
