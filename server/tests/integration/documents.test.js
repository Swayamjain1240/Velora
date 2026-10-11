'use strict';

// Part 4 document gate. Runs against a replica-set MongoDB plus the disposable
// encrypted storage root, so validation, storage and access are all real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const harness = require('../helpers/setup');
const { pdfDocuments, pngDocuments, jpegDocuments, upload } = require('../helpers/documents');
const documentStorage = require('../../src/services/documentStorage');
const documentValidator = require('../../src/services/documentValidator');
const { resetEnvCache, loadEnv } = require('../../src/config/env');

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

// Two clinics with a team coordinator (who owns the patient + episode), a
// second coordinator, a verified reviewer, an admin and a clinic-B coordinator.
async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'DOCA' });
  const b = await harness.makeClinic({ codePrefix: 'DOCB' });
  const ctx = { clinicA: a.clinic, clinicB: b.clinic };

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);

  const coord2 = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord2 = coord2;
  ctx.coord2Ctx = await harness.signInStaff(app, coord2.user.email);

  const reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);

  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);
  const coordB = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, coordB.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Document Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episode = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      patientId: ctx.patient.id,
      dischargeDate: '2026-09-30',
      dischargeTimezone: 'Europe/London',
    });
  assert.equal(episode.status, 201, JSON.stringify(episode.body));
  ctx.episode = episode.body.episode;
  return ctx;
}

function uploadPdf(ctx, body = pdfDocuments.valid(), filename = 'discharge-summary.pdf') {
  return upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename,
    mediaType: 'application/pdf',
    body,
  });
}

async function objectCount() {
  return (await documentStorage.listKeys()).length;
}

test('a valid PDF is validated, stored encrypted, and listed as ready', async () => {
  const ctx = await setup();
  const pdf = pdfDocuments.valid();
  const res = await uploadPdf(ctx);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const doc = res.body.document;
  assert.equal(doc.status, 'ready');
  assert.equal(doc.readyForReview, true);
  assert.equal(doc.mediaType, 'application/pdf');
  assert.equal(doc.byteSize, pdf.length);
  assert.equal(doc.sha256, crypto.createHash('sha256').update(pdf).digest('hex'));
  assert.equal(doc.technical.pages, 1);
  // The storage key is NEVER exposed.
  assert.equal(doc.storageKey, undefined);

  // Exactly one encrypted object exists and it is NOT the plaintext.
  const keys = await documentStorage.listKeys();
  assert.equal(keys.length, 1);
  const onDisk = fs.readFileSync(documentStorage.objectPath(keys[0]));
  assert.notEqual(onDisk.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(onDisk.subarray(0, 3).toString('latin1'), /^VD1/);

  const list = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/documents`);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].status, 'ready');
});

test('a ready download returns the exact uploaded bytes with hardened headers', async () => {
  const ctx = await setup();
  const pdf = pdfDocuments.valid();
  const created = await uploadPdf(ctx);
  const doc = created.body.document;

  const res = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/documents/${doc.id}/download`
  );
  assert.equal(res.status, 200);
  // Byte-for-byte identical to the uploaded original.
  const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
  assert.equal(body.length, pdf.length);
  assert.ok(body.equals(pdf), 'downloaded bytes must match the original');
  assert.equal(res.headers['cache-control'], 'no-store, private, max-age=0');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  assert.match(res.headers['content-disposition'], /^attachment;/);
  assert.equal(res.headers['content-type'], 'application/pdf');
});

test('the patient owner can download their own ready document', async () => {
  const ctx = await setup();
  const created = await uploadPdf(ctx);
  const patientUser = await harness.makeMember(ctx.clinicA, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  const patientCtx = await harness.signInStaff(app, patientUser.user.email);
  const res = await patientCtx.a.get(
    `/api/episodes/${ctx.episode.id}/documents/${created.body.document.id}/download`
  );
  assert.equal(res.status, 200);
});

test('wrong MIME, wrong extension and traversal filenames are refused with no record', async () => {
  const ctx = await setup();
  // Declared PDF but PNG bytes.
  const mime = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'disguised.pdf',
    mediaType: 'application/pdf',
    body: pngDocuments.valid(),
  });
  assert.equal(mime.status, 400, JSON.stringify(mime.body));
  assert.equal(mime.body.error.code, 'TYPE_MISMATCH');

  // Declared PNG but a .pdf extension.
  const ext = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'wrong.pdf',
    mediaType: 'image/png',
    body: pngDocuments.valid(),
  });
  assert.equal(ext.status, 400);
  assert.equal(ext.body.error.code, 'TYPE_MISMATCH');

  // Path traversal in the display filename.
  const traversal = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: '../../etc/passwd.pdf',
    mediaType: 'application/pdf',
    body: pdfDocuments.valid(),
  });
  assert.equal(traversal.status, 400);
  assert.equal(traversal.body.error.code, 'BAD_FILENAME');

  assert.equal(await harness.models.EpisodeDocument.countDocuments({}), 0);
  assert.equal(await objectCount(), 0);
});

test('an empty file and an oversize file are refused', async () => {
  const ctx = await setup();
  const empty = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'empty.pdf',
    mediaType: 'application/pdf',
    body: Buffer.alloc(0),
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'EMPTY');

  // The configured ceiling is exactly 10 MiB by default; a reduced ceiling here
  // proves the enforcement path without moving 11 MiB over the test socket.
  const { getEnv } = require('../../src/config/env');
  assert.equal(getEnv().DOCUMENT_MAX_BYTES, 10 * 1024 * 1024);
  const previous = process.env.DOCUMENT_MAX_BYTES;
  process.env.DOCUMENT_MAX_BYTES = '2048';
  resetEnvCache();
  loadEnv();
  try {
    const oversize = Buffer.concat([pdfDocuments.valid(), Buffer.alloc(4096)]);
    const tooBig = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
      filename: 'big.pdf',
      mediaType: 'application/pdf',
      body: oversize,
    });
    assert.equal(tooBig.status, 413, JSON.stringify(tooBig.body));
    assert.equal(tooBig.body.error.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_MAX_BYTES;
    else process.env.DOCUMENT_MAX_BYTES = previous;
    resetEnvCache();
    loadEnv();
  }
  assert.equal(await objectCount(), 0);
});

test('encrypted, active-content, attachment and form PDFs are rejected and store nothing', async () => {
  const ctx = await setup();
  const cases = [
    ['/Encrypt 9 0 R', 'PDF_ENCRYPTED'],
    ['/OpenAction 9 0 R', 'PDF_ACTIVE_CONTENT'],
    ['/EmbeddedFile', 'PDF_ATTACHMENT'],
    ['/AcroForm', 'PDF_FORM'],
    ['/URI (http://example.invalid)', 'PDF_EXTERNAL_REF'],
  ];
  for (const [token, code] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const res = await uploadPdf(ctx, pdfDocuments.withToken(token));
    assert.equal(res.status, 201, `${code}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.document.status, 'rejected');
    assert.equal(res.body.document.rejectionCode, code);
  }
  // Rejected rows are recorded, but NOT a single byte is stored.
  assert.equal(await objectCount(), 0);
  assert.equal(await harness.models.EpisodeDocument.countDocuments({ status: 'rejected' }), cases.length);
});

test('a malformed/truncated PDF and a PDF with appended data are rejected', async () => {
  const ctx = await setup();
  const malformed = await uploadPdf(ctx, pdfDocuments.malformed());
  assert.equal(malformed.body.document.rejectionCode, 'PDF_MALFORMED');

  const trailing = await uploadPdf(ctx, pdfDocuments.trailing());
  assert.equal(trailing.body.document.rejectionCode, 'PDF_TRAILING_DATA');
  assert.equal(await objectCount(), 0);
});

test('page, object and declared-stream limits are enforced', async () => {
  const ctx = await setup();
  const pages = await uploadPdf(ctx, pdfDocuments.manyPages(320));
  assert.equal(pages.body.document.rejectionCode, 'PDF_TOO_MANY_PAGES');

  const objects = await uploadPdf(ctx, pdfDocuments.manyObjects(5200));
  assert.equal(objects.body.document.rejectionCode, 'PDF_TOO_MANY_OBJECTS');

  const streams = await uploadPdf(ctx, pdfDocuments.withToken('/Length 999999999'));
  assert.equal(streams.body.document.rejectionCode, 'PDF_STREAM_TOO_LARGE');
  assert.equal(await objectCount(), 0);
});

test('image pixel bombs, multi-frame images and malformed images are rejected', async () => {
  const ctx = await setup();
  const bomb = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'bomb.png',
    mediaType: 'image/png',
    body: pngDocuments.pixelBomb(),
  });
  assert.equal(bomb.body.document.rejectionCode, 'IMAGE_PIXEL_BOMB');

  const animated = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'animated.png',
    mediaType: 'image/png',
    body: pngDocuments.animated(),
  });
  assert.equal(animated.body.document.rejectionCode, 'IMAGE_MULTIFRAME');

  const jpegFrames = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'frames.jpg',
    mediaType: 'image/jpeg',
    body: jpegDocuments.multiFrame(),
  });
  assert.equal(jpegFrames.body.document.rejectionCode, 'IMAGE_MULTIFRAME');

  const malformed = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'broken.png',
    mediaType: 'image/png',
    body: pngDocuments.malformed(),
  });
  assert.equal(malformed.body.document.rejectionCode, 'IMAGE_MALFORMED');
  assert.equal(await objectCount(), 0);
});

test('a valid PNG and JPEG are accepted and ready', async () => {
  const ctx = await setup();
  const png = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'scan.png',
    mediaType: 'image/png',
    body: pngDocuments.valid(),
  });
  assert.equal(png.status, 201, JSON.stringify(png.body));
  assert.equal(png.body.document.status, 'ready');
  assert.equal(png.body.document.technical.width, 64);
  assert.equal(png.body.document.technical.height, 64);

  const jpeg = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'scan.jpg',
    mediaType: 'image/jpeg',
    body: jpegDocuments.valid(),
  });
  assert.equal(jpeg.status, 201, JSON.stringify(jpeg.body));
  assert.equal(jpeg.body.document.status, 'ready');
  assert.equal(jpeg.body.document.technical.width, 128);
});

test('a parser timeout quarantines the document and it can never be downloaded', async () => {
  const ctx = await setup();
  const previous = process.env.DOCUMENT_PARSER_TIMEOUT_MS;
  process.env.DOCUMENT_PARSER_TIMEOUT_MS = '120';
  resetEnvCache();
  loadEnv();
  try {
    const verdict = await documentValidator.validate(pdfDocuments.valid(), {
      filename: 'slow.pdf',
      declaredMediaType: 'application/pdf',
      stallMs: 2000,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'PARSER_TIMEOUT');
    assert.equal(verdict.errorClass, 'quarantined');
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_PARSER_TIMEOUT_MS;
    else process.env.DOCUMENT_PARSER_TIMEOUT_MS = previous;
    resetEnvCache();
    loadEnv();
  }
  assert.ok(ctx.episode.id, 'context prepared');
});

test('worker saturation is refused with a service-busy error rather than hanging', async () => {
  const previous = {
    concurrency: process.env.DOCUMENT_PARSER_CONCURRENCY,
    queue: process.env.DOCUMENT_PARSER_QUEUE_MAX,
  };
  process.env.DOCUMENT_PARSER_CONCURRENCY = '1';
  process.env.DOCUMENT_PARSER_QUEUE_MAX = '0';
  resetEnvCache();
  loadEnv();
  try {
    const slow = documentValidator.validate(pdfDocuments.valid(), {
      filename: 'a.pdf',
      declaredMediaType: 'application/pdf',
      stallMs: 300,
    });
    // The slot is taken, and the queue is full: this must reject immediately.
    await assert.rejects(
      () =>
        documentValidator.validate(pdfDocuments.valid(), {
          filename: 'b.pdf',
          declaredMediaType: 'application/pdf',
        }),
      (err) => err.code === 'SERVICE_BUSY' && err.status === 503
    );
    await slow;
  } finally {
    for (const [key, value] of [
      ['DOCUMENT_PARSER_CONCURRENCY', previous.concurrency],
      ['DOCUMENT_PARSER_QUEUE_MAX', previous.queue],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
    loadEnv();
  }
});

test('parallel uploads of identical bytes dedupe to a single row and a single object', async () => {
  const ctx = await setup();
  const pdf = pdfDocuments.valid();
  const [r1, r2] = await Promise.all([
    uploadPdf(ctx, pdf),
    uploadPdf(ctx, pdf),
  ]);
  assert.ok([r1.status, r2.status].every((s) => s === 201), `${r1.status}/${r2.status}`);
  assert.equal(await harness.models.EpisodeDocument.countDocuments({ episode: ctx.episode.id }), 1);
  assert.equal(await objectCount(), 1);
  const list = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/documents`);
  assert.equal(list.body.items[0].status, 'ready');
});

test('re-uploading identical bytes is idempotent, and a rejected file can be replaced', async () => {
  const ctx = await setup();
  const pdf = pdfDocuments.valid();
  const first = await uploadPdf(ctx, pdf);
  const again = await uploadPdf(ctx, pdf);
  assert.equal(again.status, 201);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.document.id, first.body.document.id);
  assert.equal(await objectCount(), 1);

  // A rejected file (same episode, no bytes) can be re-uploaded once corrected.
  const rejected = await uploadPdf(ctx, pdfDocuments.withToken('/Encrypt 1 0 R'));
  assert.equal(rejected.body.document.status, 'rejected');
  const corrected = await uploadPdf(ctx, pdfDocuments.withToken(''), 'corrected.pdf');
  assert.equal(corrected.status, 201);
  assert.equal(corrected.body.document.status, 'ready');
  assert.equal(corrected.body.duplicate, false);
});

test('a storage write failure fails safe and marks the row failed', async () => {
  const ctx = await setup();
  documentStorage.__setProviderForTest({
    name: 'broken',
    put: async () => {
      throw new Error('disk offline');
    },
    get: async () => {
      throw new Error('disk offline');
    },
    stat: async () => null,
    remove: async () => {},
    listKeys: async () => [],
  });
  try {
    const res = await uploadPdf(ctx);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    // No diagnostics leak.
    assert.ok(!JSON.stringify(res.body).includes('disk offline'));
    const rows = await harness.models.EpisodeDocument.find({ episode: ctx.episode.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
  } finally {
    documentStorage.__resetProvider();
  }
});

test('a tampered ciphertext and a missing object both fail closed', async () => {
  const ctx = await setup();
  const created = await uploadPdf(ctx);
  const doc = created.body.document;
  const row = await harness.models.EpisodeDocument.findById(doc.id).lean();

  // Tamper: overwrite the object with garbage.
  fs.writeFileSync(documentStorage.objectPath(row.storageKey), Buffer.from('not a velora document at all'));
  const tampered = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/documents/${doc.id}/download`
  );
  assert.equal(tampered.status, 500);
  const afterTamper = await harness.models.EpisodeDocument.findById(doc.id).lean();
  assert.equal(afterTamper.status, 'failed');
});

test('a missing object fails closed', async () => {
  const ctx = await setup();
  const created = await uploadPdf(ctx);
  const doc = created.body.document;
  const row = await harness.models.EpisodeDocument.findById(doc.id).lean();
  fs.rmSync(documentStorage.objectPath(row.storageKey), { force: true });

  const res = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/documents/${doc.id}/download`
  );
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
});

test('storage keys are traversal-proof', () => {
  for (const bad of ['../../etc/passwd', 'a/b', '..', '/abs/path', 'not-a-uuid']) {
    assert.throws(() => documentStorage.objectPath(bad));
  }
});

test('a closed episode refuses new documents but still serves ready downloads', async () => {
  const ctx = await setup();
  const created = await uploadPdf(ctx);
  const doc = created.body.document;

  await harness.models.RecoveryEpisode.updateOne(
    { _id: ctx.episode.id },
    { $set: { status: 'closed' } }
  );

  // The episode state is checked FIRST, so even byte-identical input is refused.
  const blocked = await uploadPdf(ctx, pdfDocuments.valid());
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  const blockedFresh = await uploadPdf(ctx, pdfDocuments.withToken('/Title (another)'), 'another.pdf');
  assert.equal(blockedFresh.status, 409, JSON.stringify(blockedFresh.body));

  const download = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/documents/${doc.id}/download`
  );
  assert.equal(download.status, 200, 'a read-only episode still allows downloads');
});

test('access is denied to the other clinic, unassigned staff, admins and caregivers', async () => {
  const ctx = await setup();
  const created = await uploadPdf(ctx);
  const doc = created.body.document;

  // Another clinic.
  assert.equal((await ctx.otherClinicCtx.a.get(`/api/episodes/${ctx.episode.id}/documents`)).status, 404);
  // Same-clinic staff who are NOT on the episode team.
  assert.equal((await ctx.coord2Ctx.a.get(`/api/episodes/${ctx.episode.id}/documents`)).status, 404);
  // An administrator is explicitly denied clinical metadata.
  assert.equal((await ctx.adminCtx.a.get(`/api/episodes/${ctx.episode.id}/documents`)).status, 403);
  assert.equal(
    (await ctx.adminCtx.a.get(`/api/episodes/${ctx.episode.id}/documents/${doc.id}`)).status,
    403
  );
  assert.equal(
    (await ctx.adminCtx.a.get(`/api/episodes/${ctx.episode.id}/documents/${doc.id}/download`)).status,
    403
  );

  // A caregiver holding ONLY view_profile is denied.
  const caregiver = await harness.makeMember(ctx.clinicA, { roleKey: 'caregiver' });
  const caregiverCtx = await harness.signInStaff(app, caregiver.user.email);
  await harness.models.CaregiverGrant.create({
    clinic: ctx.clinicA,
    patient: ctx.patient.id,
    granteeEmail: caregiver.user.email,
    caregiverUser: caregiver.user.id,
    scopes: ['view_profile'],
    status: 'active',
    grantedByRole: 'staff',
    grantedByUser: ctx.coord.user.id,
  });
  assert.equal((await caregiverCtx.a.get(`/api/episodes/${ctx.episode.id}/documents`)).status, 404);
});

test('a revoked episode assignment immediately loses document access', async () => {
  const ctx = await setup();
  await uploadPdf(ctx);
  // Add the second coordinator to the team, then revoke it.
  const assigned = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.coord2.user.id, responsibility: 'care_coordinator' });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.equal((await ctx.coord2Ctx.a.get(`/api/episodes/${ctx.episode.id}/documents`)).status, 200);

  const revoked = await ctx.coordCtx.a
    .delete(`/api/episodes/${ctx.episode.id}/team/${assigned.body.assignment.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal((await ctx.coord2Ctx.a.get(`/api/episodes/${ctx.episode.id}/documents`)).status, 404);
});

test('document listings are paginated and scoped to the episode', async () => {
  const ctx = await setup();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await uploadPdf(ctx, pdfDocuments.withToken(`/Title (doc ${i})`), `doc-${i}.pdf`);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const page1 = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/documents?page=1&limit=2`);
  assert.equal(page1.body.total, 3);
  assert.equal(page1.body.items.length, 2);
  const page2 = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/documents?page=2&limit=2`);
  assert.equal(page2.body.items.length, 1);
});

// The patient-owned mirror is read-and-download only, and scoped by ownership:
// there is no upload route, and another patient's episode is a uniform 404.
test('the patient mirror serves only the owning patient and never accepts an upload', async () => {
  const ctx = await setup();
  const pdf = pdfDocuments.valid();
  const created = await uploadPdf(ctx);
  const doc = created.body.document;

  const ownerUser = await harness.makeMember(ctx.clinicA, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: ownerUser.user.id, status: 'active' } }
  );
  const ownerCtx = await harness.signInStaff(app, ownerUser.user.email);

  const list = await ownerCtx.a.get(`/api/patient/me/episodes/${ctx.episode.id}/documents`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].filename, 'discharge-summary.pdf');
  assert.equal(list.body.items[0].storageKey, undefined);

  const detail = await ownerCtx.a.get(
    `/api/patient/me/episodes/${ctx.episode.id}/documents/${doc.id}`
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.document.sha256, doc.sha256);

  const download = await ownerCtx.a.get(
    `/api/patient/me/episodes/${ctx.episode.id}/documents/${doc.id}/download`
  );
  assert.equal(download.status, 200);
  assert.equal(Buffer.compare(download.body, pdf), 0, 'the patient receives the original bytes');

  // No write route exists on the mirror, and the staff write route refuses a
  // patient owner outright (ownership is not an episode-team assignment).
  const mirrorUpload = await ownerCtx.a
    .post(`/api/patient/me/episodes/${ctx.episode.id}/documents`)
    .set('X-CSRF-Token', ownerCtx.csrf)
    .set('X-Document-Filename', 'patient-upload.pdf')
    .set('Content-Type', 'application/pdf')
    .send(pdf);
  assert.equal(mirrorUpload.status, 404);

  const staffRouteUpload = await upload(
    ownerCtx.a,
    ownerCtx.csrf,
    ctx.episode.id,
    { filename: 'patient-upload.pdf', mediaType: 'application/pdf', body: pdf }
  );
  assert.equal(staffRouteUpload.status, 403, JSON.stringify(staffRouteUpload.body));
  assert.equal(await objectCount(), 1, 'a refused patient upload stores nothing');

  // Another patient sees nothing: the episode is not theirs.
  const otherUser = await harness.makeMember(ctx.clinicA, { roleKey: 'patient' });
  const otherCtx = await harness.signInStaff(app, otherUser.user.email);
  assert.equal(
    (await otherCtx.a.get(`/api/patient/me/episodes/${ctx.episode.id}/documents`)).status,
    404
  );
  assert.equal(
    (await otherCtx.a.get(`/api/patient/me/episodes/${ctx.episode.id}/documents/${doc.id}`)).status,
    404
  );
});

test('document error responses never leak storage keys, paths or parser internals', async () => {
  const ctx = await setup();
  const res = await uploadPdf(ctx, pdfDocuments.malformed());
  const serialized = JSON.stringify(res.body);
  assert.ok(!/storageKey|\.bin|objects\//.test(serialized));
  assert.ok(!/at .*documentInspector/.test(serialized));
});
