'use strict';

const { errors } = require('../services/errors');
const { getEnv } = require('../config/env');

// Reads a raw request body into memory with a HARD cap (control #8). An
// unlimited body can never be buffered: the moment the running total exceeds
// the limit the stream is destroyed and a 413 is returned. This middleware must
// run AFTER authorization, so an unauthorized caller's bytes are never read.
function boundedBody() {
  return (req, res, next) => {
    const maxBytes = getEnv().DOCUMENT_MAX_BYTES;

    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Drain the socket so the client sees the 413 rather than a reset.
      req.resume();
      return next(errors.payloadTooLarge('The file exceeds the size limit.'));
    }

    const chunks = [];
    let received = 0;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) return next(err);
      req.fileBytes = Buffer.concat(chunks);
      return next();
    };

    req.on('data', (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        chunks.length = 0;
        req.destroy();
        finish(errors.payloadTooLarge('The file exceeds the size limit.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish());
    req.on('error', () => finish(errors.badRequest('The upload could not be read.')));
  };
}

module.exports = { boundedBody };
