'use strict';

// Phase A gate 4: a scheduled backup is only worth anything if the SET it writes
// can be verified and restored. The assertions this file turns on:
//
//   - the set on disk contains no plaintext clinical rows and no key material;
//   - its manifest agrees with the database and the object store it copied;
//   - a wrong backup key is refused BEFORE a restore writes anything;
//   - a restore targets an isolated database, refuses the application database,
//     refuses a non-empty target without --force, and reproduces the rows and
//     object bytes exactly;
//   - the run is recorded, so "the schedule fired" is evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

const harness = require('../helpers/setup');
const backup = require('../../src/services/backupService');
const storage = require('../../src/services/documentStorage');

const BACKUP_KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

let app;
let root;

test.before(async () => {
  app = await harness.init();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-backup-sets-'));
});

test.beforeEach(async () => {
  await harness.resetDb();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
});

test.after(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await harness.shutdown();
});

// Mirrors services/documentStorage.js: MAGIC | IV | TAG | body.
function decryptObject(envelope, keyBase64) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyBase64, 'base64'),
    envelope.subarray(3, 15)
  );
  decipher.setAuthTag(envelope.subarray(15, 31));
  return Buffer.concat([decipher.update(envelope.subarray(31)), decipher.final()]);
}

function withDbName(uri, name) {
  const [base, query] = String(uri).split('?');
  const scheme = /^(mongodb(\+srv)?:\/\/)(.*)$/.exec(base);
  const rest = scheme[3];
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  return `${scheme[1]}${authority}/${name}${query ? `?${query}` : ''}`;
}

// One clinical row and one stored object: enough for every count, checksum and
// byte comparison below to be meaningful.
async function seed() {
  const db = mongoose.connection.db;
  await db.collection('patients').insertOne({
    fullName: 'Synthetic Backup Patient',
    patientCode: 'SYN-BACKUP-1',
    clinic: new mongoose.Types.ObjectId(),
  });
  // A collection that exists but holds no rows and no secondary index: a restore
  // that only creates collections by inserting rows would lose it silently.
  await db.collection('empty_marker').createIndex({ marker: 1 });
  await db.collection('empty_marker').deleteMany({});
  const objectKey = storage.newStorageKey();
  await storage.put(objectKey, Buffer.from('synthetic clinical document bytes'));
  return objectKey;
}

async function makeSet() {
  return backup.createBackup({
    db: mongoose.connection.db,
    objectsRoot: path.join(process.env.DOCUMENT_STORAGE_ROOT, 'objects'),
    destinationRoot: root,
    key: BACKUP_KEY,
    keyFingerprints: backup.fingerprintsFor(process.env),
    now: new Date(),
  });
}

test('a created set is encrypted, matches the database, and verifies', async () => {
  await seed();
  const created = await makeSet();
  const { manifest, directory, manifestPath } = created;

  const db = mongoose.connection.db;
  const patientRows = await db.collection('patients').countDocuments({});
  const entry = manifest.mongo.collections.find((c) => c.name === 'patients');
  assert.ok(entry, 'the manifest lists the patients collection');
  assert.equal(entry.documents, patientRows);
  assert.equal(entry.plaintextBytes > 0, true);
  assert.equal(manifest.objects.count >= 1, true);

  // Encryption at rest: neither the row text nor any key appears on disk.
  const rowFile = fs.readFileSync(path.join(directory, 'mongo', 'patients.jsonl.enc'));
  assert.equal(rowFile.includes(Buffer.from('Synthetic Backup Patient')), false);
  const raw = fs.readFileSync(manifestPath, 'utf8');
  assert.equal(raw.includes(process.env.DOCUMENT_ENCRYPTION_KEY), false);
  assert.equal(raw.includes(BACKUP_KEY.toString('base64')), false);
  assert.equal(raw.includes(Buffer.from(BACKUP_KEY).toString('hex')), false);

  const verification = await backup.verifySet(directory, BACKUP_KEY);
  assert.equal(verification.ok, true, JSON.stringify(verification.checks));
  // key, manifest digest, complete, file set, collections, objects
  assert.equal(verification.checks.length, 6);
  assert.deepEqual(
    verification.checks.map((c) => c.ok),
    [true, true, true, true, true, true]
  );

  await backup.recordRun({
    setId: manifest.setId,
    status: 'complete',
    trigger: 'schedule',
    destination: root,
    startedAt: new Date(manifest.startedAt),
    finishedAt: new Date(manifest.finishedAt),
    durationMs: manifest.durationMs,
    collections: manifest.mongo.collectionCount,
    documents: manifest.mongo.documents,
    objectCount: manifest.objects.count,
    objectBytes: manifest.objects.bytes,
    keyFingerprint: manifest.encryption.keyFingerprint,
  });
  const run = await harness.models.BackupRun.findOne({ setId: manifest.setId }).lean();
  assert.equal(run.status, 'complete');
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.documents, manifest.mongo.documents);
});

test('a wrong key is refused before anything is written', async () => {
  await seed();
  const { directory, manifest } = await makeSet();

  const verification = await backup.verifySet(directory, OTHER_KEY);
  assert.equal(verification.ok, false);
  assert.equal(verification.checks[0].name, 'encryption key matches the set');

  const targetUri = withDbName(process.env.MONGODB_TEST_URI, `velora_backup_wrongkey_${Date.now()}`);
  await assert.rejects(
    () =>
      backup.restoreSet({
        directory,
        targetUri,
        objectsRoot: path.join(root, 'objects-wrongkey'),
        key: OTHER_KEY,
        env: process.env,
        force: false,
      }),
    (err) => err.code === 'SET_KEY_MISMATCH'
  );
  assert.equal(manifest.encryption.keyFingerprint, backup.fingerprint(BACKUP_KEY));
});

test('restore refuses the application database and a non-empty target', async () => {
  await seed();
  const { directory } = await makeSet();
  const objectsRoot = path.join(root, 'objects-guard');

  await assert.rejects(
    () =>
      backup.restoreSet({
        directory,
        targetUri: process.env.MONGODB_URI,
        objectsRoot,
        key: BACKUP_KEY,
        env: process.env,
      }),
    (err) => err.code === 'RESTORE_TARGET_REFUSED'
  );

  const targetUri = withDbName(process.env.MONGODB_TEST_URI, `velora_backup_guard_${Date.now()}`);
  const first = await backup.restoreSet({ directory, targetUri, objectsRoot, key: BACKUP_KEY, env: process.env });
  assert.equal(first.ok, true, JSON.stringify(first));

  await assert.rejects(
    () => backup.restoreSet({ directory, targetUri, objectsRoot, key: BACKUP_KEY, env: process.env }),
    (err) => err.code === 'RESTORE_TARGET_NOT_EMPTY'
  );

  const client = new mongoose.mongo.MongoClient(targetUri);
  await client.connect();
  await client.db().dropDatabase();
  await client.close();
  fs.rmSync(objectsRoot, { recursive: true, force: true });
});

test('a restored set reproduces the rows and the encrypted object bytes', async () => {
  const objectKey = await seed();
  const { directory, manifest } = await makeSet();
  const targetUri = withDbName(process.env.MONGODB_TEST_URI, `velora_backup_restore_${Date.now()}`);
  const objectsRoot = path.join(root, 'objects-restored');

  const result = await backup.restoreSet({
    directory,
    targetUri,
    objectsRoot,
    key: BACKUP_KEY,
    env: process.env,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.documents, manifest.mongo.documents);
  assert.equal(result.rowMismatches, 0);
  assert.equal(result.collectionMismatches, 0);
  assert.equal(result.objectsOk, true);
  assert.equal(result.recoveryPoint, manifest.startedAt);

  // The object bytes are copied verbatim (the app envelope is already encrypted),
  // so the restored file must be byte-identical to the backed-up one.
  const shard = objectKey.slice(0, 2);
  const source = fs.readFileSync(
    path.join(directory, 'objects', shard, `${objectKey}.bin`)
  );
  const restored = fs.readFileSync(
    path.join(objectsRoot, 'objects', shard, `${objectKey}.bin`)
  );
  assert.equal(restored.equals(source), true);
  // And it still decrypts with the document key: a copy, not a lookalike.
  const plaintext = decryptObject(restored, process.env.DOCUMENT_ENCRYPTION_KEY);
  assert.equal(plaintext.toString(), 'synthetic clinical document bytes');

  const client = new mongoose.mongo.MongoClient(targetUri);
  await client.connect();
  const restoredPatient = await client.db().collection('patients').findOne({ patientCode: 'SYN-BACKUP-1' });
  assert.equal(restoredPatient.fullName, 'Synthetic Backup Patient');
  // A row-less collection is part of the set and must come back as a collection.
  const emptyMarker = await client
    .db()
    .listCollections({ name: 'empty_marker' })
    .toArray();
  assert.equal(emptyMarker.length, 1, 'the empty collection was recreated');
  await client.db().dropDatabase();
  await client.close();
});

test('a tampered manifest is caught by verification', async () => {
  await seed();
  const { directory, manifestPath } = await makeSet();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Drop a collection from the manifest. The file is still on disk, so the set
  // is internally inconsistent - the probe that found this reported PASSED
  // before the file-set and digest checks existed.
  manifest.mongo.collections = manifest.mongo.collections.filter((c) => c.name !== 'empty_marker');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const verification = await backup.verifySet(directory, BACKUP_KEY);
  assert.equal(verification.ok, false);
  const failed = verification.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes('manifest matches its own digest'), failed.join(', '));
  assert.ok(failed.includes('manifest lists exactly the collection files present'), failed.join(', '));

  // And a restore refuses the same set instead of publishing it.
  await assert.rejects(
    () =>
      backup.restoreSet({
        directory,
        targetUri: withDbName(process.env.MONGODB_TEST_URI, `velora_backup_tampered_${Date.now()}`),
        objectsRoot: path.join(root, 'objects-tampered'),
        key: BACKUP_KEY,
        env: process.env,
      }),
    (err) => err.code === 'RESTORE_SET_TAMPERED'
  );
});

test('a failed set is never restored and never pruned as a recovery point', async () => {
  await seed();
  const { directory, manifest } = await makeSet();
  await backup.markSetFailed(directory, 'injected failure');

  const marked = await backup.listSets(root);
  assert.equal(marked.find((s) => s.id === manifest.setId).complete, false);

  const targetUri = withDbName(process.env.MONGODB_TEST_URI, `velora_backup_failed_${Date.now()}`);
  await assert.rejects(
    () =>
      backup.restoreSet({
        directory,
        targetUri,
        objectsRoot: path.join(root, 'objects-failed'),
        key: BACKUP_KEY,
        env: process.env,
      }),
    (err) => err.code === 'RESTORE_SET_FAILED'
  );

  // Retention ignores it: a failed newest set must not evict a good older one.
  const prune = await backup.pruneSets(root, 1);
  assert.deepEqual(prune.deleted, []);
  assert.equal(prune.skipped.some((s) => s.id === manifest.setId), true);
});

test('the sweep copies an object referenced by a row written after the object pass', async () => {
  const db = mongoose.connection.db;
  // This is the window the ordering claim originally missed: the object is
  // written and its metadata row committed AFTER the set's object copy.
  const objectKey = storage.newStorageKey();
  await storage.put(objectKey, Buffer.from('late synthetic document bytes'));
  await db.collection('episodedocuments').insertOne({
    storageKey: objectKey,
    status: 'ready',
    byteSize: 28,
  });

  const destination = path.join(root, 'objects-sweep');
  const result = await backup.sweepReferencedObjects({
    db,
    objectsRoot: path.join(process.env.DOCUMENT_STORAGE_ROOT, 'objects'),
    destinationRoot: destination,
    entries: [],
  });

  assert.equal(result.copied, 1);
  assert.equal(result.missing, 0);
  const copied = path.join(destination, objectKey.slice(0, 2), `${objectKey}.bin`);
  assert.equal(fs.existsSync(copied), true);
  assert.equal(fs.readFileSync(copied).equals(fs.readFileSync(storage.objectPath(objectKey))), true);
});
