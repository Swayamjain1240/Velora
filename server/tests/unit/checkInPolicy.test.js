'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/policies/checkInPolicy');

const GOOD = {
  questions: [
    { id: 'pain_level', prompt: 'How would you rate your pain today?', kind: 'scale', scaleMin: 0, scaleMax: 10 },
    {
      id: 'wound_state',
      prompt: 'Is the wound area red, hot or leaking?',
      kind: 'choice',
      options: ['no', 'red', 'hot', 'leaking'],
    },
    { id: 'walking', prompt: 'Were you able to walk around today?', kind: 'confirm' },
  ],
  cadence: { startOffsetDays: 1, everyDays: 2, horizonDays: 14 },
  responseWindowHours: 24,
  reviewRules: [
    {
      id: 'pain_high',
      label: 'Pain score was high - a clinician should look at this',
      when: { questionId: 'pain_level', operator: 'at_least', value: 7 },
      action: 'queue_review',
    },
    {
      id: 'wound_flagged',
      label: 'The patient reported a wound change that needs a clinician to look',
      when: { questionId: 'wound_state', operator: 'includes_any', values: ['red', 'hot', 'leaking'] },
      action: 'queue_review',
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('a well-formed clinic template has no problems', () => {
  assert.deepEqual(policy.validateTemplateDefinition(GOOD), []);
});

test('a template without questions or with a bad cadence is refused', () => {
  const noQuestions = clone(GOOD);
  noQuestions.questions = [];
  assert.match(policy.validateTemplateDefinition(noQuestions).join(' '), /at least one question/i);

  const badCadence = clone(GOOD);
  badCadence.cadence = { startOffsetDays: 1, everyDays: 30, horizonDays: 7 };
  assert.match(
    policy.validateTemplateDefinition(badCadence).join(' '),
    /horizon must cover at least one interval/i
  );

  const farFuture = clone(GOOD);
  farFuture.cadence = { startOffsetDays: 400, everyDays: 1, horizonDays: 7 };
  assert.match(policy.validateTemplateDefinition(farFuture).join(' '), /0-180 days/i);
});

test('question ids are unique slugs and choices need bounded distinct options', () => {
  const duplicate = clone(GOOD);
  duplicate.questions[1].id = 'pain_level';
  assert.match(policy.validateTemplateDefinition(duplicate).join(' '), /reuses the id/i);

  const badSlug = clone(GOOD);
  badSlug.questions[0].id = 'Pain Level!';
  assert.match(policy.validateTemplateDefinition(badSlug).join(' '), /short slug id/i);

  const oneOption = clone(GOOD);
  oneOption.questions[1].options = ['red'];
  assert.match(policy.validateTemplateDefinition(oneOption).join(' '), /at least two options/i);

  const repeated = clone(GOOD);
  repeated.questions[1].options = ['red', 'red'];
  assert.match(policy.validateTemplateDefinition(repeated).join(' '), /duplicate options/i);

  const badScale = clone(GOOD);
  badScale.questions[0].scaleMax = 40;
  assert.match(policy.validateTemplateDefinition(badScale).join(' '), /bounded 0-10 range/i);
});

test('rules must point at a real question and use a supported condition', () => {
  const dangling = clone(GOOD);
  dangling.reviewRules[0].when.questionId = 'not_a_question';
  assert.match(
    policy.validateTemplateDefinition(dangling).join(' '),
    /point at one of this template's questions/i
  );

  const noValues = clone(GOOD);
  noValues.reviewRules[1].when.values = [];
  assert.match(policy.validateTemplateDefinition(noValues).join(' '), /at least one value/i);

  const noThreshold = clone(GOOD);
  delete noThreshold.reviewRules[0].when.value;
  assert.match(policy.validateTemplateDefinition(noThreshold).join(' '), /numeric threshold/i);

  const unsupported = clone(GOOD);
  unsupported.reviewRules[0].when.operator = 'escalate';
  assert.match(policy.validateTemplateDefinition(unsupported).join(' '), /unsupported condition/i);
});

test('a rule action other than a human review is refused', () => {
  const escalate = clone(GOOD);
  escalate.reviewRules[0].action = 'escalate_autonomously';
  assert.match(
    policy.validateTemplateDefinition(escalate).join(' '),
    /only supported action is a review queued for a person/i
  );
});

test('diagnostic wording is refused in a rule label', () => {
  for (const label of [
    'Abnormal response detected',
    'The patient may have an infection',
    'This indicates a complication',
    'Signs of deterioration - escalate',
    'AI reviewed this as abnormal',
  ]) {
    const template = clone(GOOD);
    template.reviewRules[0].label = label;
    const problems = policy.validateTemplateDefinition(template).join(' ');
    assert.match(problems, /diagnostic wording/i, `expected a refusal for "${label}"`);
  }
});

test('diagnostic wording is refused in a question prompt', () => {
  const template = clone(GOOD);
  template.questions[0].prompt = 'Do you have signs of infection?';
  assert.match(policy.validateTemplateDefinition(template).join(' '), /clinical interpretation/i);

  // The same guard must NOT block an ordinary question or the clinic's own
  // warning wording, which is asking, not concluding.
  const ordinary = clone(GOOD);
  ordinary.questions[1].prompt = 'Is the wound area red, hot or leaking?';
  assert.deepEqual(policy.validateTemplateDefinition(ordinary), []);
});

test('rule evaluation returns attention, never a classification', () => {
  const triggered = policy.evaluateRules(GOOD, {
    answers: [{ questionId: 'pain_level', value: 8 }],
  });
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].id, 'pain_high');
  assert.ok(!('severity' in triggered[0]));
  assert.ok(!('diagnosis' in triggered[0]));
  assert.ok(!('score' in triggered[0]));
});

test('every supported operator evaluates against a submitted answer', () => {
  const template = {
    reviewRules: [
      { id: 'a', label: 'answered', when: { questionId: 'q', operator: 'answered' }, action: 'queue_review' },
      { id: 'b', label: 'no answer', when: { questionId: 'q', operator: 'no_answer' }, action: 'queue_review' },
      { id: 'c', label: 'equals', when: { questionId: 'q', operator: 'equals', values: ['yes'] }, action: 'queue_review' },
      { id: 'd', label: 'not equals', when: { questionId: 'q', operator: 'not_equals', values: ['no'] }, action: 'queue_review' },
      { id: 'e', label: 'any', when: { questionId: 'q', operator: 'includes_any', values: ['yes'] }, action: 'queue_review' },
      { id: 'f', label: 'at least', when: { questionId: 'q', operator: 'at_least', value: 5 }, action: 'queue_review' },
      { id: 'g', label: 'at most', when: { questionId: 'q', operator: 'at_most', value: 5 }, action: 'queue_review' },
    ],
  };

  const yes = policy.evaluateRules(template, { answers: [{ questionId: 'q', value: 'Yes' }] }).map((r) => r.id);
  assert.deepEqual(yes.sort(), ['a', 'c', 'd', 'e'].sort());

  const missing = policy.evaluateRules(template, { answers: [] }).map((r) => r.id);
  assert.deepEqual(missing, ['b']);

  const numeric = policy.evaluateRules(template, { answers: [{ questionId: 'q', value: 5 }] }).map((r) => r.id);
  assert.deepEqual(numeric.sort(), ['a', 'd', 'f', 'g'].sort());

  const list = policy.evaluateRules(template, {
    answers: [{ questionId: 'q', value: ['yes', 'other'] }],
  }).map((r) => r.id);
  assert.ok(list.includes('e'));
});

test('a review summary never calls a response normal or abnormal', () => {
  const attention = policy.reviewSummary({
    reviewState: 'needs_review',
    triggeredRules: [{ id: 'pain_high', label: 'Pain score was high' }],
  });
  assert.equal(attention.state, 'needs_review');
  assert.match(attention.note, /workflow attention/i);
  assert.match(attention.note, /not a diagnosis/i);

  const reviewed = policy.reviewSummary({ reviewState: 'reviewed', triggeredRules: [] });
  assert.equal(reviewed.state, 'reviewed');

  const plain = policy.reviewSummary({ reviewState: 'none', triggeredRules: [] });
  assert.equal(plain.state, 'none');
  assert.equal(plain.note, null);

  const serialised = JSON.stringify([attention, reviewed, plain]);
  assert.ok(!/normal|abnormal|diagnosis confirmed/i.test(serialised.replace(/not a diagnosis/g, '')));
});

test('a missing response stays missing and is never translated into a meaning', () => {
  const missing = policy.missingResponseSummary();
  assert.equal(missing.state, 'no_response');
  assert.equal(missing.isMissing, true);
  assert.match(missing.note, /not a normal result, not an abnormal result/i);
  assert.match(missing.note, /nothing is inferred/i);
});

test('the clinic-hours note never promises continuous monitoring', () => {
  assert.match(policy.CLINIC_HOURS_NOTE, /not monitored continuously/i);
  assert.match(policy.TEMPLATE_WORDING_NOTE, /do not diagnose/i);
});

test('answers are validated against the frozen version that asked them', () => {
  const problems = policy.validateAnswers(GOOD, [
    { questionId: 'pain_level', value: '4' },
    { questionId: 'wound_state', value: 'leaking' },
    { questionId: 'walking', value: 'true' },
  ]);
  assert.deepEqual(problems, []);
});

test('an answer to a question this version never asked is refused', () => {
  const problems = policy.validateAnswers(GOOD, [
    { questionId: 'pain_level', value: '4' },
    { questionId: 'invented_question', value: 'x' },
    { questionId: 'wound_state', value: 'red' },
    { questionId: 'walking', value: 'true' },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not part of this check-in/i);
});

test('a required question left blank, a duplicated question and out-of-range values are refused', () => {
  const blank = policy.validateAnswers(GOOD, [
    { questionId: 'wound_state', value: 'red' },
    { questionId: 'walking', value: 'true' },
  ]);
  assert.match(blank.join(' '), /pain_level.*needs an answer/i);

  const twice = policy.validateAnswers(GOOD, [
    { questionId: 'pain_level', value: '4' },
    { questionId: 'pain_level', value: '9' },
    { questionId: 'wound_state', value: 'no' },
    { questionId: 'walking', value: 'false' },
  ]);
  assert.match(twice.join(' '), /answered twice/i);

  const offScale = policy.validateAnswers(GOOD, [
    { questionId: 'pain_level', value: '11' },
    { questionId: 'wound_state', value: 'no' },
    { questionId: 'walking', value: 'false' },
  ]);
  assert.match(offScale.join(' '), /whole number from 0 to 10/i);

  const offList = policy.validateAnswers(GOOD, [
    { questionId: 'pain_level', value: '4' },
    { questionId: 'wound_state', value: 'infected' },
    { questionId: 'walking', value: 'false' },
  ]);
  assert.match(offList.join(' '), /one of its listed options/i);
});

test('answers are stored as comparison-ready strings so a rule is never tripped by coercion', () => {
  const stored = policy.normaliseAnswers(GOOD, [
    { questionId: 'pain_level', value: 0 },
    { questionId: 'wound_state', values: ['red', 'hot'] },
    { questionId: 'walking', value: true },
  ]);
  const byId = Object.fromEntries(stored.map((a) => [a.questionId, a]));
  assert.strictEqual(byId.pain_level.value, '0');
  assert.equal(typeof byId.pain_level.value, 'string');
  assert.deepEqual(byId.wound_state.values, ['red', 'hot']);
  assert.strictEqual(byId.walking.value, 'true');
});

test('a zero answer still triggers a numeric rule, but a missing one never does', () => {
  const zero = policy.evaluateRules(GOOD, {
    answers: [{ questionId: 'pain_level', value: '0' }],
  });
  assert.deepEqual(zero, []);

  const atMost = {
    questions: GOOD.questions,
    reviewRules: [
      {
        id: 'low',
        label: 'A clinician should look at this score',
        when: { questionId: 'pain_level', operator: 'at_most', value: 5 },
      },
    ],
  };
  assert.equal(
    policy.evaluateRules(atMost, { answers: [{ questionId: 'pain_level', value: '0' }] }).length,
    1,
    'an answered zero is a real answer'
  );
  assert.equal(
    policy.evaluateRules(atMost, { answers: [] }).length,
    0,
    'a question nobody answered must never satisfy a threshold rule'
  );
});

test('an open slot is open, a closed unanswered slot is missing, and a late answer is still an answer', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const open = policy.slotView(
    { state: 'open', dueAt: new Date('2026-03-10T09:00:00Z'), windowEndsAt: new Date('2026-03-11T09:00:00Z') },
    now
  );
  assert.equal(open.state, 'open');
  assert.equal(open.isMissing, false);

  const missing = policy.slotView(
    { state: 'open', dueAt: new Date('2026-03-08T09:00:00Z'), windowEndsAt: new Date('2026-03-09T09:00:00Z') },
    now
  );
  assert.equal(missing.state, 'no_response');
  assert.equal(missing.isMissing, true);
  assert.match(missing.note, /nothing is inferred/i);

  const late = policy.slotView(
    {
      state: 'submitted',
      isLate: true,
      submittedAt: new Date('2026-03-09T10:00:00Z'),
      windowEndsAt: new Date('2026-03-09T09:00:00Z'),
      reviewState: 'none',
      triggeredRules: [],
      answers: [{ questionId: 'pain_level', value: '3' }],
    },
    now
  );
  assert.equal(late.state, 'submitted');
  assert.equal(late.isLate, true);
  assert.match(late.note, /timing fact/i);
  assert.match(late.note, /not a clinical finding/i);

  assert.equal(
    policy.isLateSubmission(new Date('2026-03-09T10:00:00Z'), new Date('2026-03-09T09:00:00Z')),
    true
  );
  assert.equal(
    policy.isLateSubmission(new Date('2026-03-09T08:00:00Z'), new Date('2026-03-09T09:00:00Z')),
    false
  );
});
