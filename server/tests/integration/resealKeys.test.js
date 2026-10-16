'use strict';

// Part 10 key rotation.
//
// Rotating MFA_ENCRYPTION_KEY or DOCUMENT_ENCRYPTION_KEY used to strand data:
// enrolled authenticators and stored documents were sealed with the retired key
// and nothing re-encrypted them. This file performs a REAL rotation - the
// current keys become previous keys and brand-new keys become current - and then
// proves through the product's own interfaces that nothing was lost: the
// document downloads byte-for-byte over HTTP, the recorded hash still matches,
// and the user's TOTP code still verifies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const harness = require('../helpers/setup');
const { pdfDocuments, upload } = require('../helpers/documents');
const documentStorage = require('../../src/services/documentStorage');
const mfaService = require('../../src/services/mfaService');
const { reseal } = require('../../scripts/reseal-keys');
const { resetEnvCache } = require('../../src/config/env');

let app;

const ORIGINAL_DOCUMENT_KEY = process.env.DOCUMENT_ENCRYPTION_KEY;
const ORIGINAL_MFA_KEY = process.env.MFA_ENCRYPTION_KEY;
const THIRD_DOCUMENT_KEY = Buffer.alloc(32, 21).toString('base64');

function freshKey() {
  return crypto.randomBytes(32).toString('base64');
}

test.before(async () => {
  app = await harness.init();
});
test.afterEach(() => {
  // Every case restores the environment it started with, so one rotation test
  // can never decide what a later file sees.
  process.env.DOCUMENT_ENCRYPTION_KEY = ORIGINAL_DOCUMENT_KEY;
  process.env.MFA_ENCRYPTION_KEY = ORIGINAL_MFA_KEY;
  delete process.env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS;
  delete process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
  resetEnvCache();
});
test.beforeEach(async () => {
  await harness.resetDb();
});
test.after(async () => {
  process.env.DOCUMENT_ENCRYPTION_KEY = ORIGINAL_DOCUMENT_KEY;
  process.env.MFA_ENCRYPTION_KEY = ORIGINAL_MFA_KEY;
  resetEnvCache();
  await harness.shutdown();
});

// One coordinator, one patient, one episode, one stored document and one
// enrolled authenticator - the smallest state a rotation can destroy.
async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'RESEAL' });
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  const coordCtx = await harness.signInStaff(app, coord.user.email);
  const created = await harness.createPatient(coordCtx.a, coordCtx.csrf, {
    fullName: 'Synthetic Rotation Patient',
  });
  const episode = await coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', coordCtx.csrf)
    .send({ patientId: created.body.patient.id, dischargeDate: '2026-09-30', dischargeTimezone: 'Europe/London' });
  assert.equal(episode.status, 201, JSON.stringify(episode.body));

  const pdf = pdfDocuments.valid();
  const uploaded = await upload(coordCtx.a, coordCtx.csrf, episode.body.episode.id, {
    filename: 'discharge-summary.pdf',
    mediaType: 'application/pdf',
    body: pdf,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

  // The signing-in coordinator is MFA-enrolled by the harness, so a sealed TOTP
  // seed exists already; keep the row so the authenticator can be proven to
  // survive the rotation.
  const user = await harness.models.User.findOne({ email: coord.user.email }).select('+mfa.secretEnc');
  assert.ok(user.mfa.secretEnc, 'the enrolled user must hold a sealed secret');

  const stored = await harness.models.EpisodeDocument.findById(uploaded.body.document.id).lean();
  return { clinic: a.clinic, coordCtx, episode: episode.body.episode, document: stored, pdf, userId: user._id };
}

// Rotates both keys the way the runbook says: new key current, old key previous.
function rotateEnv() {
  process.env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS = process.env.DOCUMENT_ENCRYPTION_KEY;
  process.env.MFA_ENCRYPTION_KEY_PREVIOUS = process.env.MFA_ENCRYPTION_KEY;
  process.env.DOCUMENT_ENCRYPTION_KEY = freshKey();
  process.env.MFA_ENCRYPTION_KEY = freshKey();
  resetEnvCache();
}

test('a rotated document key strands nothing: the bytes still restore and still match their hash', async () => {
  const ctx = await setup();
  const oldSealed = ctx.document.storageKey;

  rotateEnv();
  // Before the re-seal the retired key is still the only thing that can open it,
  // which is exactly why the re-seal pass has to exist.
  await assert.rejects(() => documentStorage.get(oldSealed));

  const dry = await reseal({});
  assert.equal(dry.targets.documents, true);
  assert.equal(dry.documents.scanned, 1);
  assert.equal(dry.documents.wouldReseal, 1);
  assert.equal(dry.documents.resealed, 0, 'a dry run must not write');
  assert.equal(dry.applied, false);

  const applied = await reseal({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.documents.resealed, 1);
  assert.equal(applied.documents.failed.length, 0);
  // The strongest available proof: read back with the NEW key and compare to the
  // hash the database recorded, so a silent byte change cannot pass.
  assert.equal(applied.verification.documentsMatched, 1);
  assert.equal(applied.verification.documentsMismatched.length, 0);

  // And through the product's own interface, as a clinician would.
  const download = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/documents/${ctx.document._id}/download`
  );
  assert.equal(download.status, 200, JSON.stringify(download.body));
  const bytes = Buffer.isBuffer(download.body) ? download.body : Buffer.from(download.body);
  assert.equal(bytes.length, ctx.pdf.length);
  assert.ok(bytes.equals(ctx.pdf), 'the rotated document must still download byte-for-byte');

  // The old key is now useless, and the new one is the only way in.
  await assert.rejects(() => documentStorage.getWithKey(oldSealed, ORIGINAL_DOCUMENT_KEY));
  const reread = await documentStorage.get(oldSealed);
  assert.ok(reread.equals(ctx.pdf));
});

test('a rotated MFA key strands no authenticator: the same TOTP code still verifies', async () => {
  const ctx = await setup();
  const before = await harness.models.User.findById(ctx.userId).select('+mfa.secretEnc');
  const code = harness.totpCode(
    require('../../src/services/crypto').openSecret(before.mfa.secretEnc),
    before.email
  );
  assert.equal(await mfaService.verifyTotp(before, code), true);

  rotateEnv();
  const stranded = await harness.models.User.findById(ctx.userId).select('+mfa.secretEnc');
  assert.equal(
    await mfaService.verifyTotp(stranded, code),
    false,
    'the retired key must not still open the seed'
  );

  const dry = await reseal({});
  assert.equal(dry.mfaSecrets.scanned, 1);
  assert.equal(dry.mfaSecrets.wouldReseal, 1);
  assert.equal(dry.mfaSecrets.resealed, 0);

  const applied = await reseal({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.mfaSecrets.resealed, 1);
  assert.equal(applied.verification.mfaSecretsConfirmed, 1);
  assert.equal(applied.mfaSecrets.failed.length, 0);

  const rotated = await harness.models.User.findById(ctx.userId).select('+mfa.secretEnc');
  assert.notEqual(rotated.mfa.secretEnc, before.mfa.secretEnc);
  // The user's EXISTING authenticator entry keeps working: same seed, new key.
  assert.equal(await mfaService.verifyTotp(rotated, code), true);
});

test('one run re-seals both stores and records a single attributed audit event', async () => {
  const ctx = await setup();
  rotateEnv();
  const applied = await reseal({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.documents.resealed, 1);
  assert.equal(applied.mfaSecrets.resealed, 1);

  const audit = await harness.models.AuditEvent.find({ action: 'key.rotation.resealed' }).lean();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'success');
  assert.equal(audit[0].actorLabel, 'operator@clinic.example');
  assert.equal(audit[0].targetId, 'documents+mfa');
  assert.deepEqual(audit[0].detail, {
    documents: 1,
    mfaSeeds: 1,
    failed: 0,
    mismatched: 0,
  });
  // The trail must never carry key material or a clinical value.
  const serialised = JSON.stringify(audit[0]);
  for (const forbidden of [process.env.DOCUMENT_ENCRYPTION_KEY, process.env.MFA_ENCRYPTION_KEY, 'discharge-summary']) {
    assert.ok(!serialised.includes(forbidden));
  }
  assert.ok(!serialised.includes(String(ctx.document.sha256)));

  // Nothing is left sealed with the retired key, so a second pass with the
  // previous variable still present reports that it cannot open anything - it
  // must not silently rewrite an object it cannot read.
  const second = await reseal({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(second.documents.resealed, 0);
  assert.equal(second.documents.failed.length, 1);
  assert.equal(second.mfaSecrets.resealed, 0);
  assert.equal(second.mfaSecrets.failed.length, 1);
});

test('a re-seal is refused without an operator, and a same-value rotation is refused at startup', async () => {
  rotateEnv();
  await assert.rejects(() => reseal({ apply: true }), /refusing to apply without/);

  // The environment gate: naming the CURRENT key as its own PREVIOUS value would
  // quietly re-encrypt with the key the operator believes is retired.
  process.env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS = process.env.DOCUMENT_ENCRYPTION_KEY;
  resetEnvCache();
  assert.throws(
    () => require('../../src/config/env').loadEnv(),
    /DOCUMENT_ENCRYPTION_KEY_PREVIOUS/
  );
});

test('a run with no rotation variables reports that there is nothing to do', async () => {
  await setup();
  const report = await reseal({});
  assert.deepEqual(report.targets, { documents: false, mfaSecrets: false });
  assert.equal(report.documents.scanned, 0);
  assert.equal(report.mfaSecrets.scanned, 0);
});

test('an object the previous key cannot open is reported, never rewritten', async () => {
  const ctx = await setup();
  rotateEnv();
  // A document sealed with a THIRD key (a restore from an older generation, or a
  // botched partial rotation) cannot be opened by the previous key either.
  process.env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS = THIRD_DOCUMENT_KEY;
  resetEnvCache();

  const dry = await reseal({});
  assert.equal(dry.documents.wouldReseal, 0);
  assert.equal(dry.documents.failed.length, 1);
  assert.equal(dry.documents.failed[0].reason, 'previous-key-cannot-open');

  const applied = await reseal({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.documents.resealed, 0);
  assert.equal(applied.verification.documentsMatched, 0);
  // The object is untouched, so the correct key can still rescue it later.
  const stillSealed = await harness.models.EpisodeDocument.findById(ctx.document._id).lean();
  const recovered = await documentStorage.getWithKey(stillSealed.storageKey, ORIGINAL_DOCUMENT_KEY);
  assert.ok(recovered.equals(ctx.pdf));
  assert.equal(applied.operator, 'operator@clinic.example');
});
