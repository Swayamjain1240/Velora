'use strict';

// Server entrypoint: fail closed on invalid environment (control #2), connect
// to MongoDB, then listen. Startup never proceeds with a bad configuration.
const { loadEnv, getEnv } = require('./config/env');
const { connectDb } = require('./config/db');
const { buildApp } = require('./app');
const { assertProviderConfiguration } = require('./providers/extractionProvider');

async function main() {
  try {
    loadEnv();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[startup] ${err.message}`);
    process.exit(1);
  }

  // Part 6 provider gate (control #2, #22): the selected extraction provider is
  // resolved and ITS environment validated once, here. An unknown provider name
  // or a missing provider key fails closed at boot instead of on the first
  // clinical request. Only the provider NAME and model are logged - never a key.
  try {
    const provider = assertProviderConfiguration();
    if (provider.name !== 'none') {
      // eslint-disable-next-line no-console
      console.log(
        `[startup] extraction provider: ${provider.name}` +
          `${provider.network ? ' (external network calls enabled)' : ' (local)'}`
      );
    }
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
