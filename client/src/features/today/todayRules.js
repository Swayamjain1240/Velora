'use strict';

// Pure helpers for the Today screen (Part 7). The wording here is deliberately
// careful: nothing labels a missing entry as a missed dose, and nothing implies
// that a patient's own entry is clinician-verified.

export const TABS = [
  { key: 'medication', label: 'Medication' },
  { key: 'task', label: 'Tasks' },
];

export const PAGE_SIZE = 10;

// The four recorded facts, plus the honest absence of an entry.
export const STATE_LABELS = {
  taken: 'Taken',
  skipped: 'Skipped',
  reported_done: 'Reported done',
  needs_help: 'Needs help',
  not_recorded: 'No entry recorded',
};

export const ENTRY_ACTIONS = [
  { state: 'taken', label: 'Taken' },
  { state: 'skipped', label: 'Skipped' },
  { state: 'reported_done', label: 'Reported done' },
  { state: 'needs_help', label: 'Needs help' },
];

export function stateLabel(state) {
  return STATE_LABELS[state] || 'No entry recorded';
}

export function statePillClass(state) {
  return state === 'not_recorded' ? 'pill pill--none' : `pill pill--${state}`;
}

// A missing entry is the absence of a fact, and the screen says so in words
// rather than showing a "missed" badge.
export function missingEntryText() {
  return 'No entry recorded. This is not a missed dose.';
}

export function safetyLines(safety = {}) {
  return [
    safety.note ||
      'An entry with nothing recorded is not a missed dose and never means you should take an extra ' +
        'or replacement dose. Follow the approved plan and contact your care team with any question.',
    safety.asNeededNote || 'A conditional instruction is recorded when it happens and is never due.',
    safety.selfReportNote || 'Entries recorded by a patient or caregiver are self-reports, not clinical verification.',
  ];
}

export function canRecord(day, item) {
  if (!day || !item) return false;
  if (day.episode && day.episode.readOnly) return false;
  if (!day.logAllowed) return false;
  return Boolean(item.actionable);
}

export function rowTitle(item) {
  if (item.medication) {
    return [item.medication.name, item.medication.dose].filter(Boolean).join(' · ') || 'Medication';
  }
  if (item.task) return item.task.title || 'Recovery task';
  return 'Instruction';
}

export function rowDetail(item, emptyText = 'Not stated in the approved plan') {
  const parts = [];
  if (item.medication) {
    if (item.medication.route) parts.push(`Route: ${item.medication.route}`);
    if (item.medication.frequency) parts.push(`How often: ${item.medication.frequency}`);
    if (item.medication.timing) parts.push(`When: ${item.medication.timing}`);
    if (item.medication.condition) parts.push(`Condition: ${item.medication.condition}`);
  } else if (item.task) {
    if (item.task.frequency) parts.push(`How often: ${item.task.frequency}`);
    if (item.task.timing) parts.push(`When: ${item.task.timing}`);
  }
  return parts.length ? parts : [emptyText];
}

export function latestEntry(item) {
  if (!item || !item.entries || !item.entries.length) return null;
  return item.entries[item.entries.length - 1];
}

export function entryProvenance(entry) {
  if (!entry) return null;
  if (entry.selfReport) {
    return {
      kind: 'self_report',
      text: entry.actorRole === 'caregiver' ? 'Recorded by a caregiver (self-report)' : 'Recorded by the patient (self-report)',
    };
  }
  return { kind: 'staff', text: `Recorded by care staff (${String(entry.actorRole || 'staff').replace(/_/g, ' ')})` };
}

export function correctionNote(item) {
  if (!item || !item.corrected) return null;
  return 'This entry was corrected. Earlier entries are kept in the history.';
}

export function shiftDate(dateOnly, days) {
  const [year, month, day] = String(dateOnly).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function dateInZone(timezone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function describeDay(dateOnly, timezone) {
  if (!dateOnly) return '';
  const parsed = new Date(`${dateOnly}T12:00:00.000Z`);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(parsed);
  } catch {
    return dateOnly;
  }
}

export function formatLocalTime(localTime, offset) {
  if (!localTime) return '—';
  return offset ? `${localTime} (${offset})` : localTime;
}

export function newRequestId() {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 12)}`;
}
