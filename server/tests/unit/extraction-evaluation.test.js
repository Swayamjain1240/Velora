'use strict';

// Gate for the Part 6 evaluation harness (synthetic fixtures only). It asserts
// the DETERMINISTIC fake provider plus the server's validation/classification
// meet every labelled expectation, and that the metrics are perfect on this set.
//
// Passing is software behaviour on invented values - it is NOT clinical accuracy
// and does not validate any real provider or real document.
const test = require('node:test');
const assert = require('node:assert/strict');

const { runEvaluation, formatReport } = require('../../scripts/evaluate-extraction');

test('every labelled expectation holds on the synthetic evaluation set', () => {
  const result = runEvaluation();
  assert.deepEqual(result.failures, [], formatReport(result));
});

test('the evaluation metrics are perfect on the labelled set', () => {
  const { metrics } = runEvaluation();
  assert.equal(metrics.fieldAccuracy, 1);
  assert.equal(metrics.citationPrecision, 1);
  assert.equal(metrics.missingRecall, 1);
  assert.equal(metrics.conflictRecall, 1);
  assert.equal(metrics.languageAccuracy, 1);
  assert.equal(metrics.injectionAccuracy, 1);
  // The set must actually exercise each dimension, not pass trivially.
  assert.ok(metrics.fieldsChecked >= 20);
  assert.ok(metrics.citationsChecked >= 5);
  assert.ok(metrics.missingExpected >= 2);
  assert.ok(metrics.conflictExpected >= 1);
  assert.ok(metrics.languageChecked >= 3);
  assert.ok(metrics.injectionChecked >= 1);
});
