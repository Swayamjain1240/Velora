'use strict';

// Server entrypoint: fail closed on invalid environment (control #2), connect
// to MongoDB, then listen. Startup never proceeds with a bad configuration.
const { loadEnv, getEnv } = require('./config/env');
const { connectDb } = require('./config/db');
const { buildApp } = require('./app');

async function main() {
  try {
    loadEnv();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[startup] ${err.message}`);
    process.exit(1);
  }

  const env = getEnv();
  try {
    await connectDb(env.MONGODB_URI);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[startup] could not connect to MongoDB: ${err.message}`);
    process.exit(1);
  }

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Velora API listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
