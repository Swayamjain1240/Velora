'use strict';

// Deterministic FAKE extraction provider (Part 6).
//
// This is not a clinical extractor and must never be used on real patient data.
// It exists so the whole provider-independent pipeline - job lifecycle, strict
// schema validation, citation verification, missing/conflict classification,
// review UI and the evaluation harness - can be built and tested BEFORE a
// provider is selected. It performs no network request, has no key, and is
// reproducible byte-for-byte: the same document always yields the same JSON.
//
// What it does: reads the synthetic discharge-note layout used by the fixtures
// and evaluation set (labelled lines such as
// `Medication: Paracetamol 500 mg orally every 6 hours for 3 days`) and emits the
// strict schema, quoting the source line VERBATIM as the citation. Everything it
// cannot read is reported as missing rather than filled in - and when two lines
// disagree about the same medication's dose, both are flagged as conflicting
// instead of choosing one.
//
// Deliberate limitations (documented, not hidden):
//   - free prose is not understood; only the labelled synthetic layout is;
//   - no unit conversion, no abbreviation expansion, no inference;
//   - `confidence` is a fixed function of how many fields were read, never a
//     calibrated probability, and the server never treats it as authority.
const { EXTRACTION_FIELDS } = require('../policies/extractionPolicy');

// Labelled lines, keyed by the ITEM KIND the suggestion becomes. The kind names
// are the Part 5 catalog values, so a suggestion maps onto a draft item without
// any translation step.
const LABELS = Object.freeze([
  { kind: 'medication', field: 'medication', pattern: /^(?:medication|medicine|drug)\s*[:\-]\s*(.+)$/i },
  { kind: 'home_care', field: 'homeCare', pattern: /^(?:home\s*care|wound\s*care|dressing|care)\s*[:\-]\s*(.+)$/i },
  {
    kind: 'diet_activity',
    field: 'dietActivity',
    pattern: /^(?:diet|activity|mobilis(?:e|ation)|mobiliz(?:e|ation)|exercise)\s*[:\-]\s*(.+)$/i,
  },
  {
    kind: 'follow_up',
    field: 'followUp',
    pattern: /^(?:follow\s*[- ]?up|review|appointment|clinic\s+review)\s*[:\-]\s*(.+)$/i,
  },
  {
    kind: 'warning',
    field: 'warning',
    pattern: /^(?:warning|warnings|seek\s+help|red\s+flags?|contact)\s*[:\-]\s*(.+)$/i,
  },
]);

const DOSE = /\b(\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|iu|units?|tabs?|tablets?|caps?|capsules?))\b/i;
const ROUTE = /\b(oral|orally|by mouth|iv|intravenous|im|intramuscular|s\.?c\.?|subcutaneous|topical|inhaled|rectal|nasal|sublingual)\b/i;
const FREQUENCY =
  /\b((?:every|q)\s*\d+\s*(?:hours?|hrs?|h)|once\s+daily|twice\s+daily|three\s+times\s+daily|four\s+times\s+daily|\d+\s*times\s+(?:a|per)\s+day|bd|tds|qds|od|nocte|mane)\b/i;
const DURATION = /\bfor\s+(\d+\s*(?:hours?|days?|weeks?|months?))\b/i;
const MEDICATION_NAME = /^([A-Za-z][A-Za-z0-9-]{2,})\b/;

// Wording that states nothing actionable. It is reported as MISSING: the model
// must never translate "as directed" into an invented regimen.
const VAGUE = /\b(as\s+directed|as\s+needed\s+per\s+protocol|unknown|unspecified|tbd|tba|to\s+be\s+(?:determined|decided)|see\s+notes|not\s+stated)\b/i;

function fieldsFromMedicationLine(line) {
  const fields = {};
  const missing = [];

  const nameMatch = MEDICATION_NAME.exec(line);
  if (nameMatch) fields.medication = nameMatch[1];

  const doseMatch = DOSE.exec(line);
  if (doseMatch) fields.dose = doseMatch[1].replace(/\s+/g, ' ');
  else missing.push('dose');

  const routeMatch = ROUTE.exec(line);
  if (routeMatch) fields.route = routeMatch[1];
  else missing.push('route');

  const frequencyMatch = FREQUENCY.exec(line);
  if (frequencyMatch) fields.frequency = frequencyMatch[1].replace(/\s+/g, ' ');
  else missing.push('frequency');

  const durationMatch = DURATION.exec(line);
  if (durationMatch) fields.duration = durationMatch[1];
  else missing.push('duration');

  // A vague statement anywhere in the line poisons the fields it could describe.
  if (VAGUE.test(line)) {
    for (const field of ['dose', 'frequency', 'duration', 'route']) {
      if (fields[field] !== undefined) {
        missing.push(field);
        delete fields[field];
      }
    }
  }
  return { fields, missing };
}

function fieldsFromLabelledLine(kind, body) {
  const value = body.trim();
  return { fields: { [kind]: value }, missing: [] };
}

function suggestionFor({ kind, line, page, fields, missing, conflicts }) {
  const known = Object.values(fields).filter((value) => value !== undefined && String(value).trim() !== '');
  return {
    kind,
    originalWording: line.trim(),
    ...fields,
    missing: missing.length ? [...new Set(missing)] : undefined,
    conflicts: conflicts && conflicts.length ? [...new Set(conflicts)] : undefined,
    // A fixed, transparent function - NOT a calibrated probability.
    confidence: Math.min(1, Math.round((known.length / 5) * 100) / 100),
    citations: [{ page, text: line.trim() }],
  };
}

// The whole extraction. Pure: same input -> same output, no clock, no randomness.
function extractSuggestions(pages = []) {
  const suggestions = [];
  // medication name (lowercased) -> [{ index, dose }] so cross-line conflicts can
  // be detected without choosing a winner.
  const byMedication = new Map();

  for (const page of pages) {
    const lines = String(page.text || '').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const medicationLabel = LABELS[0];
      const medicationMatch = medicationLabel.pattern.exec(line);
      if (medicationMatch) {
        const body = medicationMatch[1];
        const { fields, missing } = fieldsFromMedicationLine(body);
        const suggestion = suggestionFor({
          kind: 'medication',
          line,
          page: page.page || 1,
          fields,
          missing,
        });
        const key = String(fields.medication || body).toLowerCase();
        if (!byMedication.has(key)) byMedication.set(key, []);
        byMedication.get(key).push({ index: suggestions.length, dose: fields.dose || null });
        suggestions.push(suggestion);
        continue;
      }

      let matchedLabel = null;
      for (const label of LABELS) {
        if (label.kind === 'medication') continue;
        const match = label.pattern.exec(line);
        if (match) {
          matchedLabel = { kind: label.kind, field: label.field, body: match[1] };
          break;
        }
      }
      if (matchedLabel) {
        const { fields, missing } = fieldsFromLabelledLine(matchedLabel.field, matchedLabel.body);
        suggestions.push(
          suggestionFor({
            kind: matchedLabel.kind,
            line,
            page: page.page || 1,
            fields,
            missing,
          })
        );
      }
    }
  }

  // Cross-line conflict: the same medication named twice with different doses.
  // Both keep their own wording; both are flagged. Nothing is merged or picked.
  for (const entries of byMedication.values()) {
    if (entries.length < 2) continue;
    const doses = new Set(entries.map((entry) => (entry.dose || '').toLowerCase()).filter(Boolean));
    if (doses.size < 2) continue;
    for (const entry of entries) {
      const target = suggestions[entry.index];
      target.conflicts = [...new Set([...(target.conflicts || []), 'dose'])];
    }
  }

  return { suggestions, notes: 'deterministic fake provider' };
}

const fakeExtractionProvider = Object.freeze({
  name: 'fake',
  label: 'Deterministic fake provider (local, non-clinical)',
  network: false,
  requiredEnv: Object.freeze([]),
  defaultModel: 'fake-extractor-v1',
  // `pages` is used locally for provenance. Nothing leaves the process, and a
  // network provider implementing this contract must send `text` only.
  async extract({ pages = [], model } = {}) {
    const output = extractSuggestions(pages);
    return {
      raw: JSON.stringify(output),
      model: model || fakeExtractionProvider.defaultModel,
      usage: null,
      providerRequestId: null,
    };
  },
});

module.exports = {
  fakeExtractionProvider,
  extractSuggestions,
  LABELS,
  VAGUE,
  EXTRACTION_FIELDS,
};
