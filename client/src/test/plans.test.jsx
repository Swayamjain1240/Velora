import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// The role is a UI hint only (the server is the authority), so each test can
// choose the role whose affordances it exercises.
const authState = vi.hoisted(() => ({ roleKey: 'clinical_reviewer' }));

vi.mock('../features/auth/AuthContext', () => ({
  useAuth: () => ({ memberships: [{ roleKey: authState.roleKey }] }),
}));

// Imported after the mock so the component picks it up.
const { default: CarePlanPanel } = await import('../features/plans/CarePlanPanel');
const { default: PatientPlan } = await import('../features/patient/PatientPlan');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function basePlan(overrides = {}) {
  return {
    id: 'p1',
    version: 1,
    state: 'draft',
    revision: 3,
    title: 'Post-discharge plan',
    summary: null,
    isCurrent: false,
    editable: true,
    clarificationReason: null,
    approvedAt: null,
    approvedByLabel: null,
    supersededAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function draftItem(overrides = {}) {
  return {
    id: 'i1',
    order: 1,
    kind: 'medication',
    originalWording: 'Paracetamol 500 mg',
    medication: 'Paracetamol',
    dose: null,
    frequency: null,
    duration: null,
    unresolvedFields: ['dose', 'frequency', 'duration'],
    clinicalReviewState: 'pending',
    reviewNote: null,
    reviewedByLabel: null,
    sourceCount: 0,
    sources: [],
    ...overrides,
  };
}

function versionsBody(plan = basePlan()) {
  return { items: [plan], total: 1, page: 1, limit: 8 };
}

describe('CarePlanPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authState.roleKey = 'clinical_reviewer';
  });

  it('shows unresolved clinical fields as the reason approval is blocked', async () => {
    const plan = basePlan();
    window.fetch = vi.fn(async (url) => {
      if (url.includes('/items')) {
        return jsonResponse(200, { items: [draftItem()], total: 1, page: 1, limit: 8 });
      }
      if (url.endsWith('/plans/p1')) {
        return jsonResponse(200, {
          plan,
          items: [draftItem()],
          blockers: {
            approval: [
              { code: 'unresolved_fields', message: 'Item 1 has unresolved clinical fields: dose.' },
            ],
            submit: [],
          },
          events: [],
        });
      }
      return jsonResponse(200, versionsBody(plan));
    });

    render(<CarePlanPanel episodeId="e1" episodeStatus="draft" />);

    expect(
      await screen.findByText(/blocking approval: dose missing or unclear/i)
    ).toBeInTheDocument();
    // The clinical wording is rendered as text, never as markup.
    expect(screen.getAllByText(/Paracetamol 500 mg/).length).toBeGreaterThan(0);
    expect(document.querySelector('script')).toBeNull();
  });

  it('creates a new draft version by copying a chosen version', async () => {
    authState.roleKey = 'care_coordinator';
    const plan = basePlan({ state: 'approved', editable: false, isCurrent: true });
    const posted = [];
    window.fetch = vi.fn(async (url, options) => {
      if (options && options.method === 'POST' && url.endsWith('/plans')) {
        posted.push(JSON.parse(options.body));
        return jsonResponse(201, { plan: basePlan({ id: 'p2', version: 2 }) });
      }
      if (url.includes('/items')) {
        return jsonResponse(200, { items: [], total: 0, page: 1, limit: 8 });
      }
      if (url.endsWith('/plans/p1')) {
        return jsonResponse(200, {
          plan,
          items: [],
          blockers: { approval: [{ code: 'no_items', message: 'A plan needs at least one item.' }], submit: [] },
          events: [],
        });
      }
      return jsonResponse(200, versionsBody(plan));
    });

    render(<CarePlanPanel episodeId="e1" episodeStatus="draft" />);

    await userEvent.click(await screen.findByRole('button', { name: /new draft version/i }));
    await userEvent.click(screen.getByRole('radio', { name: /copy an existing version/i }));
    await userEvent.selectOptions(screen.getByLabelText(/version to copy/i), 'p1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.type(screen.getByLabelText(/title \(optional\)/i), 'Revised plan');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(screen.getByRole('button', { name: /create draft version/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ title: 'Revised plan', fromVersionId: 'p1' });
  });

  it('requires an explicit acknowledgement before approving, and sends the held revision', async () => {
    const plan = basePlan({ state: 'in_review', revision: 7, editable: false });
    const accepted = draftItem({
      dose: '500 mg',
      frequency: 'every 6 hours',
      duration: '3 days',
      unresolvedFields: [],
      clinicalReviewState: 'accepted',
      sourceCount: 1,
    });
    const approvals = [];
    window.fetch = vi.fn(async (url, options) => {
      if (options && options.method === 'POST' && url.endsWith('/approve')) {
        approvals.push(JSON.parse(options.body));
        return jsonResponse(200, {
          plan: basePlan({ state: 'approved', isCurrent: true }),
          idempotent: false,
          superseded: null,
        });
      }
      if (url.includes('/items')) {
        return jsonResponse(200, { items: [accepted], total: 1, page: 1, limit: 8 });
      }
      if (url.endsWith('/plans/p1')) {
        return jsonResponse(200, { plan, items: [accepted], blockers: { approval: [], submit: [] }, events: [] });
      }
      return jsonResponse(200, versionsBody(plan));
    });

    render(<CarePlanPanel episodeId="e1" episodeStatus="draft" />);

    await userEvent.click(await screen.findByRole('tab', { name: /review/i }));
    await userEvent.click(await screen.findByRole('button', { name: /review approval/i }));

    const publish = screen.getByRole('button', { name: /approve and publish/i });
    expect(publish).toBeDisabled();
    // The consequences are stated before the action is possible.
    expect(screen.getByText(/superseded and cannot be edited/i)).toBeInTheDocument();
    expect(screen.getByText(/no task, reminder or message is created/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /I have reviewed the content/i }));
    await userEvent.click(publish);

    await waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toEqual({ expectedRevision: 7, confirm: true });
  });

  it('clears a stale item editor when a write is refused with a conflict', async () => {
    authState.roleKey = 'care_coordinator';
    const plan = basePlan();
    let itemCalls = 0;
    window.fetch = vi.fn(async (url, options) => {
      if (options && options.method === 'POST' && url.includes('/items')) {
        return jsonResponse(409, {
          error: { code: 'CONFLICT', message: 'Your copy is out of date. Reload the plan and try again.' },
        });
      }
      if (url.includes('/items')) {
        itemCalls += 1;
        return jsonResponse(200, { items: [], total: 0, page: 1, limit: 8 });
      }
      if (url.endsWith('/plans/p1')) {
        return jsonResponse(200, {
          plan,
          items: [],
          blockers: { approval: [{ code: 'no_items', message: 'A plan needs at least one item.' }], submit: [] },
          events: [],
        });
      }
      return jsonResponse(200, versionsBody(plan));
    });

    render(<CarePlanPanel episodeId="e1" episodeStatus="draft" />);

    await userEvent.click(await screen.findByRole('button', { name: /add item/i }));
    await userEvent.type(screen.getByLabelText(/original wording/i), 'Amoxicillin 500 mg');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(screen.getByRole('button', { name: /add item/i }));

    expect(await screen.findByText(/out of date/i)).toBeInTheDocument();
    // The stale editor is gone and the list has been re-read.
    await waitFor(() => expect(screen.queryByLabelText(/original wording/i)).toBeNull());
    expect(itemCalls).toBeGreaterThan(1);
  });
});

describe('PatientPlan', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authState.roleKey = 'patient';
  });

  it('never shows a plan before one is clinically approved', async () => {
    window.fetch = vi.fn(async () => jsonResponse(200, { plan: null, items: [] }));
    render(<PatientPlan episodeId="e1" />);
    expect(
      await screen.findByText(/has not published an approved plan/i)
    ).toBeInTheDocument();
  });

  it('renders the approved clinical wording and its sources as text', async () => {
    window.fetch = vi.fn(async () =>
      jsonResponse(200, {
        plan: {
          id: 'p1',
          version: 2,
          state: 'approved',
          isCurrent: true,
          title: '<b>Approved</b> plan',
          summary: null,
          approvedByLabel: 'reviewer@clinic.invalid',
          approvedAt: '2026-10-02T09:00:00.000Z',
        },
        items: [
          {
            id: 'i1',
            order: 1,
            kind: 'medication',
            originalWording: '<script>alert(1)</script> Paracetamol 500 mg',
            medication: 'Paracetamol',
            dose: '500 mg',
            route: 'oral',
            frequency: 'every 6 hours',
            duration: '3 days',
            sources: [
              {
                id: 's1',
                documentFilename: 'discharge-summary.pdf',
                page: 2,
                location: 'Page 2',
                text: 'Paracetamol 500 mg every 6 hours for 3 days',
              },
            ],
          },
        ],
      })
    );

    render(<PatientPlan episodeId="e1" />);

    expect(await screen.findByText(/Approved v2/)).toBeInTheDocument();
    // Hostile clinical text is shown literally, never parsed as markup.
    expect(
      screen.getAllByText(/<script>alert\(1\)<\/script> Paracetamol 500 mg/).length
    ).toBeGreaterThan(0);
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('500 mg')).toBeInTheDocument();
    expect(screen.getByText('Paracetamol 500 mg every 6 hours for 3 days')).toBeInTheDocument();
  });
});
