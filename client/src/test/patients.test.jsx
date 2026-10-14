import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import PatientList from '../features/patients/PatientList';
import PatientDetail from '../features/patients/PatientDetail';

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

// Part 7 adds the first caregiver scopes that are more than a read of the
// profile, so the grant form must be able to express them - and must never
// imply the WRITE scope from a read scope.
describe('PatientDetail caregiver scopes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockPatientApi(onInvite) {
    window.fetch = vi.fn(async (url, options) => {
      if (url.startsWith('/api/patients/p1/caregivers')) {
        if (options && options.method === 'POST') {
          onInvite(JSON.parse(options.body));
          return jsonResponse(201, { invitation: { token: 'tok-1' } });
        }
        return jsonResponse(200, { items: [] });
      }
      if (url.startsWith('/api/patients/p1')) {
        return jsonResponse(200, {
          patient: { id: 'p1', reference: 'PT-1', fullName: 'Synthetic Person', status: 'active' },
        });
      }
      return jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 });
    });
  }

  it('offers log_tasks explicitly and never sends it just because view_tasks was chosen', async () => {
    let posted = null;
    mockPatientApi((body) => { posted = body; });
    render(<PatientDetail patientId="p1" onBack={() => {}} />);

    await userEvent.click(await screen.findByRole('tab', { name: /caregivers/i }));

    const logTasks = await screen.findByLabelText(/log tasks \(record entries/i);
    const viewTasks = screen.getByLabelText(/^view tasks$/i);
    // Neither task scope is granted by default: the form starts read-profile only.
    expect(logTasks).not.toBeChecked();
    expect(viewTasks).not.toBeChecked();

    await userEvent.click(viewTasks);
    await userEvent.type(screen.getByLabelText(/caregiver email/i), 'cg@synthetic.invalid');
    await userEvent.click(screen.getByRole('button', { name: /invite caregiver/i }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted.scopes).toEqual(['view_profile', 'view_tasks']);
    expect(posted.scopes).not.toContain('log_tasks');
  });

  it('sends the write scope when it is granted explicitly', async () => {
    let posted = null;
    mockPatientApi((body) => { posted = body; });
    render(<PatientDetail patientId="p1" onBack={() => {}} />);

    await userEvent.click(await screen.findByRole('tab', { name: /caregivers/i }));
    await userEvent.click(await screen.findByLabelText(/log tasks \(record entries/i));
    await userEvent.type(screen.getByLabelText(/caregiver email/i), 'cg@synthetic.invalid');
    await userEvent.click(screen.getByRole('button', { name: /invite caregiver/i }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted.scopes).toContain('view_profile');
    expect(posted.scopes).toContain('log_tasks');
    expect(posted.scopes).not.toContain('view_tasks');
  });
});
