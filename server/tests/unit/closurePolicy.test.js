'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/policies/closurePolicy');

test('an operational closure never reads as a clinical outcome', () => {
  assert.equal(policy.describesClinicalRecovery('The patient has recovered fully.'), true);
  assert.equal(policy.describesClinicalRecovery('All coordination steps are finished.'), false);
  assert.match(policy.CLOSURE_MEANING, /does not mean the patient has recovered/i);
});

test('every clinic-policy check must be explicitly confirmed', () => {
  const { normalised, problems } = policy.validatePolicyChecks([
    { key: 'plan_reviewed', confirmed: true },
    { key: 'documents_archived', confirmed: false },
  ]);
  assert.equal(normalised.length, policy.CLOSURE_POLICY_CHECKS.length);
  assert.equal(normalised.find((c) => c.key === 'plan_reviewed').confirmed, true);
  assert.ok(problems.some((p) => /Confirm these clinic-policy checks/.test(p)));
  assert.ok(problems.some((p) => /not met/.test(p)));
});

test('a blocking preflight item needs a written override', () => {
  const items = policy.preflightCatalog().map((item) => ({ ...item, count: item.blocking ? 1 : 0 }));
  const blocked = policy.evaluatePreflight(items, []);
  assert.equal(blocked.canClose, false);
  assert.ok(blocked.blocking.length > 0);

  const cleared = policy.evaluatePreflight(
    items,
    policy.preflightCatalog().map((item) => ({ key: item.key, reason: 'Reviewed and cleared by hand.' }))
  );
  assert.equal(cleared.canClose, true);
  const blockingCount = policy.preflightCatalog().filter((item) => item.blocking).length;
  assert.equal(cleared.clearedByOverride.length, blockingCount);
});

test('an unknown override key is refused', () => {
  const items = policy.preflightCatalog().map((item) => ({ ...item, count: 0 }));
  const result = policy.evaluatePreflight(items, [{ key: 'not_a_queue', reason: 'nope nope nope' }]);
  assert.equal(result.canClose, false);
  assert.deepEqual(result.unknownOverrides, ['not_a_queue']);
});
