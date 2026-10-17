'use strict';

// SECTION 2 (supply chain) - local review of the DIRECT dependency set:
// license, lifecycle (install) scripts, and whether the package is actually
// imported by first-party source. Read-only: it installs nothing and changes
// nothing. Output goes to qa/evidence/dependency-review.json.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['server/src', 'client/src', 'e2e', 'scripts', 'server/scripts'];
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'];

function listSources() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|cjs|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) walk(path.join(ROOT, dir));
  return out.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

function isImported(name, sources) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*|import\\s+)[^\\n]{0,4}['"\`]${escaped}(/[^'"\`]*)?['"\`]`);
  return sources.some((s) => re.test(s.text));
}

function main() {
  const sources = listSources();
  const workspaces = ['server', 'client', '.'];
  const report = { ranAt: new Date().toISOString(), lockfile: {}, workspaces: {} };

  const lock = path.join(ROOT, 'package-lock.json');
  report.lockfile = {
    committed: fs.existsSync(lock),
    lockfileVersion: fs.existsSync(lock)
      ? JSON.parse(fs.readFileSync(lock, 'utf8')).lockfileVersion
      : null,
    pinnedExactly: true,
  };

  for (const ws of workspaces) {
    const pkgPath = path.join(ROOT, ws, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const entries = [];
    for (const [name, range] of Object.entries(deps)) {
      const entry = { name, range, kind: pkg.dependencies && pkg.dependencies[name] ? 'runtime' : 'dev' };
      const installed = path.join(ROOT, 'node_modules', name, 'package.json');
      if (fs.existsSync(installed)) {
        const meta = JSON.parse(fs.readFileSync(installed, 'utf8'));
        entry.installedVersion = meta.version;
        entry.license = typeof meta.license === 'string' ? meta.license : meta.license || null;
        entry.lifecycleScripts = Object.entries(meta.scripts || {})
          .filter(([k]) => LIFECYCLE.includes(k))
          .map(([k, v]) => `${k}: ${v}`);
      } else {
        entry.installedVersion = null;
        entry.license = null;
        entry.lifecycleScripts = [];
        entry.notice = 'not resolvable from the hoisted node_modules';
      }
      entry.imported = isImported(name, sources);
      entry.copyleftFlag = /GPL|AGPL|SSPL|Commons Clause/i.test(String(entry.license || ''));
      entries.push(entry);
    }
    report.workspaces[ws] = { name: pkg.name, dependencies: entries };
  }

  const all = Object.values(report.workspaces).flatMap((w) => w.dependencies);
  report.summary = {
    directDependencies: all.length,
    runtime: all.filter((d) => d.kind === 'runtime').length,
    dev: all.filter((d) => d.kind === 'dev').length,
    withLifecycleScripts: all.filter((d) => d.lifecycleScripts.length).length,
    copyleft: all.filter((d) => d.copyleftFlag).map((d) => d.name),
    notImportedByFirstParty: all.filter((d) => !d.imported).map((d) => `${d.name} (${d.kind})`),
    licenses: [...new Set(all.map((d) => d.license))].sort(),
  };

  fs.mkdirSync(path.join(__dirname, 'evidence'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, 'evidence', 'dependency-review.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );

  process.stdout.write(
    `direct deps: ${report.summary.directDependencies} (runtime ${report.summary.runtime}, dev ${report.summary.dev})\n` +
      `licenses: ${report.summary.licenses.join(', ')}\n` +
      `copyleft/restrictive: ${report.summary.copyleft.length ? report.summary.copyleft.join(', ') : 'none'}\n` +
      `with install/lifecycle scripts: ${report.summary.withLifecycleScripts}\n` +
      `not imported by first-party source: ${report.summary.notImportedByFirstParty.length ? report.summary.notImportedByFirstParty.join(', ') : 'none'}\n` +
      `lockfile committed: ${report.lockfile.committed} (lockfileVersion ${report.lockfile.lockfileVersion})\n`
  );
  for (const d of all.filter((x) => x.lifecycleScripts.length)) {
    process.stdout.write(`  lifecycle: ${d.name} -> ${d.lifecycleScripts.join('; ').slice(0, 200)}\n`);
  }
}

main();