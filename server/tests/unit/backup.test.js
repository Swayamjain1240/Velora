'use strict';

// Phase A gate 4: the parts of a backup set that decide whether a restore is
// trustworthy. The assertions this file turns on:
//
//   - a set id cannot escape the destination directory;
//   - a missing or short backup key is a REFUSAL, never a plaintext fallback;
//   - the envelope round-trips, and a wrong key or a flipped byte FAILS instead
//     of returning partial rows;
//   - the object digest is order-independent, so two copies of the same set
//     agree;
//   - retention keeps the newest sets, never deletes an incomplete one, and
//     never deletes the newest set even when asked to keep none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const backup = require('../../src/services/backupService');

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);
const REPO_ROOT = path.resolve(__dirname, '../../..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'velora-backup-test-'));
}

function writeSet(root, id, status = 'complete') {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify({ format: backup.SET_FORMAT, setId: id, status, objects: {} })
  );
  return directory;
}

test('a set id is UTC, sortable and cannot escape the destination', () => {
  const id = backup.setNow(new Date('2026-10-19T09:55:31.123Z'));
  assert.equal(id, '20261019T095531Z');
  assert.match(id, /^\d{8}T\d{6}Z$/);
  for (const bad of ['../etc', '2026-10-19', '20261019T0955Z', '']) {
    assert.throws(() => backup.assertSetId(bad), /invalid backup set id/);
  }
});

test('the backup key is required, exactly 32 bytes, and never printed', () => {
  assert.throws(() => backup.resolveKey({}), /BACKUP_ENCRYPTION_KEY is not configured/);
  assert.throws(
    () => backup.decodeKey(Buffer.alloc(16, 1).toString('base64')),
    /exactly 32 bytes/
  );
  assert.equal(backup.resolveKey({ BACKUP_ENCRYPTION_KEY: KEY.toString('base64') }).length, 32);

  // The fingerprint identifies a key without disclosing it.
  const print = backup.fingerprint(KEY);
  assert.match(print, /^[0-9a-f]{12}$/);
  assert.equal(print, backup.fingerprint(KEY));
  assert.notEqual(print, backup.fingerprint(OTHER_KEY));
});

test('a set cannot be written inside the repository', () => {
  assert.throws(() => backup.assertOutsideRepo('', REPO_ROOT), /absolute path/);
  assert.throws(
    () => backup.assertOutsideRepo(path.join(REPO_ROOT, 'backups'), REPO_ROOT),
    /outside the repository/
  );
  const outside = tempDir();
  assert.equal(backup.assertOutsideRepo(outside, REPO_ROOT), path.resolve(outside));
});

test('an encrypted file round-trips with matching digests', async () => {
  const root = tempDir();
  const file = path.join(root, 'rows.jsonl.enc');
  const rows = ['{"a":1}\n', '{"a":2}\n', '{"a":3}\n'];
  const written = await backup.writeEncryptedFile(file, KEY, async function* produce() {
    for (const row of rows) yield Buffer.from(row);
  });

  assert.equal(written.plaintextBytes, rows.join('').length);
  assert.equal(written.plaintextSha256, crypto.createHash('sha256').update(rows.join('')).digest('hex'));
  // The stored bytes are NOT the plaintext, and the size includes header + tag.
  assert.ok(written.cipherBytes > written.plaintextBytes);
  assert.ok(!fs.readFileSync(file).includes(Buffer.from('{"a":1}')));
  const stored = await backup.fileDigest(file);
  assert.equal(stored.sha256, written.cipherSha256);
  assert.equal(stored.bytes, written.cipherBytes);

  const scanned = await backup.scanEncryptedJsonl(file, KEY);
  assert.equal(scanned.documents, 3);
  assert.equal(scanned.parseErrors, 0);
  assert.equal(scanned.plaintextSha256, written.plaintextSha256);
});

test('a wrong key or a flipped byte fails the read instead of returning rows', async () => {
  const root = tempDir();
  const file = path.join(root, 'rows.jsonl.enc');
  await backup.writeEncryptedFile(file, KEY, async function* produce() {
    yield Buffer.from('{"patient":"synthetic"}\n');
  });

  await assert.rejects(
    () => backup.scanEncryptedJsonl(file, OTHER_KEY),
    (err) => err.code === 'SET_UNREADABLE'
  );

  const bytes = fs.readFileSync(file);
  bytes[backup.MAGIC.length + 12] ^= 0xff; // first ciphertext byte
  fs.writeFileSync(file, bytes);
  await assert.rejects(
    () => backup.scanEncryptedJsonl(file, KEY),
    (err) => err.code === 'SET_UNREADABLE'
  );
});

test('the object digest is order-independent and sensitive to one byte', () => {
  const a = { key: 'aa/x.bin', sha256: 'a'.repeat(64) };
  const b = { key: 'bb/y.bin', sha256: 'b'.repeat(64) };
  assert.equal(backup.objectDigest([a, b]), backup.objectDigest([b, a]));
  assert.notEqual(backup.objectDigest([a, b]), backup.objectDigest([a, { ...b, sha256: 'c'.repeat(64) }]));
  assert.equal(backup.objectDigest([]), crypto.createHash('sha256').update('').digest('hex'));
});

test('retention keeps the newest sets and refuses to guess at unknown directories', () => {
  const selection = backup.selectSetsToPrune(
    [
      { id: '20261018T000000Z', complete: true },
      { id: '20261019T000000Z', complete: true },
      { id: '20261017T000000Z', complete: true },
      { id: '20261016T000000Z', complete: false },
      { id: 'not-a-set', complete: true },
    ],
    2
  );
  assert.equal(selection.keep.length, 2);
  assert.deepEqual(selection.keep.map((e) => e.id), ['20261019T000000Z', '20261018T000000Z']);
  assert.deepEqual(selection.prune.map((e) => e.id), ['20261017T000000Z']);
  // An incomplete set and an unrecognised directory are reported, never deleted.
  assert.equal(selection.skipped.length, 2);

  // Keeping zero still keeps the newest set: there is always a recovery point.
  assert.equal(backup.selectSetsToPrune([{ id: '20261019T000000Z', complete: true }], 0).keep.length, 1);
});

test('pruning deletes only old complete sets', async () => {
  const root = tempDir();
  writeSet(root, '20261017T000000Z');
  writeSet(root, '20261018T000000Z');
  writeSet(root, '20261019T000000Z');
  const incomplete = writeSet(root, '20261016T000000Z', 'failed');
  const unknown = path.join(root, 'manual-copy');
  fs.mkdirSync(unknown, { recursive: true });

  const result = await backup.pruneSets(root, 2);
  assert.deepEqual(result.deleted, ['20261017T000000Z']);
  assert.ok(!fs.existsSync(path.join(root, '20261017T000000Z')));
  assert.ok(fs.existsSync(path.join(root, '20261019T000000Z')));
  assert.ok(fs.existsSync(incomplete), 'an incomplete set is never deleted');
  assert.ok(fs.existsSync(unknown), 'an unrecognised directory is never deleted');
  assert.equal(result.skipped.length, 2);
});

test('index options survive the manifest so a restore cannot weaken a rule', () => {
  const entry = backup.indexEntry({
    name: 'one_active_grant',
    key: { clinic: 1, patient: 1, caregiver: 1 },
    unique: true,
    partialFilterExpression: { status: 'active' },
    expireAfterSeconds: 3600,
  });
  const options = backup.indexOptions(entry);
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, { status: 'active' });
  assert.equal(options.expireAfterSeconds, 3600);
  assert.equal(options.name, 'one_active_grant');
});
