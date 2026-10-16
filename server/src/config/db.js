'use strict';

const mongoose = require('mongoose');
const { getEnv } = require('./env');

// Bounded MongoDB connection (Part 10). Every limit comes from the validated
// environment, so a deployment cannot inherit an unbounded pool and one slow
// dependency cannot hold the whole process open: selection, connect and socket
// timeouts all fail a request instead of queueing forever (controls #8, #12).
async function connectDb(uri, logger) {
  const env = getEnv();
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    connectTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    socketTimeoutMS: env.REQUEST_TIMEOUT_MS,
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    minPoolSize: env.MONGO_MIN_POOL_SIZE,
    maxIdleTimeMS: 60_000,
  });
  if (logger) logger.info('database.connected', { poolSize: env.MONGO_MAX_POOL_SIZE });
  return mongoose.connection;
}

// Readiness needs a real round trip, not just a "connected" flag: a connection
// can be technically open while the server refuses commands.
async function pingDb() {
  const state = mongoose.connection.readyState;
  if (state !== 1) return { ok: false, detail: 'not_connected' };
  try {
    await mongoose.connection.db.admin().command({ ping: 1 });
    return { ok: true, detail: 'ok' };
  } catch {
    // Never surface driver text: it can carry host names and credentials.
    return { ok: false, detail: 'unreachable' };
  }
}

async function disconnectDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, disconnectDb, pingDb };
