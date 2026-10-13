'use strict';

// Part 6 presentation rules for AI-assisted extraction and reviewed language
// renderings. Display only: the server owns authority, validation, completeness
// and state.
//
// The screen deliberately exposes exactly TWO decisions - "apply to the draft"
// (an ordinary draft edit, attributed to the person who clicked it) and
// "dismiss". There is no approve, publish, prescribe, reminder or task action
// anywhere in this file, because AI output has zero authority over them.

import { PAGE_SIZE } from '../plans/planRules';

export { PAGE_SIZE };
// How many clinical fields of one suggestion are shown at a time, so a long
// extraction still fits one viewport.
export const FIELD_PAGE_SIZE = 5;

// The permanent statement a reviewer sees beside every AI suggestion.
export const AI_AUTHORITY_NOTICE =
  'AI output is an untrusted draft. It cannot approve, publish, prescribe, change clinical state, activate a task or send a reminder. Nothing here is clinical advice until a person accepts it and the plan is clinically approved.';

export const JOB_STATES = {
  queued: {
    label: 'Queued',
    note: 'Created but not started. Creating a job reads nothing from the document.',
  },
  running: { label: 'Running', note: 'The provider is being called once, within its limits.' },
  completed: {
    label: 'Completed',
    note: 'Suggestions were produced. They are drafts until a person accepts them.',
  },
  needs_review: {
    label: 'Needs review',
    note: 'Something needs a human: a missing field, a conflict or a suspicious instruction.',
  },
  failed: { label: 'Failed', note: 'No usable suggestion. Draft this plan by hand.' },
  cancelled: { label: 'Cancelled', note: 'Stopped before or during the run.' },
};

export function jobStateLabel(state) {
  return (JOB_STATES[state] && JOB_STATES[state].label) || state;
}

export function jobStateNote(state) {
  return (JOB_STATES[state] && JOB_STATES[state].note) || '';
}

export const SUGGESTION_STATES = {
  proposed: 'Awaiting your decision',
  needs_review: 'Needs your review',
  applied: 'Applied to the draft',
  dismissed: 'Dismissed',
};

export function suggestionStateLabel(state) {
  return SUGGESTION_STATES[state] || state;
}

// What each per-field state MEANS, in the reviewer's language. `suggested` is the
// only state that came straight from the source; every other state is a reason
// not to trust the value.
export const FIELD_STATES = {
  suggested: 'Stated in the source',
  missing: 'Not stated in the source',
  conflicting: 'Conflicting instructions',
  unresolved: 'Unclear or unsupported by the source',
};

export function fieldStateLabel(state) {
  return FIELD_STATES[state] || state;
}

export function fieldStateClass(state) {
  return state === 'suggested' ? 'pill--ready' : 'pill--rejected';
}

export const FIELD_LABELS = {
  medication: 'Medication name',
  dose: 'Dose',
  route: 'Route',
  frequency: 'Frequency',
  duration: 'Duration',
  homeCare: 'Home care',
  dietActivity: 'Activity or diet',
  followUp: 'Follow-up',
  warning: 'Warning instructions',
};

export function fieldLabel(field) {
  return FIELD_LABELS[field] || String(field).replace(/([A-Z])/g, ' $1');
}

export const KIND_LABELS = {
  medication: 'Medication',
  instruction: 'Instruction',
  monitoring: 'Monitoring',
  follow_up: 'Follow-up',
  warning: 'Warning sign',
  diet_activity: 'Diet or activity',
  home_care: 'Home care',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind;
}

export const LANGUAGE_LABELS = { hi: 'Hindi', en: 'Simplified English' };
export const VARIANT_KIND_LABELS = { translation: 'Translation', simplification: 'Simplification' };

export const VARIANT_STATES = {
  draft: 'Draft (not submitted)',
  in_review: 'Waiting for clinical review',
  approved: 'Clinically approved',
  superseded: 'Superseded by a newer rendering',
};

export function variantStateLabel(state) {
  return VARIANT_STATES[state] || state;
}

// A machine fidelity guard, not a fidelity proof. Its warnings are shown as
// reasons approval is blocked, never as a statement that meaning is preserved.
export function fidelityWarningLabel(code) {
  const match = /^missing_number_in_(.+)$/.exec(String(code));
  if (match) return `The ${fieldLabel(match[1]).toLowerCase()} number is missing from this wording.`;
  const valueMatch = /^missing_value_in_(.+)$/.exec(String(code));
  if (valueMatch) return `The ${fieldLabel(valueMatch[1]).toLowerCase()} value is missing from this wording.`;
  if (code === 'empty_text') return 'This wording is empty.';
  return String(code).replace(/_/g, ' ');
}

// A denial (lost session, clinic, assignment, document or plan access) clears
// loaded content before the message is shown.
export function isExtractionDenied(err) {
  return Boolean(err) && [401, 403, 404].includes(err.status);
}

// A conflict means the draft, the document or the suggestion moved on: the
// screen reloads instead of offering an action that can no longer succeed.
export function isStaleExtraction(err) {
  return Boolean(err) && err.status === 409;
}

export function safeExtractionMessage(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  if (isExtractionDenied(err)) return 'This extraction view is not available to you.';
  return err.message || fallback;
}

// Fields a reviewer must look at before accepting: anything the source did not
// simply state.
export function isFieldFlagged(field) {
  return Boolean(field) && field.state !== 'suggested';
}

// The dependency ordering of the four switchable panels.
export const PANELS = [
  ['source', 'Source'],
  ['ai', 'AI suggestion'],
  ['manual', 'Accepted value'],
  ['decision', 'Decision'],
];
