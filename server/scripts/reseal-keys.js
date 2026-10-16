#!/usr/bin/env node
'use strict';

// Key rotation (Part 10, control #1).
//
// Two stores hold data sealed with a key the operator may have to retire:
//
//   * `MFA_ENCRYPTION_KEY`  seals every TOTP seed (`User.mfa.secretEnc`);
//   * `DOCUMENT_ENCRYPTION_KEY` seals every stored discharge document
//     (each object is an AES-256-GCM envelope).
//
// Rotating either key WITHOUT re-sealing strands the data: every enrolled user
// would lose their authenticator and every stored document would become
// unreadable. This command re-seals instead:
//
//   node scripts/reseal-keys.js                     # dry run (default)
//   node scripts/reseal-keys.js --json              # machine-readable report
//   node scripts/reseal-keys.js --apply --operator you@clinic.example
//
// The procedure (see docs/VELORA_OPERATIONS_RUNBOOK.md) is: generate the new
// key, set it as the CURRENT value, move the old value to the `*_PREVIOUS`
// variable, restart with BOTH present, run this command, verify, then remove the
// previous variable. Nothing is written without `--apply --operator`, and a
// refusal is a non-zero exit rather than a silent no-op.
//
// The logic lives in `reseal()` so the integration suite can drive it against a
// real replica set and a disposable storage root; the CLI wrapper only handles
// environment, connection, printing and exit codes. It never logs a key, a
// secret, a filename or a document body - only counts, ids and reason codes.
const crypto = require('node:crypto');

function parseArgs(argv) {
  const args = { apply: false, operator: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--operator') args.operator = argv[i + 1];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Re-seals the two stores. `previous*` default to the configured rotation
// variables; passing them explicitly (tests, an operator with a key from a
// secret manager) does not read the environment.
async function reseal({
  apply = false,
  operator = null,
  log = null,
  previousDocumentKey = null,
  previousMfaKey = null,
} = {}) {
  if (apply && !operator) {
    const err = new Error('refusing to apply without --operator <email>');
    err.code = 'OPERATOR_REQUIRED';
    throw err;
  }

  // Required late so the module can be imported by tests without side effects.
  /* eslint-disable global-require */
  const { getEnv } = require('../src/config/env');
  const EpisodeDocument = require('../src/models/EpisodeDocument');
  const User = require('../src/models/User');
  const storage = require('../src/services/documentStorage');
  const { sealWithKey, openWithKey } = require('../src/services/crypto');
  const audit = require('../src/services/auditService');
  /* eslint-enable global-require */

  const env = getEnv();
  const fromDocuments = previousDocumentKey || env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS || null;
  const fromMfa = previousMfaKey || env.MFA_ENCRYPTION_KEY_PREVIOUS || null;

  const report = {
    targets: { documents: Boolean(fromDocuments), mfaSecrets: Boolean(fromMfa) },
    documents: { scanned: 0, wouldReseal: 0, resealed: 0, failed: [] },
    mfaSecrets: {
      scanned: 0,
      wouldReseal: 0,
      resealed: 0,
      skippedConcurrentChange: 0,
      failed: [],
    },
    verification: { documentsMatched: 0, documentsMismatched: [], mfaSecretsConfirmed: 0 },
    applied: false,
    operator: null,
    notes: [
      'Rotating SESSION_PEPPER cannot be re-sealed: it peppers session-token hashes and MFA recovery-code hashes, so rotating it deliberately invalidates every session and every recovery code. Sign everyone out and re-issue recovery codes.',
      'Generated privacy exports carry their own key and a short TTL; rotate them by letting artifacts expire rather than re-sealing them.',
    ],
  };

  // ---- documents -------------------------------------------------------------
  if (fromDocuments) {
    const keys = await storage.listKeys();
    report.documents.scanned = keys.length;
    for (const key of keys) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await storage.getWithKey(key, fromDocuments);
        report.documents.wouldReseal += 1;
      } catch {
        report.documents.failed.push({ key, reason: 'previous-key-cannot-open' });
      }
    }
  }

  // ---- MFA seeds -------------------------------------------------------------
  let mfaTargets = [];
  if (fromMfa) {
    // `+mfa.secretEnc` overrides the schema's `select: false`, exactly as the
    // auth service does: the sealed seed is deliberately not loaded by default.
    mfaTargets = await User.find({ 'mfa.secretEnc': { $exists: true, $ne: null } })
      .select('_id +mfa.secretEnc')
      .lean();
    report.mfaSecrets.scanned = mfaTargets.length;
    for (const user of mfaTargets) {
      try {
        openWithKey(fromMfa, user.mfa.secretEnc);
        report.mfaSecrets.wouldReseal += 1;
      } catch {
        report.mfaSecrets.failed.push({ user: String(user._id), reason: 'previous-key-cannot-open' });
      }
    }
  }

  if (!apply) return report;

  report.applied = true;
  report.operator = operator;

  // ---- documents -------------------------------------------------------------
  if (fromDocuments) {
    const result = await storage.resealAll({
      fromKey: fromDocuments,
      toKey: env.DOCUMENT_ENCRYPTION_KEY,
    });
    report.documents.resealed = result.resealed;
    // The scan above already reported every object the previous key cannot
    // open; the re-seal pass fails on exactly those, so report each object once
    // instead of listing the same key under two reason codes.
    const alreadyReported = new Set(report.documents.failed.map((item) => item.key));
    for (const item of result.failed) {
      if (!alreadyReported.has(item.key)) report.documents.failed.push(item);
    }

    // PROOF OF NO LOSS: every object is read back with the CURRENT key and
    // compared against the hash the database recorded for it. A rotation that
    // silently altered bytes would be caught here, not in production.
    const rows = await EpisodeDocument.find({ storageKey: { $in: await storage.listKeys() } })
      .select('storageKey sha256 byteSize')
      .lean();
    const byKey = new Map(rows.map((row) => [row.storageKey, row]));
    for (const key of await storage.listKeys()) {
      const row = byKey.get(key);
      if (!row) continue; // an orphan is the reconciliation command's business
      try {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await storage.get(key);
        if (sha256(bytes) === row.sha256 && bytes.length === row.byteSize) {
          report.verification.documentsMatched += 1;
        } else {
          report.verification.documentsMismatched.push(key);
        }
      } catch {
        report.verification.documentsMismatched.push(key);
      }
    }
    if (log) log(`    documents resealed: ${report.documents.resealed}`);
  }

  // ---- MFA seeds -------------------------------------------------------------
  if (fromMfa) {
    for (const user of mfaTargets) {
      let plaintext;
      try {
        plaintext = openWithKey(fromMfa, user.mfa.secretEnc);
      } catch {
        continue; // already reported as unopenable
      }
      const next = sealWithKey(env.MFA_ENCRYPTION_KEY, plaintext);
      // Conditional on the OLD sealed value: if the user re-enrolled during the
      // rotation, the compare-and-set fails and their new secret is untouched.
      // eslint-disable-next-line no-await-in-loop
      const updated = await User.updateOne(
        { _id: user._id, 'mfa.secretEnc': user.mfa.secretEnc },
        { $set: { 'mfa.secretEnc': next } }
      );
      if (updated.modifiedCount !== 1) {
        report.mfaSecrets.skippedConcurrentChange += 1;
        continue;
      }
      // Read the stored value back and prove it opens with the CURRENT key to
      // the same seed: the authenticator keeps working after the rotation.
      // eslint-disable-next-line no-await-in-loop
      const reread = await User.findById(user._id).select('+mfa.secretEnc').lean();
      try {
        if (openWithKey(env.MFA_ENCRYPTION_KEY, reread.mfa.secretEnc) === plaintext) {
          report.mfaSecrets.resealed += 1;
          report.verification.mfaSecretsConfirmed += 1;
        } else {
          report.mfaSecrets.failed.push({ user: String(user._id), reason: 'verification-failed' });
        }
      } catch {
        report.mfaSecrets.failed.push({ user: String(user._id), reason: 'verification-failed' });
      }
    }
    if (log) log(`    MFA seeds resealed: ${report.mfaSecrets.resealed}`);
  }

  // One audit event per RUN, not per row: the trail records who rotated what and
  // how much, without ever carrying a key, a secret or a clinical value.
  await audit.record({
    actorLabel: operator,
    action: 'key.rotation.resealed',
    category: 'admin',
    targetType: 'encryption_key',
    targetId: [report.targets.documents ? 'documents' : null, report.targets.mfaSecrets ? 'mfa' : null]
      .filter(Boolean)
      .join('+') || 'none',
    outcome:
      report.documents.failed.length || report.mfaSecrets.failed.length ? 'failure' : 'success',
    detail: {
      documents: report.documents.resealed,
      // Named `mfaSeeds` rather than `mfaSecrets`: the audit redactor withholds
      // any key containing "secret", which would hide the count itself.
      mfaSeeds: report.mfaSecrets.resealed,
      failed: report.documents.failed.length + report.mfaSecrets.failed.length,
      mismatched: report.verification.documentsMismatched.length,
    },
  });

  return report;
}

function printReport(report, write) {
  write('Key rotation re-seal report');
  write(`  targets:                ${Object.entries(report.targets).filter(([, on]) => on).map(([name]) => name).join(', ') || 'none (nothing to do)'}`);
  write(`  documents scanned:      ${report.documents.scanned}`);
  write(`  documents resealable:   ${report.documents.wouldReseal}`);
  write(`  documents resealed:     ${report.documents.resealed}`);
  write(`  MFA seeds scanned:      ${report.mfaSecrets.scanned}`);
  write(`  MFA seeds resealable:   ${report.mfaSecrets.wouldReseal}`);
  write(`  MFA seeds resealed:     ${report.mfaSecrets.resealed}`);
  write(`  documents verified:     ${report.verification.documentsMatched}`);
  write(`  MFA seeds verified:     ${report.verification.mfaSecretsConfirmed}`);
  for (const item of report.documents.failed) write(`    document problem: ${item.key} (${item.reason})`);
  for (const item of report.mfaSecrets.failed) write(`    MFA problem: ${item.user} (${item.reason})`);
  for (const key of report.verification.documentsMismatched) write(`    hash mismatch after re-seal: ${key}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const write = (line) => process.stdout.write(`${line}\n`);

  /* eslint-disable global-require */
  const { loadEnv, getEnv } = require('../src/config/env');
  const { connectDb, disconnectDb } = require('../src/config/db');
  /* eslint-enable global-require */

  loadEnv();
  await connectDb(getEnv().MONGODB_URI);

  const report = await reseal({
    apply: args.apply,
    operator: args.operator,
    log: write,
  });

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report, write);

  const rotatable = report.targets.documents || report.targets.mfaSecrets;
  if (!rotatable) {
    write(
      '\nNothing to rotate: set the new key as current and the old one as its *_PREVIOUS variable, then restart.'
    );
  } else if (!report.applied) {
    write('\nDRY RUN: nothing changed. Re-run with --apply --operator <email> to re-seal.');
  } else {
    write(
      `\nAPPLIED by ${report.operator}: ${report.documents.resealed} document(s) and ` +
        `${report.mfaSecrets.resealed} MFA seed(s) re-sealed and verified. ` +
        'Remove the *_PREVIOUS variables and restart once you are satisfied.'
    );
  }

  await disconnectDb();
}

if (require.main === module) {
  main().catch(async (err) => {
    process.stderr.write(`reseal failed: ${err.message}\n`);
    try {
      // eslint-disable-next-line global-require
      await require('../src/config/db').disconnectDb();
    } catch {
      // ignore
    }
    // A refusal is not a crash: exit 2 for a missing operator, 1 for anything else.
    process.exit(err.code === 'OPERATOR_REQUIRED' ? 2 : 1);
  });
}

module.exports = { reseal, parseArgs, sha256 };
