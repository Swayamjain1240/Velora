#!/usr/bin/env node
'use strict';

// QA inventory (read-only). Prints the surface a QA pass has to cover, derived
// from the CODE rather than from a document: every registered API route with its
// method, its path and whether it is public or behind authentication, plus every
// Mongoose model with its index count and uniqueness/partial/TTL flags, plus a
// dependency-usage check across both workspaces.
//
// It connects to nothing and writes nothing: it exists so a QA report can quote
// a reproducible inventory instead of trusting a README.
//
//   node server/scripts/qa-inventory.js
//   node server/scripts/qa-inventory.js --json
const fs = require('node:fs');
const path = require('node:path');

// Public by design: the two probes (which disclose nothing) plus the routes a
// signed-out browser must be able to reach - sign in, the MFA steps that run on
// a password-accepted-but-pending session, password recovery, invitation
// acceptance and the single-use-token caregiver/patient activation endpoints.
// Everything else must require authentication, and the QA contract test proves it
// with a live anonymous request rather than by reading this list.
const PUBLIC_ROUTE_PATTERNS = [
  /^\/api\/(health|ready)$/,
  /^\/api\/auth\/(login|logout|status|accept-invitation|password\/forgot|password\/reset)$/,
  /^\/api\/auth\/mfa\/(verify|enroll\/setup|enroll\/verify)$/,
  /^\/api\/access\/(caregiver-invitation|patient-activation)$/,
];

function isPublic(routePath) {
  return PUBLIC_ROUTE_PATTERNS.some((pattern) => pattern.test(routePath));
}

// Express 4 encodes a mount path as a regexp; recover the literal prefix.
function literalFromRegExp(source) {
  return source
    .replace(/^\^/, '')
    .replace(/\\\//g, '/')
    .replace(/\/\?\(\?=\/\|\$\)$/, '')
    .replace(/\/\?\$$/, '')
    .replace(/\(\?=\/\|\$\)$/, '')
    .replace(/\$$/, '')
    .replace(/\$$/, '');
}

function routePathFrom(regexp) {
  const literal = literalFromRegExp(regexp.source);
  if (literal === '' || literal === '/') return '';
  return literal.replace(/\/$/, '');
}

function collectRoutes(stack, prefix = '') {
  const routes = [];
  for (const layer of stack) {
    if (layer.route) {
      const routePath = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path: routePath || '/', public: isPublic(routePath || '/') });
      }
      continue;
    }
    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const nested = routePathFrom(layer.regexp);
      routes.push(...collectRoutes(layer.handle.stack, `${prefix}${nested}`));
    }
  }
  return routes;
}

function modelInventory() {
  const modelsDir = path.join(__dirname, '..', 'src', 'models');
  const files = fs.readdirSync(modelsDir).filter((name) => name.endsWith('.js'));
  // eslint-disable-next-line global-require
  const mongoose = require('mongoose');
  for (const file of files) {
    // eslint-disable-next-line global-require
    require(path.join(modelsDir, file));
  }
  return Object.values(mongoose.models)
    .map((model) => {
      const indexes = model.schema.indexes();
      return {
        model: model.modelName,
        indexes: indexes.length,
        unique: indexes.filter(([, options]) => options && options.unique).length,
        partial: indexes.filter(([, options]) => options && options.partialFilterExpression).length,
        ttl: indexes.filter(([, options]) => options && options.expireAfterSeconds !== undefined).length,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

function workspaceDependencies(workspaceDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'));
  const names = Object.keys(pkg.dependencies || {});
  const devNames = Object.keys(pkg.devDependencies || {});
  const searchRoots = [path.join(workspaceDir, 'src'), path.join(workspaceDir, 'tests'), path.join(workspaceDir, 'scripts')]
    .filter((dir) => fs.existsSync(dir));
  // Tooling packages are used by the workspace ROOT config files (vite, eslint,
  // vitest), not by src, so those files belong in the scan.
  const files = fs
    .readdirSync(workspaceDir)
    .filter((name) => /\.(c?js|m?js)$/.test(name))
    .map((name) => path.join(workspaceDir, name));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(c?js|m?js|jsx)$/.test(entry.name)) files.push(full);
    }
  };
  searchRoots.forEach(walk);
  const sources = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  // Tooling is also referenced by CONFIGURATION rather than by import: the ESLint
  // CLI, the `plugins: ['react']` list, the npm script that invokes them and
  // vitest's `environment: 'jsdom'` name their package without importing it.
  const configSources = files
    .filter((file) => /\.(c?js|m?js)$/.test(file) && !file.includes(`${path.sep}src${path.sep}`))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .concat([
      JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8')),
    ])
    .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    .join('\n');
  const used = (name) => {
    // `from 'pkg'`, `require('pkg')`, a subpath, OR a side-effect import
    // (`import 'pkg'`, `import 'pkg/vitest'`) which carries no `from` keyword.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(from|require\\()\\s*['"\`]${escaped}(/[^'"\`]*)?['"\`]` +
        `|import\\s*['"\`]${escaped}(/[^'"\`]*)?['"\`]`
    );
    if (pattern.test(sources)) return true;
    const quoted = new RegExp(`['"]${escaped}['"]`);
    if (quoted.test(configSources)) return true;
    // eslint-plugin-X is named in .eslintrc.cjs as just `X` in the plugins list.
    if (name.startsWith('eslint-plugin-')) {
      const short = name.slice('eslint-plugin-'.length);
      return new RegExp(`['"]${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(configSources);
    }
    return false;
  };
  return {
    unusedRuntime: names.filter((name) => !used(name)),
    unusedDev: devNames.filter((name) => !used(name)),
  };
}

function main() {
  const root = path.resolve(__dirname, '..', '..');
  // eslint-disable-next-line global-require
  const { loadEnv } = require('../src/config/env');
  loadEnv();
  // eslint-disable-next-line global-require
  const { buildApp } = require('../src/app');

  const app = buildApp();
  const routes = collectRoutes(app._router.stack).sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
  const models = modelInventory();
  const report = {
    routes: {
      total: routes.length,
      public: routes.filter((route) => route.public).length,
      authenticated: routes.filter((route) => !route.public).length,
      list: routes,
    },
    models: {
      total: models.length,
      indexes: models.reduce((sum, model) => sum + model.indexes, 0),
      list: models,
    },
    dependencies: {
      server: workspaceDependencies(path.join(root, 'server')),
      client: workspaceDependencies(path.join(root, 'client')),
    },
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Routes: ${report.routes.total} total, ${report.routes.public} public, ${report.routes.authenticated} authenticated\n`);
  for (const route of routes) {
    process.stdout.write(`  ${route.public ? 'public ' : 'private'} ${route.method.padEnd(7)} ${route.path}\n`);
  }
  process.stdout.write(`\nModels: ${report.models.total}, indexes declared: ${report.models.indexes}\n`);
  for (const model of models) {
    process.stdout.write(
      `  ${model.model.padEnd(26)} indexes=${model.indexes} unique=${model.unique} partial=${model.partial} ttl=${model.ttl}\n`
    );
  }
  process.stdout.write(`\nUnused runtime deps (server): ${JSON.stringify(report.dependencies.server.unusedRuntime)}\n`);
  process.stdout.write(`Unused dev deps (server):     ${JSON.stringify(report.dependencies.server.unusedDev)}\n`);
  process.stdout.write(`Unused runtime deps (client): ${JSON.stringify(report.dependencies.client.unusedRuntime)}\n`);
  process.stdout.write(`Unused dev deps (client):     ${JSON.stringify(report.dependencies.client.unusedDev)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`qa-inventory failed: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { collectRoutes, isPublic };
