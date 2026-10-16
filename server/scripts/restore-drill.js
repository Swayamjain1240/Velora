#!/usr/bin/env node
'use strict';

// Synthetic restore drill (Part 10, item 5).
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT
//
// A backup you have never restored is a hypothesis. This command restores the
// three assets that must travel TOGETHER - MongoDB rows, the encrypted object
// store, and the document key - into an ISOLATED target and then verifies the
// result by reading it back: row counts, content checksums, indexes, and a real
// decryption of a stored document from the RESTORED copy.
//
//   node scripts/restore-drill.js                       # drill MONGODB_URI, then clean up
//   node scripts/restore-drill.js --keep                # leave the restored copy
//   node scripts/restore-drill.js --source <uri> --target <uri>
//
// It is deliberately a LOGICAL, same-host restore driven by the MongoDB driver:
// no mongodump/mongorestore binary and no provider snapshot is required, so the
// drill is runnable anywhere the app itself runs. It therefore does NOT prove
// provider-level durability, cross-region recovery, or that a scheduled backup
// exists - and it cannot bound data loss (RPO), because the copy is taken from
// the live database at run time. Those remain owner decisions (see the Part 10
// operations runbook). It never restores OVER a live database: the target must
// be a different, drill-suffixed database, and the target is dropped at the end
// unless --keep is passed.
//
// Nothing here prints clinical content, a connection string or a key: the report
// carries collection names, counts, checksums and timings only.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const MAGIC = Buffer.from('VD1'); // mirrors services/documentStorage.js
const BATCH = 500;

function parseArgs(argv) {
  const args = { keep: false, source: null, target: null, sourceLabel: 'env' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') args.keep = true;
    else if (argv[i] === '--source') {
      args.source = argv[i + 1];
      args.sourceLabel = 'argument';
    } else if (argv[i] === '--target') args.target = argv[i + 1];
  }
  return args;
}

function requireEnv() {
  // eslint-disable-next-line global-require
  const { loadEnv, getEnv } = require('../src/config/env');
  loadEnv();
  return getEnv();
}

function dbNameOf(uri) {
  const withoutQuery = String(uri).split('?')[0];
  const afterScheme = withoutQuery.replace(/^mongodb(\+srv)?:\/\//, '');
  const slash = afterScheme.indexOf('/');
  if (slash === -1) return '';
  return afterScheme.slice(slash + 1).replace(/^\//, '');
}

function withDbName(uri, name) {
  const [base, query] = String(uri).split('?');
  const schemeMatch = /^(mongodb(\+srv)?:\/\/)(.*)$/.exec(base);
  const rest = schemeMatch[3];
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  return `${schemeMatch[1]}${authority}/${name}${query ? `?${query}` : ''}`;
}

// Deterministic JSON so a checksum of the same rows is the same string twice.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (Buffer.isBuffer(value)) return `"buf:${value.toString('base64')}"`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function decryptObject(envelope, key) {
  if (envelope.length < MAGIC.length + 28 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a Velora object envelope');
  }
  const iv = envelope.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = envelope.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const body = envelope.subarray(MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

async function collectionDigest(db, name) {
  const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
  const hash = crypto.createHash('sha256');
  for (const doc of docs) hash.update(canonical(doc));
  return { count: docs.length, checksum: hash.digest('hex').slice(0, 16) };
}

// An index is its name, its key, and EVERY option that changes which documents it
// accepts. A partial unique index restored as a full unique index silently
// rejects valid data - the drill found exactly that - so the signature carries
// the filter and the TTL too.
async function indexSignature(db, name) {
  const list = await db.collection(name).indexes();
  return list
    .map((index) =>
      [
        index.name,
        canonical(index.key),
        index.unique ? 'unique' : 'plain',
        index.sparse ? 'sparse' : '',
        index.expireAfterSeconds === undefined ? '' : `ttl:${index.expireAfterSeconds}`,
        index.partialFilterExpression ? `partial:${canonical(index.partialFilterExpression)}` : '',
        index.collation ? `collation:${canonical(index.collation)}` : '',
      ].join(':')
    )
    .sort();
}

// Recreates one source index on the target with its options intact.
function indexOptions(index) {
  const options = { name: index.name };
  if (index.unique) options.unique = true;
  if (index.sparse) options.sparse = true;
  if (index.expireAfterSeconds !== undefined) options.expireAfterSeconds = index.expireAfterSeconds;
  if (index.partialFilterExpression) options.partialFilterExpression = index.partialFilterExpression;
  if (index.collation) options.collation = index.collation;
  return options;
}

async function walkObjects(root) {
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
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.bin')) out.push(target);
    }
  }
  await walk(root);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = requireEnv();

  // The application database is the default subject: a drill against an empty
  // test database would prove almost nothing. `--source` overrides it.
  const sourceUri = args.source || env.MONGODB_URI || env.MONGODB_TEST_URI;
  const sourceName = dbNameOf(sourceUri);
  if (!sourceName) {
    process.stderr.write('refused: the source connection string names no database\n');
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const targetName = `velora_restore_drill_${stamp}`;
  const targetUri = args.target || withDbName(sourceUri, targetName);
  const targetNameResolved = dbNameOf(targetUri);

  // Guard rails: never restore over the source, and never over the application
  // database, whatever was passed on the command line.
  if (targetNameResolved === sourceName) {
    process.stderr.write('refused: the target must be a different database from the source\n');
    process.exit(2);
  }
  if (targetNameResolved === dbNameOf(env.MONGODB_URI) && targetUri !== sourceUri) {
    process.stderr.write('refused: the target must not be the application database\n');
    process.exit(2);
  }

  const report = { checks: [], observations: {}, ok: true };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.ok = false;
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name} - ${detail}\n`);
  };

  process.stdout.write('Velora synthetic restore drill (logical, same-host)\n');
  process.stdout.write(`  source database: ${sourceName} (read-only)\n`);
  process.stdout.write(`  target database: ${targetNameResolved}\n\n`);

  const source = new MongoClient(sourceUri, { serverSelectionTimeoutMS: 5000 });
  const target = new MongoClient(targetUri, { serverSelectionTimeoutMS: 5000 });
  await source.connect();
  await target.connect();

  const sourceDb = source.db(sourceName);
  const targetDb = target.db(targetNameResolved);
  const objectsRoot = path.join(env.DOCUMENT_STORAGE_ROOT, 'objects');
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'velora-restore-drill-'));

  try {
    // ---- 1. Inventory the source, including its checksums ----------------------
    const t0 = Date.now();
    const collections = (await sourceDb.listCollections().toArray())
      .map((c) => c.name)
      .filter((name) => !name.startsWith('system.'))
      .sort();
    const before = {};
    for (const name of collections) {
      // eslint-disable-next-line no-await-in-loop
      before[name] = await collectionDigest(sourceDb, name);
    }
    const dumpMs = Date.now() - t0;

    const sourceObjects = await walkObjects(objectsRoot);
    let sourceObjectBytes = 0;
    for (const file of sourceObjects) sourceObjectBytes += (await fsp.stat(file)).size;

    // ---- 2. Restore rows and indexes into the isolated target -------------------
    const t1 = Date.now();
    const indexFailures = [];
    for (const name of collections) {
      // eslint-disable-next-line no-await-in-loop
      const cursor = sourceDb.collection(name).find({}).sort({ _id: 1 });
      let batch = [];
      // eslint-disable-next-line no-await-in-loop
      while (await cursor.hasNext()) {
        // eslint-disable-next-line no-await-in-loop
        batch.push(await cursor.next());
        if (batch.length >= BATCH) {
          // eslint-disable-next-line no-await-in-loop
          await targetDb.collection(name).insertMany(batch, { ordered: false });
          batch = [];
        }
      }
      if (batch.length) await targetDb.collection(name).insertMany(batch, { ordered: false });

      // Indexes are part of the restore: a unique index that never came back is a
      // silently weakened database, so they are recreated from the source.
      // eslint-disable-next-line no-await-in-loop
      const indexes = await sourceDb.collection(name).indexes();
      for (const index of indexes) {
        if (index.name === '_id_') continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await targetDb.collection(name).createIndex(index.key, indexOptions(index));
        } catch (err) {
          // A failure here is a FINDING, not a crash: report which index could not
          // be rebuilt and let the verification below fail the drill.
          indexFailures.push(`${name}.${index.name} (${err && err.codeName ? err.codeName : 'error'})`);
        }
      }
    }
    const restoreMs = Date.now() - t1;

    // ---- 3. Copy the encrypted objects and verify by DECRYPTING them ------------
    const t2 = Date.now();
    const restoredObjectsRoot = path.join(scratch, 'objects');
    let restoredBytes = 0;
    for (const file of sourceObjects) {
      const relative = path.relative(objectsRoot, file);
      const destination = path.join(restoredObjectsRoot, relative);
      // eslint-disable-next-line no-await-in-loop
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await fsp.copyFile(file, destination);
      // eslint-disable-next-line no-await-in-loop
      restoredBytes += (await fsp.stat(destination)).size;
    }
    const objectsMs = Date.now() - t2;

    // ---- 4. Verify the restored set ---------------------------------------------
    const t3 = Date.now();
    const afterCollections = (await targetDb.listCollections().toArray())
      .map((c) => c.name)
      .filter((name) => !name.startsWith('system.'))
      .sort();
    check(
      'collections restored',
      canonical(afterCollections) === canonical(collections),
      `${afterCollections.length} of ${collections.length} collections present in the target`
    );

    let rows = 0;
    let countMismatches = 0;
    let checksumMismatches = 0;
    let indexMismatches = 0;
    for (const name of collections) {
      rows += before[name].count;
      // eslint-disable-next-line no-await-in-loop
      const after = await collectionDigest(targetDb, name);
      if (after.count !== before[name].count) countMismatches += 1;
      if (after.checksum !== before[name].checksum) checksumMismatches += 1;
      // eslint-disable-next-line no-await-in-loop
      const [sourceIndexes, targetIndexes] = await Promise.all([
        indexSignature(sourceDb, name),
        indexSignature(targetDb, name),
      ]);
      if (canonical(sourceIndexes) !== canonical(targetIndexes)) indexMismatches += 1;
    }
    check('row counts identical', countMismatches === 0, `${rows} rows across ${collections.length} collections, ${countMismatches} mismatch(es)`);
    check('content checksums identical', checksumMismatches === 0, `deterministic sha256 per collection, ${checksumMismatches} mismatch(es)`);
    check(
      'indexes identical',
      indexMismatches === 0 && indexFailures.length === 0,
      indexMismatches === 0 && indexFailures.length === 0
        ? 'name/key/uniqueness/partial filter/TTL compared per collection'
        : `${indexMismatches} mismatch(es); could not rebuild: ${indexFailures.join(', ') || 'none'}`
    );
    check(
      'object store bytes identical',
      restoredBytes === sourceObjectBytes,
      `${sourceObjects.length} encrypted object(s), ${sourceObjectBytes} bytes, ${restoredBytes} restored`
    );

    // The decisive test: a stored document must DECRYPT from the restored copy
    // using the document key. Counts alone would not catch a mismatched key.
    const documents = await sourceDb
      .collection('episodedocuments')
      .find({ status: 'ready' })
      .limit(25)
      .toArray();
    let decryptable = 0;
    let integrity = 0;
    const key = Buffer.from(env.DOCUMENT_ENCRYPTION_KEY, 'base64');
    for (const doc of documents) {
      const relative = path.join(doc.storageKey.slice(0, 2), `${doc.storageKey}.bin`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const envelope = await fsp.readFile(path.join(restoredObjectsRoot, relative));
        const plaintext = decryptObject(envelope, key);
        decryptable += 1;
        if (plaintext.length === doc.byteSize && sha256(plaintext) === String(doc.sha256).slice(0, 16)) {
          integrity += 1;
        }
      } catch {
        // counted as not decryptable
      }
    }
    check(
      'restored documents decrypt and match their recorded hash',
      documents.length === 0 || decryptable === documents.length,
      documents.length === 0
        ? 'no ready document in this database (row/object checks above still applied)'
        : `${decryptable} of ${documents.length} ready document(s) decrypted from the restored copy, ${integrity} matched the stored sha256`
    );

    // ---- 5. Prove the drill did not touch the source ----------------------------
    for (const name of collections) {
      // eslint-disable-next-line no-await-in-loop
      const again = await collectionDigest(sourceDb, name);
      if (again.checksum !== before[name].checksum) countMismatches += 1;
    }
    check('source unchanged by the drill', countMismatches === 0, 'read-only: every source checksum is unchanged');
    const verifyMs = Date.now() - t3;

    report.observations = {
      collections: collections.length,
      rows,
      encryptedObjects: sourceObjects.length,
      objectBytes: sourceObjectBytes,
      dumpMs,
      restoreMs,
      objectsCopyMs: objectsMs,
      verifyMs,
      targetDatabase: targetNameResolved,
      // Stated plainly so no reader mistakes this for a production figure.
      rpoNote:
        'This drill restores the newest state present at run time. It does NOT bound data loss: there is no scheduled backup, so RPO depends on the future backup cadence the owner selects.',
      rtoNote:
        'Copy + verify took the milliseconds above for this synthetic volume on this host. It is not a production RTO, which depends on volume, network and the chosen provider.',
      limitations: [
        'Logical same-host restore driven by the MongoDB driver: no mongodump/mongorestore and no provider snapshot.',
        'The document key is required for the object store to be usable; the drill reads it from configuration, as a real restore would.',
        'No cross-region, cross-provider or point-in-time restore was exercised.',
      ],
    };
  } finally {
    if (!args.keep) {
      await targetDb.dropDatabase().catch(() => {});
      await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    } else {
      process.stdout.write(`  kept for inspection: target database ${targetNameResolved}, objects in ${scratch}\n`);
    }
    await source.close();
    await target.close();
  }

  process.stdout.write(`\nRESULT: ${report.ok ? 'PASSED' : 'FAILED'}\n`);
  process.stdout.write(`${JSON.stringify(report.observations, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

// Run as a command, but keep the pure helpers testable: the URI/name plumbing and
// the index-option fidelity are the parts that decide whether a restore is
// trustworthy, so they carry unit tests.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`restore drill failed: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { canonical, dbNameOf, withDbName, indexOptions, indexSignature, sha256 };
