'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/policies/reminderPolicy');

test('the dedupe key is stable for the same recipient, event version and channel', () => {
  const base = {
    recipientUser: 'user-1',
    recipientRole: 'patient',
    channel: 'in_app',
    kind: 'task_due',
    eventVersion: 3,
    eventId: 'occurrence-9',
    localDate: '2026-03-02',
  };
  assert.equal(policy.dedupeKey(base), policy.dedupeKey({ ...base }));
  assert.notEqual(policy.dedupeKey(base), policy.dedupeKey({ ...base, recipientUser: 'user-2' }));
  assert.notEqual(policy.dedupeKey(base), policy.dedupeKey({ ...base, channel: 'sms' }));
  assert.notEqual(policy.dedupeKey(base), policy.dedupeKey({ ...base, eventVersion: 4 }));
  assert.notEqual(policy.dedupeKey(base), policy.dedupeKey({ ...base, localDate: '2026-03-03' }));
  assert.match(policy.DEDUPE_NOTE, /never queued twice/i);
});

test('retry backoff is bounded and grows, and attempts are capped', () => {
  const first = policy.nextAttemptDelayMs(1);
  const second = policy.nextAttemptDelayMs(2);
  const tenth = policy.nextAttemptDelayMs(10);
  assert.ok(first > 0);
  assert.ok(second > first);
  assert.ok(tenth <= policy.MAX_BACKOFF_MS, 'the backoff is capped');
  const now = new Date('2026-03-02T09:00:00Z');
  assert.equal(
    policy.nextAttemptAt(1, now).getTime() - now.getTime(),
    policy.nextAttemptDelayMs(1)
  );
  assert.equal(policy.attemptsExhausted({ attempts: 3, maxAttempts: 3 }), true);
  assert.equal(policy.attemptsExhausted({ attempts: 2, maxAttempts: 3 }), false);
});

test('every pre-delivery recheck can stop a reminder that went stale', () => {
  const episode = { status: 'active' };
  const notification = { planVersion: 'plan-1' };
  const currentPlan = { _id: 'plan-1', isCurrent: true, state: 'approved', toString: () => 'plan-1' };

  const ok = policy.recheck({
    episode,
    notification,
    planVersion: { ...currentPlan },
    source: { relevant: true },
    recipient: { authorized: true },
  });
  assert.equal(ok.deliverable, true);
  assert.deepEqual(ok.checks, {
    episodeOpen: true,
    versionCurrent: true,
    taskRelevant: true,
    recipientAuthorized: true,
  });

  const closed = policy.recheck({
    episode: { status: 'closed' },
    notification,
    planVersion: currentPlan,
    source: { relevant: true },
    recipient: { authorized: true },
  });
  assert.equal(closed.deliverable, false);
  assert.match(closed.problems.join(' '), /episode is closed/i);

  const stalePlan = policy.recheck({
    episode,
    notification,
    planVersion: { _id: 'plan-1', isCurrent: false, state: 'superseded' },
    source: { relevant: true },
    recipient: { authorized: true },
  });
  assert.equal(stalePlan.deliverable, false);
  assert.match(stalePlan.problems.join(' '), /no longer current/i);
  assert.match(stalePlan.note, /nothing was sent, and no assumption is made/i);

  const supersededTask = policy.recheck({
    episode,
    notification,
    planVersion: currentPlan,
    source: { relevant: false },
    recipient: { authorized: true },
  });
  assert.equal(supersededTask.deliverable, false);

  const revokedRecipient = policy.recheck({
    episode,
    notification,
    planVersion: currentPlan,
    source: { relevant: true },
    recipient: { authorized: false },
  });
  assert.equal(revokedRecipient.deliverable, false);
  assert.match(revokedRecipient.problems.join(' '), /no longer authorized/i);

  // An unknown recipient is never assumed authorized.
  assert.equal(
    policy.recheck({ episode, notification, source: {}, recipient: null }).deliverable,
    false
  );
  assert.match(policy.RECHECK_NOTE, /checked again/i);
});

test('only in-app is a non-external channel', () => {
  assert.equal(policy.isExternalChannel('in_app'), false);
  for (const channel of ['email', 'sms', 'whatsapp', 'push']) {
    assert.equal(policy.isExternalChannel(channel), true, channel);
    assert.equal(policy.isExternalProvider(channel), true);
  }
  assert.equal(policy.isExternalProvider('in_app'), false);
});
