'use strict';

// Provider-neutral extraction interface (Part 6).
//
// NO AI/OCR PROVIDER IS SELECTED OR CALLED. This module defines the boundary a
// future provider must implement and resolves the ACTIVE provider from
// `EXTRACTION_PROVIDER`. It never invents a provider: an unregistered name fails
// closed, and nothing in this file makes a network request.
//
// Contract — a provider is a plain object:
//
//   name         string  registry key, stored on every job and model run
//   label        string  human label for the provider register
//   network      boolean true when the provider transmits data off-host
//   requiredEnv  string[] env var NAMES that must be present when enabled
//   defaultModel string|null
//   extract({ text, pages, maxOutputBytes, timeoutMs })
//                -> { raw, model, usage?, providerRequestId? }
//
// `text` is the ONLY thing a network provider may transmit: it is already the
// minimum necessary, delimiter-quoted document text (see
// policies/extractionPolicy.buildModelInput). `pages` exists for LOCAL providers
// (and for provenance) and MUST NOT be sent off-host.
//
// `raw` is untrusted text. The caller validates it with
// extractionPolicy.validateModelOutput before anything reads it.
const { getEnv } = require('../config/env');
const { AppError } = require('../services/errors');
const { fakeExtractionProvider } = require('./fakeExtractionProvider');

// The `none` provider is the shipped default: the feature is OFF and the manual
// Part 5 workflow is the only path. It throws a stable, safe code rather than
// pretending to work.
const noneProvider = Object.freeze({
  name: 'none',
  label: 'No AI provider selected',
  network: false,
  requiredEnv: Object.freeze([]),
  defaultModel: null,
  async extract() {
    throw new AppError(409, 'EXTRACTION_DISABLED', 'AI-assisted extraction is not enabled.');
  },
});

// The registry. Adding a real provider means (1) completing the disclosure table
// in docs/VELORA_AI_EXTRACTION.md, (2) adding an adapter here, and (3) declaring
// the env var NAMES it needs in `requiredEnv`. Nothing else changes: the service,
// the policy and the UI are provider-independent.
const REGISTRY = new Map([
  [noneProvider.name, noneProvider],
  [fakeExtractionProvider.name, fakeExtractionProvider],
]);

// Providers that are DISCLOSED AS CANDIDATES but deliberately NOT implemented
// until the owner selects one. Recorded here so the boundary is explicit and a
// reader can see the decision was made, not forgotten.
const DISCLOSED_CANDIDATES = Object.freeze([
  'openai',
  'anthropic',
  'google-vertex',
  'aws-textract',
  'azure-document-intelligence',
  'tesseract-local',
]);

function misconfigured(message, code = 'EXTRACTION_PROVIDER_MISCONFIGURED') {
  return new AppError(500, code, message);
}

// Resolves the active provider and validates ITS environment only. A provider
// that needs no key (none, fake) never requires one; an unknown name fails
// closed; a missing required key fails closed WITHOUT echoing any value.
function resolveProvider({ name, env } = {}) {
  const config = env || getEnv();
  const requested = String((name || config.EXTRACTION_PROVIDER || 'none')).toLowerCase();
  const provider = REGISTRY.get(requested);
  if (!provider) {
    throw misconfigured(
      'Unknown EXTRACTION_PROVIDER. No provider with that name is registered.',
      'EXTRACTION_PROVIDER_UNKNOWN'
    );
  }
  const missing = (provider.requiredEnv || []).filter((key) => !config[key]);
  if (missing.length) {
    // Names only: a secret value is never echoed, logged or returned.
    throw misconfigured(
      `The selected extraction provider requires these environment variables: ${missing.join(', ')}.`,
      'EXTRACTION_PROVIDER_MISSING_ENV'
    );
  }
  return provider;
}

// Called once at startup so a misconfigured provider fails closed at boot rather
// than on the first clinical request.
function assertProviderConfiguration() {
  const provider = resolveProvider();
  return { name: provider.name, network: provider.network, model: provider.defaultModel || null };
}

// Test-only seam: swap the active provider so every failure mode (timeout,
// error, malformed payload) can be driven deterministically, exactly like the
// document storage seam. Never used by request handlers.
let activeOverride = null;
function __setProviderForTest(provider) {
  activeOverride = provider || null;
}
function __resetProvider() {
  activeOverride = null;
}
function activeProvider() {
  return activeOverride || resolveProvider();
}

module.exports = {
  noneProvider,
  fakeExtractionProvider,
  REGISTRY,
  DISCLOSED_CANDIDATES,
  resolveProvider,
  assertProviderConfiguration,
  activeProvider,
  __setProviderForTest,
  __resetProvider,
};
