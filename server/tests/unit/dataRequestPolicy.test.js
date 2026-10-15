'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/policies/dataRequestPolicy');

test('the request state machine only allows the documented transitions', () => {
  assert.equal(policy.canTransition(policy.STATES.IDENTITY_PENDING, policy.STATES.IDENTITY_VERIFIED), true);
  assert.equal(policy.canTransition(policy.STATES.IDENTITY_PENDING, policy.STATES.APPROVED), false);
  assert.equal(policy.canTransition(policy.STATES.IN_REVIEW, policy.STATES.APPROVED), true);
  assert.equal(policy.canTransition(policy.STATES.APPROVED, policy.STATES.EXECUTING), true);
  assert.equal(policy.canTransition(policy.STATES.EXECUTING, policy.STATES.COMPLETED), true);
  assert.equal(policy.canTransition(policy.STATES.COMPLETED, policy.STATES.APPROVED), false);
  assert.equal(policy.isTerminal(policy.STATES.DENIED), true);
  assert.equal(policy.isTerminal(policy.STATES.APPROVED), false);
});

test('a deletion evaluation never reports a full destructive completion when retention applies', () => {
  const limited = policy.deletionOutcome({ eligible: 3, held: 1, reportOnly: true });
  assert.equal(limited.state, policy.STATES.PARTIALLY_COMPLETED);
  assert.equal(limited.limited, true);
  assert.match(limited.result, /No destructive deletion/);

  const nothing = policy.deletionOutcome({ eligible: 0, held: 0, reportOnly: false });
  assert.equal(nothing.state, policy.STATES.COMPLETED);
  assert.equal(nothing.limited, false);
});

test('every request type states what it does and does not do', () => {
  const meanings = policy.meanings();
  for (const kind of policy.requestKinds()) {
    assert.ok(meanings[kind], `${kind} needs a meaning`);
  }
  assert.match(meanings.deletion_request, /may be denied or limited/i);
  assert.match(meanings.deletion_request, /no destructive deletion is performed automatically/i);
  assert.match(meanings.note, /instant destructive deletion/i);
});
