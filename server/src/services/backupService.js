'use strict';

// Automated, encrypted BACKUP SETS (Phase A gate 4).
//
// The restore drill (scripts/restore-drill.js) proves a copy CAN be restored,
// but the copy it restores is taken from the live database at run time, so it
// can never bound data loss. This module produces the missing artifact: a
// durable set on disk that an operator - or a scheduler - writes on a cadence,
// plus the restore path that reads it back.
//
// A set is the four assets the operations runbook names:
//
//   manifest.json                   counts, checksums, index definitions, key fingerprints
//   mongo/<collection>.jsonl.enc    EJSON rows, one document per line
//   objects/<shard>/<key>.bin       the encrypted object store, copied verbatim
//   (keys and configuration are NOT in the set: they belong in a secret manager)
//
// Design decisions that matter, because each one is a way a backup quietly fails:
//
//   - The set is ENCRYPTED AT REST with BACKUP_ENCRYPTION_KEY (AES-256-GCM, a
//     per-file IV, the authentication tag appended). MongoDB rows are clinical
//     text; a backup directory is not a place for plaintext. A missing key is a
//     refusal, never a plaintext fallback.
//   - OBJECTS ARE COPIED BEFORE ROWS. Metadata is committed only after its
//     object is written, so this ordering can leave an ORPHAN object (harmless,
//     and reported by reconciliation) but can never leave a row whose bytes are
//     missing.
//   - The copy is LOGICAL, not a snapshot: collections are read sequentially.
//     The manifest records the read window and the ordering so the consistency
//     level is stated rather than implied.
//   - The manifest carries checksums and KEY FINGERPRINTS only - never key
//     material, never clinical values.
//   - Restore REFUSES to write over the application database, and refuses a set
//     whose key fingerprint does not match: a wrong key must fail loudly, not
//     produce a database that starts and cannot decrypt its documents.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { once } = require('node:events');
const { BSON, MongoClient } = require('mongodb');

const { EJSON } = BSON;

const MAGIC = Buffer.from('VB1'); // Velora Backup, version 1
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;
const SET_FORMAT = 'velora-backup/1';
const SET_ID_PATTERN = /^\d{8}T\d{6}Z$/;
const BATCH = 200;

function backupError(message, code) {
  const err = new Error(message);
  err.code = code || 'BACKUP_FAILED';
  return err;
}

// Deterministic set id: UTC, second precision, sortable as a string.
function setNow(now = new Date()) {
  // 2026-10-19T09:55:31.123Z -> 20261019T095531Z (seconds, UTC, lexical order).
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function assertSetId(setId) {
  if (!SET_ID_PATTERN.test(String(setId))) {
    throw backupError(`invalid backup set id: ${setId}`, 'SET_ID_INVALID');
  }
  return String(setId);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Identifies a key WITHOUT disclosing it: a restore can then check that it was
// handed the same key the set was written with.
function fingerprint(secret) {
  return sha256Hex(secret).slice(0, 12);
}

function decodeKey(base64, name = 'BACKUP_ENCRYPTION_KEY') {
  const key = Buffer.from(String(base64 || ''), 'base64');
  if (key.length !== 32) {
    throw backupError(
      `${name} must be base64 encoding exactly 32 bytes; backups are never written in plaintext.`,
      'BACKUP_KEY_INVALID'
    );
  }
  return key;
}

// Fail closed when no key is configured. The product still starts without one;
// the backup COMMANDS cannot run without one.
function resolveKey(env) {
  if (!env || !env.BACKUP_ENCRYPTION_KEY) {
    throw backupError(
      'BACKUP_ENCRYPTION_KEY is not configured. Set it (32 bytes, base64) before creating or restoring a backup set.',
      'BACKUP_KEY_MISSING'
    );
  }
  return decodeKey(env.BACKUP_ENCRYPTION_KEY);
}

function isInsideRepo(target, repoRoot) {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertOutsideRepo(target, repoRoot, label = 'backup destination') {
  if (!path.isAbsolute(target)) {
    throw backupError(`${label} must be an absolute path`, 'BACKUP_PATH_INVALID');
  }
  if (isInsideRepo(target, repoRoot)) {
    throw backupError(`${label} must be outside the repository`, 'BACKUP_PATH_INVALID');
  }
  return path.resolve(target);
}

// ---------------------------------------------------------------------------
// Envelope: MAGIC | IV | ciphertext | TAG
//
// The tag is appended at the END so the file can be written as a stream without
// knowing the ciphertext length in advance.
// ---------------------------------------------------------------------------

async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await pipeline(
    fs.createReadStream(file),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    })
  );
  return { sha256: hash.digest('hex'), bytes };
}

// Writes `produce()` (an async iterable of Buffers) into an encrypted file and
// returns the digests of BOTH the plaintext and the stored bytes.
async function writeEncryptedFile(destPath, key, produce) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plainHash = crypto.createHash('sha256');
  let plainBytes = 0;

  await fsp.mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });
  const out = fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 });
  await new Promise((resolve, reject) => {
    out.write(Buffer.concat([MAGIC, iv]), (err) => (err ? reject(err) : resolve()));
  });

  async function* hashed() {
    for await (const chunk of produce()) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      plainHash.update(buf);
      plainBytes += buf.length;
      yield buf;
    }
  }

  await pipeline(hashed, cipher, out);
  // The authenticated tag can only be read once the stream is finalised.
  await fsp.appendFile(destPath, cipher.getAuthTag());

  const stored = await fileDigest(destPath);
  return {
    plaintextSha256: plainHash.digest('hex'),
    plaintextBytes: plainBytes,
    cipherSha256: stored.sha256,
    cipherBytes: stored.bytes,
  };
}

// A Readable of decrypted plaintext. Authentication failure surfaces when the
// stream ends, so a caller that stops early cannot assume the file was valid.
function openDecryptedStream(file, key) {
  const stat = fs.statSync(file);
  if (stat.size < HEADER_BYTES + TAG_BYTES) {
    throw backupError(`${path.basename(file)} is not a complete backup file`, 'SET_UNREADABLE');
  }
  const fd = fs.openSync(file, 'r');
  let header;
  let tag;
  try {
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    fs.readSync(fd, header, 0, HEADER_BYTES, 0);
    fs.readSync(fd, tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw backupError(`${path.basename(file)} is not a Velora backup file`, 'SET_UNREADABLE');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const bodyEnd = stat.size - TAG_BYTES - 1;
  if (bodyEnd < HEADER_BYTES) return Readable.from([]);
  return fs.createReadStream(file, { start: HEADER_BYTES, end: bodyEnd }).pipe(decipher);
}

// Streams one encrypted JSONL file: parses every row, hashes the plaintext, and
// hands each document to `onDocument`. Used by BOTH verify and restore so the
// verification cannot pass on a file a restore would choke on.
async function scanEncryptedJsonl(file, key, onDocument) {
  const stream = openDecryptedStream(file, key);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  stream.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let documents = 0;
  let parseErrors = 0;
  let handlerError = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let doc;
      try {
        doc = EJSON.parse(line, { relaxed: false });
      } catch {
        parseErrors += 1;
        continue;
      }
      documents += 1;
      if (onDocument) {
        try {
          await onDocument(doc);
        } catch (err) {
          // A CALLER's failure (an insert, for example) is not a damaged file:
          // surface it unchanged instead of reporting the set as unreadable.
          handlerError = err;
          throw err;
        }
      }
    }
  } catch (err) {
    rl.close();
    stream.destroy();
    if (handlerError) throw handlerError;
    throw backupError(
      `cannot read ${path.basename(file)}: ${err.message}`,
      'SET_UNREADABLE'
    );
  }
  // The tag is only checked once the cipher stream ends; wait for it so a
  // tampered final block cannot be mistaken for a short but valid file.
  if (!stream.readableEnded && !stream.destroyed) {
    await once(stream, 'end').catch(() => {});
  }
  return {
    documents,
    parseErrors,
    plaintextSha256: hash.digest('hex'),
    plaintextBytes: bytes,
  };
}

// ---------------------------------------------------------------------------
// Inventory helpers
// ---------------------------------------------------------------------------

async function walkFiles(root, suffix) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow a link out of the set
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && (!suffix || entry.name.endsWith(suffix))) out.push(target);
    }
  }
  await walk(root);
  return out.sort();
}

function relativeKey(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

// One aggregate digest over sorted `relative:sha256` lines: order-independent,
// and small enough for a manifest.
function objectDigest(entries) {
  return sha256Hex(
    entries
      .map((entry) => `${entry.key}:${entry.sha256}`)
      .sort()
      .join('\n')
  );
}

async function copyWithHash(source, destination) {
  const hash = crypto.createHash('sha256');
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await pipeline(
    fs.createReadStream(source),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  );
  return hash.digest('hex');
}

// Metadata is committed only AFTER its object is written, so copying objects
// first is what makes "no row without its bytes" true for the set.
async function copyObjects(objectsRoot, destinationRoot) {
  const files = await walkFiles(objectsRoot, '.bin');
  const entries = [];
  let bytes = 0;
  for (const file of files) {
    const key = relativeKey(objectsRoot, file);
    // eslint-disable-next-line no-await-in-loop
    const sha256 = await copyWithHash(file, path.join(destinationRoot, key));
    // eslint-disable-next-line no-await-in-loop
    bytes += (await fsp.stat(path.join(destinationRoot, key))).size;
    entries.push({ key, sha256 });
  }
  return { count: entries.length, bytes, digest: objectDigest(entries) };
}

function indexOptions(entry) {
  const options = { name: entry.name };
  if (entry.unique) options.unique = true;
  if (entry.sparse) options.sparse = true;
  if (entry.expireAfterSeconds !== undefined && entry.expireAfterSeconds !== null) {
    options.expireAfterSeconds = entry.expireAfterSeconds;
  }
  if (entry.partialFilterExpression) options.partialFilterExpression = entry.partialFilterExpression;
  if (entry.collation) options.collation = entry.collation;
  return options;
}

// Every option that changes WHICH documents an index accepts travels with it: a
// partial unique index restored as a full one silently rejects valid data (the
// restore drill found exactly that).
function indexEntry(index) {
  return {
    name: index.name,
    key: index.key,
    unique: Boolean(index.unique),
    sparse: Boolean(index.sparse),
    expireAfterSeconds:
      index.expireAfterSeconds === undefined ? null : index.expireAfterSeconds,
    partialFilterExpression: index.partialFilterExpression || null,
    collation: index.collation || null,
  };
}

async function mongoCollections(db) {
  return (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();
}

async function* jsonlFromCursor(cursor, counter) {
  let batch = [];
  for await (const doc of cursor) {
    if (counter) counter.n += 1;
    batch.push(EJSON.stringify(doc, { relaxed: false }));
    if (batch.length >= BATCH) {
      yield Buffer.from(`${batch.join('\n')}\n`);
      batch = [];
    }
  }
  if (batch.length) yield Buffer.from(`${batch.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Writes one complete set and returns its manifest. `db` is a mongodb Db, so the
// caller decides the connection and the command can be driven by a test.
async function createBackup({
  db,
  objectsRoot,
  destinationRoot,
  key,
  keyFingerprints = {},
  now = new Date(),
  log = () => {},
}) {
  if (!db) throw backupError('createBackup needs a database handle', 'BACKUP_ARGUMENT');
  const setId = assertSetId(setNow(now));
  const destination = path.join(destinationRoot, setId);
  if (fs.existsSync(destination)) {
    throw backupError(`backup set ${setId} already exists at ${destination}`, 'SET_EXISTS');
  }
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });

  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  // 1. Objects first (see the ordering note at the top of this file).
  const objects = await copyObjects(objectsRoot, path.join(destination, 'objects'));
  log(`  objects      ${objects.count} copied, ${objects.bytes} bytes`);

  // 2. Rows, collection by collection.
  const objectStart = Date.now();
  const collections = await mongoCollections(db);
  const mongoEntries = [];
  let documents = 0;
  for (const name of collections) {
    const cursor = db.collection(name).find({});
    // eslint-disable-next-line no-await-in-loop
    const indexes = (await db.collection(name).indexes())
      .filter((index) => index.name !== '_id_')
      .map(indexEntry);
    // Counted AS THE ROWS ARE STREAMED, not with a later countDocuments(): a
    // concurrent write must not make the manifest disagree with its own file.
    const counter = { n: 0 };
    // eslint-disable-next-line no-await-in-loop
    const written = await writeEncryptedFile(
      path.join(destination, 'mongo', `${name}.jsonl.enc`),
      key,
      () => jsonlFromCursor(cursor, counter)
    );
    mongoEntries.push({ name, documents: counter.n, ...written, indexes });
    documents += counter.n;
  }
  const mongoMs = Date.now() - objectStart;
  log(`  rows         ${documents} across ${collections.length} collections`);

  const finished = Date.now();
  const manifest = {
    format: SET_FORMAT,
    setId,
    status: 'complete',
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    source: { database: db.databaseName },
    // Stated, not implied: this is a logical read, not a point-in-time snapshot.
    consistency: {
      mode: 'logical',
      ordering: 'objects-before-rows',
      objectWindowMs: mongoMs,
      readWindowMs: finished - started,
      note:
        'Collections are read sequentially while the application may be writing. Objects are copied first, so no copied row can reference a missing object; a concurrent write can instead leave an ORPHAN object, which reconciliation reports after restore. A backup of MongoDB alone is not a backup of this system: the keys and configuration are separate assets.',
    },
    encryption: {
      algorithm: 'aes-256-gcm',
      envelope: 'VB1',
      keyFingerprint: fingerprint(key),
    },
    // Fingerprints let an operator confirm they hold the SAME document/MFA/
    // export/pepper material the set was taken with - without any key in the
    // manifest.
    keyFingerprints,
    mongo: {
      collections: mongoEntries,
      collectionCount: mongoEntries.length,
      documents,
      durationMs: mongoMs,
    },
    objects,
  };

  // Payload size excludes the manifest, which is written last and atomically.
  const payloadFiles = await walkFiles(destination);
  manifest.payloadBytes = payloadFiles.reduce(
    (sum, file) => sum + fs.statSync(file).size,
    0
  );

  const tmp = path.join(destination, 'manifest.json.tmp');
  await fsp.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, path.join(destination, 'manifest.json'));
  return { manifest, directory: destination, manifestPath: path.join(destination, 'manifest.json') };
}

// Fingerprints of the OTHER assets a restore needs (document/MFA/export keys and
// the session pepper). No key material is included: an operator compares these
// before a restore so a set is never opened with the wrong key material.
function fingerprintsFor(env) {
  const pairs = {
    document: env.DOCUMENT_ENCRYPTION_KEY,
    mfa: env.MFA_ENCRYPTION_KEY,
    privacyExport: env.PRIVACY_EXPORT_ENCRYPTION_KEY,
    sessionPepper: env.SESSION_PEPPER,
  };
  const out = {};
  for (const [name, value] of Object.entries(pairs)) {
    if (!value) continue;
    const material =
      name === 'sessionPepper'
        ? Buffer.from(String(value))
        : Buffer.from(String(value), 'base64');
    out[name] = fingerprint(material);
  }
  return out;
}

async function readManifest(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw backupError(`no readable manifest.json in ${directory}`, 'SET_INVALID');
  }
  if (manifest.format !== SET_FORMAT) {
    throw backupError(`unexpected backup format in ${directory}`, 'SET_INVALID');
  }
  assertSetId(manifest.setId);
  return manifest;
}

// ---------------------------------------------------------------------------
// Verify: can this set be READ back, and does it match its own manifest?
// ---------------------------------------------------------------------------

async function verifySet(directory, key) {
  const manifest = await readManifest(directory);
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  check(
    'encryption key matches the set',
    manifest.encryption && manifest.encryption.keyFingerprint === fingerprint(key),
    `set written with key fingerprint ${manifest.encryption && manifest.encryption.keyFingerprint}`
  );

  let documents = 0;
  let collectionFailures = 0;
  let parseErrors = 0;
  for (const entry of manifest.mongo.collections) {
    const file = path.join(directory, 'mongo', `${entry.name}.jsonl.enc`);
    try {
      // eslint-disable-next-line no-await-in-loop
      const scanned = await scanEncryptedJsonl(file, key);
      documents += scanned.documents;
      parseErrors += scanned.parseErrors;
      if (
        scanned.documents !== entry.documents ||
        scanned.plaintextSha256 !== entry.plaintextSha256 ||
        scanned.plaintextBytes !== entry.plaintextBytes ||
        scanned.parseErrors !== 0
      ) {
        collectionFailures += 1;
      }
    } catch {
      collectionFailures += 1;
    }
  }
  check(
    'every collection decrypts, parses and matches its recorded checksum',
    collectionFailures === 0,
    `${manifest.mongo.collections.length} file(s), ${documents} document(s), ${collectionFailures} mismatch(es), ${parseErrors} unparseable line(s)`
  );

  const objectsDir = path.join(directory, 'objects');
  const files = await walkFiles(objectsDir, '.bin');
  const entries = [];
  let bytes = 0;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const digest = await fileDigest(file);
    bytes += digest.bytes;
    entries.push({ key: relativeKey(objectsDir, file), sha256: digest.sha256 });
  }
  check(
    'encrypted objects match the recorded digest',
    files.length === manifest.objects.count &&
      bytes === manifest.objects.bytes &&
      objectDigest(entries) === manifest.objects.digest,
    `${files.length} of ${manifest.objects.count} object(s), ${bytes} of ${manifest.objects.bytes} bytes`
  );

  return { ok: checks.every((c) => c.ok), checks, manifest, directory };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async function restoreSet({
  directory,
  targetUri,
  objectsRoot,
  key,
  env,
  force = false,
  log = () => {},
}) {
  const manifest = await readManifest(directory);
  if (manifest.encryption.keyFingerprint !== fingerprint(key)) {
    throw backupError(
      'the configured BACKUP_ENCRYPTION_KEY does not match the key this set was written with; refusing to restore a set that would not decrypt',
      'SET_KEY_MISMATCH'
    );
  }
  if (!targetUri) throw backupError('restoreSet needs a target connection string', 'BACKUP_ARGUMENT');
  const targetName = dbNameOf(targetUri);
  if (!targetName) throw backupError('the target connection string names no database', 'BACKUP_ARGUMENT');
  const appName = env && env.MONGODB_URI ? dbNameOf(env.MONGODB_URI) : null;
  if (appName && targetName === appName) {
    throw backupError('refused: a restore must not target the application database', 'RESTORE_TARGET_REFUSED');
  }
  if (!objectsRoot || !path.isAbsolute(objectsRoot)) {
    throw backupError('restoreSet needs an absolute objects root', 'BACKUP_ARGUMENT');
  }

  const client = new MongoClient(targetUri, { serverSelectionTimeoutMS: 5000 });
  const started = Date.now();
  const timings = {};
  let documents = 0;

  await client.connect();
  const db = client.db(targetName);
  try {
    const existing = await mongoCollections(db);
    let existingRows = 0;
    for (const name of existing) {
      // eslint-disable-next-line no-await-in-loop
      existingRows += await db.collection(name).countDocuments({});
    }
    if (existingRows > 0 && !force) {
      throw backupError(
        `refused: target database ${targetName} already holds ${existingRows} document(s); pass --force to replace it`,
        'RESTORE_TARGET_NOT_EMPTY'
      );
    }
    if (existingRows > 0) await db.dropDatabase();

    // 1. Rows and indexes.
    for (const entry of manifest.mongo.collections) {
      const file = path.join(directory, 'mongo', `${entry.name}.jsonl.enc`);
      let batch = [];
      // eslint-disable-next-line no-await-in-loop
      await scanEncryptedJsonl(file, key, async (doc) => {
        batch.push(doc);
        if (batch.length >= BATCH) {
          // eslint-disable-next-line no-await-in-loop
          await db.collection(entry.name).insertMany(batch, { ordered: true });
          batch = [];
        }
      });
      if (batch.length) await db.collection(entry.name).insertMany(batch, { ordered: true });
      for (const index of entry.indexes || []) {
        // A failure here is a finding for the report, not a silent skip.
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.collection(entry.name).createIndex(index.key, indexOptions(index));
        } catch (err) {
          throw backupError(
            `could not rebuild index ${entry.name}.${index.name}: ${err.message}`,
            'RESTORE_INDEX_FAILED'
          );
        }
      }
      documents += entry.documents;
    }
    timings.mongoMs = Date.now() - started;
    log(`  rows         ${documents} restored into ${targetName}`);

    // 2. Objects.
    const objectsStart = Date.now();
    const sourceObjects = path.join(directory, 'objects');
    const files = await walkFiles(sourceObjects, '.bin');
    const entries = [];
    for (const file of files) {
      const rel = relativeKey(sourceObjects, file);
      // eslint-disable-next-line no-await-in-loop
      const sha256 = await copyWithHash(file, path.join(objectsRoot, 'objects', rel));
      entries.push({ key: rel, sha256 });
    }
    timings.objectsMs = Date.now() - objectsStart;

    // 3. Verify the restored target against the manifest BEFORE declaring success.
    let restoredRows = 0;
    let rowMismatches = 0;
    for (const entry of manifest.mongo.collections) {
      // eslint-disable-next-line no-await-in-loop
      const count = await db.collection(entry.name).countDocuments({});
      restoredRows += count;
      if (count !== entry.documents) rowMismatches += 1;
    }
    const objectOk =
      entries.length === manifest.objects.count && objectDigest(entries) === manifest.objects.digest;

    return {
      ok: rowMismatches === 0 && objectOk,
      targetDatabase: targetName,
      documents: restoredRows,
      rowMismatches,
      objects: entries.length,
      objectsOk: objectOk,
      timings: { ...timings, totalMs: Date.now() - started },
      recoveryPoint: manifest.startedAt,
    };
  } finally {
    await client.close();
  }
}

function dbNameOf(uri) {
  const withoutQuery = String(uri).split('?')[0];
  const afterScheme = withoutQuery.replace(/^mongodb(\+srv)?:\/\//, '');
  const slash = afterScheme.indexOf('/');
  if (slash === -1) return '';
  return afterScheme.slice(slash + 1).replace(/^\//, '');
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// Keeps the newest `retain` COMPLETE sets. A directory without a valid manifest
// is never deleted: unknown provenance is not the same as an old backup.
function selectSetsToPrune(directories, retain) {
  const valid = [];
  const skipped = [];
  for (const entry of directories) {
    if (!SET_ID_PATTERN.test(entry.id)) {
      skipped.push({ ...entry, reason: 'not a set id' });
      continue;
    }
    if (!entry.complete) {
      skipped.push({ ...entry, reason: 'no complete manifest' });
      continue;
    }
    valid.push(entry);
  }
  valid.sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
  return { keep: valid.slice(0, Math.max(1, retain)), prune: valid.slice(Math.max(1, retain)), skipped };
}

async function listSets(destinationRoot) {
  let entries;
  try {
    entries = await fsp.readdir(destinationRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(destinationRoot, entry.name);
    let complete = false;
    try {
      const manifest = await readManifest(directory);
      complete = manifest.status === 'complete';
    } catch {
      complete = false;
    }
    out.push({ id: entry.name, directory, complete });
  }
  return out;
}

async function pruneSets(destinationRoot, retain) {
  const selection = selectSetsToPrune(await listSets(destinationRoot), retain);
  const deleted = [];
  for (const entry of selection.prune) {
    // eslint-disable-next-line no-await-in-loop
    await fsp.rm(entry.directory, { recursive: true, force: true });
    deleted.push(entry.id);
  }
  return { kept: selection.keep.map((e) => e.id), deleted, skipped: selection.skipped };
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

// Every run is recorded so "the schedule fired" is evidence, not a claim: the
// newest complete run is the recovery point an operator can quote.
async function recordRun(fields) {
  // Required late: the unit tests import this module without a database.
  // eslint-disable-next-line global-require
  const BackupRun = require('../models/BackupRun');
  return BackupRun.create({
    setId: fields.setId,
    status: fields.status,
    trigger: fields.trigger || 'manual',
    destination: fields.destination,
    startedAt: fields.startedAt,
    finishedAt: fields.finishedAt || null,
    durationMs: fields.durationMs || 0,
    collections: fields.collections || 0,
    documents: fields.documents || 0,
    objectCount: fields.objectCount || 0,
    objectBytes: fields.objectBytes || 0,
    setBytes: fields.setBytes || 0,
    keyFingerprint: fields.keyFingerprint || null,
    error: fields.error ? String(fields.error).slice(0, 280) : null,
  });
}

module.exports = {
  SET_FORMAT,
  SET_ID_PATTERN,
  BATCH,
  MAGIC,
  setNow,
  assertSetId,
  fingerprint,
  decodeKey,
  resolveKey,
  assertOutsideRepo,
  isInsideRepo,
  dbNameOf,
  indexEntry,
  indexOptions,
  objectDigest,
  selectSetsToPrune,
  listSets,
  createBackup,
  fingerprintsFor,
  readManifest,
  verifySet,
  restoreSet,
  pruneSets,
  recordRun,
  writeEncryptedFile,
  openDecryptedStream,
  scanEncryptedJsonl,
  walkFiles,
  fileDigest,
};
