'use strict';

// Part 10: the reconciliation REPAIR path.
//
// The read-only report had a CI step and a dry run, but the code that actually
// repairs drift - marking a document whose bytes cannot be trusted as `failed`,
// removing an orphan object, and auditing both - had never been executed by any
// test. This file drives `reconcile()` directly against a real replica set, the
// real encrypted object store and the real audit trail, and it deliberately
// corrupts a RESTORED-EQUIVALENT state (a lost object, a tampered object, an
// object with no metadata row) rather than trusting the happy path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = require('../helpers/setup');
const { pdfDocuments, upload } = require('../helpers/documents');
const { reconcile } = require('../../scripts/reconcile-documents');
const documentStorage = require('../../src/services/documentStorage');

let app;

test.before(async () => {
  app = await harness.init();
});
test.beforeEach(async () => {
  await harness.resetDb();
});
test.after(async () => {
  await harness.shutdown();
});

// One clinic, an assigned coordinator, a patient and an episode with one READY
// document, which is the smallest real state drift can be observed on.
async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'RECON' });
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  const coordCtx = await harness.signInStaff(app, coord.user.email);
  const created = await harness.createPatient(coordCtx.a, coordCtx.csrf, {
    fullName: 'Synthetic Reconciliation Patient',
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
  assert.equal(uploaded.body.document.status, 'ready');

  // The storage key is never exposed by the API, so read it from the database -
  // exactly as an operator would.
  const stored = await harness.models.EpisodeDocument.findById(uploaded.body.document.id).lean();
  return { clinic: a.clinic, coordinCtx: coordCtx, document: stored };
}

function objectsDir() {
  return path.join(process.env.DOCUMENT_STORAGE_ROOT, 'objects');
}

// Writes a synthetic orphan object into the store, in the same shape the storage
// provider writes: <root>/objects/<2-char prefix>/<uuid>.bin
function writeOrphanObject() {
  const key = crypto.randomUUID();
  const dir = path.join(objectsDir(), key.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.bin`), Buffer.from('orphan-bytes'));
  return key;
}

test('a clean store reports no drift and changes nothing', async () => {
  const ctx = await setup();
  const report = await reconcile({});

  assert.equal(report.inspected, 1);
  assert.equal(report.missing.length, 0);
  assert.equal(report.unreadable.length, 0);
  assert.equal(report.integrity.length, 0);
  assert.equal(report.orphans.length, 0);
  assert.equal(report.applied, false);

  const still = await harness.models.EpisodeDocument.findById(ctx.document._id).lean();
  assert.equal(still.status, 'ready');
});

test('a losing object is reported without touching it, and only an operator may repair it', async () => {
  const ctx = await setup();
  // The state a partial restore leaves: metadata without its object.
  fs.rmSync(documentStorage.objectPath(ctx.document.storageKey), { force: true });

  const dry = await reconcile({});
  assert.equal(dry.missing.length, 1);
  assert.equal(dry.missing[0].id, String(ctx.document._id));
  assert.equal(dry.applied, false);
  assert.equal(
    (await harness.models.EpisodeDocument.findById(ctx.document._id).lean()).status,
    'ready',
    'a dry run must never change a document'
  );

  // An unattributed repair is refused outright, and it changes nothing.
  await assert.rejects(() => reconcile({ apply: true }), /refusing to apply without/);
  assert.equal(
    (await harness.models.EpisodeDocument.findById(ctx.document._id).lean()).status,
    'ready'
  );

  const applied = await reconcile({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.applied, true);
  assert.equal(applied.repaired.documents, 1);
  assert.equal(applied.repaired.orphans, 0);

  const after = await harness.models.EpisodeDocument.findById(ctx.document._id).lean();
  // The document stops being `ready`, but nothing is deleted: the metadata that
  // proves it existed survives as evidence.
  assert.equal(after.status, 'failed');
  assert.equal(after.sha256, ctx.document.sha256);
  assert.equal(after.byteSize, ctx.document.byteSize);

  const audit = await harness.models.AuditEvent.find({ action: 'document.reconciled.failed' }).lean();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'success');
  assert.equal(audit[0].detail.reason, 'missing-object');
  // The audit row names the record, never its contents.
  const serialised = JSON.stringify(audit[0]);
  assert.ok(!serialised.includes('discharge-summary.pdf'), 'the audit must not carry the filename');
});

test('a tampered object is detected and its document stops being ready', async () => {
  const ctx = await setup();
  const file = documentStorage.objectPath(ctx.document.storageKey);
  const envelope = fs.readFileSync(file);
  // Flip a byte inside the ciphertext: the GCM tag no longer authenticates.
  envelope[envelope.length - 1] ^= 0xff;
  fs.writeFileSync(file, envelope);

  // The storage layer itself must refuse to hand back the bytes.
  await assert.rejects(() => documentStorage.get(ctx.document.storageKey));

  const dry = await reconcile({});
  assert.equal(dry.unreadable.length, 1);
  assert.equal(dry.integrity.length, 0);
  assert.equal(dry.missing.length, 0);

  const applied = await reconcile({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.repaired.documents, 1);
  assert.equal(
    (await harness.models.EpisodeDocument.findById(ctx.document._id).lean()).status,
    'failed'
  );
  const audit = await harness.models.AuditEvent.findOne({ action: 'document.reconciled.failed' }).lean();
  assert.equal(audit.detail.reason, 'unreadable-object');
});

test('a valid envelope whose plaintext no longer matches the recorded hash is an integrity mismatch', async () => {
  const ctx = await setup();
  // Delete and rewrite the object under the SAME key with different, validly
  // encrypted bytes: everything decrypts, so only the recorded hash can catch it.
  await documentStorage.remove(ctx.document.storageKey);
  await documentStorage.put(ctx.document.storageKey, Buffer.from('%PDF-1.4 swapped content'));

  const dry = await reconcile({});
  assert.equal(dry.integrity.length, 1);
  assert.equal(dry.unreadable.length, 0);

  const applied = await reconcile({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.repaired.documents, 1);
  const audit = await harness.models.AuditEvent.findOne({ action: 'document.reconciled.failed' }).lean();
  assert.equal(audit.detail.reason, 'integrity-mismatch');
});

test('an orphan object is reported and then removed with an audit trail', async () => {
  await setup();
  const orphan = writeOrphanObject();

  const dry = await reconcile({});
  assert.deepEqual(dry.orphans, [orphan]);
  assert.ok(fs.existsSync(path.join(objectsDir(), orphan.slice(0, 2), `${orphan}.bin`)), 'a dry run must not delete bytes');

  const applied = await reconcile({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(applied.repaired.orphans, 1);
  assert.ok(!fs.existsSync(path.join(objectsDir(), orphan.slice(0, 2), `${orphan}.bin`)));

  const audit = await harness.models.AuditEvent.find({ action: 'document.reconciled.orphan-removed' }).lean();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].targetId, orphan);

  // Idempotent: a second pass finds nothing wrong.
  const again = await reconcile({ apply: true, operator: 'operator@clinic.example' });
  assert.equal(again.orphans.length, 0);
  assert.equal(again.repaired.orphans, 0);
});
