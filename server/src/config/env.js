'use strict';

// Environment boundary (Security-2): every required server variable is
// validated once at startup. Missing or malformed values fail closed with a
// safe message that never echoes secret material.

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const dotenv = require('dotenv');

function loadDotenvFiles() {
  const candidates = [
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '../../.env'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
      return;
    }
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    MONGODB_TEST_URI: z.string().min(1).optional(),
    CLIENT_ORIGIN: z.string().url('CLIENT_ORIGIN must be an exact origin URL'),
    SESSION_PEPPER: z
      .string()
      .min(16, 'SESSION_PEPPER must be at least 16 characters'),
    MFA_ENCRYPTION_KEY: z
      .string()
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'MFA_ENCRYPTION_KEY must be base64 encoding exactly 32 bytes'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((value, ctx) => {
    if (
      value.NODE_ENV === 'production' &&
      !value.CLIENT_ORIGIN.startsWith('https://')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CLIENT_ORIGIN must use https in production',
      });
    }
  });

let cached = null;

function loadEnv(overrides) {
  loadDotenvFiles();
  // Many shells/CI systems export variables as empty strings. Treat an empty
  // value as absent so a required field reports as missing (fail closed with a
  // clear message) instead of coercing '' to 0 and failing a range check.
  const source = {};
  for (const [key, value] of Object.entries(overrides || process.env)) {
    if (value !== '') source[key] = value;
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ');
    // Fail closed with a safe message (no values echoed).
    throw new Error(
      `Invalid server environment configuration. Check: ${fields}. See .env.example.`
    );
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

function getEnv() {
  if (!cached) return loadEnv();
  return cached;
}

function resetEnvCache() {
  cached = null;
}

module.exports = { loadEnv, getEnv, resetEnvCache };
