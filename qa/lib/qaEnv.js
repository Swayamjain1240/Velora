'use strict';

// The isolated QA environment for every scripted probe in qa/.
// Pointing ONLY at local disposable infrastructure:
//   - test MongoDB replica set on 127.0.0.1:27019 (npm run mongo:test-rs -w server)
//   - database `velora_test`, wiped/seeded with synthetic identities
//   - API spawned on 127.0.0.1:4101 with NODE_ENV=test
// Nothing here ever contains or prints a real credential: all secret-shaped
// values are the same throwaway literals CI already publishes in .github/workflows/ci.yml.
const path = require('node:path');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.QA_API_PORT || 4101);
const BASE = `http://127.0.0.1:${PORT}`;
const MONGO_URI = 'mongodb://127.0.0.1:27019/velora_test?replicaSet=rs0';

const qaEnv = {
  NODE_ENV: 'test',
  PORT: String(PORT),
  MONGODB_URI: MONGO_URI,
  MONGODB_TEST_URI: MONGO_URI,
  CLIENT_ORIGIN: 'http://localhost:5173',
  SESSION_PEPPER: 'ci_test_session_pepper_0123456789',
  MFA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  SESSION_TTL_HOURS: '12',
  // Outside the repo: the env validator rejects in-repo storage roots.
  DOCUMENT_STORAGE_ROOT: path.join(os.tmpdir(), 'velora-qa-documents'),
  DOCUMENT_ENCRYPTION_KEY: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=',
  PRIVACY_EXPORT_ENCRYPTION_KEY: 'Cw0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=',
  EXTRACTION_PROVIDER: process.env.QA_EXTRACTION_PROVIDER || 'fake',
  LOG_LEVEL: 'warn',
  // Test-stacked parser limits stay modest so a probe can never wed the box.
  DOCUMENT_PARSER_TIMEOUT_MS: '15000',
  DOCUMENT_PARSER_MEMORY_MB: '256',
  ...process.env.QA_EXTRA_ENV ? JSON.parse(process.env.QA_EXTRA_ENV) : {},
};

module.exports = { qaEnv, BASE, PORT, MONGO_URI, REPO };