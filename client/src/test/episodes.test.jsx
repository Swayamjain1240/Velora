import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import EpisodeList from '../features/episodes/EpisodeList';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EpisodeList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state when the caller is on no episode team', async () => {
    window.fetch = vi.fn(async () => jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 }));
    render(<EpisodeList onOpen={() => {}} />);
    expect(await screen.findByText(/no episodes are assigned to you/i)).toBeInTheDocument();
  });

  it('requires a patient before leaving the first wizard step', async () => {
    window.fetch = vi.fn(async () => jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 }));
    render(<EpisodeList onOpen={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: /new episode/i }));

    // No patient selected yet -> Continue is blocked.
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('POSTs the new episode and hands the id to the caller', async () => {
    window.fetch = vi.fn(async (url, options) => {
      if (url.startsWith('/api/episodes') && options && options.method === 'POST') {
        return jsonResponse(201, { episode: { id: 'e1', reference: 'EP-ABC', status: 'draft', revision: 1 } });
      }
      if (url.startsWith('/api/patients')) {
        return jsonResponse(200, { items: [{ id: 'p1', reference: 'PT-1', fullName: 'Synthetic Person' }], total: 1 });
      }
      return jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 });
    });
    const onOpen = vi.fn();
    render(<EpisodeList onOpen={onOpen} />);

    await userEvent.click(await screen.findByRole('button', { name: /new episode/i }));
    await screen.findByRole('option', { name: /PT-1/ });
    await userEvent.selectOptions(screen.getByLabelText(/^patient$/i), 'p1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.type(screen.getByLabelText(/discharge date/i), '2026-09-20');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(screen.getByRole('button', { name: /create episode/i }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('e1'));
  });
});
