'use strict';

// Multi-document atomicity helper. MongoDB only allows transactions on a
// replica set or mongos; the integration harness asserts that and fails closed,
// so a missing transaction is a test failure rather than silent partial writes.
const mongoose = require('mongoose');

async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { withTransaction };
