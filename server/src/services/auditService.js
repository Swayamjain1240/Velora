'use strict';

// Append-only audit trail. Never records secrets, password material, tokens
// or raw clinical text (controls #9, #19). Auditing must never break the
// primary request: failures are logged, not thrown.
const AuditEvent = require('../models/AuditEvent');

async function record(event) {
  try {
    await AuditEvent.create({
      clinic: event.clinic,
      actorUser: event.actorUser,
      actorLabel: event.actorLabel,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      outcome: event.outcome,
      ip: event.ip,
      userAgent: event.userAgent ? String(event.userAgent).slice(0, 400) : undefined,
      detail: event.detail,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('audit record failed:', err.message);
  }
}

module.exports = { record };
