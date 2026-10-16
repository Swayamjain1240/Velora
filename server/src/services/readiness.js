'use strict';

// Process readiness state (Part 10).
//
// A starting or draining process must tell the truth about itself: while it is
// shutting down it stops accepting new work, so a load balancer or orchestrator
// has to see it leave rotation BEFORE the listener closes. This module is the
// single flag the readiness route reads, so the health surface and the shutdown
// path can never disagree.

const startedAt = Date.now();
let draining = false;

function markDraining() {
  draining = true;
}

function isDraining() {
  return draining;
}

function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

// Test seam only: a suite that exercises readiness states must not leak the
// draining flag into a later test.
function __resetForTest() {
  draining = false;
}

module.exports = { markDraining, isDraining, uptimeSeconds, __resetForTest };
