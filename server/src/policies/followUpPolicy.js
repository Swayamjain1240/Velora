'use strict';

// Follow-up policy (Part 8). Pure module: no database, no clock, no request.
//
// The product implements a BASIC prescribed follow-up: a date, a location, a
// contact and an optional in-app reminder. This policy keeps the boundary
// explicit and testable:
//
//   * The field list is closed. A request cannot smuggle a test-result field, a
//     report reference or a referral destination in, because there is nowhere for
//     it to go - the schema would refuse the unknown key even if this module did
//     not, and this module names the refusal for what it is.
//   * The WORDING guard refuses text that describes a results or referral
//     workflow, so the product cannot be used to hold a finding it does not model.
//   * Reminder timing is bounded, so a reminder cannot be scheduled absurdly far
//     ahead of (or after) the appointment.

const FOLLOW_UP_NOTE =
  'A follow-up is a prescribed appointment: a date, a place and a contact. It contains no test results, no reports and no referral, and nothing here interprets what will happen at the appointment.';
const REMINDER_NOTE =
  'The in-app reminder is a reminder about the appointment. It is not a result, and it does not mean the appointment has been confirmed by anyone.';

// Anything that would turn a scheduling record into a results or referral record.
const OUT_OF_SCOPE_WORDING = [
  /test result/i,
  /\bresults? (are|will be) (ready|back)\b/i,
  /report match/i,
  /matching report/i,
  /\breferral\b/i,
  /refer (the patient )?to (a|the) (specialist|department|clinic|team)/i,
  /await(ing)? (the )?(scan|test|report|biopsy)/i,
  /\bbiopsy result/i,
  /\bhistolog/i,
];

// The complete set of fields a follow-up may carry.
const ALLOWED_FIELDS = Object.freeze([
  'date',
  'time',
  'timezone',
  'location',
  'contactName',
  'contactPhone',
  'note',
  'reminder',
]);
const REMINDER_FIELDS = Object.freeze(['enabled', 'localTime', 'daysBefore']);

function wordingProblems(text) {
  if (!text) return [];
  return OUT_OF_SCOPE_WORDING.filter((pattern) => pattern.test(text)).map(() => text);
}

function isValidDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) &&
    !Number.isNaN(new Date(`${value.trim()}T00:00:00Z`).getTime());
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function isValidTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Structural validation on write (control #6). Bounds, formats and the wording
// boundary - never a clinical judgement.
function validateFollowUpInput(input = {}) {
  const problems = [];

  const unknown = Object.keys(input).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknown.length) {
    problems.push(
      `A follow-up carries only a date, a location, a contact and an optional reminder. Unsupported: ${unknown.join(', ')}.`
    );
  }

  if (!isValidDateOnly(input.date)) {
    problems.push('Give the follow-up date as YYYY-MM-DD.');
  }
  if (!isValidTimezone(input.timezone)) {
    problems.push('State the IANA timezone the follow-up date is in.');
  }
  if (input.time !== undefined && input.time !== null && !isValidTime(input.time)) {
    problems.push('The follow-up time must use HH:MM.');
  }
  if (!input.location || String(input.location).trim().length < 3) {
    problems.push('State where the follow-up is.');
  }
  if (input.location && String(input.location).length > 200) {
    problems.push('The location must be at most 200 characters.');
  }
  if (input.contactPhone && !/^[0-9+()\-\s]{3,40}$/.test(String(input.contactPhone))) {
    problems.push('The contact number contains unsupported characters.');
  }
  if (input.note !== undefined && input.note !== null) {
    if (!String(input.note).trim()) {
      problems.push('Write an instruction or leave it out.');
    }
    if (String(input.note).length > 500) {
      problems.push('The instruction must be at most 500 characters.');
    }
  }

  if (input.reminder !== undefined && input.reminder !== null) {
    const reminder = input.reminder;
    const unknownReminder = Object.keys(reminder).filter((key) => !REMINDER_FIELDS.includes(key));
    if (unknownReminder.length) {
      problems.push(`Unsupported reminder options: ${unknownReminder.join(', ')}.`);
    }
    if (reminder.localTime !== undefined && reminder.localTime !== null && !isValidTime(reminder.localTime)) {
      problems.push('The reminder time must use HH:MM.');
    }
    if (reminder.daysBefore !== undefined) {
      const days = Number(reminder.daysBefore);
      if (!Number.isInteger(days) || days < 0 || days > 30) {
        problems.push('A reminder may be 0-30 days before the appointment.');
      }
    }
  }

  // The wording boundary applies to everything a patient will read.
  for (const field of ['location', 'note', 'contactName']) {
    if (wordingProblems(input[field]).length) {
      problems.push(
        'Describe the appointment (where and who to contact). Results, reports, referrals and test matching are not part of a follow-up.'
      );
      break;
    }
  }

  return problems;
}

// The local date the in-app reminder should appear on: the appointment date minus
// the configured number of days. Arithmetic on the CALENDAR date itself, so a
// daylight-saving change can never shift the day the reminder appears on.
function reminderDateOnly({ date, daysBefore = 1 }) {
  if (!isValidDateOnly(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() - Math.max(0, daysBefore));
  return base.toISOString().slice(0, 10);
}

module.exports = {
  validateFollowUpInput,
  wordingProblems,
  reminderDateOnly,
  isValidDateOnly,
  isValidTime,
  isValidTimezone,
  FOLLOW_UP_NOTE,
  REMINDER_NOTE,
  ALLOWED_FIELDS,
  REMINDER_FIELDS,
  OUT_OF_SCOPE_WORDING,
};
