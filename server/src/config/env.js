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
    // Part 10: bounded runtime budgets. A request body, a request's wall-clock
    // life and the connection pool are all capped from here, so a deployment can
    // never inherit an unbounded default and one client cannot exhaust the
    // process (controls #8, #12).
    JSON_BODY_LIMIT_KB: z.coerce.number().int().min(4).max(1024).default(32),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
    // How long a graceful shutdown may drain before it is forced.
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
    MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    MONGO_MIN_POOL_SIZE: z.coerce.number().int().min(0).max(50).default(0),
    MONGO_SERVER_SELECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(5000),
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
    // Only a deployment that actually sits behind a trusted reverse proxy may
    // turn this on, and it must state how many hops to trust: trusting an
    // arbitrary X-Forwarded-For chain would let a caller forge the address the
    // rate limiters and the audit trail key on (controls #8, #12). This value is
    // the ONLY thing that decides `trust proxy` in app.js.
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),
    // Part 7: the scheduling anchor used ONLY when an episode carries no IANA
    // zone (episodes always store one, so this is a defensive default). It is
    // validated with Intl at startup, so a typo fails closed instead of silently
    // scheduling a patient in the wrong offset (control #2).
    SCHEDULE_FALLBACK_TIMEZONE: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .default('UTC')
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'SCHEDULE_FALLBACK_TIMEZONE must be a valid IANA timezone'),
    // Part 8: in-app reminders ship first, so the default provider is `in_app`
    // and it needs no key. Email/SMS/WhatsApp/push need their own disclosure and
    // a real credential before they may be named here (control #22); the
    // provider REGISTRY (src/providers/notificationProvider.js) is what actually
    // refuses an unknown or unauthorized name, so this field only bounds shape.
    REMINDER_PROVIDER: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'REMINDER_PROVIDER must be a short lowercase slug')
      .default('in_app'),
    // Server-only, optional: only a real (disclosed) provider would use it.
    REMINDER_API_KEY: z.string().min(1).max(4096).optional(),
    // Bounded retries for one delivery attempt chain (control #8).
    REMINDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    // Part 9: generated privacy-request EXPORTS are encrypted at rest with a key
    // that is SEPARATE from the document and MFA keys (control #1, #15). It is
    // optional so the shipped product still starts without it, but the export
    // service FAILS CLOSED when it is absent rather than storing plaintext - a
    // deployment that wants exports must configure it (control #2).
    PRIVACY_EXPORT_ENCRYPTION_KEY: z
      .string()
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'PRIVACY_EXPORT_ENCRYPTION_KEY must be base64 encoding exactly 32 bytes')
      .optional(),
    // How long a generated export artifact may be downloaded (control #8/#11).
    EXPORT_ARTIFACT_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    // A freshly authorized download link is short-lived on purpose.
    EXPORT_DOWNLOAD_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
    // Hard ceiling on one generated export, so a request cannot produce an
    // unbounded artifact (control #8).
    EXPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(5 * 1024 * 1024),
    // A retention apply is bounded so one run cannot touch an unbounded set.
    RETENTION_APPLY_MAX_ITEMS: z.coerce.number().int().min(1).max(100000).default(5000),
    // Audit search window bound, so a query cannot scan the whole history at once.
    AUDIT_SEARCH_MAX_RANGE_DAYS: z.coerce.number().int().min(1).max(3650).default(366),
  })
  .superRefine((value, ctx) => {
    const issue = (path, message) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    // An allowed origin is an ORIGIN, not a URL: a path, query or trailing slash
    // in the allowlist would silently never match a real browser Origin, or
    // match more than intended.
    try {
      const parsed = new URL(value.CLIENT_ORIGIN);
      if (parsed.origin !== value.CLIENT_ORIGIN) {
        issue(
          'CLIENT_ORIGIN',
          'CLIENT_ORIGIN must be a bare origin such as https://app.example.com (no path, query, trailing slash or fragment)'
        );
      }
    } catch {
      issue('CLIENT_ORIGIN', 'CLIENT_ORIGIN must be an absolute origin URL');
    }

    if (value.MONGO_MIN_POOL_SIZE > value.MONGO_MAX_POOL_SIZE) {
      issue('MONGO_MIN_POOL_SIZE', 'MONGO_MIN_POOL_SIZE must not exceed MONGO_MAX_POOL_SIZE');
    }

    if (value.NODE_ENV === 'production') {
      if (!value.CLIENT_ORIGIN.startsWith('https://')) {
        issue('CLIENT_ORIGIN', 'CLIENT_ORIGIN must use https in production');
      }
      // Production debug diagnostics stay off (control #12). Refusing the value
      // is stronger than logging a warning nobody reads.
      if (value.LOG_LEVEL === 'debug') {
        issue('LOG_LEVEL', 'LOG_LEVEL must not be debug in production');
      }
      // A production session pepper is the only thing protecting stored session
      // token hashes, so the development floor is not enough.
      if (value.SESSION_PEPPER.length < 32) {
        issue(
          'SESSION_PEPPER',
          'SESSION_PEPPER must be at least 32 characters in production (run `npm run gen:env`)'
        );
      }
      // Key separation (control #1): one leaked key must never open another
      // store. MFA secrets, stored documents and generated exports each have
      // their own key, and the pepper must differ from all of them.
      const keys = [
        ['MFA_ENCRYPTION_KEY', value.MFA_ENCRYPTION_KEY],
        ['DOCUMENT_ENCRYPTION_KEY', value.DOCUMENT_ENCRYPTION_KEY],
        ['PRIVACY_EXPORT_ENCRYPTION_KEY', value.PRIVACY_EXPORT_ENCRYPTION_KEY],
      ].filter(([, v]) => Boolean(v));
      const seen = new Map();
      for (const [name, v] of keys) {
        if (seen.has(v)) {
          issue(name, `${name} must not reuse the value of ${seen.get(v)}`);
        } else {
          seen.set(v, name);
        }
      }
      if (keys.some(([, v]) => v === value.SESSION_PEPPER)) {
        issue('SESSION_PEPPER', 'SESSION_PEPPER must not reuse an encryption key');
      }
      // Database traffic carries clinical records, so production requires an
      // encrypted connection. The message never echoes the URI (control #9).
      const uri = value.MONGODB_URI;
      const tls =
        uri.startsWith('mongodb+srv://') ||
        /[?&](tls|ssl)=true(&|$)/i.test(uri);
      if (!tls) {
        issue(
          'MONGODB_URI',
          'MONGODB_URI must use TLS in production (mongodb+srv://, or tls=true)'
        );
      }
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
