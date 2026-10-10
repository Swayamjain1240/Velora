import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'velora_csrf=csrf-token-123';
  });

  afterEach(() => {
    document.cookie = 'velora_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('attaches the CSRF cookie value as a header on mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/staff/invitations', { method: 'POST', body: { email: 'a@b.com' } });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/staff/invitations');
    expect(options.method).toBe('POST');
    expect(options.headers['X-CSRF-Token']).toBe('csrf-token-123');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ email: 'a@b.com' });
  });

  it('does not send a CSRF header on GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/auth/me');

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('throws a typed ApiError carrying code and issues from the envelope', async () => {
    // A Response body can only be read once; hand out a fresh one per call.
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse(400, {
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid request. Check the highlighted fields.',
          issues: [{ path: 'email', message: 'Enter a valid email address' }],
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
    try {
      await api('/auth/login', { method: 'POST', body: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.issues).toHaveLength(1);
    }
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/auth/me')).rejects.toMatchObject({
      status: 500,
      code: 'UNKNOWN',
    });
  });
});
