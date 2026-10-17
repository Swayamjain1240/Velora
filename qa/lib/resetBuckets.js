'use strict';

// Clears the durable Mongo-backed rate-limit buckets in the DISPOSABLE test
// database between probe/perf phases. This is test hygiene on isolated
// infrastructure only - the limiter code and its thresholds are never changed,
// and limiter behaviour itself is asserted live by qa/security-probes.js SEC-2
// (429 observed under credential stuffing).
const mongoose = require('mongoose');
const { qaEnv } = require('./qaEnv');

async function resetBuckets() {
  Object.assign(process.env, {
    PORT: qaEnv.PORT,
    MONGODB_URI: qaEnv.MONGODB_URI,
    MONGODB_TEST_URI: qaEnv.MONGODB_TEST_URI,
    NODE_ENV: 'test',
    SESSION_PEPPER: qaEnv.SESSION_PEPPER,
    MFA_ENCRYPTION_KEY: qaEnv.MFA_ENCRYPTION_KEY,
    DOCUMENT_STORAGE_ROOT: qaEnv.DOCUMENT_STORAGE_ROOT,
    DOCUMENT_ENCRYPTION_KEY: qaEnv.DOCUMENT_ENCRYPTION_KEY,
    PRIVACY_EXPORT_ENCRYPTION_KEY: qaEnv.PRIVACY_EXPORT_ENCRYPTION_KEY,
    CLIENT_ORIGIN: qaEnv.CLIENT_ORIGIN,
  });
  const { loadEnv } = require('../../server/src/config/env');
  loadEnv();
  await mongoose.connect(qaEnv.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const before = await mongoose.connection.db.collection('ratelimitbuckets').countDocuments();
  // Wipe whole collection: buckets only exist to throttle this disposable DB.
  await mongoose.connection.db.collection('ratelimitbuckets').deleteMany({});
  await mongoose.connection.close();
  return before;
}

module.exports = { resetBuckets };