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

export default api;
