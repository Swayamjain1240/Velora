'use strict';

// Zoned-time helpers (Part 7, controls #5/#6). Pure functions over the IANA
// timezone database - no dependency, no server clock inside the conversions.
//
// Why this module exists: recovery schedules are authored as LOCAL wall times
// ("08:00 and 20:00 in Europe/London") but stored and compared as UTC instants.
// Those two representations disagree twice a year, so every conversion goes
// through one implementation here instead of being re-derived per caller.
//
// Deterministic DST rules (documented so a test can pin them):
//   - a local time that does not exist (spring-forward gap) converts to NO
//     instant; the caller must decide, and schedule generation SKIPS the slot
//     rather than silently shifting it;
//   - a local time that occurs twice (autumn fall-back) converts to the EARLIER
//     instant, so a dose is never pushed later by an hour of clock change.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;

// Wall-clock parts of an instant, in the given zone.
function localParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const dateOnly = `${parts.year}-${parts.month}-${parts.day}`;
  const timeOnly = `${parts.hour}:${parts.minute}`;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dateOnly,
    timeOnly,
    secondsOnly: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

// Offsets are whole minutes in every zone the ICU database ships, so a minute
// resolution is exact and keeps the arithmetic obvious.
function offsetMinutesAt(date, timezone) {
  const parts = localParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const instant = Math.floor(date.getTime() / 1000) * 1000;
  return (asUtc - instant) / 60000;
}

function matchesLocal(date, dateOnly, time, timezone) {
  const parts = localParts(date, timezone);
  return parts.dateOnly === dateOnly && parts.timeOnly === time;
}

// Converts a local wall time in a zone to the UTC instant it names.
// Returns `{ instant, nonexistent, ambiguous }`; `instant` is null exactly when
// the local time does not exist that day (DST spring-forward gap).
function zonedTimeToUtc({ dateOnly, time, timezone, disambiguation = 'earlier' }) {
  if (!DATE_ONLY.test(String(dateOnly))) throw new TypeError('dateOnly must be YYYY-MM-DD');
  if (!TIME_ONLY.test(String(time))) throw new TypeError('time must be HH:MM (24 hour)');

  const [year, month, day] = dateOnly.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Probe the offset a half-day on either side of the naive instant as well as
  // at it: a DST transition inside that window is exactly what makes the local
  // time missing (spring forward) or doubled (autumn fall back).
  const probeOffsets = [
    offsetMinutesAt(new Date(naiveUtc - 12 * 3600 * 1000), timezone),
    offsetMinutesAt(new Date(naiveUtc), timezone),
    offsetMinutesAt(new Date(naiveUtc + 12 * 3600 * 1000), timezone),
  ];

  const candidates = [...new Set(probeOffsets.map((offset) => naiveUtc - offset * 60000))]
    .map((ms) => new Date(ms))
    .filter((candidate) => matchesLocal(candidate, dateOnly, time, timezone))
    .sort((a, b) => a.getTime() - b.getTime());

  if (!candidates.length) return { instant: null, nonexistent: true, ambiguous: false };
  const chosen = disambiguation === 'later' ? candidates[candidates.length - 1] : candidates[0];
  return { instant: chosen, nonexistent: false, ambiguous: candidates.length > 1 };
}

// The zone's UTC offset in force at an instant, as "+05:30" / "-04:00".
function offsetLabel(date, timezone) {
  const minutes = offsetMinutesAt(date, timezone);
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mm = String(absolute % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function isValidTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    // Throws for an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Calendar-date arithmetic on the DATE STRING, so a month/day rollover never
// depends on the server's own zone.
function addDays(dateOnly, days) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return shifted.toISOString().slice(0, 10);
}

function addMinutes(dateOnly, time, minutes) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes, 0, 0));
  return {
    dateOnly: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16),
  };
}

// The calendar date AS SEEN IN a zone, which is what "today" means to a patient
// whose clinic authored the plan in another offset.
function todayInTimezone(timezone, now = new Date()) {
  return localParts(now, timezone).dateOnly;
}

function isValidDateOnly(value) {
  if (!DATE_ONLY.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTimeOnly(value) {
  return TIME_ONLY.test(String(value));
}

// Difference in whole calendar days between two YYYY-MM-DD strings.
function daysBetween(fromDateOnly, toDateOnly) {
  const from = Date.parse(`${fromDateOnly}T00:00:00.000Z`);
  const to = Date.parse(`${toDateOnly}T00:00:00.000Z`);
  return Math.round((to - from) / 86400000);
}

module.exports = {
  DATE_ONLY,
  TIME_ONLY,
  localParts,
  offsetMinutesAt,
  offsetLabel,
  zonedTimeToUtc,
  isValidTimezone,
  isValidDateOnly,
  isValidTimeOnly,
  addDays,
  addMinutes,
  todayInTimezone,
  daysBetween,
};
