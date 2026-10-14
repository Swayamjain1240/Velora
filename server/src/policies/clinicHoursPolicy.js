'use strict';

// Clinic-hours policy (Part 8). One place decides what the product may claim
// about responsiveness, so no screen can imply continuous monitoring that the
// clinic has not stated.
//
// The rule is deliberately blunt: `monitoredContinuously` is false unless the
// clinic set it, and the wording follows that flag. Nothing here is clinical
// advice, and the emergency line never promises that the app is an emergency
// service.

const RESPONSE_HOURS_NOTE = 'Clinic response hours are shown with every question and check-in.';
const NOT_MONITORED_NOTE =
  'This queue is not monitored continuously. Answers are sent during the clinic response hours below.';
const CONTINUOUS_NOTE =
  'This clinic states that it provides continuous cover for this queue during the hours below.';
const UNPUBLISHED_NOTE =
  'This clinic has not published response hours. Do not assume that a question or check-in is seen immediately.';
const EMERGENCY_FALLBACK =
  'If this is an emergency, contact your local emergency number now. This application is not an emergency service and cannot respond to an emergency.';

function isValidTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// The public projection. It never invents hours; an unconfigured clinic reads
// as unconfigured rather than as "always available".
function responseHoursSummary(clinic) {
  const hours = (clinic && clinic.responseHours) || null;
  const emergency = (clinic && clinic.emergencyInstructions) || null;
  const configured = Boolean(hours && (hours.display || (hours.from && hours.to)));
  const monitoredContinuously = Boolean(hours && hours.monitoredContinuously);

  return {
    configured,
    display: configured && hours.display ? hours.display : null,
    timezone: configured && hours.timezone ? hours.timezone : null,
    weekdays: configured && hours.weekdays ? hours.weekdays : null,
    from: configured && hours.from ? hours.from : null,
    to: configured && hours.to ? hours.to : null,
    monitoredContinuously,
    note: !configured
      ? UNPUBLISHED_NOTE
      : monitoredContinuously
        ? CONTINUOUS_NOTE
        : NOT_MONITORED_NOTE,
    responseHoursNote: RESPONSE_HOURS_NOTE,
    emergency: {
      configured: Boolean(emergency && emergency.display),
      display: emergency && emergency.display ? emergency.display : null,
      contactPhone: emergency && emergency.contactPhone ? emergency.contactPhone : null,
      fallback: EMERGENCY_FALLBACK,
    },
  };
}

// Structural validation on write (control #6): bounds and format only, never a
// clinical judgement. A display line without a timezone is refused because the
// hours would be ambiguous.
function validateSettingsInput({ responseHours, emergencyInstructions } = {}) {
  const problems = [];

  if (responseHours !== undefined && responseHours !== null) {
    const hasTimes = responseHours.from !== undefined || responseHours.to !== undefined;
    if (hasTimes && !(responseHours.from && responseHours.to)) {
      problems.push('Provide both a start and an end time for the response hours.');
    }
    if (hasTimes && !responseHours.timezone) {
      problems.push('State the IANA timezone the response hours are in.');
    }
    if (responseHours.timezone && !isValidTimezone(responseHours.timezone)) {
      problems.push('The response-hours timezone must be a valid IANA timezone.');
    }
    if (responseHours.from && !parseTime(responseHours.from)) {
      problems.push('The start time must use HH:MM.');
    }
    if (responseHours.to && !parseTime(responseHours.to)) {
      problems.push('The end time must use HH:MM.');
    }
    if (
      responseHours.monitoredContinuously === true &&
      !(responseHours.display || hasTimes)
    ) {
      problems.push('Continuous cover can only be stated alongside published response hours.');
    }
    if (
      responseHours.monitoredContinuously === true &&
      responseHours.timezone &&
      !isValidTimezone(responseHours.timezone)
    ) {
      problems.push('The response-hours timezone must be a valid IANA timezone.');
    }
  }

  if (emergencyInstructions !== undefined && emergencyInstructions !== null) {
    if (emergencyInstructions.display !== undefined && emergencyInstructions.display.length < 5) {
      problems.push('Emergency instructions need a short explanation.');
    }
    if (
      emergencyInstructions.contactPhone &&
      !/^[0-9+()\-\s]{3,40}$/.test(emergencyInstructions.contactPhone)
    ) {
      problems.push('The emergency contact number contains unsupported characters.');
    }
  }

  return problems;
}

module.exports = {
  responseHoursSummary,
  validateSettingsInput,
  isValidTimezone,
  RESPONSE_HOURS_NOTE,
  NOT_MONITORED_NOTE,
  CONTINUOUS_NOTE,
  UNPUBLISHED_NOTE,
  EMERGENCY_FALLBACK,
};
