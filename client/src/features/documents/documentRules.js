'use strict';

// Client-side document rules. These are a UX pre-check ONLY: the server
// re-validates every byte, and a browser check never substitutes for it.
export const MAX_BYTES = 10 * 1024 * 1024;

const MEDIA_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export function mediaTypeFor(filename) {
  const idx = String(filename).lastIndexOf('.');
  if (idx <= 0) return null;
  return MEDIA_TYPES[String(filename).slice(idx + 1).toLowerCase()] || null;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

// Returns { ok: true } or { ok: false, reason } with a plain, safe sentence.
export function preflight(file) {
  if (!file || !file.size) return { ok: false, reason: 'The file is empty.' };
  if (file.size > MAX_BYTES) return { ok: false, reason: 'The file exceeds the 10 MiB limit.' };
  if (!mediaTypeFor(file.name)) {
    return { ok: false, reason: 'Only PDF, JPEG and PNG files are accepted.' };
  }
  return { ok: true };
}

// A `ready` document is TECHNICALLY accepted for later review. The wording here
// must never suggest clinical approval.
export const STATUS_LABELS = Object.freeze({
  uploading: 'Uploading',
  ready: 'Ready for review',
  rejected: 'Rejected',
  quarantined: 'Quarantined',
  failed: 'Failed',
});

export const STATUS_NOTES = Object.freeze({
  ready: 'Technically accepted for later review. This is not clinical approval.',
  rejected: 'The file was refused and no copy was kept.',
  quarantined: 'Could not be fully validated; held privately for an operator. It is not downloadable.',
  failed: 'The stored copy could not be completed. Upload it again.',
  uploading: 'Still being stored.',
});

// Maps a transport failure to a safe, actionable sentence. Server messages are
// already safe (they never contain parser internals); they are kept for 4xx so
// the user learns what to fix, while 5xx stays generic.
export function safeMessage(err) {
  const status = Number(err && err.status);
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 404) return 'This episode is no longer available to you.';
  if (status === 503) return 'The validation service is busy. Please retry in a moment.';
  if (status >= 500) return 'The request could not be completed. Please retry.';
  return (err && err.message) || 'Something went wrong.';
}

export function isDenied(err) {
  const status = Number(err && err.status);
  return status === 401 || status === 403 || status === 404;
}
