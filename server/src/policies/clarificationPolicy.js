'use strict';

// Clarification queue policy (VEL-016). Pure module: no database, no clock, no
// request context. Three jobs:
//
//   1. Own the STATE MACHINE. Every legal transition is listed here, so a new
//      route cannot invent one, and every transition is required to carry
//      actor/time/history.
//   2. Own the AUTHORITY SPLIT. A CLINICAL question may only be answered by an
//      eligible clinical reviewer who is ASSIGNED to the thread; an OPERATIONAL
//      question belongs to a care coordinator. Holding one authority never
//      confers the other.
//   3. Own the wording of a system event. A status line says what happened to
//      the WORKFLOW - it never interprets an answer and never promises that the
//      clinic is watching continuously.

const { THREAD_STATES, THREAD_ACTIONS, THREAD_KINDS } = require('../config/constants');

const CLINICAL_ANSWER_PERMISSION = 'question.answer.clinical';
const OPERATIONAL_ANSWER_PERMISSION = 'question.answer.operational';
const ASSIGN_PERMISSION = 'question.assign';

const THREAD_MAX_BODY = 2000;
const THREAD_MAX_SUBJECT = 160;
const THREAD_MAX_MESSAGES = 200;

const STATE_NOTE =
  'Questions and answers here are normal care-team messages. They are reviewed during the clinic response hours shown with this thread.';
const NO_MONITORING_NOTE =
  'This queue is not monitored continuously unless the clinic states otherwise. For anything urgent, use the emergency guidance below.';
const ANSWERED_NOTE =
  'A care-team member has answered. This is a reply from a person, not an automated assessment.';
const REOPEN_NOTE =
  'This thread was reopened, so it needs attention again. The full history is kept.';
const CLOSED_NOTE = 'This thread is closed. It can be reopened if the question is still open.';

// Legal transitions. `reopen` is only legal from a settled state, and a reopened
// thread behaves like a fresh open one while remaining visibly distinct.
const TRANSITIONS = Object.freeze({
  [THREAD_STATES.OPEN]: [
    THREAD_ACTIONS.ASSIGN,
    THREAD_ACTIONS.ANSWER,
    THREAD_ACTIONS.CLOSE,
    THREAD_ACTIONS.RECLASSIFY,
    THREAD_ACTIONS.NOTE,
  ],
  [THREAD_STATES.ASSIGNED]: [
    THREAD_ACTIONS.ANSWER,
    THREAD_ACTIONS.CLOSE,
    THREAD_ACTIONS.REOPEN,
    THREAD_ACTIONS.RECLASSIFY,
    THREAD_ACTIONS.NOTE,
  ],
  [THREAD_STATES.ANSWERED]: [
    THREAD_ACTIONS.CLOSE,
    THREAD_ACTIONS.REOPEN,
    THREAD_ACTIONS.ASSIGN,
    THREAD_ACTIONS.ANSWER,
    THREAD_ACTIONS.NOTE,
  ],
  [THREAD_STATES.CLOSED]: [THREAD_ACTIONS.REOPEN, THREAD_ACTIONS.NOTE],
  [THREAD_STATES.REOPENED]: [
    THREAD_ACTIONS.ASSIGN,
    THREAD_ACTIONS.ANSWER,
    THREAD_ACTIONS.CLOSE,
    THREAD_ACTIONS.RECLASSIFY,
    THREAD_ACTIONS.NOTE,
  ],
});

// Where a transition lands. `reopen` lands in its own state so the history shows
// that the thread came back rather than pretending it was never answered.
const RESULT_STATE = Object.freeze({
  [THREAD_ACTIONS.OPEN]: THREAD_STATES.OPEN,
  [THREAD_ACTIONS.ASSIGN]: THREAD_STATES.ASSIGNED,
  [THREAD_ACTIONS.ANSWER]: THREAD_STATES.ANSWERED,
  [THREAD_ACTIONS.CLOSE]: THREAD_STATES.CLOSED,
  [THREAD_ACTIONS.REOPEN]: THREAD_STATES.REOPENED,
});

function assertTransition(from, action) {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(action)) {
    throw new Error(`Illegal clarification transition: ${from} -> ${action}`);
  }
  return RESULT_STATE[action] || from;
}

function canTransition(from, action) {
  return (TRANSITIONS[from] || []).includes(action);
}

// ---- authority ---------------------------------------------------------------

// The permission an answer requires, decided by the thread's KIND. A clinical
// thread can never be answered with the operational permission, and vice versa.
function answerPermissionFor(kind) {
  return kind === THREAD_KINDS.CLINICAL
    ? CLINICAL_ANSWER_PERMISSION
    : OPERATIONAL_ANSWER_PERMISSION;
}

// The full authority an actor needs to answer. `permissions` is the caller's
// clinic-scoped permission set; assignment is checked separately by the service
// because it needs the thread document.
function canAnswer({ kind, permissions, isAssignedReviewer }) {
  const needed = answerPermissionFor(kind);
  if (!permissions || !permissions.has(needed)) return false;
  if (kind === THREAD_KINDS.CLINICAL && !isAssignedReviewer) return false;
  return true;
}

// ---- wording and content guards ----------------------------------------------

// Message bodies are rendered as TEXT, never as HTML, so markup is refused
// outright instead of being escaped somewhere and trusted everywhere (control #7).
const MARKUP = /[<>]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function contentProblems(text, { max, label }) {
  const problems = [];
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) problems.push(`Write ${label}.`);
  if (value.length > max) problems.push(`${label[0].toUpperCase()}${label.slice(1)} must be at most ${max} characters.`);
  if (MARKUP.test(value)) {
    problems.push('Markup is not supported here; write plain text.');
  }
  if (CONTROL_CHARS.test(value)) problems.push('Remove unsupported characters.');
  return problems;
}

function validateSubject(subject) {
  return contentProblems(subject, { max: THREAD_MAX_SUBJECT, label: 'a short subject' });
}

function validateBody(body) {
  return contentProblems(body, { max: THREAD_MAX_BODY, label: 'a message' });
}

// ---- system messages ---------------------------------------------------------

// A status line describes the WORKFLOW only. It never states or implies a
// clinical conclusion, and it never claims that someone is watching.
function systemMessage(action, { actorLabel, toState, note } = {}) {
  const who = actorLabel || 'A care-team member';
  const suffix = note ? ` ${note}` : '';
  switch (action) {
    case THREAD_ACTIONS.OPEN:
      return `${who} opened this question. It is waiting for the care team.${suffix}`;
    case THREAD_ACTIONS.ASSIGN:
      return `${who} assigned this to the care team member responsible for it. It is now in the assigned queue.${suffix}`;
    case THREAD_ACTIONS.ANSWER:
      return `${who} replied.${suffix}`;
    case THREAD_ACTIONS.CLOSE:
      return `This thread was closed by ${who}.${suffix}`;
    case THREAD_ACTIONS.REOPEN:
      return `This thread was reopened by ${who} and needs attention again. The history is unchanged.${suffix}`;
    case THREAD_ACTIONS.RECLASSIFY:
      return `${who} moved this question to the clinical queue, where only an assigned clinical reviewer may answer it.${suffix}`;
    default:
      return `${who} updated this thread${toState ? ` (${toState})` : ''}.${suffix}`;
  }
}

module.exports = {
  assertTransition,
  canTransition,
  answerPermissionFor,
  canAnswer,
  validateSubject,
  validateBody,
  systemMessage,
  TRANSITIONS,
  CLINICAL_ANSWER_PERMISSION,
  OPERATIONAL_ANSWER_PERMISSION,
  ASSIGN_PERMISSION,
  THREAD_MAX_BODY,
  THREAD_MAX_SUBJECT,
  THREAD_MAX_MESSAGES,
  STATE_NOTE,
  NO_MONITORING_NOTE,
  ANSWERED_NOTE,
  REOPEN_NOTE,
  CLOSED_NOTE,
  MARKUP,
};
