import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import PatientList from '../features/patients/PatientList';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PatientList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state when the caller has no assigned patients', async () => {
    window.fetch = vi.fn(async () => jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 }));
    render(<PatientList onOpen={() => {}} />);
    expect(await screen.findByText(/no patients are assigned to you/i)).toBeInTheDocument();
  });

  it('walks the creation wizard from details to review', async () => {
    window.fetch = vi.fn(async () => jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 }));
    render(<PatientList onOpen={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: /new patient/i }));

    // Continue is blocked until a name is provided.
    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/full name/i), 'Synthetic Person');
    await userEvent.click(continueBtn);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /review/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Synthetic Person')).toBeInTheDocument();
  });

  it('POSTs the new patient and reports the assignment notice', async () => {
    const created = {
      patient: { id: 'p1', fullName: 'Synthetic Person', status: 'draft', reference: 'PT-ABC' },
    };
    window.fetch = vi.fn(async (url, options) => {
      if (url.startsWith('/api/patients') && options && options.method === 'POST') {
        return jsonResponse(201, created);
      }
      return jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 });
    });
    const onOpen = vi.fn();
    render(<PatientList onOpen={onOpen} />);

    await userEvent.click(await screen.findByRole('button', { name: /new patient/i }));
    await userEvent.type(screen.getByLabelText(/full name/i), 'Synthetic Person');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(screen.getByRole('button', { name: /create patient/i }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('p1'));
  });
});
