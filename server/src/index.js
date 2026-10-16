'use strict';

// Server entrypoint (Part 10): validate configuration, connect with a bounded
// pool, listen, and shut down gracefully. Every startup failure is fatal and
// safe to read - the process never runs on a bad or partial configuration
// (controls #2, #9, #12).

const { loadEnv, getEnv } = require('./config/env');
const { connectDb, disconnectDb } = require('./config/db');
const { buildApp } = require('./app');
const { assertProviderConfiguration } = require('./providers/extractionProvider');
const { getLogger } = require('./services/logger');
const readiness = require('./services/readiness');

let shuttingDown = false;

async function main() {
  let env;
  try {
    loadEnv();
    env = getEnv();
  } catch (err) {
    // Before the environment is valid there is no configured logger, so this is
    // the one place that writes straight to stderr. The message names the
    // offending FIELDS only (control #9).
    process.stderr.write(`[startup] ${err.message}\n`);
    process.exit(1);
  }

  const log = getLogger();

  // Provider gate (controls #2, #22): the selected extraction provider is
  // resolved and ITS configuration validated here, so an unknown provider name
  // or a missing key fails at boot rather than on the first clinical request.
  let provider;
  try {
    provider = assertProviderConfiguration();
  } catch (err) {
    log.error('startup.provider_invalid', { err });
    process.exit(1);
  }

  try {
    await connectDb(env.MONGODB_URI, log);
  } catch (err) {
    // The driver message can carry a host name, so only the safe summary is
    // logged. Nothing about credentials or topology reaches the line.
    log.error('startup.database_unreachable', { err, code: err && err.code });
    process.exit(1);
  }

  const app = buildApp();
  const server = app.listen(env.PORT);

  // Bounded request life: a client that opens a connection and dribbles a body
  // cannot hold a worker indefinitely (control #8). headersTimeout must stay
  // above keepAliveTimeout, which Node enforces.
  server.requestTimeout = env.REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(env.REQUEST_TIMEOUT_MS, 60_000);
  server.keepAliveTimeout = 5_000;

  server.on('listening', () => {
    log.info('server.listening', {
      port: env.PORT,
      environment: env.NODE_ENV,
      logLevel: env.LOG_LEVEL,
      trustProxy: env.TRUST_PROXY,
      proxyHops: env.TRUST_PROXY ? env.PROXY_HOPS : 0,
      extractionProvider: provider.name,
      extractionNetwork: Boolean(provider.network),
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
      jsonBodyLimitKb: env.JSON_BODY_LIMIT_KB,
      mongoPoolMax: env.MONGO_MAX_POOL_SIZE,
    });
    if (!env.TRUST_PROXY) {
      // Alert-worthy, not fatal: behind a reverse proxy this deployment would
      // key its rate limits and audit trail on the proxy address instead of the
      // caller, which is a configuration mistake worth one loud line.
      log.warn('server.proxy_not_trusted', {
        note: 'TRUST_PROXY is false: req.ip is the socket address. Set TRUST_PROXY=true and PROXY_HOPS only when every request arrives through a trusted proxy.',
      });
    }
  });

  server.on('error', (err) => {
    log.error('server.listen_failed', { err, code: err && err.code });
    process.exit(1);
  });

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop advertising readiness FIRST, so a load balancer drains this process
    // before the listener closes and in-flight requests keep their connections.
    readiness.markDraining();
    log.info('shutdown.begin', { reason, graceMs: env.SHUTDOWN_GRACE_MS });

    const force = setTimeout(() => {
      log.error('shutdown.forced', {
        graceMs: env.SHUTDOWN_GRACE_MS,
        note: 'in-flight requests did not finish inside the grace window',
      });
      process.exit(1);
    }, env.SHUTDOWN_GRACE_MS);
    force.unref();

    server.close(async () => {
      clearTimeout(force);
      try {
        await disconnectDb();
        log.info('shutdown.complete', { reason });
        process.exit(0);
      } catch (err) {
        log.error('shutdown.database_close_failed', { err });
        process.exit(1);
      }
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // An uncaught exception leaves the process in an unknown state: drain and exit
  // non-zero rather than keep serving requests from it. An unhandled rejection
  // is recorded and the process continues, because the request path itself
  // already converts every handler error into a safe response.
  process.on('uncaughtException', (err) => {
    log.error('process.uncaught_exception', { err });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('process.unhandled_rejection', { err: reason });
  });
}

main();
