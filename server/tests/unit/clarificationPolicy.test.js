'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/policies/clarificationPolicy');
const { THREAD_STATES, THREAD_ACTIONS, THREAD_KINDS } = require('../../src/config/constants');

test('every legal transition lands in the documented state', () => {
  assert.equal(policy.assertTransition(THREAD_STATES.OPEN, THREAD_ACTIONS.ASSIGN), 'assigned');
  assert.equal(policy.assertTransition(THREAD_STATES.ASSIGNED, THREAD_ACTIONS.ANSWER), 'answered');
  assert.equal(policy.assertTransition(THREAD_STATES.ANSWERED, THREAD_ACTIONS.CLOSE), 'closed');
  assert.equal(policy.assertTransition(THREAD_STATES.CLOSED, THREAD_ACTIONS.REOPEN), 'reopened');
  assert.equal(policy.assertTransition(THREAD_STATES.REOPENED, THREAD_ACTIONS.ASSIGN), 'assigned');
});

test('an illegal transition is refused rather than silently applied', () => {
  assert.equal(policy.canTransition(THREAD_STATES.CLOSED, THREAD_ACTIONS.ANSWER), false);
  assert.throws(
    () => policy.assertTransition(THREAD_STATES.CLOSED, THREAD_ACTIONS.ANSWER),
    /Illegal clarification transition/
  );
  assert.equal(policy.canTransition(THREAD_STATES.OPEN, THREAD_ACTIONS.REOPEN), false);
});

test('a reopened thread is its own state so the history shows it came back', () => {
  const reopened = policy.assertTransition(THREAD_STATES.CLOSED, THREAD_ACTIONS.REOPEN);
  assert.equal(reopened, 'reopened');
  assert.notEqual(reopened, THREAD_STATES.OPEN);
  assert.match(policy.REOPEN_NOTE, /full history is kept/i);
  assert.match(policy.CLOSED_NOTE, /can be reopened/i);
});

test('clinical answers need the clinical permission AND an assignment', () => {
  const perms = (list) => new Set(list);
  assert.equal(
    policy.canAnswer({
      kind: THREAD_KINDS.CLINICAL,
      permissions: perms(['question.answer.clinical']),
      isAssignedReviewer: false,
    }),
    false,
    'an unassigned reviewer cannot answer a clinical thread'
  );
  assert.equal(
    policy.canAnswer({
      kind: THREAD_KINDS.CLINICAL,
      permissions: perms(['question.answer.clinical']),
      isAssignedReviewer: true,
    }),
    true
  );
  assert.equal(
    policy.canAnswer({
      kind: THREAD_KINDS.CLINICAL,
      permissions: perms(['question.answer.operational']),
      isAssignedReviewer: true,
    }),
    false,
    'the operational permission never answers a clinical question'
  );
  assert.equal(
    policy.canAnswer({
      kind: THREAD_KINDS.OPERATIONAL,
      permissions: perms(['question.answer.operational']),
      isAssignedReviewer: false,
    }),
    true
  );
  assert.equal(
    policy.canAnswer({
      kind: THREAD_KINDS.OPERATIONAL,
      permissions: perms(['question.answer.clinical']),
      isAssignedReviewer: true,
    }),
    false,
    'a clinical reviewer does not answer operational questions by default'
  );
});

test('the answer permission follows the thread kind, not the caller', () => {
  assert.equal(policy.answerPermissionFor('clinical'), 'question.answer.clinical');
  assert.equal(policy.answerPermissionFor('operational'), 'question.answer.operational');
});

test('subjects and bodies are bounded plain text, never markup', () => {
  assert.deepEqual(policy.validateSubject('Can I shower with the dressing on?'), []);
  assert.deepEqual(policy.validateBody('The nurse said to keep it dry for two days.'), []);
  assert.match(policy.validateSubject('').join(' '), /write a short subject/i);
  assert.match(policy.validateBody('x'.repeat(2001)).join(' '), /at most 2000 characters/i);
  assert.match(policy.validateBody('<img src=x onerror=alert(1)>').join(' '), /plain text/i);
  assert.match(policy.validateBody('hello\u0000there').join(' '), /unsupported characters/i);
});

test('a system status line describes the workflow and never a clinical judgement', () => {
  const lines = [
    THREAD_ACTIONS.OPEN,
    THREAD_ACTIONS.ASSIGN,
    THREAD_ACTIONS.ANSWER,
    THREAD_ACTIONS.CLOSE,
    THREAD_ACTIONS.REOPEN,
    THREAD_ACTIONS.RECLASSIFY,
  ].map((action) => policy.systemMessage(action, { actorLabel: 'A. Coordinator' }));

  for (const line of lines) {
    assert.match(line, /A\. Coordinator/);
    assert.ok(!/diagnos|abnormal|normal result|deteriorat|sepsis/i.test(line), line);
  }
  assert.match(lines[5], /only an assigned clinical reviewer/i);
});

test('the queue wording never promises continuous monitoring', () => {
  assert.match(policy.NO_MONITORING_NOTE, /not monitored continuously unless the clinic states otherwise/i);
  assert.match(policy.STATE_NOTE, /clinic response hours/i);
  assert.match(policy.ANSWERED_NOTE, /reply from a person, not an automated assessment/i);
});
