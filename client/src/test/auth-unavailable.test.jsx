import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../app/router';
import { AuthProvider } from '../features/auth/AuthContext';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderAt(entry) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('session status failure handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a retry state, not the login form, when the status check is rate limited', async () => {
    window.fetch = vi.fn(async () =>
      json({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, 429)
    );

    renderAt('/app');

    expect(
      await screen.findByRole('heading', { name: /temporarily unreachable/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /staff sign in/i })).not.toBeInTheDocument();
    // The retry is a real second attempt, not a single-shot state.
    expect(window.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/status')).length)
      .toBe(2);
  });

  it('signs out on a 401 from the status check', async () => {
    window.fetch = vi.fn(async () => json({ authenticated: false }, 401));

    renderAt('/app');

    expect(await screen.findByRole('heading', { name: /staff sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /temporarily unreachable/i })).not.toBeInTheDocument();
  });
});
