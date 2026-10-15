'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inferCategory } = require('../../src/services/auditService');
const { AUDIT_CATEGORIES } = require('../../src/config/constants');

// Every sensitive action the part must cover maps to a real catalog category.
const EXPECTED = {
  'document.downloaded': 'download',
  'document.uploaded': 'read',
  'staff.member.updated': 'membership',
  'staff.invitation.created': 'membership',
  'caregiver.invited': 'caregiver_grant',
  'caregiver.revoked': 'caregiver_grant',
  'care_plan.approved': 'approval',
  'extraction.suggestion_applied': 'ai_application',
  'activity.recorded': 'log_write',
  'checkin.submitted': 'checkin_response',
  'clarification.answered': 'clarification_response',
  'privacy.request.created': 'privacy_request',
  'privacy.export.downloaded': 'export',
  'episode.closed': 'closure',
  'episode.reopened': 'closure',
  'retention.applied': 'retention',
};

test('the sensitive action catalog maps to real audit categories', () => {
  for (const [action, category] of Object.entries(EXPECTED)) {
    assert.equal(inferCategory(action), category, `${action} should be ${category}`);
    assert.ok(AUDIT_CATEGORIES.includes(category), `${category} must be a catalog category`);
  }
});

test('an unrecognised action still lands in a real category', () => {
  assert.equal(inferCategory('something.new'), 'admin');
  assert.ok(AUDIT_CATEGORIES.includes(inferCategory('something.new')));
});
