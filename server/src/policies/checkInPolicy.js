'use strict';

// Check-in policy (VEL-015/VEL-016). Pure module: no database, no clock, no
// request context. Two jobs:
//
//   1. Validate a clinic-defined template definition structurally and refuse
//      wording that would make the product look like it interprets recovery.
//   2. Evaluate the clinic's review rules. Evaluation NEVER classifies a
//      patient: it returns "this rule asked for a human to look" so the work
//      lands in an assigned queue. There is no severity, score or diagnosis.
//
// It also owns the wording for a missing response, so the server, the tests and
// the client cannot drift apart.

const { CHECKIN_QUESTION_KINDS } = require('../config/constants');

// Vocabulary that turns "workflow attention" into a clinical judgement. The
// guard applies to rule labels and to question prompts: a clinic may ask how a
// patient FEELS, but it may not have the product announce a diagnosis, a
// severity, or an interpretation of a missing answer.
const DIAGNOSTIC_WORDING = [
  /diagnos/i,
  /abnormal/i,
  /normality/i,
  /nonadheren/i,
  /\bsepsis\b/i,
  /(patient|person|they|you|he|she)\s+(may|might|could|probably|likely)\s+have/i,
  /\bmay have (an? )?(infection|condition|complication|reaction|allergic)/i,
  /indicates? (a|an|the) (infection|condition|complication)/i,
  /signs? of (infection|complication|deterioration)/i,
  /deteriorat/i,
  /\bdangerous\b/i,
  /medical (emergency|escalation)/i,
  /\bAI (reviewed|analysed|analyzed|decided|diagnosed)\b/i,
];

const MISSING_RESPONSE_STATE = 'no_response';
const MISSING_RESPONSE_NOTE =
  'No response was recorded for this check-in. Nothing is inferred from a missing check-in: it is not a normal result, not an abnormal result and not a statement about recovery. Contact your care team with any concern.';
const RULE_ATTENTION_NOTE =
  'A clinic rule asked for a staff member to look at this response. It is workflow attention, not a diagnosis and not a clinical interpretation.';
const TEMPLATE_WORDING_NOTE =
  'Clinic check-in questions and rules are workflow aids. They do not diagnose, score recovery or replace clinical judgement.';
const CLINIC_HOURS_NOTE =
  'Check-ins are reviewed during the clinic response hours shown with this record. They are not monitored continuously unless the clinic states otherwise.';

function wordingProblems(text) {
  if (!text) return [];
  return DIAGNOSTIC_WORDING.filter((pattern) => pattern.test(text)).map(() => text);
}

// ---- template definition validation -----------------------------------------

function validateTemplateDefinition(definition = {}) {
  const problems = [];
  const questions = Array.isArray(definition.questions) ? definition.questions : [];

  if (!questions.length) problems.push('A check-in template needs at least one question.');
  if (questions.length > 30) problems.push('A template may carry at most 30 questions.');

  const seen = new Set();
  for (const [index, question] of questions.entries()) {
    const at = `Question ${index + 1}`;
    if (!question || typeof question !== 'object') {
      problems.push(`${at} is not a valid question.`);
      continue;
    }
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(question.id || ''))) {
      problems.push(`${at} needs a short slug id (letters, digits, underscore).`);
    } else if (seen.has(question.id)) {
      problems.push(`${at} reuses the id "${question.id}".`);
    } else {
      seen.add(question.id);
    }
    if (!question.prompt || String(question.prompt).trim().length < 3) {
      problems.push(`${at} needs a prompt.`);
    }
    if (!Object.values(CHECKIN_QUESTION_KINDS).includes(question.kind)) {
      problems.push(`${at} has an unsupported kind.`);
    }
    if (question.kind === 'choice') {
      const options = Array.isArray(question.options) ? question.options : [];
      if (options.length < 2) problems.push(`${at} is a choice question, so it needs at least two options.`);
      if (options.length > 12) problems.push(`${at} may have at most 12 options.`);
      if (new Set(options).size !== options.length) problems.push(`${at} has duplicate options.`);
    }
    if (question.kind === 'scale') {
      const min = Number(question.scaleMin);
      const max = Number(question.scaleMax);
      if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min || min < 0 || max > 10) {
        problems.push(`${at} is a scale question, so it needs a bounded 0-10 range.`);
      }
    }
    // Wording guard: a question may ask, it may not interpret.
    if (wordingProblems(question.prompt).length) {
      problems.push(
        `${at} uses wording that reads as a clinical interpretation. Ask the patient, do not let the product conclude.`
      );
    }
  }

  const cadence = definition.cadence || {};
  const start = Number(cadence.startOffsetDays);
  const every = Number(cadence.everyDays);
  const horizon = Number(cadence.horizonDays);
  if (!Number.isInteger(start) || start < 0 || start > 180) {
    problems.push('Cadence: the first check-in must be 0-180 days after discharge.');
  }
  if (!Number.isInteger(every) || every < 1 || every > 90) {
    problems.push('Cadence: the repeat interval must be 1-90 days.');
  }
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 90) {
    problems.push('Cadence: the horizon must be 1-90 days.');
  }
  if (Number.isInteger(start) && Number.isInteger(every) && Number.isInteger(horizon) && horizon < every) {
    problems.push('Cadence: the horizon must cover at least one interval, otherwise no check-in is ever created.');
  }

  const window = Number(definition.responseWindowHours);
  if (definition.responseWindowHours !== undefined && (!Number.isInteger(window) || window < 1 || window > 168)) {
    problems.push('The response window must be 1-168 hours.');
  }

  const rules = Array.isArray(definition.reviewRules) ? definition.reviewRules : [];
  if (rules.length > 20) problems.push('A template may carry at most 20 review rules.');
  const ruleIds = new Set();
  for (const [index, rule] of rules.entries()) {
    const at = `Rule ${index + 1}`;
    if (!rule || typeof rule !== 'object') {
      problems.push(`${at} is not a valid rule.`);
      continue;
    }
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(rule.id || ''))) {
      problems.push(`${at} needs a short slug id.`);
    } else if (ruleIds.has(rule.id)) {
      problems.push(`${at} reuses the id "${rule.id}".`);
    } else {
      ruleIds.add(rule.id);
    }
    if (!rule.label || String(rule.label).trim().length < 3) {
      problems.push(`${at} needs a label (what the reviewer will read).`);
    }
    if (!rule.when || !seen.has(rule.when.questionId)) {
      problems.push(`${at} must point at one of this template's questions.`);
    }
    if (!['answered', 'no_answer', 'equals', 'not_equals', 'includes_any', 'at_least', 'at_most'].includes(rule.when && rule.when.operator)) {
      problems.push(`${at} has an unsupported condition.`);
    }
    const values = (rule.when && rule.when.values) || [];
    if (['equals', 'not_equals', 'includes_any'].includes(rule.when && rule.when.operator) && values.length === 0) {
      problems.push(`${at} needs at least one value to compare against.`);
    }
    if (['at_least', 'at_most'].includes(rule.when && rule.when.operator) && typeof rule.when.value !== 'number') {
      problems.push(`${at} needs a numeric threshold.`);
    }
    if (rule.action !== undefined && rule.action !== 'queue_review') {
      problems.push(`${at}: the only supported action is a review queued for a person.`);
    }
    // The wording guard is strictest here: a rule label is what a reviewer sees
    // first, so it must describe the workflow, never a clinical conclusion.
    if (wordingProblems(rule.label).length) {
      problems.push(
        `${at} uses diagnostic wording. Describe the workflow ("needs a clinician to look"), not a clinical conclusion.`
      );
    }
  }

  return problems;
}

// ---- rule evaluation ---------------------------------------------------------

function answerFor(response, questionId) {
  const answers = (response && response.answers) || [];
  return answers.find((a) => a.questionId === questionId) || null;
}

// A submitted answer is one of: text, choice value, a scale number in range, or
// a confirm boolean. Values are compared as strings after trimming so the rule
// language stays simple and auditable.
function matches(rule, answer) {
  const when = rule.when || {};
  const operator = when.operator;
  if (operator === 'answered') return Boolean(answer);
  if (operator === 'no_answer') return !answer;

  const values = (when.values || []).map((v) => String(v).trim().toLowerCase());
  const raw = answer ? answer.value : null;
  const text = raw === null || raw === undefined ? null : String(raw).trim().toLowerCase();

  if (operator === 'equals') return values.includes(text);
  if (operator === 'not_equals') return text !== null && !values.includes(text);
  if (operator === 'includes_any') {
    const list = Array.isArray(raw) ? raw.map((v) => String(v).trim().toLowerCase()) : [text];
    return list.some((v) => values.includes(v));
  }
  // A MISSING answer must never satisfy a numeric threshold rule: `Number(null)`
  // is 0, which would quietly make "at most 5" true for a question the patient
  // never answered. Absence is handled by the `no_answer` operator only.
  if (raw === null || raw === undefined || String(raw).trim() === '') return false;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return false;
  if (operator === 'at_least') return numeric >= when.value;
  if (operator === 'at_most') return numeric <= when.value;
  return false;
}

// Returns the rules the clinic configured that this response matched. The result
// is a list of ids/labels only - there is no score, no severity and no verdict.
function evaluateRules(templateVersion, response) {
  const rules = (templateVersion && templateVersion.reviewRules) || [];
  return rules
    .filter((rule) => matches(rule, answerFor(response, rule.when && rule.when.questionId)))
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      questionId: rule.when.questionId,
      operator: rule.when.operator,
    }));
}

// The public, non-clinical summary of a response's workflow state.
function reviewSummary(response) {
  const triggered = (response && response.triggeredRules) || [];
  if (response && response.reviewState === 'reviewed') {
    return { state: 'reviewed', note: 'A staff member reviewed this response.', triggered };
  }
  if (triggered.length) {
    return { state: 'needs_review', note: RULE_ATTENTION_NOTE, triggered };
  }
  return { state: 'none', note: null, triggered };
}

function missingResponseSummary() {
  return {
    state: MISSING_RESPONSE_STATE,
    isMissing: true,
    note: MISSING_RESPONSE_NOTE,
  };
}

module.exports = {
  validateTemplateDefinition,
  evaluateRules,
  reviewSummary,
  missingResponseSummary,
  wordingProblems,
  DIAGNOSTIC_WORDING,
  MISSING_RESPONSE_STATE,
  MISSING_RESPONSE_NOTE,
  RULE_ATTENTION_NOTE,
  TEMPLATE_WORDING_NOTE,
  CLINIC_HOURS_NOTE,
};
