'use strict';

// Thin fetch wrapper. Cookie sessions only - no tokens in localStorage
// (control #4). Reads the readable velora_csrf cookie and attaches it to every
// mutating request, matching the server's double-submit CSRF check.
const BASE = import.meta.env.VITE_API_BASE_URL || '/api';

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export class ApiError extends Error {
  constructor(status, code, message, issues) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (MUTATING.has(method)) {
    const csrf = readCookie('velora_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    throw new ApiError(
      res.status,
      err.code || 'UNKNOWN',
      err.message || 'Something went wrong.',
      err.issues
    );
  }
  return data;
}

async function readError(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const err = data && data.error ? data.error : {};
  return new ApiError(
    res.status,
    err.code || 'UNKNOWN',
    err.message || 'Something went wrong.',
    err.issues
  );
}

// Raw byte upload. The declared media type travels in Content-Type and the
// display filename in X-Document-Filename (percent-encoded because HTTP
// headers are latin-1) - never in the URL, so a filename can never reach a
// server access log or the browser history.
export async function uploadDocument(path, { filename, mediaType, bytes }) {
  const headers = {
    'Content-Type': mediaType,
    'X-Document-Filename': encodeURIComponent(filename),
  };
  const csrf = readCookie('velora_csrf');
  if (csrf) headers['X-CSRF-Token'] = csrf;

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: bytes,
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

// Authenticated binary download. The bytes only ever leave the server after a
// fresh authorization + checksum check; the original filename comes back in the
// Content-Disposition attachment header.
function filenameFromDisposition(header) {
  if (!header) return 'document';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain && plain[1] ? plain[1] : 'document';
}

export async function downloadDocument(path) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!res.ok) throw await readError(res);
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('content-disposition')),
    mediaType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

export default api;
