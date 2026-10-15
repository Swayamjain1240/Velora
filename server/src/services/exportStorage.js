'use strict';

// Encrypted storage for GENERATED privacy-request exports (Part 9).
//
// Deliberately separate from document storage: it uses its own key
// (PRIVACY_EXPORT_ENCRYPTION_KEY), its own directory and its own magic header,
// so an export artifact can never be confused with a discharge document and a
// document key cannot open an export (control #1, #15).
//
// If the export key is not configured the store FAILS CLOSED: an export request
// is refused rather than the artifact being written in the clear.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getEnv } = require('../config/env');
const { errors } = require('./errors');

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAGIC = Buffer.from('VX1'); // Velora eXport, version 1

function newStorageKey() {
  return crypto.randomUUID();
}

function exportsDir() {
  return path.join(path.resolve(getEnv().DOCUMENT_STORAGE_ROOT), 'exports');
}

function objectPath(key) {
  if (!KEY_PATTERN.test(String(key))) throw errors.internal('Invalid export storage key.');
  return path.join(exportsDir(), key.slice(0, 2), `${key}.bin`);
}

function exportKey() {
  const value = getEnv().PRIVACY_EXPORT_ENCRYPTION_KEY;
  if (!value) {
    throw errors.internal('Export storage is not configured, so an export cannot be generated.');
  }
  return Buffer.from(value, 'base64');
}

function encrypt(plaintext) {
  const key = exportKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, body]);
}

function decrypt(envelope) {
  if (envelope.length < MAGIC.length + 28 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw errors.internal('Stored export is not a Velora export artifact.');
  }
  const iv = envelope.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = envelope.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const body = envelope.subarray(MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', exportKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

async function put(key, plaintext) {
  const target = objectPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const envelope = encrypt(plaintext);
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(envelope);
  } finally {
    await handle.close();
  }
  return { key, storedBytes: envelope.length };
}

async function get(key) {
  const target = objectPath(key);
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw errors.internal('Stored export is not a regular file.');
  return decrypt(await fs.readFile(target));
}

async function remove(key) {
  await fs.rm(objectPath(key), { force: true });
}

module.exports = { newStorageKey, objectPath, exportsDir, put, get, remove };
