'use strict';

// Notification provider registry (Part 8, control #22).
//
// The shipped product delivers reminders IN-APP and needs no external service, no
// key and no disclosure. Anything that would send a message to a person OUTSIDE
// the application - email, SMS, WhatsApp, push, an external queue - must be
// disclosed FIRST: which provider, why, which key and environment variable,
// where it runs, what data leaves, how it is retained and where, and what it
// costs. Until that disclosure is recorded and the user authorizes it, those
// providers REFUSE to deliver and fail closed.
//
// The registry is the single place that decides which names exist, so a typo in
// REMINDER_PROVIDER fails at startup rather than silently sending nothing.

const { getEnv } = require('../config/env');
const { errors } = require('../services/errors');
const reminderPolicy = require('../policies/reminderPolicy');

// What a disclosure must state. Every externally-communicating provider has to
// fill ALL of these in before it can be selected.
const DISCLOSURE_FIELDS = Object.freeze([
  'provider',
  'purpose',
  'keyName',
  'envVar',
  'runsOn',
  'dataSent',
  'retention',
  'region',
  'cost',
]);

function disclosureProblems(disclosure) {
  if (!disclosure) return ['A provider disclosure is required before this channel may deliver anything.'];
  return DISCLOSURE_FIELDS.filter((field) => {
    const value = disclosure[field];
    return value === undefined || value === null || String(value).trim() === '';
  }).map((field) => `The provider disclosure is missing: ${field}.`);
}

// ---- in-app (the only shipped provider) --------------------------------------

const inAppProvider = Object.freeze({
  name: 'in_app',
  channel: 'in_app',
  external: false,
  // Nothing leaves the application, so there is nothing to disclose.
  disclosure: Object.freeze({
    provider: 'Velora in-app',
    purpose: 'Show a reminder inside the patient or caregiver queue that is already open.',
    keyName: 'none',
    envVar: 'none',
    runsOn: 'server (in the same application)',
    dataSent: 'nothing is sent to any third party; the reminder is stored in this database',
    retention: 'Follows the episode record.',
    region: 'The database region the clinic already uses.',
    cost: 'No separate cost.',
  }),
  async deliver({ notification, attempt }) {
    // The reminder is already persisted; "delivery" records that it is available
    // in the recipient's own queue. It is NOT an acknowledgement.
    return {
      outcome: 'delivered',
      provider: 'in_app',
      reason: 'Available in the recipient’s in-app queue.',
      detail: { notificationId: String(notification._id || notification.id), attempt },
    };
  },
});

// ---- the fake provider (development and tests only) ---------------------------

// Deterministic and offline. It exists so the delivery pipeline, the retry path
// and the failure path can be exercised without any third party, and it refuses
// to operate in production.
const fakeProvider = Object.freeze({
  name: 'fake',
  channel: 'in_app',
  external: false,
  disclosure: Object.freeze({
    provider: 'Velora fake provider (development only)',
    purpose: 'Exercise the delivery pipeline without any external service.',
    keyName: 'none',
    envVar: 'none',
    runsOn: 'server (test/development)',
    dataSent: 'nothing leaves the process',
    retention: 'Not applicable.',
    region: 'Not applicable.',
    cost: 'No cost.',
  }),
  async deliver({ notification }) {
    if (getEnv().NODE_ENV === 'production') {
      return {
        outcome: 'failed',
        provider: 'fake',
        errorCode: 'FAKE_PROVIDER_IN_PRODUCTION',
        reason: 'The fake provider is never used in production.',
      };
    }
    // A synthetic failure trigger, so the failure and retry paths are testable.
    if (String(notification.title || '').includes('[fail]')) {
      return {
        outcome: 'failed',
        provider: 'fake',
        errorCode: 'FAKE_DELIVERY_FAILURE',
        reason: 'The fake provider was asked to fail this delivery.',
      };
    }
    return { outcome: 'delivered', provider: 'fake', reason: 'Delivered by the fake provider.' };
  },
});

// ---- providers that require disclosure ---------------------------------------

// Declared so a name is recognized (and refused with a helpful message) rather
// than silently unknown.
const PENDING_DISCLOSURE = Object.freeze({
  email: { channel: 'email', vendor: 'not selected' },
  sms: { channel: 'sms', vendor: 'not selected' },
  whatsapp: { channel: 'whatsapp', vendor: 'not selected' },
  push: { channel: 'push', vendor: 'not selected' },
});

const REGISTRY = Object.freeze({
  in_app: inAppProvider,
  fake: fakeProvider,
});

function listProviders() {
  return Object.keys(REGISTRY);
}

// Resolved once per call so a stricter deployment setting takes effect without a
// restart, exactly like the extraction provider registry.
function resolveProvider(name) {
  const requested = String(name || 'in_app').trim();
  const provider = REGISTRY[requested];
  if (provider) return provider;

  if (Object.prototype.hasOwnProperty.call(PENDING_DISCLOSURE, requested)) {
    // Refuse with the exact list of what must be disclosed, and never fall back
    // to another provider: silently sending through a different channel would be
    // worse than not sending.
    throw errors.conflict(
      `The "${requested}" reminder channel is not authorized. A disclosure is required first: ` +
        `${DISCLOSURE_FIELDS.join(', ')}. Until then reminders stay in-app.`
    );
  }
  throw errors.internal(`Unknown reminder provider "${requested}".`);
}

function activeProvider() {
  return resolveProvider(getEnv().REMINDER_PROVIDER);
}

// The disclosure a provider must supply before it can be enabled - used by the
// API surface that lists what is configured today.
function providerStatus() {
  const configured = getEnv().REMINDER_PROVIDER;
  return {
    configured,
    active: REGISTRY[configured] ? configured : null,
    available: listProviders(),
    externalChannels: reminderPolicy.EXTERNAL_CHANNELS,
    pendingDisclosure: Object.keys(PENDING_DISCLOSURE),
    disclosureFields: DISCLOSURE_FIELDS,
    disclosure: REGISTRY[configured] ? REGISTRY[configured].disclosure : null,
  };
}

module.exports = {
  resolveProvider,
  activeProvider,
  providerStatus,
  listProviders,
  disclosureProblems,
  DISCLOSURE_FIELDS,
  PENDING_DISCLOSURE,
};
