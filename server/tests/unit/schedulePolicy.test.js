'use strict';

// Unit coverage for the deterministic parts of Part 7: IANA/DST conversion and
// the wording rules that decide what may be scheduled at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zonedTime = require('../../src/services/zonedTime');
const policy = require('../../src/policies/schedulePolicy');

// ---- zoned time -------------------------------------------------------------

test('an IANA zone is validated without accepting a made-up one', () => {
  assert.equal(zonedTime.isValidTimezone('Europe/London'), true);
  assert.equal(zonedTime.isValidTimezone('Asia/Kolkata'), true);
  assert.equal(zonedTime.isValidTimezone('Not/AZone'), false);
  assert.equal(zonedTime.isValidTimezone(''), false);
  assert.equal(zonedTime.isValidTimezone('GMT+5'), false);
});

test('a wall time converts to the UTC instant of its own offset', () => {
  const london = zonedTime.zonedTimeToUtc({ dateOnly: '2026-10-13', time: '08:00', timezone: 'Europe/London' });
  assert.equal(london.instant.toISOString(), '2026-10-13T07:00:00.000Z');
  const kolkata = zonedTime.zonedTimeToUtc({ dateOnly: '2026-10-13', time: '08:00', timezone: 'Asia/Kolkata' });
  assert.equal(kolkata.instant.toISOString(), '2026-10-13T02:30:00.000Z');
  assert.equal(zonedTime.offsetLabel(kolkata.instant, 'Asia/Kolkata'), '+05:30');
});

test('a wall time inside the spring-forward gap has no instant at all', () => {
  // America/New_York loses 02:00-03:00 on 2027-03-14.
  const gap = zonedTime.zonedTimeToUtc({ dateOnly: '2027-03-14', time: '02:30', timezone: 'America/New_York' });
  assert.equal(gap.instant, null);
  assert.equal(gap.nonexistent, true);
  // The same clock time the day before and after exists normally.
  assert.ok(zonedTime.zonedTimeToUtc({ dateOnly: '2027-03-13', time: '02:30', timezone: 'America/New_York' }).instant);
  assert.ok(zonedTime.zonedTimeToUtc({ dateOnly: '2027-03-15', time: '02:30', timezone: 'America/New_York' }).instant);
});

test('a wall time that happens twice resolves to the earlier instant', () => {
  // Europe/London repeats 01:30 on 2026-10-25 (BST then GMT).
  const first = zonedTime.zonedTimeToUtc({ dateOnly: '2026-10-25', time: '01:30', timezone: 'Europe/London' });
  assert.equal(first.ambiguous, true);
  assert.equal(first.instant.toISOString(), '2026-10-25T00:30:00.000Z');
  const later = zonedTime.zonedTimeToUtc({
    dateOnly: '2026-10-25',
    time: '01:30',
    timezone: 'Europe/London',
    disambiguation: 'later',
  });
  assert.equal(later.instant.toISOString(), '2026-10-25T01:30:00.000Z');
});

test('local calendar dates are read in the zone, not on the server clock', () => {
  const instant = new Date('2026-10-13T23:30:00.000Z');
  assert.equal(zonedTime.todayInTimezone('UTC', instant), '2026-10-13');
  assert.equal(zonedTime.todayInTimezone('Asia/Kolkata', instant), '2026-10-14');
  assert.equal(zonedTime.todayInTimezone('America/Los_Angeles', instant), '2026-10-13');
  assert.equal(zonedTime.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(zonedTime.daysBetween('2026-10-01', '2026-10-31'), 30);
});

// ---- wording rules ----------------------------------------------------------

test('a medication becomes a medication schedule and a caution becomes nothing', () => {
  assert.equal(policy.scheduleTypeFor({ kind: 'medication' }), 'medication');
  assert.equal(policy.scheduleTypeFor({ kind: 'home_care' }), 'task');
  assert.equal(policy.scheduleTypeFor({ kind: 'warning' }), null);
  assert.equal(policy.isSchedulable({ kind: 'warning' }), false);
});

test('PRN and conditional wording is detected and never yields repeating times', () => {
  const prn = policy.detectConditional({
    kind: 'medication',
    frequency: 'every 6 hours',
    timing: 'as needed for pain',
    originalWording: 'Paracetamol 500 mg oral every 6 hours as needed for pain',
  });
  assert.equal(prn.conditional, true);

  const conditional = policy.detectConditional({ kind: 'medication', condition: 'if the temperature is above 38C' });
  assert.equal(conditional.conditional, true);
  assert.equal(conditional.reason, 'condition');

  const plan = policy.planForItem(
    {
      kind: 'medication',
      dose: '500 mg',
      frequency: 'every 6 hours',
      timing: 'as needed for pain',
      condition: 'only for pain',
      duration: '3 days',
      originalWording: 'Paracetamol 500 mg every 6 hours as needed for pain for 3 days',
    },
    { startDate: '2026-10-13', timezone: 'Europe/London' }
  );
  assert.equal(plan.scheduleKind, 'as_needed');
  assert.deepEqual(plan.timesOfDay, []);
  // Conditional medicine can never become a repeating dose: it is offered as an
  // as-needed entry (activatable, but with zero generated slots), NOT as a
  // repeating schedule.
  assert.equal(plan.status, policy.SCHEDULE_STATUS.PENDING_ACTIVATION);
});

test('stated frequencies and stated clock times give exact daily times', () => {
  assert.deepEqual(policy.deriveTimes({ frequency: 'twice daily' }).times, ['09:00', '21:00']);
  assert.deepEqual(policy.deriveTimes({ frequency: 'three times daily' }).times, ['09:00', '14:00', '21:00']);
  assert.deepEqual(policy.deriveTimes({ timing: 'at 8am and 8pm' }).times, ['08:00', '20:00']);
  assert.deepEqual(policy.deriveTimes({ frequency: 'once daily', timing: 'in the morning' }).times, ['09:00']);
});

test('an interval with no stated anchor stays unresolved instead of inventing one', () => {
  const derived = policy.deriveTimes({ frequency: 'every 6 hours' });
  assert.deepEqual(derived.times, []);
  assert.equal(derived.detail, 'interval_without_anchor');
  const plan = policy.planForItem(
    { kind: 'medication', dose: '500 mg', frequency: 'every 6 hours', duration: '3 days', originalWording: 'x' },
    { startDate: '2026-10-13', timezone: 'Europe/London' }
  );
  assert.equal(plan.status, policy.SCHEDULE_STATUS.NEEDS_DETAILS);
});

test('durations become bounded end dates and unbounded wording does not', () => {
  assert.equal(policy.deriveDurationDays({ duration: '3 days' }), 3);
  assert.equal(policy.deriveDurationDays({ duration: '2 weeks' }), 14);
  assert.equal(policy.deriveDurationDays({ duration: 'until reviewed' }), null);
  assert.equal(policy.deriveDurationDays({ duration: '' }), null);
});

test('generation skips a DST gap and reports it instead of shifting the dose', () => {
  const generated = policy.generateOccurrences({
    timesOfDay: ['02:30'],
    timezone: 'America/New_York',
    fromDate: '2027-03-13',
    throughDate: '2027-03-15',
  });
  assert.equal(generated.items.length, 2);
  assert.deepEqual(
    generated.items.map((item) => item.localDate),
    ['2027-03-13', '2027-03-15']
  );
  assert.deepEqual(generated.skipped, [{ localDate: '2027-03-14', localTime: '02:30', reason: 'dst_gap' }]);
});

test('a day state is the recorded fact, and nothing recorded is not adherence', () => {
  assert.equal(policy.todayState(null), 'not_recorded');
  assert.equal(policy.todayState({ entryState: 'taken' }), 'taken');
  assert.equal(policy.todayState({ entryState: 'reported_done' }), 'reported_done');
  assert.equal(policy.isSelfReport('patient'), true);
  assert.equal(policy.isSelfReport('caregiver'), true);
  assert.equal(policy.isSelfReport('care_coordinator'), false);
  assert.match(policy.SAFETY_NOTE, /not a missed dose/);
  assert.doesNotMatch(policy.SAFETY_NOTE, /take (an|another) extra dose to catch up/);
});

test('occupancy bounds keep one schedule from generating an unbounded list', () => {
  const generated = policy.generateOccurrences({
    timesOfDay: ['09:00', '21:00'],
    timezone: 'UTC',
    fromDate: '2026-01-01',
    throughDate: '2026-12-31',
    max: 20,
  });
  assert.equal(generated.items.length, 20);
  assert.equal(generated.truncated, true);
});
