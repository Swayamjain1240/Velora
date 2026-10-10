'use strict';

// Small crypto helpers: peppered token hashing and AES-256-GCM secret box.
// SESSION_PEPPER and MFA_ENCRYPTION_KEY are validated at startup (control #1,
// #2) and never leave the server process.
const crypto = require('node:crypto');
const { getEnv } = require('../config/env');

function hmac(value) {
  return crypto
    .createHmac('sha256', getEnv().SESSION_PEPPER)
    .update(value)
    .digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Encrypts small secrets (TOTP seeds) at rest with AES-256-GCM.
function sealSecret(plaintext) {
  const key = Buffer.from(getEnv().MFA_ENCRYPTION_KEY, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function openSecret(sealed) {
  const [ivB64, tagB64, dataB64] = sealed.split('.');
  const key = Buffer.from(getEnv().MFA_ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { hmac, randomToken, sealSecret, openSecret };
