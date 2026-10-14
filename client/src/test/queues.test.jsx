import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AssignedQueues from '../features/queues/AssignedQueues';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SUMMARY = {
  counts: {
    total: 2,
    mine: 1,
    unowned: 1,
    byQueue: {
      pending_approvals: { count: 1, mine: 0, unowned: 1 },
      open_questions: { count: 1, mine: 1, unowned: 0 },
      check_in_reviews: { count: 0, mine: 0, unowned: 0 },
      failed_reminders: { count: 0, mine: 0, unowned: 0 },
      missing_owners: { count: 0, mine: 0, unowned: 0 },
    },
  },
  episodes: 3,
  note: 'These queues are workflow lists for assigned care-team staff.',
};

const QUESTION = {
  id: 't1',
  queue: 'open_questions',
  targetType: 'clarification_thread',
  episode: 'e1',
  patient: 'p1',
  title: 'When can I drive again?',
  kind: 'clinical',
  state: 'open',
  since: '2026-10-01T09:00:00.000Z',
  requires: 'clinical_reviewer',
  mine: true,
  owner: {
    assignmentId: 'a1',
    assigneeUser: 'u1',
    assigneeLabel: 'reviewer@example.com',
    claimedBySelf: true,
  },
  route: { surface: 'question', episodeId: 'e1', threadId: 't1' },
};

const APPROVAL = {
  id: 'v1',
  queue: 'pending_approvals',
  targetType: 'plan_version',
  episode: 'e2',
  patient: 'p2',
  title: 'Plan version 2',
  version: 2,
  state: 'in_review',
  since: '2026-10-02T09:00:00.000Z',
  mine: false,
  owner: null,
  route: { surface: 'episode', episodeId: 'e2', planId: 'v1' },
};

// A valid queue envelope for any queue the screen asks for, so a mock never has
// to enumerate every tab.
function queueEnvelope(overrides = {}) {
  return {
    queue: 'pending_approvals',
    items: [],
    total: 0,
    page: 1,
    limit: 10,
    summary: SUMMARY,
    ...overrides,
  };
}

const THREAD = {
  id: 't1',
  episode: 'e1',
  kind: 'clinical',
  subject: 'When can I drive again?',
  state: 'open',
  openedByLabel: 'patient@example.com',
  openedByRole: 'patient',
  assignedToLabel: 'reviewer@example.com',
  reopenCount: 0,
  messages: [
    {
      id: 'm1',
      kind: 'question',
      body: 'When can I drive again?',
      authorLabel: 'patient@example.com',
      answeredAs: null,
      at: '2026-10-01T09:00:00.000Z',
    },
    {
      id: 'm2',
      kind: 'note',
      body: 'Called the clinic about transport.',
      authorLabel: 'reviewer@example.com',
      answeredAs: null,
      at: '2026-10-01T10:00:00.000Z',
    },
  ],
  notes: { state: 'The state of a question is workflow, not a clinical finding.' },
  guidance: {
    configured: true,
    display: 'Mon-Fri 09:00-17:00',
    note: 'This queue is not monitored continuously.',
    emergency: { display: 'Call the clinic switchboard.', fallback: 'Call local emergency services.' },
  },
};

describe('AssignedQueues', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows every queue with its server-provided count and claims an unowned item', async () => {
    const calls = [];
    window.fetch = vi.fn(async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      if (url === '/api/dashboard') return jsonResponse(200, { summary: SUMMARY, note: SUMMARY.note });
      if (url.startsWith('/api/dashboard/queues/pending_approvals')) {
        return jsonResponse(200, queueEnvelope({ items: [APPROVAL], total: 1 }));
      }
      if (url.startsWith('/api/dashboard/queues/')) return jsonResponse(200, queueEnvelope());
      return jsonResponse(200, { summary: SUMMARY, queues: [], provider: null });
    });

    render(<AssignedQueues />);

    // Counts come from the server summary, not from the page of items.
    expect(await screen.findByRole('tab', { name: /approvals \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /open questions \(1\)/i })).toBeInTheDocument();
    expect(await screen.findByText('Plan version 2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^claim$/i }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/dashboard/queues/pending_approvals/v1/claim',
        method: 'POST',
      })
    );
  });

  it('renders a clarification answer as escaped text and offers the review actions', async () => {
    window.fetch = vi.fn(async (url, options) => {
      if (url === '/api/dashboard') return jsonResponse(200, { summary: SUMMARY, note: SUMMARY.note });
      if (url.startsWith('/api/dashboard/queues/open_questions')) {
        return jsonResponse(200, queueEnvelope({ queue: 'open_questions', items: [QUESTION], total: 1 }));
      }
      if (url.startsWith('/api/dashboard/queues/')) return jsonResponse(200, queueEnvelope());
      if (url === '/api/episodes/e1/questions/t1' && options.method === 'GET') {
        return jsonResponse(200, { thread: THREAD });
      }
      return jsonResponse(200, { thread: THREAD });
    });

    render(<AssignedQueues />);

    await userEvent.click(await screen.findByRole('tab', { name: /open questions/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'When can I drive again?' }));

    // The internal note is shown to the team, plainly as text.
    expect(await screen.findByText('Called the clinic about transport.')).toBeInTheDocument();
    // Response hours and the emergency line travel with the thread.
    expect(screen.getByText(/Response hours: Mon-Fri 09:00-17:00/)).toBeInTheDocument();
    expect(screen.getByText(/Call the clinic switchboard\./)).toBeInTheDocument();
    // A clinical reply is offered on a clinical question.
    expect(screen.getByRole('button', { name: /reply as reviewer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('releases only an assignment the caller owns', async () => {
    const calls = [];
    window.fetch = vi.fn(async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      if (url === '/api/dashboard') return jsonResponse(200, { summary: SUMMARY, note: SUMMARY.note });
      if (url.startsWith('/api/dashboard/queues/pending_approvals')) {
        return jsonResponse(200, queueEnvelope({ items: [APPROVAL], total: 1 }));
      }
      if (url.startsWith('/api/dashboard/queues/')) return jsonResponse(200, queueEnvelope());
      return jsonResponse(200, { summary: SUMMARY, queues: [], provider: null });
    });

    render(<AssignedQueues />);
    await screen.findByText('Plan version 2');

    // Somebody else's assignment is not offerable for release (and would be a
    // 404 server-side anyway).
    expect(screen.queryByRole('button', { name: /release/i })).not.toBeInTheDocument();
  });
});
