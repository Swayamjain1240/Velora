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
    // Part 4: private encrypted document storage. The root MUST live outside the
    // repository and outside any web root, and the document key is a SEPARATE
    // secret from MFA_ENCRYPTION_KEY (control #1, #2, #15).
    DOCUMENT_STORAGE_ROOT: z.string().min(1, 'DOCUMENT_STORAGE_ROOT is required'),
    DOCUMENT_ENCRYPTION_KEY: z
      .string()
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'DOCUMENT_ENCRYPTION_KEY must be base64 encoding exactly 32 bytes'),
    // Hard upload ceiling (10 MiB) and the bounded parser worker's limits.
    DOCUMENT_MAX_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
    DOCUMENT_PARSER_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(3000),
    DOCUMENT_PARSER_MEMORY_MB: z.coerce.number().int().min(16).max(1024).default(128),
    DOCUMENT_PARSER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    DOCUMENT_PARSER_QUEUE_MAX: z.coerce.number().int().min(0).max(64).default(8),
    // Part 6: AI-assisted extraction. NO provider is selected by default
    // (`none`), and nothing here is required unless a provider is enabled -
    // controls #2 and #22: shipping the product must never require an AI key.
    // `EXTRACTION_PROVIDER` is only shape-checked here; the provider REGISTRY
    // (src/providers/index.js) decides which names exist and fails closed at
    // startup for an unknown one, so this file never has to know providers.
    EXTRACTION_PROVIDER: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'EXTRACTION_PROVIDER must be a short lowercase slug')
      .default('none'),
    // Server-only. Never prefixed with VITE_ and never sent to the browser.
    EXTRACTION_API_KEY: z.string().min(1).max(4096).optional(),
    EXTRACTION_MODEL: z.string().min(1).max(120).optional(),
    // Bounded job I/O: the model receives at most this much document text and
    // may return at most this many bytes (control #8).
    EXTRACTION_MAX_INPUT_CHARS: z.coerce.number().int().min(1000).max(500_000).default(60_000),
    EXTRACTION_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(2 * 1024 * 1024).default(256 * 1024),
    EXTRACTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
    EXTRACTION_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    EXTRACTION_JOBS_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
    EXTRACTION_RUNS_PER_DAY: z.coerce.number().int().min(1).max(10_000).default(200),
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
        path: ['CLIENT_ORIGIN'],
        message: 'CLIENT_ORIGIN must use https in production',
      });
    }
    // Storage-root/key pairing: a root without its own key would store
    // plaintext, and the root must never sit inside the repo or a web root.
    const repoRoot = path.resolve(__dirname, '../../..');
    if (value.DOCUMENT_STORAGE_ROOT) {
      if (!path.isAbsolute(value.DOCUMENT_STORAGE_ROOT)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DOCUMENT_STORAGE_ROOT'],
          message: 'DOCUMENT_STORAGE_ROOT must be an absolute path',
        });
      } else {
        const root = path.resolve(value.DOCUMENT_STORAGE_ROOT);
        const rel = path.relative(repoRoot, root);
        const insideRepo = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        if (insideRepo) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['DOCUMENT_STORAGE_ROOT'],
            message: 'DOCUMENT_STORAGE_ROOT must be outside the repository',
          });
        }
      }
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
