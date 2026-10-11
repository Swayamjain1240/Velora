'use strict';

const { mongoRateLimit } = require('./rateLimit');

// Part 4: document limits are deliberately SEPARATE from episode limits, and
// upload is limited far more tightly than download/read (control #8). Sharing
// one bucket would let a download storm exhaust a caller's upload allowance.
const uploadLimit = mongoRateLimit({
  keyPrefix: 'document-upload',
  limit: 20,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const downloadLimit = mongoRateLimit({
  keyPrefix: 'document-download',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const readLimit = mongoRateLimit({
  keyPrefix: 'document-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

module.exports = { uploadLimit, downloadLimit, readLimit };
