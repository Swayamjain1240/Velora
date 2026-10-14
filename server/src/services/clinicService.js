'use strict';

// Clinic settings (Part 8): the tenant's published response hours and emergency
// guidance. Only the clinic admin may change them (administrative configuration,
// not clinical content), and every change is audited.
const { errors } = require('./errors');
const audit = require('./auditService');
const hoursPolicy = require('../policies/clinicHoursPolicy');
const Clinic = require('../models/Clinic');

function publicSettings(clinic) {
  return {
    responseHours: hoursPolicy.responseHoursSummary(clinic),
    emergency: hoursPolicy.responseHoursSummary(clinic).emergency,
  };
}

function publicClinic(clinic) {
  return {
    id: clinic.id,
    name: clinic.name,
    code: clinic.code,
    status: clinic.status,
    settings: publicSettings(clinic),
  };
}

async function getClinic({ clinicId }) {
  const clinic = await Clinic.findById(clinicId).lean();
  if (!clinic) throw errors.notFound('Clinic not found.');
  return publicClinic(clinic);
}

// The settings that matter to a patient/caregiver screen: published hours plus
// the emergency line, with the honesty wording attached.
async function getDisplaySettings({ clinicId }) {
  const clinic = await Clinic.findById(clinicId).lean();
  return hoursPolicy.responseHoursSummary(clinic);
}

async function updateClinic({ clinicId, changes, actor, ip, userAgent }) {
  const problems = hoursPolicy.validateSettingsInput(changes);
  if (problems.length) throw errors.badRequest(problems.join(' '));

  const update = {};
  if (changes.name !== undefined) update.name = changes.name;
  if (changes.responseHours !== undefined) {
    update.responseHours = {
      ...changes.responseHours,
      // A clinic that does not state continuous cover keeps the safe default.
      monitoredContinuously: changes.responseHours.monitoredContinuously === true,
    };
  }
  if (changes.emergencyInstructions !== undefined) {
    update.emergencyInstructions = changes.emergencyInstructions;
  }
  if (!Object.keys(update).length) throw errors.badRequest('Provide a setting to update.');

  const clinic = await Clinic.findByIdAndUpdate(clinicId, { $set: update }, { new: true }).lean();
  if (!clinic) throw errors.notFound('Clinic not found.');

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'clinic.settings.updated',
    targetType: 'clinic',
    targetId: clinic.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      fields: Object.keys(update),
      monitoredContinuously: Boolean(
        clinic.responseHours && clinic.responseHours.monitoredContinuously
      ),
    },
  });

  return publicClinic(clinic);
}

module.exports = { getClinic, getDisplaySettings, updateClinic, publicClinic };
