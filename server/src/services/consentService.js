'use strict';

// Consent history. Append-only: recording consent adds a row, and changing it
// adds another. Nothing here can update or delete a prior row.
const { errors } = require('./errors');
const audit = require('./auditService');
const patientService = require('./patientService');
const PatientConsent = require('../models/PatientConsent');

function publicConsent(row) {
  return {
    id: row.id,
    action: row.action,
    purpose: row.purpose,
    categories: [...(row.categories || [])],
    actorLabel: row.actorLabel,
    note: row.note || null,
    recordedAt: row.recordedAt,
  };
}

async function appendConsent({ clinicId, user, patientId, data, ip, userAgent }) {
  await patientService.requireStaffAssignment({ clinicId, user, patientId });

  const row = await PatientConsent.create({
    clinic: clinicId,
    patient: patientId,
    action: data.action,
    purpose: data.purpose,
    categories: data.categories || [],
    actorUser: user.id,
    actorLabel: user.email,
    note: data.note,
    recordedAt: new Date(),
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: `patient.consent.${data.action}`,
    targetType: 'patient',
    targetId: String(patientId),
    outcome: 'success',
    ip,
    userAgent,
    // Categories/purpose are non-clinical metadata; no clinical content.
    detail: { categories: data.categories || [] },
  });
  return publicConsent(row);
}

async function listConsent({ clinicId, user, patientId, page, limit }) {
  await patientService.requireStaffAssignment({ clinicId, user, patientId });
  const filter = { clinic: clinicId, patient: patientId };
  const [items, total] = await Promise.all([
    PatientConsent.find(filter)
      .sort({ recordedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PatientConsent.countDocuments(filter),
  ]);
  // The latest row describing the current state, for the UI summary.
  const latest = items.length ? publicConsent(items[0]) : null;
  return { items: items.map(publicConsent), total, page, limit, latest };
}

// Current effective consent: the most recent granted/updated row, unless a later
// withdrawal supersedes it.
async function currentConsentState(clinicId, patientId) {
  const rows = await PatientConsent.find({ clinic: clinicId, patient: patientId })
    .sort({ recordedAt: -1 })
    .limit(1)
    .lean();
  const latest = rows[0];
  if (!latest || latest.action === 'withdrawn') {
    return { granted: false, categories: [], at: latest ? latest.recordedAt : null };
  }
  return { granted: true, categories: [...(latest.categories || [])], at: latest.recordedAt };
}

async function assertConsentFor({ clinicId, patientId, category, message }) {
  const state = await currentConsentState(clinicId, patientId);
  if (!state.granted || !state.categories.includes(category)) {
    throw errors.forbidden(message || 'Consent for this purpose is not currently recorded.');
  }
  return state;
}

module.exports = {
  publicConsent,
  appendConsent,
  listConsent,
  currentConsentState,
  assertConsentFor,
};
