'use strict';

// Argon2id password hashing (controls #4, #17). Plaintext passwords never
// reach storage, logs or responses.
const argon2 = require('@node-rs/argon2');

const HASH_OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
};

async function hashPassword(plaintext) {
  return argon2.hash(plaintext, HASH_OPTIONS);
}

async function verifyPassword(hash, plaintext) {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
