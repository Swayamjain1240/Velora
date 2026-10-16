'use strict';

// Small crypto helpers: peppered token hashing and AES-256-GCM secret box.
// SESSION_PEPPER and MFA_ENCRYPTION_KEY are validated at startup (control #1,
// #2) and never leave the server process.
//
// Every seal/open takes its key EXPLICITLY in the `*WithKey` form. The
// convenience wrappers use the configured key, and the key-rotation command uses
// the explicit form to read with the PREVIOUS key and write with the CURRENT one
// - the one place a process legitimately holds two keys at once (control #1).
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

function keyOf(keyBase64) {
  const key = Buffer.from(String(keyBase64 || ''), 'base64');
  // A wrong-length key would make createCipheriv throw a message that names the
  // length; a caller-visible check keeps the failure safe and explicit.
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes.');
  return key;
}

// Encrypts small secrets (TOTP seeds) at rest with AES-256-GCM.
function sealWithKey(keyBase64, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(keyBase64), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function openWithKey(keyBase64, sealed) {
  const [ivB64, tagB64, dataB64] = String(sealed).split('.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyOf(keyBase64),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function sealSecret(plaintext) {
  return sealWithKey(getEnv().MFA_ENCRYPTION_KEY, plaintext);
}

function openSecret(sealed) {
  return openWithKey(getEnv().MFA_ENCRYPTION_KEY, sealed);
}

module.exports = {
  hmac,
  randomToken,
  sealWithKey,
  openWithKey,
  sealSecret,
  openSecret,
};
