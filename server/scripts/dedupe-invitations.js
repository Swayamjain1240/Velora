#!/usr/bin/env node
'use strict';

// Staff-invitation deduplication (NQ-3).
//
// The NQ-3 fix adds a UNIQUE partial index on (clinic, email) for still-live
// invitations. A database written BEFORE the fix may already hold several live
// invitations for one address (measured during QA: 8 parallel requests left 8
// usable tokens), and MongoDB refuses to build a unique index over duplicates.
// This command reports those duplicates and, only with an EXPLICIT operator
// attribution, revokes the older ones so the index can be created.
//
//   node scripts/dedupe-invitations.js                          # dry run
//   node scripts/dedupe-invitations.js --apply --operator you@clinic.example
//   node scripts/dedupe-invitations.js --json
//
// A revoked invitation keeps its row and token hash (nothing is deleted), so the
// change is reversible: clearing `revokedAt` restores the record. Revoking -
// rather than deleting - keeps the audit trail and cannot be mistaken for an
// invitation that never existed.
function parseArgs(argv) {
  const args = { apply: false, operator: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--operator') args.operator = argv[i + 1];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

// Finds every clinic+email with more than one LIVE invitation. The oldest row is
// kept (it is the one the recipient most likely already received) and the rest
// are revoked. Returns a structured report; it never deletes anything.
async function dedupeInvitations({ apply = false, operator = null, log = null } = {}) {
  if (apply && !operator) {
    const err = new Error('refusing to apply without --operator <email>');
    err.code = 'OPERATOR_REQUIRED';
    throw err;
  }
  // eslint-disable-next-line global-require
  const Invitation = require('../src/models/Invitation');
  const live = { acceptedAt: null, revokedAt: null };
  const rows = await Invitation.find(live).sort({ createdAt: 1 }).lean();

  const byKey = new Map();
  for (const row of rows) {
    const key = `${String(row.clinic)}|${row.email}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const groups = [];
  let revoked = 0;
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const [keep, ...duplicates] = group;
    const entry = {
      clinic: String(keep.clinic),
      email: keep.email,
      live: group.length,
      kept: String(keep._id),
      revoke: duplicates.map((d) => String(d._id)),
    };
    if (apply) {
      await Invitation.updateMany(
        { _id: { $in: entry.revoke } },
        { $set: { revokedAt: new Date() } }
      );
      revoked += entry.revoke.length;
      if (log) log(`revoked ${entry.revoke.length} duplicate(s) for ${entry.email}`);
    }
    groups.push(entry);
  }

  return {
    scannedLive: rows.length,
    duplicateGroups: groups.length,
    revoked,
    applied: !!apply,
    operator: operator || null,
    groups,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  /* eslint-disable global-require */
  const { loadEnv, getEnv } = require('../src/config/env');
  const { connectDb, disconnectDb } = require('../src/config/db');
  /* eslint-enable global-require */

  loadEnv();
  await connectDb(getEnv().MONGODB_URI);

  const report = await dedupeInvitations({
    apply: args.apply,
    operator: args.operator,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `live invitations scanned: ${report.scannedLive}\n` +
        `clinic+email groups with duplicates: ${report.duplicateGroups}\n` +
        `duplicates ${report.applied ? 'revoked' : 'to revoke'}: ${report.applied ? report.revoked : report.groups.reduce((n, g) => n + g.revoke.length, 0)}\n`
    );
    for (const group of report.groups) {
      process.stdout.write(`  ${group.email}: ${group.live} live, keeping ${group.kept}\n`);
    }
    if (!report.applied) {
      process.stdout.write('\nDRY RUN: nothing changed. Re-run with --apply --operator <email>.\n');
    } else {
      process.stdout.write(`\nAPPLIED by ${report.operator}: ${report.revoked} duplicate invitation(s) revoked.\n`);
    }
  }

  await disconnectDb();
}

if (require.main === module) {
  main().catch(async (err) => {
    process.stderr.write(`dedupe-invitations failed: ${err.message}\n`);
    try {
      // eslint-disable-next-line global-require
      await require('../src/config/db').disconnectDb();
    } catch {
      // ignore
    }
    process.exit(err.code === 'OPERATOR_REQUIRED' ? 2 : 1);
  });
}

module.exports = { dedupeInvitations, parseArgs };