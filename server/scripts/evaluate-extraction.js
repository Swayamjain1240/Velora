#!/usr/bin/env node
'use strict';

// Part 6 EVALUATION HARNESS (synthetic only).
//
// It runs the DETERMINISTIC local provider over the fabricated evaluation set
// and measures the SOFTWARE against labelled expectations:
//   - field accuracy (exact value + state match),
//   - missing-field detection,
//   - conflict detection,
//   - citation correctness (every citation must resolve inside its page),
//   - reviewed-language fidelity guarding.
//
// READ THIS: passing here is a statement about the software, never a claim of
// clinical accuracy. The fixture values are invented; a real provider on real
// documents must be evaluated separately, clinically, before any pilot.
//
//   node scripts/evaluate-extraction.js        report + non-zero exit on failure
//
const fs = require('node:fs');
const path = require('node:path');
const { extractSuggestions } = require('../src/providers/fakeExtractionProvider');
const policy = require('../src/policies/extractionPolicy');
const { fidelityCheck } = require('../src/services/languageVariantService');

const FIXTURE_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'extraction-evaluation.json');

function loadFixtures() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function pagesOf(document) {
  return document.pages.map((page) => ({ page: page.page, text: page.lines.join('\n') }));
}

// Runs one document through the SAME stages the service uses: deterministic
// provider -> strict output validation -> citation verification -> classification.
function runDocument(document) {
  const pages = pagesOf(document);
  // The provider's raw payload is a JSON STRING, exactly as a network provider
  // would return it, so the harness validates the same serialized shape.
  const raw = JSON.stringify(extractSuggestions(pages));
  const validated = policy.validateModelOutput(raw, {
    maxOutputBytes: policy.LIMIT_DEFAULTS.maxOutputBytes,
  });
  if (!validated.ok) return { ok: false, code: validated.code, produced: [], injections: [] };

  const produced = [];
  for (const suggestion of validated.value.suggestions) {
    const citations = policy.verifyCitations(suggestion.citations, pages);
    if (!citations.ok) {
      produced.push({ wording: suggestion.originalWording, citationError: citations.code });
      continue;
    }
    const classified = policy.classifySuggestion(suggestion);
    const states = {};
    const values = {};
    const missingRequired = [];
    const conflicting = [];
    for (const [name, field] of Object.entries(classified.fields)) {
      states[name] = field.state;
      values[name] = field.value;
      if (field.required && field.state === policy.FIELD_STATES.MISSING) missingRequired.push(name);
      if (field.state === policy.FIELD_STATES.CONFLICTING) conflicting.push(name);
    }
    produced.push({
      wording: classified.originalWording,
      kind: classified.kind,
      states,
      values,
      missingRequired: missingRequired.sort(),
      conflicting: conflicting.sort(),
      citations: citations.citations,
    });
  }
  return {
    ok: true,
    produced,
    injections: policy.detectInjectionSignals(pages),
  };
}

// The provider emits suggestions in document order, so a labelled expectation is
// matched to the produced suggestion with the same wording.
function findProduced(produced, wording) {
  return produced.find((row) => row.wording === wording);
}

function runEvaluation(fixtures = loadFixtures()) {
  const failures = [];
  let fieldsChecked = 0;
  let fieldsMatched = 0;
  let citationsChecked = 0;
  let citationsVerified = 0;
  const missing = { expected: 0, detected: 0 };
  const conflict = { expected: 0, detected: 0 };
  let languageChecked = 0;
  let languageCorrect = 0;
  let injectionChecked = 0;
  let injectionCorrect = 0;

  for (const document of fixtures.documents) {
    const run = runDocument(document);
    if (!run.ok) {
      failures.push(`${document.id}: output rejected by validation (${run.code})`);
      continue;
    }

    // --- injection detection ------------------------------------------------
    injectionChecked += 1;
    const injected = run.injections.length > 0;
    if (injected === Boolean(document.injectionExpected)) injectionCorrect += 1;
    else failures.push(`${document.id}: injection expectation not met (detected=${injected})`);

    // --- citations ----------------------------------------------------------
    for (const produced of run.produced) {
      if (produced.citationError) {
        failures.push(`${document.id}: citation rejected (${produced.citationError})`);
        continue;
      }
      for (const citation of produced.citations) {
        citationsChecked += 1;
        // Re-verify and confirm the page is one we supplied.
        const page = document.pages.find((p) => p.page === citation.page);
        if (page && policy.appearsInText(citation.text, [page.lines.join('\n')])) citationsVerified += 1;
        else failures.push(`${document.id}: citation not found on supplied page ${citation.page}`);
      }
    }

    // --- labelled expectations ---------------------------------------------
    for (const expected of document.expect) {
      const produced = findProduced(run.produced, expected.wording);
      if (!produced) {
        failures.push(`${document.id}: no suggestion for "${expected.wording}"`);
        continue;
      }
      if (expected.kind && produced.kind !== expected.kind) {
        failures.push(`${document.id}: kind ${produced.kind} != expected ${expected.kind}`);
      }
      for (const [field, expectedValue] of Object.entries(expected.fields || {})) {
        fieldsChecked += 1;
        const actualValue = produced.values[field];
        if ((actualValue || null) === (expectedValue || null)) fieldsMatched += 1;
        else failures.push(`${document.id}: field ${field} value=${actualValue} expected ${expectedValue}`);
      }
      for (const [field, state] of Object.entries(expected.states || {})) {
        fieldsChecked += 1;
        if (produced.states[field] === state) fieldsMatched += 1;
        else failures.push(`${document.id}: field ${field} state=${produced.states[field]} expected ${state}`);
      }
      for (const field of expected.missingRequired || []) {
        missing.expected += 1;
        if (produced.missingRequired.includes(field)) missing.detected += 1;
        else failures.push(`${document.id}: required ${field} missing was NOT detected`);
      }
      for (const field of expected.conflicting || []) {
        conflict.expected += 1;
        if (produced.conflicting.includes(field)) conflict.detected += 1;
        else failures.push(`${document.id}: conflict on ${field} was NOT detected`);
      }
    }
  }

  // --- language fidelity ---------------------------------------------------
  for (const c of fixtures.language) {
    languageChecked += 1;
    const result = fidelityCheck(c.item, c.text, c.language);
    const warningsOk =
      JSON.stringify([...result.warnings].sort()) === JSON.stringify([...c.expect.warnings].sort());
    if (result.passed === c.expect.passed && warningsOk) languageCorrect += 1;
    else {
      failures.push(
        `${c.id}: fidelity passed=${result.passed} warnings=${JSON.stringify(result.warnings)} expected ${JSON.stringify(c.expect)}`
      );
    }
  }

  return {
    failures,
    metrics: {
      fieldAccuracy: ratio(fieldsMatched, fieldsChecked),
      fieldsChecked,
      citationPrecision: ratio(citationsVerified, citationsChecked),
      citationsChecked,
      missingRecall: ratio(missing.detected, missing.expected),
      missingExpected: missing.expected,
      conflictRecall: ratio(conflict.detected, conflict.expected),
      conflictExpected: conflict.expected,
      languageAccuracy: ratio(languageCorrect, languageChecked),
      languageChecked,
      injectionAccuracy: ratio(injectionCorrect, injectionChecked),
      injectionChecked,
    },
  };
}

function ratio(numerator, denominator) {
  if (!denominator) return 1;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function formatReport(result) {
  const m = result.metrics;
  const lines = [
    'Velora Part 6 extraction evaluation (SYNTHETIC - software behaviour, not clinical accuracy)',
    `  field accuracy        : ${m.fieldAccuracy} (${m.fieldsChecked} labelled fields)`,
    `  citation precision    : ${m.citationPrecision} (${m.citationsChecked} citations)`,
    `  missing-field recall  : ${m.missingRecall} (${m.missingExpected} required fields)`,
    `  conflict recall       : ${m.conflictRecall} (${m.conflictExpected} conflicts)`,
    `  language fidelity     : ${m.languageAccuracy} (${m.languageChecked} renderings)`,
    `  injection detection   : ${m.injectionAccuracy} (${m.injectionChecked} documents)`,
  ];
  if (result.failures.length) {
    lines.push('FAILURES:');
    for (const failure of result.failures) lines.push(`  - ${failure}`);
  } else {
    lines.push('  all labelled expectations met');
  }
  return lines.join('\n');
}

module.exports = { loadFixtures, runDocument, runEvaluation, formatReport, FIXTURE_PATH };

if (require.main === module) {
  const result = runEvaluation();
  process.stdout.write(`${formatReport(result)}\n`);
  process.exit(result.failures.length ? 1 : 0);
}
