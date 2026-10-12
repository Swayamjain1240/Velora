'use strict';

// Part 5 presentation rules. Everything here is display-only: the server decides
// authority, completeness and state. These helpers keep wording, badge classes
// and "what is this field" labels consistent between the draft, review and
// patient screens.

export const PAGE_SIZE = 8;

export const PLAN_STATES = {
  draft: { label: 'Draft', note: 'Only the assigned care team can see this.' },
  in_review: { label: 'In review', note: 'Waiting for the assigned clinical reviewer.' },
  needs_clarification: {
    label: 'Needs clarification',
    note: 'The reviewer sent this back with a question.',
  },
  approved: { label: 'Approved', note: 'Published to the patient as the current plan.' },
  superseded: { label: 'Superseded', note: 'Replaced by a newer approved version.' },
};

export function stateLabel(state) {
  return (PLAN_STATES[state] && PLAN_STATES[state].label) || state;
}

export function stateNote(state) {
  return (PLAN_STATES[state] && PLAN_STATES[state].note) || '';
}

export const ITEM_KINDS = [
  ['medication', 'Medication'],
  ['instruction', 'Instruction'],
  ['monitoring', 'Monitoring'],
  ['follow_up', 'Follow-up'],
  ['warning', 'Warning sign'],
  ['diet_activity', 'Diet or activity'],
  ['home_care', 'Home care'],
];

export const ITEM_REVIEW_STATES = {
  pending: 'Awaiting clinical review',
  accepted: 'Clinically accepted',
  clarify_requested: 'Sent back for clarification',
};

// Field labels and how each clinical field is presented to a reviewer or to the
// patient. The values are ALWAYS rendered as text (control #7).
export const CLINICAL_FIELDS = [
  ['originalWording', 'Original wording (as written at source)'],
  ['medication', 'Medication'],
  ['dose', 'Dose'],
  ['route', 'Route'],
  ['frequency', 'Frequency'],
  ['timing', 'Timing'],
  ['duration', 'Duration'],
  ['condition', 'Condition'],
  ['homeCare', 'Home care instruction'],
  ['dietActivity', 'Diet or activity instruction'],
  ['followUp', 'Follow-up information'],
  ['warning', 'Warning instruction'],
];

export const UNRESOLVED_LABELS = {
  originalWording: 'original wording missing',
  dose: 'dose missing or unclear',
  frequency: 'frequency missing or unclear',
  duration: 'duration missing or unclear',
  medication: 'medication unclear',
  route: 'route unclear',
  timing: 'timing unclear',
  condition: 'condition unclear',
  homeCare: 'home care wording unclear',
  dietActivity: 'diet or activity wording unclear',
  followUp: 'follow-up wording unclear',
  warning: 'warning wording unclear',
  dose_conflict: 'conflicting dose values',
  frequency_conflict: 'conflicting frequency values',
  duration_conflict: 'conflicting duration values',
  medication_conflict: 'conflicting medication values',
  timing_conflict: 'conflicting timing values',
  condition_conflict: 'conflicting condition values',
  originalWording_conflict: 'conflicting original wording',
  route_conflict: 'conflicting route values',
  homeCare_conflict: 'conflicting home care wording',
  dietActivity_conflict: 'conflicting diet or activity wording',
  followUp_conflict: 'conflicting follow-up wording',
  warning_conflict: 'conflicting warning wording',
};

export function unresolvedLabel(field) {
  return UNRESOLVED_LABELS[field] || field.replace(/_/g, ' ');
}

// A denial always clears loaded clinical content before the message is shown, so
// nothing stale stays on screen after authorization is lost.
export function isPlanDenied(err) {
  return Boolean(err) && [401, 403, 404].includes(err.status);
}

// A stale plan (moved revision, decided version) clears the loaded copy too: the
// screen must never keep offering an action against state that no longer exists.
export function isStalePlan(err) {
  return Boolean(err) && err.status === 409;
}

export function safePlanMessage(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  if (isPlanDenied(err)) return 'This plan is not available to you.';
  return err.message || fallback;
}

export function reviewStateLabel(state) {
  return ITEM_REVIEW_STATES[state] || state;
}

export function formatWhen(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

// The item fields the coordinator supplied, in order, with empty values omitted.
export function clinicalValues(item) {
  return CLINICAL_FIELDS.filter(([key]) => item[key]).map(([key, label]) => [
    key,
    label,
    item[key],
  ]);
}
