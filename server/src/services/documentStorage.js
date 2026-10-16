'use strict';

// Provider-neutral private document storage.
//
// No external object-store provider is selected yet (control #22), so this
// module ships a local, encrypted filesystem provider behind a narrow interface
// (`put`/`get`/`stat`/`remove`). A future S3/Cloudinary/Firebase provider is
// dropped in by implementing the same interface and registering it below -
// callers never touch the filesystem directly.
//
// Design:
//   - objects are addressed by an OPAQUE UUID key. The key never contains a
//     filename or a user value, and is validated against a strict regex before
//     any path is built, so path traversal is structurally impossible;
//   - objects are encrypted at rest with a SEPARATE document key
//     (DOCUMENT_ENCRYPTION_KEY), using AES-256-GCM with a per-object IV and an
//     authenticated tag. Tampering is detected on read;
//   - the storage root sits outside the repository and outside any web root
//     (enforced in config/env.js);
//   - writes are exclusive (`wx`), files are 0600 and directories 0700 where
//     the platform supports it.
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getEnv } = require('../config/env');
const { errors } = require('./errors');

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAGIC = Buffer.from('VD1'); // Velora Document, version 1

function newStorageKey() {
  return crypto.randomUUID();
}

function storageRoot() {
  return path.resolve(getEnv().DOCUMENT_STORAGE_ROOT);
}

function objectsDir() {
  return path.join(storageRoot(), 'objects');
}

// Rejects any key that is not a bare UUID, so a caller can never escape the
// objects directory with `..`, a separator, an absolute path or a symlink name.
function objectPath(key) {
  if (!KEY_PATTERN.test(String(key))) {
    throw errors.internal('Invalid storage key.');
  }
  return path.join(objectsDir(), key.slice(0, 2), `${key}.bin`);
}

// The envelope key is passed EXPLICITLY: request handlers use the configured key
// through `encrypt`/`decrypt`, and the key-rotation command reads with the
// PREVIOUS key and writes with the CURRENT one (control #1).
function keyOf(keyBase64) {
  const key = Buffer.from(String(keyBase64 || ''), 'base64');
  if (key.length !== 32) throw errors.internal('Document storage key must be 32 bytes.');
  return key;
}

function encryptWith(keyBase64, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(keyBase64), iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, body]);
}

function decryptWith(keyBase64, envelope) {
  if (envelope.length < MAGIC.length + 12 + 16 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw errors.internal('Stored object is not a Velora document.');
  }
  const iv = envelope.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = envelope.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const body = envelope.subarray(MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(keyBase64), iv);
  decipher.setAuthTag(tag);
  // final() throws if the ciphertext or tag was tampered with.
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function encrypt(plaintext) {
  return encryptWith(getEnv().DOCUMENT_ENCRYPTION_KEY, plaintext);
}

function decrypt(envelope) {
  return decryptWith(getEnv().DOCUMENT_ENCRYPTION_KEY, envelope);
}

async function ensureRoot() {
  await fs.mkdir(objectsDir(), { recursive: true, mode: 0o700 });
}

const localProvider = {
  name: 'local-encrypted',
  async put(key, plaintext) {
    const target = objectPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const envelope = encrypt(plaintext);
    // 'wx' fails if the object already exists: exclusive write, no clobbering.
    const handle = await fs.open(target, 'wx', 0o600);
    try {
      await handle.writeFile(envelope);
    } finally {
      await handle.close();
    }
    return { key, storedBytes: envelope.length };
  },
  async get(key) {
    const target = objectPath(key);
    const info = await fs.lstat(target);
    // Never follow a symlink or read a non-regular file.
    if (!info.isFile() || info.isSymbolicLink()) {
      throw errors.internal('Stored object is not a regular file.');
    }
    const envelope = await fs.readFile(target);
    return decrypt(envelope);
  },
  async stat(key) {
    const target = objectPath(key);
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return { key, storedBytes: info.size };
  },
  async remove(key) {
    const target = objectPath(key);
    await fs.rm(target, { force: true });
  },
  // Reads one object with an EXPLICIT key, used only by the key-rotation
  // command: the dry run has to know whether the PREVIOUS key can still open an
  // object before anything is written.
  async getWithKey(key, keyBase64) {
    const target = objectPath(key);
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw errors.internal('Stored object is not a regular file.');
    }
    return decryptWith(keyBase64, await fs.readFile(target));
  },
  // Re-encrypts one object under `toKey`, reading it with `fromKey`. The new
  // envelope is written to a sibling temp file, verified by decrypting it back,
  // and only then renamed over the original, so an interrupted rotation leaves
  // the ORIGINAL object intact rather than a half-written one.
  async reseal(key, { fromKey, toKey }) {
    const target = objectPath(key);
    const plaintext = decryptWith(fromKey, await fs.readFile(target));
    const next = encryptWith(toKey, plaintext);
    const tmp = `${target}.reseal.tmp`;
    try {
      await fs.writeFile(tmp, next, { mode: 0o600 });
      const check = decryptWith(toKey, await fs.readFile(tmp));
      if (!check.equals(plaintext)) throw new Error('re-seal verification failed');
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return { key };
  },
  // Removes a temp file a killed rotation may have left behind. A leftover never
  // shadows a real object (it is not a `.bin`), but it would hold ciphertext that
  // no metadata row refers to.
  async sweepResealTempFiles() {
    const dir = objectsDir();
    let prefixes;
    try {
      prefixes = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const prefix of prefixes) {
      // eslint-disable-next-line no-await-in-loop
      const entries = await fs.readdir(path.join(dir, prefix)).catch(() => []);
      for (const entry of entries) {
        if (entry.endsWith('.reseal.tmp')) {
          // eslint-disable-next-line no-await-in-loop
          await fs.rm(path.join(dir, prefix, entry), { force: true });
        }
      }
    }
  },
  // Lists stored object keys (used only by the reconciliation command).
  async listKeys() {
    const dir = objectsDir();
    let prefixes;
    try {
      prefixes = await fs.readdir(dir);
    } catch {
      return [];
    }
    const keys = [];
    for (const prefix of prefixes) {
      // eslint-disable-next-line no-await-in-loop
      const entries = await fs.readdir(path.join(dir, prefix)).catch(() => []);
      for (const entry of entries) {
        if (entry.endsWith('.bin')) keys.push(entry.slice(0, -4));
      }
    }
    return keys;
  },
};

// Registry: exactly one active provider. Tests swap it to simulate a storage
// failure; production uses the local encrypted provider.
let activeProvider = localProvider;

function provider() {
  return activeProvider;
}

async function put(key, plaintext) {
  return activeProvider.put(key, plaintext);
}
async function get(key) {
  return activeProvider.get(key);
}
async function stat(key) {
  return activeProvider.stat(key);
}
async function remove(key) {
  return activeProvider.remove(key);
}
async function listKeys() {
  return activeProvider.listKeys ? activeProvider.listKeys() : [];
}

// Reads one object with an explicit key (never a request path). Any future
// provider must support it for a rotation to be verifiable.
async function getWithKey(key, keyBase64) {
  if (!activeProvider.getWithKey) throw errors.internal('This storage provider cannot read with an explicit key.');
  return activeProvider.getWithKey(key, keyBase64);
}

// Key rotation (Part 10, control #1). Every stored object is re-encrypted from
// the PREVIOUS document key to the CURRENT one, one object at a time. A provider
// that cannot re-encrypt can still satisfy this by reading and rewriting, so the
// capability is required of any future provider rather than optional.
async function resealAll({ fromKey, toKey }) {
  if (!activeProvider.reseal) throw errors.internal('This storage provider cannot re-seal objects.');
  await activeProvider.sweepResealTempFiles();
  const keys = await listKeys();
  const result = { scanned: keys.length, resealed: 0, failed: [] };
  for (const key of keys) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await activeProvider.reseal(key, { fromKey, toKey });
      result.resealed += 1;
    } catch (err) {
      result.failed.push({ key, reason: 'reseal-failed' });
    }
  }
  return result;
}

// Readiness probe (Part 10). It reports WHETHER the configured storage is
// usable, never WHERE it is: the root path is configuration and a readiness
// payload is unauthenticated, so it must not leak it (controls #9, #15).
async function storageHealth() {
  try {
    const info = await fs.stat(storageRoot());
    if (!info.isDirectory()) return { ok: false, detail: 'not_a_directory' };
    await fs.access(storageRoot(), fsConstants.W_OK | fsConstants.R_OK);
    return { ok: true, detail: 'ok' };
  } catch (err) {
    const code = err && err.code;
    return { ok: false, detail: code === 'ENOENT' ? 'missing' : 'unusable' };
  }
}

// Test-only seam: swap the provider so storage failures and tampering can be
// exercised deterministically. Never used by request handlers.
function __setProviderForTest(nextProvider) {
  activeProvider = nextProvider || localProvider;
}
function __resetProvider() {
  activeProvider = localProvider;
}

module.exports = {
  name: 'documentStorage',
  newStorageKey,
  storageRoot,
  objectPath,
  ensureRoot,
  put,
  get,
  stat,
  remove,
  listKeys,
  getWithKey,
  resealAll,
  provider,
  storageHealth,
  __setProviderForTest,
  __resetProvider,
};
