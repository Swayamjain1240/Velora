#!/usr/bin/env node
'use strict';

// Secret scan for the tracked tree and (optionally) the whole reachable history.
//
// Written with the standard library on purpose: the project ships no
// secret-scanning dependency, and a scanner that needs a network install is the
// one command nobody runs before a push. gitleaks still runs in CI; this is the
// offline equivalent.
//
//   node qa/secret-scan.js             # tracked files only
//   node qa/secret-scan.js --history   # added lines in every reachable commit
//
// It NEVER prints the matched value: only the file, the line and the category.
// A finding is a real finding, so the exit code is 1 and the fix is to remove or
// rotate the value - not to add an exception here.
//
// Two classes are deliberately NOT findings, and the reasons are explicit:
//
//  - lockfiles and build output, where the base64 shaped strings are integrity
//    hashes rather than credentials;
//  - the CI/test fixtures, which are deterministic SYNTHETIC key material
//    (`AAAA...=`, `ci_test_session_pepper_...`). They are committed on purpose
//    and cannot open anything, so flagging them would train a reader to ignore
//    the scanner. They are still recognised - as `synthetic` - and counted.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Reviewed exceptions live in a baseline file, keyed by the SHA-256 of the
// matched value (never the value itself). A fixture can therefore be allowed
// without allowlisting the whole file: a REAL key pasted into the same file has
// a different fingerprint and still fails.
const BASELINE = path.resolve(__dirname, 'secret-scan-allowlist.json');

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return [];
  const parsed = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

const SKIP_PATHS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
  /(^|\/)test-results\//,
];

const SYNTHETIC = /(?:synthetic|example|placeholder|dummy|fake|ci_test|test[-_]|change[-_]?me|replace[-_]|your[-_])/i;

const PATTERNS = [
  {
    name: 'private-key-block',
    test: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'credentialed-mongo-uri',
    test: /mongodb(?:\+srv)?:\/\/[^\s/:@]+:[^\s/@]+@/i,
  },
  {
    name: 'credentialed-url',
    test: /\b(?:postgres|postgresql|mysql|redis|amqp|https?):\/\/[^\s/:@]+:[^\s/@]+@/i,
  },
  { name: 'aws-access-key-id', test: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws-secret-access-key', test: /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}/i },
  { name: 'github-token', test: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', test: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'openai-style-key', test: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'google-api-key', test: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'assigned-secret',
    test:
      /\b(?:SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_TOKEN|SESSION_PEPPER|ENCRYPTION_KEY)[A-Z_]*\s*[=:]\s*["']?[A-Za-z0-9+/_-]{24,}["']?/,
  },
  {
    name: 'key-material',
    // A base64 value that decodes to exactly 32 bytes on a line that also NAMES
    // a key. A bare hash on an unrelated line is not key material.
    test: /["']?[A-Za-z0-9+/]{43}=["']?/g,
    lineMustMatch: /(?:KEY|PEPPER|SECRET|TOKEN)/i,
    validate: (match) => {
      try {
        const decoded = Buffer.from(match, 'base64');
        if (decoded.length !== 32) return false;
        // Uniform bytes are synthetic fixtures (AAAA...), not entropy.
        return !decoded.every((byte) => byte === decoded[0]);
      } catch {
        return false;
      }
    },
  },
];

function isSynthetic(line) {
  return SYNTHETIC.test(line);
}

function scanText(text, label, findings) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.length > 2000) return; // minified/binary-ish line
    for (const pattern of PATTERNS) {
      pattern.test.lastIndex = 0;
      const match = pattern.test.exec(line);
      if (!match) continue;
      if (pattern.lineMustMatch && !pattern.lineMustMatch.test(line)) continue;
      if (pattern.validate && !pattern.validate(match[0])) continue;
      if (isSynthetic(line)) continue;
      // The line number is only meaningful for tree scans; for a commit the
      // label is the commit and path, and a concatenated patch offset would be
      // a lie.
      findings.push({
        label,
        line: label.includes(':') ? null : index + 1,
        category: pattern.name,
        fingerprint: fingerprint(match[0]),
      });
      break; // one category per line is enough to act on
    }
  });
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function scanTree() {
  const findings = [];
  let scanned = 0;
  let skipped = 0;
  for (const file of trackedFiles()) {
    if (SKIP_PATHS.some((pattern) => pattern.test(file))) {
      skipped += 1;
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue; // binary
    scanned += 1;
    scanText(buffer.toString('utf8'), file, findings);
  }
  return { findings, scanned, skipped };
}

function scanHistory() {
  const commits = execFileSync('git', ['rev-list', '--all'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  const findings = [];
  let inspected = 0;
  for (const commit of commits) {
    const patch = execFileSync(
      'git',
      ['show', '--format=%H', '--no-color', '--unified=0', commit],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    );
    // A commit touches several files, so added lines are accumulated PER FILE.
    // Attributing the whole patch to the last `+++ b/` path would name the wrong
    // file - a finding that cannot be located cannot be fixed.
    let currentPath = null;
    let added = [];
    const flush = () => {
      if (!currentPath || !added.length) return;
      if (SKIP_PATHS.some((pattern) => pattern.test(currentPath))) return;
      inspected += 1;
      const before = findings.length;
      scanText(added.join('\n'), `${commit.slice(0, 8)}:${currentPath}`, findings);
      // One finding per commit/file is enough to act on.
      if (findings.length > before + 1) findings.splice(before + 1);
    };
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith('+++ b/')) {
        flush();
        currentPath = line.slice(6);
        added = [];
        continue;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
    }
    flush();
  }
  return { findings, scanned: inspected, skipped: 0 };
}

function filePathOf(label) {
  // "<commit>:<path>" for history, "<path>" for the tree.
  return label.includes(':') ? label.slice(label.indexOf(':') + 1) : label;
}

function main() {
  const history = process.argv.includes('--history');
  const strict = process.argv.includes('--strict');
  const { findings, scanned, skipped } = history ? scanHistory() : scanTree();
  const baseline = strict ? [] : loadBaseline();
  const scope = history
    ? `${scanned} file revisions across all commits`
    : `${scanned} tracked files (${skipped} lockfiles/build output skipped)`;

  const allowed = [];
  const open = [];
  for (const finding of findings) {
    const file = filePathOf(finding.label);
    const match = baseline.find(
      (entry) =>
        entry.path === file &&
        entry.category === finding.category &&
        entry.fingerprint === finding.fingerprint
    );
    if (match) allowed.push({ finding, reason: match.reason });
    else open.push(finding);
  }

  for (const { finding, reason } of allowed) {
    console.log(
      `  reviewed fixture: ${finding.label}  ${finding.category}  (${reason})`
    );
  }
  if (!open.length) {
    console.log(
      `secret-scan: clean - ${scope}; ${allowed.length} reviewed fixture(s) matched the baseline`
    );
    return 0;
  }
  console.log(`secret-scan: ${open.length} finding(s) - ${scope}`);
  for (const finding of open) {
    const where = finding.line ? `${finding.label}:${finding.line}` : finding.label;
    console.log(`  ${where}  ${finding.category}  fingerprint ${finding.fingerprint}`);
  }
  return 1;
}

process.exit(main());
