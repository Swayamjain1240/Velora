'use strict';

// Schedule & recovery-task domain policy (Part 7). Pure functions only: no
// database, no request context, no clock of its own.
//
// Governing rules, in the tradition of Part 5's care-plan policy:
//   1. A schedule may ONLY be derived from an approved, clinician-confirmed
//      CarePlanItem. Nothing here reads a draft.
//   2. A conditional/PRN medicine NEVER becomes an unconditional repeating
//      dose. It becomes an as-needed entry with NO generated occurrences.
//   3. A missing or ambiguous timing is never guessed: the item stays
//      `needs_details` and generates nothing until a human states the detail.
//   4. Nothing here diagnoses, advises a substitute dose, or suggests taking an
//      extra dose after a not-recorded entry.

const zonedTime = require('../services/zonedTime');

const SCHEDULE_TYPE = Object.freeze({ MEDICATION: 'medication', TASK: 'task' });

// `needs_details` is a first-class state: it is not an error and not a draft -
// it records that the approved wording does not state when the instruction
// happens, so no occurrence is invented.
const SCHEDULE_STATUS = Object.freeze({
  NEEDS_DETAILS: 'needs_details',
  PENDING_ACTIVATION: 'pending_activation',
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  ENDED: 'ended',
});

const ACTIVATION = Object.freeze({
  CLINICAL_REVIEWER: 'clinical_reviewer',
  OPERATIONAL: 'coordinator',
});

const OCCURRENCE_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  SUPERSEDED: 'superseded',
  ENDED: 'ended',
});

const OCCURRENCE_ORIGIN = Object.freeze({ SCHEDULED: 'scheduled', AS_NEEDED: 'as_needed' });

// The five facts a day view can show. Four are recorded facts; `not_recorded`
// means exactly that - no entry exists - and is NEVER a missed dose or a
// statement about adherence.
const ENTRY_STATES = Object.freeze({
  TAKEN: 'taken',
  SKIPPED: 'skipped',
  REPORTED_DONE: 'reported_done',
  NEEDS_HELP: 'needs_help',
});
const ENTRY_STATE_VALUES = Object.freeze(Object.values(ENTRY_STATES));
const NOT_RECORDED = 'not_recorded';
const TODAY_STATES = Object.freeze([...ENTRY_STATE_VALUES, NOT_RECORDED]);

// Which approved item becomes what. `warning` is intentionally schedulable as
// nothing: a caution is read, never scheduled, so it stays plan text only.
const ITEM_KIND_TO_TYPE = Object.freeze({
  medication: SCHEDULE_TYPE.MEDICATION,
  instruction: SCHEDULE_TYPE.TASK,
  monitoring: SCHEDULE_TYPE.TASK,
  home_care: SCHEDULE_TYPE.TASK,
  diet_activity: SCHEDULE_TYPE.TASK,
  follow_up: SCHEDULE_TYPE.TASK,
});

const MAX_GENERATED_OCCURRENCES = 400;
const DEFAULT_HORIZON_DAYS = 30;

// Wording that makes a medicine conditional. A PRN medicine is never given a
// repeating time list, because "as needed" and "08:00 and 20:00" contradict.
const PRN_MARKERS = Object.freeze([
  'prn',
  'p.r.n',
  'p r n',
  'as needed',
  'as required',
  'as necessary',
  'when needed',
  'when required',
  'if needed',
  'if required',
  'only if',
  'sos',
  's.o.s',
]);

// Frequency phrases whose daily time sets are unambiguous enough to schedule.
// The wall-clock defaults are a non-clinical convenience: a medication schedule
// still requires a verified clinical reviewer's activation before a patient ever
// sees it, and the reviewer is shown exactly which times were derived.
// NOTE: an hour INTERVAL is deliberately absent here. "every 6 hours" does not
// state when the first dose is, and guessing that anchor would move every dose
// of the day - so it stays `needs_details` (see deriveTimes).
const FREQUENCY_TIMES = Object.freeze([
  { match: /^(once|one time|1 time|single)( a| per)? ?(day|daily)|^daily$|^od$|^every day$/, times: ['09:00'] },
  { match: /^(twice|two times|2 times)( a| per)? ?(day|daily)|^bd$|^b\.i\.d\.?$/, times: ['09:00', '21:00'] },
  { match: /^(three times|thrice|3 times)( a| per)? ?(day|daily)|^tds$|^t\.i\.d\.?$/, times: ['09:00', '14:00', '21:00'] },
  { match: /^(four times|4 times)( a| per)? ?(day|daily)|^qds$|^q\.i\.d\.?$/, times: ['09:00', '13:00', '17:00', '21:00'] },
]);

// Named day-parts are explicit enough to schedule without inventing a number.
const DAYPART_TIMES = Object.freeze([
  { match: /morning/, time: '09:00' },
  { match: /(midday|noon|lunch)/, time: '12:30' },
  { match: /(afternoon)/, time: '15:00' },
  { match: /(evening|dinner)/, time: '19:00' },
  { match: /(night|bedtime|before bed)/, time: '21:00' },
]);

function normalize(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function scheduleTypeFor(item) {
  const kind = normalize(item && item.kind);
  return ITEM_KIND_TO_TYPE[kind] || null;
}

function isSchedulable(item) {
  return scheduleTypeFor(item) !== null;
}

// A conditional instruction: an explicit `condition`, or PRN wording anywhere in
// the frequency/timing/condition/original wording.
function detectConditional(item = {}) {
  const condition = normalize(item.condition);
  if (condition) return { conditional: true, reason: 'condition' };

  const haystack = [item.frequency, item.timing, item.originalWording]
    .map(normalize)
    .join(' ');
  for (const marker of PRN_MARKERS) {
    if (new RegExp(`(^|[^a-z])${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(haystack)) {
      return { conditional: true, reason: `prn_wording:${marker}` };
    }
  }
  return { conditional: false, reason: null };
}

// Explicit clock times written in the item, in either 12- or 24-hour form.
function explicitTimes(text) {
  const found = new Set();
  const source = String(text || '');
  const twelveHour = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;
  let match = twelveHour.exec(source);
  while (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const suffix = match[3].toLowerCase().replace(/\./g, '');
    if (hour >= 1 && hour <= 12 && minute < 60) {
      if (suffix === 'pm' && hour !== 12) hour += 12;
      if (suffix === 'am' && hour === 12) hour = 0;
      found.add(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
    match = twelveHour.exec(source);
  }
  const twentyFour = /(?:^|[^0-9:])([01]?\d|2[0-3]):([0-5]\d)(?!\s*[ap]\.?m)/gi;
  let second = twentyFour.exec(source);
  while (second) {
    found.add(`${String(Number(second[1])).padStart(2, '0')}:${second[2]}`);
    second = twentyFour.exec(source);
  }
  return [...found].sort();
}

function daypartTimes(text) {
  const lower = normalize(text);
  const times = new Set();
  for (const rule of DAYPART_TIMES) {
    if (rule.match.test(lower)) times.add(rule.time);
  }
  return [...times].sort();
}

// Derives the daily wall times for a schedule, or reports why it cannot.
// Returns { times: string[], detail: string } - `times` empty means the approved
// wording does not say when, so the schedule must stay `needs_details`.
function addHours(time, hours) {
  const [hour, minute] = time.split(':').map(Number);
  const total = (hour + hours) % 24;
  return `${String(total).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function deriveTimes(item = {}) {
  const frequency = normalize(item.frequency);
  const timing = normalize(item.timing);
  const combined = `${frequency} ${timing}`.trim();
  const explicit = explicitTimes(combined);

  // An hour INTERVAL is arithmetic, not judgement - but only when the wording
  // states BOTH the interval and where it starts. "every 6 hours" alone has no
  // anchor, so it stays unresolved instead of inventing a first dose.
  const interval = /every\s+(\d+)\s*(hour|hours|hr|hrs)/.exec(combined);
  if (interval) {
    const hours = Number(interval[1]);
    if (!hours || 24 % hours !== 0) return { times: [], detail: 'interval_not_whole_day' };
    const anchors = explicit.length ? explicit : daypartTimes(combined);
    if (!anchors.length) return { times: [], detail: 'interval_without_anchor' };
    const anchor = anchors[0];
    const times = [];
    for (let step = 0; step < 24 / hours; step += 1) times.push(addHours(anchor, step * hours));
    return { times: [...new Set(times)].sort(), detail: `interval:every ${hours} hours from ${anchor}` };
  }

  if (explicit.length) return { times: explicit, detail: `explicit_times:${explicit.join(',')}` };

  for (const rule of FREQUENCY_TIMES) {
    if (rule.match.test(frequency) || rule.match.test(combined)) {
      return { times: [...rule.times], detail: `frequency:${frequency || combined}` };
    }
  }

  const parts = daypartTimes(combined);
  if (parts.length) return { times: parts, detail: `day_part:${combined}` };

  if (!frequency && !timing) return { times: [], detail: 'no_frequency_or_timing' };
  return { times: [], detail: `unmapped_wording:${combined.slice(0, 120)}` };
}

// Duration in days, or null when the source states none / an unbounded one.
function deriveDurationDays(item = {}) {
  const text = normalize(item.duration);
  if (!text) return null;
  const days = /(\d+)\s*(day|days)/.exec(text);
  if (days) return Math.min(Number(days[1]), 365);
  const weeks = /(\d+)\s*(week|weeks)/.exec(text);
  if (weeks) return Math.min(Number(weeks[1]) * 7, 365);
  const months = /(\d+)\s*(month|months)/.exec(text);
  if (months) return Math.min(Number(months[1]) * 30, 365);
  if (/(ongoing|continue|until reviewed|long term|long-term)/.test(text)) return null;
  return null;
}

function activationRequirementFor(type) {
  return type === SCHEDULE_TYPE.MEDICATION
    ? ACTIVATION.CLINICAL_REVIEWER
    : ACTIVATION.OPERATIONAL;
}

// A plan of what preparation would create for one approved item, with no
// database access. `status` is the state the schedule/task is created in.
function planForItem(item, { startDate, timezone, horizonDays = DEFAULT_HORIZON_DAYS } = {}) {
  const type = scheduleTypeFor(item);
  if (!type) return null;

  const conditional = detectConditional(item);
  const derived = conditional.conditional ? { times: [], detail: 'conditional' } : deriveTimes(item);
  const durationDays = deriveDurationDays(item);
  const endDate = durationDays === null ? null : zonedTime.addDays(startDate, durationDays - 1);

  // A conditional instruction is NOT a missing detail: it is complete and
  // intentional, it simply has no repeating time. It can be activated (and then
  // recorded when it happens), while an instruction whose timing was never
  // stated stays `needs_details` and can never be activated.
  const status =
    conditional.conditional || derived.times.length
      ? SCHEDULE_STATUS.PENDING_ACTIVATION
      : SCHEDULE_STATUS.NEEDS_DETAILS;

  return {
    type,
    conditional: conditional.conditional,
    conditionalReason: conditional.reason,
    scheduleKind: conditional.conditional ? OCCURRENCE_ORIGIN.AS_NEEDED : 'fixed',
    timesOfDay: derived.times,
    timingDetail: derived.detail,
    durationDays,
    endDate,
    timezone,
    startDate,
    horizonDays,
    status,
    activationRequired: activationRequirementFor(type),
  };
}

// Generates the UTC occurrences for one prepared schedule between two local
// dates (inclusive). A wall time that does not exist on a given day because of a
// DST spring-forward gap is SKIPPED and reported, never shifted: a silently
// moved dose is exactly the failure mode this rule prevents.
function generateOccurrences({
  timesOfDay = [],
  timezone,
  fromDate,
  throughDate,
  max = MAX_GENERATED_OCCURRENCES,
}) {
  const items = [];
  const skipped = [];
  if (!timesOfDay.length) return { items, skipped, truncated: false };

  let date = fromDate;
  let guard = 0;
  while (date <= throughDate) {
    guard += 1;
    if (guard > 400) break;
    for (const time of timesOfDay) {
      const converted = zonedTime.zonedTimeToUtc({ dateOnly: date, time, timezone });
      if (!converted.instant) {
        skipped.push({ localDate: date, localTime: time, reason: 'dst_gap' });
        continue;
      }
      if (items.length >= max) return { items, skipped, truncated: true };
      items.push({
        scheduledAtUtc: converted.instant,
        localDate: date,
        localTime: time,
        offset: zonedTime.offsetLabel(converted.instant, timezone),
        ambiguous: converted.ambiguous,
      });
    }
    date = zonedTime.addDays(date, 1);
  }
  return { items, skipped, truncated: false };
}

function todayState(log) {
  if (!log) return NOT_RECORDED;
  return ENTRY_STATE_VALUES.includes(log.entryState) ? log.entryState : NOT_RECORDED;
}

// A patient or caregiver entry is a SELF-REPORT. It is never a clinician
// verification and must be labelled as such wherever it is shown.
function isSelfReport(actorRole) {
  return actorRole === 'patient' || actorRole === 'caregiver';
}

// Wording shown next to a day view. Deliberately contains no instruction to take
// a dose: it never tells anyone to double up after a missing entry.
const SAFETY_NOTE =
  'An entry with nothing recorded is not a missed dose and never means you should take an extra ' +
  'or replacement dose. Follow the approved plan and contact your care team with any question ' +
  'about a dose.';

const AS_NEEDED_NOTE =
  'This medicine or task is conditional: record it when it happens. No repeating time is ' +
  'generated for it, so nothing here is shown as due.';

const SELF_REPORT_NOTE =
  'Entries recorded by a patient or caregiver are self-reports. They are not clinical verification.';

module.exports = {
  SCHEDULE_TYPE,
  SCHEDULE_STATUS,
  ACTIVATION,
  OCCURRENCE_STATUS,
  OCCURRENCE_ORIGIN,
  ENTRY_STATES,
  ENTRY_STATE_VALUES,
  NOT_RECORDED,
  TODAY_STATES,
  ITEM_KIND_TO_TYPE,
  MAX_GENERATED_OCCURRENCES,
  DEFAULT_HORIZON_DAYS,
  PRN_MARKERS,
  scheduleTypeFor,
  isSchedulable,
  detectConditional,
  deriveTimes,
  deriveDurationDays,
  activationRequirementFor,
  planForItem,
  generateOccurrences,
  todayState,
  isSelfReport,
  SAFETY_NOTE,
  AS_NEEDED_NOTE,
  SELF_REPORT_NOTE,
};
