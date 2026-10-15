import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClosurePanel from '../features/closure/ClosurePanel';
import AuditPanel from '../features/audit/AuditPanel';
import PrivacyPanel from '../features/privacy/PrivacyPanel';
import RetentionPanel from '../features/retention/RetentionPanel';
import MetricsPanel from '../features/metrics/MetricsPanel';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A fetch stub that answers by URL, with an optional spy on the last call.
function fetchBy(routes) {
  return vi.fn(async (url, options = {}) => {
    const path = String(url);
    for (const [match, handler] of routes) {
      if (path.includes(match)) return handler(options, path);
    }
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ClosurePanel', () => {
  const preflight = {
    episode: { id: 'e1', reference: 'EP-1', closureState: 'open', revision: 3 },
    items: [
      { key: 'unresolved_approvals', label: 'Plan versions waiting for approval', count: 1, blocking: true },
      { key: 'failed_deliveries', label: 'Reminders that could not be delivered', count: 0, blocking: false },
    ],
    blocking: ['unresolved_approvals'],
    unresolved: ['unresolved_approvals'],
    policyChecks: [{ key: 'plan_reviewed' }, { key: 'patient_informed' }],
    meaning: 'Closing an episode ends the coordination workflow and does not mean the patient has recovered.',
    reopenMeaning: 'Reopening restores active coordination.',
  };

  it('walks the wizard, requires a blocking override and a reason before confirming', async () => {
    let closed = null;
    window.fetch = fetchBy([
      ['/closure/preflight', () => jsonResponse(200, preflight)],
      ['/closure?', () => jsonResponse(200, { items: [], total: 0, page: 1, retentionHolds: [] })],
      ['/closure', (options) => { closed = JSON.parse(options.body); return jsonResponse(201, { episode: { status: 'closed' } }); }],
    ]);

    render(<ClosurePanel episodeId="e1" episode={{ reference: 'EP-1' }} />);
    expect(await screen.findByText(/does not mean the patient has recovered/)).toBeInTheDocument();
    expect(screen.getByText('Plan versions waiting for approval')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue to policy checks' }));
    await userEvent.click(screen.getByText('plan reviewed'));
    await userEvent.click(screen.getByText('patient informed'));
    await userEvent.type(screen.getByLabelText('Reason'), 'Coordination complete for this episode.');
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));

    // The blocking item needs a written reason before the close is allowed.
    expect(screen.getByRole('button', { name: 'Close episode' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('unresolved approvals'), 'Approval is pending but coordination ends today.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close episode' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: 'Close episode' }));
    await waitFor(() => expect(closed).not.toBeNull());
    expect(closed.confirm).toBe(true);
    expect(closed.overrides).toHaveLength(1);
    expect(closed.policyChecks.every((c) => c.confirmed)).toBe(true);
  });
});

describe('AuditPanel', () => {
  it('lists events with the redaction note and filters by category', async () => {
    const calls = [];
    window.fetch = fetchBy([
      ['/audit', (options, path) => {
        calls.push(path);
        return jsonResponse(200, {
          items: [
            { id: 'a1', at: '2026-10-14T10:00:00.000Z', action: 'episode.closed', category: 'closure', actorLabel: 'admin@x.invalid', outcome: 'success' },
          ],
          total: 1,
          page: 1,
          limit: 20,
          note: 'Audit payloads are redacted at write time.',
        });
      }],
    ]);

    render(<AuditPanel />);
    expect(await screen.findByText('episode.closed')).toBeInTheDocument();
    expect(screen.getByText(/redacted at write time/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Category'), 'closure');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.includes('category=closure'))).toBe(true));
  });
});

describe('RetentionPanel', () => {
  it('runs a dry run, shows report-only categories, and gates apply on operator and reason', async () => {
    window.fetch = fetchBy([
      ['/retention/categories', () => jsonResponse(200, {
        categories: [
          { key: 'sessions_tokens', label: 'Sessions and tokens', retainDays: 30, reportOnly: false },
          { key: 'documents', label: 'Discharge documents', retainDays: 2555, reportOnly: true },
        ],
      })],
      ['/retention/holds', () => jsonResponse(200, { items: [], total: 0, page: 1, limit: 10 })],
      ['/retention/dry-run', () => jsonResponse(200, {
        run: { mode: 'dry_run', result: 'dry_run' },
        plan: [{ category: 'sessions_tokens', eligible: 4, held: 0 }],
        note: 'Dry run only: nothing was changed.',
      })],
      ['/retention/apply', () => jsonResponse(200, { run: { result: 'applied' }, idempotent: false, affected: {} })],
    ]);

    render(<RetentionPanel />);
    expect(await screen.findByText('Discharge documents')).toBeInTheDocument();
    expect(screen.getByText('report-only')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByText('Dry run complete. Nothing was changed.')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Apply retention' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Operator'), 'Synthetic Admin');
    await userEvent.type(screen.getByLabelText('Reason'), 'Routine retention sweep per clinic policy.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply retention' })).toBeEnabled());
  });
});

describe('MetricsPanel', () => {
  it('switches panels, always shows the not-a-measure-of line, and renders queue age', async () => {
    window.fetch = fetchBy([
      ['/metrics', () => jsonResponse(200, {
        note: 'These are operational workflow durations and counts. They are not clinical outcomes.',
        clinicianNote: 'Queue age is scoped to your own active assignments.',
        metrics: [
          { key: 'approval_time', label: 'Plan approval time', unit: 'hours', definition: 'Elapsed time to a decision.', notAMeasureOf: 'Correctness of the plan.', value: { count: 2, averageHours: 2, medianHours: 2, maxHours: 2 } },
          { key: 'queue_age', label: 'Queue age', unit: 'hours', definition: 'Age of the oldest open item.', notAMeasureOf: 'Anything about a person’s health.', value: { queues: { pending_approvals: { openItems: 1, oldestHours: 5 } } } },
          { key: 'coordination_workload', label: 'Coordination workload', unit: 'items', definition: 'Items claimed per member.', notAMeasureOf: 'Staff performance.', value: { members: [{ member: 'u1', label: 'coord@x.invalid', active: 2, released: 1, claimedInWindow: 3 }] } },
        ],
      })],
    ]);

    render(<MetricsPanel />);
    expect(await screen.findByText('Plan approval time')).toBeInTheDocument();
    expect(screen.getByText(/Not a measure of: Correctness of the plan/)).toBeInTheDocument();
    expect(screen.getByText(/2h average/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Queue age' }));
    expect(await screen.findByText('pending approvals')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Workload' }));
    expect(await screen.findByText('coord@x.invalid')).toBeInTheDocument();
  });
});

describe('PrivacyPanel', () => {
  const request = {
    id: 'r1',
    reference: 'DR-1',
    kind: 'deletion_request',
    state: 'approved',
    identity: { status: 'verified', method: 'video_call' },
    ownerLabel: 'admin@x.invalid',
    dueAt: '2026-11-01T00:00:00.000Z',
    decision: { outcome: 'approved', reason: 'Identity confirmed.' },
    execution: { result: 'Evaluated against the retention rules.', limited: true, exportArtifact: null, holds: [] },
  };

  it('presents deletion as an evaluation and sends the no-destruction acknowledgement', async () => {
    let executed = null;
    window.fetch = fetchBy([
      ['/privacy-requests?', () => jsonResponse(200, { items: [request], total: 1, page: 1, limit: 10 })],
      ['/privacy-requests/r1/execute', (options) => { executed = JSON.parse(options.body); return jsonResponse(200, { request }); }],
      ['/privacy-requests/r1', () => jsonResponse(200, { request, export: null, meanings: {} })],
    ]);

    render(<PrivacyPanel />);
    expect(await screen.findByText(/may be denied or limited/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('DR-1')).toBeInTheDocument();
    expect(screen.getByText(/limited by retention/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Execute' }));
    await waitFor(() => expect(executed).not.toBeNull());
    expect(executed.acknowledgeNoDestruction).toBe(true);
  });
});
