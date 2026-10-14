'use strict';

// Reminder policy (VEL-014, Part 8). Pure module: no database, no clock, no
// request context.
//
// Four jobs, all of them about NOT trusting the moment the reminder was created:
//
//   1. Build the DEDUPE KEY from recipient + event/version + channel, so the same
//      reminder cannot be queued twice and a retry cannot become a second
//      reminder.
//   2. Decide the BOUNDED RETRY schedule.
//   3. Say what must be re-checked IMMEDIATELY BEFORE delivery: the episode is
//      still open, the approved version is still the current one, the task is
//      still relevant, and the recipient is still authorized. A plan that was
//      superseded, a revoked grant or a closed episode stops the reminder.
//   4. Own the wording. A failed reminder is a delivery problem, and a delivered
//      reminder is not an acknowledgement.

const { REMINDER_MAX_ATTEMPTS } = require('../config/constants');

const EXTERNAL_CHANNELS = Object.freeze(['email', 'sms', 'whatsapp', 'push']);
const IN_APP_CHANNEL = 'in_app';

const MAX_BACKOFF_MS = 60 * 60 * 1000;

const DEDUPE_NOTE =
  'A reminder is identified by its recipient, the event (and version) it is about, and the channel. The same combination is never queued twice.';
const RECHECK_NOTE =
  'Immediately before a reminder is delivered, the episode state, the approved plan version, the task and the recipient authorization are checked again.';
const RETRY_NOTE =
  'A reminder that cannot be delivered is retried a bounded number of times and then reported as failed where the care team can see it.';
const STALE_NOTE =
  'This reminder was stopped before delivery because what it was about changed. Nothing was sent, and no assumption is made about the patient.';

function dedupeKey({
  recipientUser,
  recipientRole,
  channel = IN_APP_CHANNEL,
  kind,
  eventVersion,
  eventId,
  localDate,
}) {
  const parts = [
    channel,
    recipientRole || 'recipient',
    String(recipientUser),
    kind,
    // The VERSION is part of the identity: a new approved plan version or a new
    // check-in template version is a new event, while the same version is not.
    eventVersion === null || eventVersion === undefined ? 'v0' : `v${eventVersion}`,
    eventId ? String(eventId) : 'event',
    localDate || 'any',
  ];
  return parts.join(':');
}

// Bounded exponential backoff: 30s, 2m, 8m, ... capped, and never more attempts
// than the record allows.
function nextAttemptDelayMs(attempt, { baseMs = 30_000, factor = 4 } = {}) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const delay = baseMs * Math.pow(factor, safeAttempt - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

function nextAttemptAt(attempt, now = new Date()) {
  return new Date(now.getTime() + nextAttemptDelayMs(attempt));
}

function attemptsExhausted(notification) {
  const max = notification.maxAttempts || REMINDER_MAX_ATTEMPTS;
  return (notification.attempts || 0) >= max;
}

// The four rechecks, as data. `checks` is stored on every attempt, so a refused
// delivery is auditable rather than invisible.
function recheck({ episode, notification, planVersion, source, recipient }) {
  const episodeOpen = Boolean(episode) && episode.status !== 'closed';

  // A reminder tied to an approved plan version may only be delivered while that
  // version is STILL the current approved one.
  let versionCurrent = true;
  if (notification.planVersion) {
    versionCurrent = Boolean(
      planVersion &&
        planVersion.isCurrent &&
        planVersion.state === 'approved' &&
        String(planVersion._id) === String(notification.planVersion)
    );
  }

  // A reminder about a task/occurrence stops being relevant once that source is
  // gone or has been superseded.
  let taskRelevant = true;
  if (source && Object.prototype.hasOwnProperty.call(source, 'relevant')) {
    taskRelevant = Boolean(source.relevant);
  }

  let recipientAuthorized = Boolean(recipient && recipient.authorized);
  if (!recipient) recipientAuthorized = false;

  const checks = { episodeOpen, versionCurrent, taskRelevant, recipientAuthorized };
  const problems = [];
  if (!episodeOpen) problems.push('The episode is closed.');
  if (!versionCurrent) problems.push('The approved plan version this reminder is about is no longer current.');
  if (!taskRelevant) problems.push('The task this reminder is about is no longer active.');
  if (!recipientAuthorized) problems.push('The recipient is no longer authorized.');

  return {
    checks,
    problems,
    deliverable: problems.length === 0,
    note: problems.length ? STALE_NOTE : null,
  };
}

function isExternalChannel(channel) {
  return EXTERNAL_CHANNELS.includes(channel);
}

function isExternalProvider(name) {
  return EXTERNAL_CHANNELS.includes(String(name));
}

module.exports = {
  dedupeKey,
  nextAttemptDelayMs,
  nextAttemptAt,
  attemptsExhausted,
  recheck,
  isExternalChannel,
  isExternalProvider,
  IN_APP_CHANNEL,
  EXTERNAL_CHANNELS,
  MAX_BACKOFF_MS,
  DEDUPE_NOTE,
  RECHECK_NOTE,
  RETRY_NOTE,
  STALE_NOTE,
};
