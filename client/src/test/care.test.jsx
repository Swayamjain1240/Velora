import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import MyCare from '../features/care/MyCare';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GUIDANCE = {
  configured: true,
  display: 'Mon-Fri 09:00-17:00',
  note: 'The clinic answers within these hours.',
  emergency: {
    display: 'Call the clinic switchboard on 011-555-0100.',
    fallback: 'Call local emergency services.',
  },
};

const OPEN_SLOT = {
  id: 'r1',
  episode: 'e1',
  templateKey: 'daily_recovery',
  title: 'Daily recovery check-in',
  slotDate: '2026-10-14',
  timezone: 'Asia/Kolkata',
  state: 'open',
  isMissing: false,
  isLate: false,
  note: 'This check-in is open and can still be answered.',
  questions: [
    { id: 'q1', kind: 'scale', prompt: 'How is your pain today?', scaleMin: 0, scaleMax: 10 },
    { id: 'q2', kind: 'choice', prompt: 'What could you do today?', multi: true, options: ['Walking', 'Sitting'] },
  ],
  answers: [],
};

const MISSING_SLOT = {
  id: 'r2',
  episode: 'e1',
  templateKey: 'daily_recovery',
  title: 'Daily recovery check-in',
  slotDate: '2026-10-13',
  timezone: 'Asia/Kolkata',
  state: 'no_response',
  isMissing: true,
  isLate: false,
  note: 'No response was recorded for this check-in. That is a missing record, not a finding about how you are.',
  questions: null,
  answers: [],
};

const FOLLOW_UP = {
  id: 'f1',
  episode: 'e1',
  date: '2026-10-28',
  time: '11:00',
  timezone: 'Asia/Kolkata',
  location: 'City Clinic, Room 4',
  contact: { name: 'Front desk', phone: '011-555-0100' },
  status: 'scheduled',
  reminder: { enabled: true, localTime: '09:00', daysBefore: 1, appearsOn: '2026-10-27' },
  note_wording: 'This is a prescribed follow-up appointment.',
};

const THREAD = {
  id: 't1',
  episode: 'e1',
  kind: 'operational',
  subject: 'Transport for my appointment',
  state: 'answered',
  openedByLabel: 'patient@example.com',
  openedByRole: 'patient',
  assignedToLabel: 'coordinator@example.com',
  reopenCount: 0,
  messages: [
    {
      id: 'm1',
      kind: 'question',
      body: 'Can the clinic arrange transport?',
      authorLabel: 'patient@example.com',
      answeredAs: null,
      at: '2026-10-10T09:00:00.000Z',
    },
    {
      id: 'm2',
      kind: 'answer',
      body: '<script>alert(1)</script> please call the desk',
      authorLabel: 'coordinator@example.com',
      answeredAs: 'operational',
      at: '2026-10-10T10:00:00.000Z',
    },
  ],
  notes: { state: 'The state of a question is workflow, not a clinical finding.' },
  guidance: GUIDANCE,
};

describe('MyCare', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists only the answerable check-ins with a form and posts the answers', async () => {
    const calls = [];
    window.fetch = vi.fn(async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET', body: options && options.body });
      if (url.startsWith('/api/patient/me/check-ins/r1/submit')) {
        return jsonResponse(200, { response: { ...OPEN_SLOT, state: 'submitted' }, attention: false });
      }
      if (url.startsWith('/api/patient/me/check-ins')) {
        return jsonResponse(200, { items: [OPEN_SLOT, MISSING_SLOT], total: 2, page: 1, limit: 10, guidance: GUIDANCE });
      }
      return jsonResponse(200, { items: [], total: 0, page: 1, limit: 10, guidance: GUIDANCE });
    });

    render(<MyCare />);

    // The clinic's response hours travel with the queue.
    expect(await screen.findByText(/The clinic answers within these hours\./)).toBeInTheDocument();

    // The missing slot is shown as a missing record, and offers no form.
    expect(screen.getByText(/That is a missing record, not a finding/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /answer this check-in/i })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /answer this check-in/i }));
    await userEvent.type(screen.getByLabelText(/How is your pain today\?/i), '3');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Walking' }));
    await userEvent.click(screen.getByRole('button', { name: /send answers/i }));

    await waitFor(() => {
      const submit = calls.find((call) => call.url.endsWith('/check-ins/r1/submit'));
      expect(submit).toBeTruthy();
      expect(submit.method).toBe('POST');
      const body = JSON.parse(submit.body);
      expect(body.answers).toContainEqual({ questionId: 'q1', value: '3' });
      expect(body.answers).toContainEqual({ questionId: 'q2', values: ['Walking'] });
    });
    expect(await screen.findByText(/answers sent/i)).toBeInTheDocument();
  });

  it('shows prescribed follow-ups with their place, contact and reminder day', async () => {
    window.fetch = vi.fn(async (url) => {
      if (url.startsWith('/api/patient/me/follow-ups')) {
        return jsonResponse(200, { items: [FOLLOW_UP], total: 1, page: 1, limit: 10 });
      }
      return jsonResponse(200, { items: [], total: 0, page: 1, limit: 10, guidance: GUIDANCE });
    });

    render(<MyCare />);
    await userEvent.click(await screen.findByRole('tab', { name: /follow-ups/i }));

    expect(await screen.findByText('2026-10-28 · City Clinic, Room 4')).toBeInTheDocument();
    expect(screen.getByText('scheduled')).toBeInTheDocument();
    expect(screen.getByText(/Front desk/)).toBeInTheDocument();
    expect(screen.getByText(/An in-app reminder appears on 2026-10-27\./)).toBeInTheDocument();
  });

  it('renders a clarification answer as text and offers no answering controls', async () => {
    window.fetch = vi.fn(async (url, options) => {
      // The api() helper always sends an explicit method, so a read is 'GET'.
      if (url.startsWith('/api/patient/me/questions/t1') && options.method === 'GET') {
        return jsonResponse(200, { thread: THREAD });
      }
      if (url.startsWith('/api/patient/me/questions')) {
        return jsonResponse(200, { items: [THREAD], total: 1, page: 1, limit: 10, guidance: GUIDANCE });
      }
      return jsonResponse(200, { items: [], total: 0, page: 1, limit: 10, guidance: GUIDANCE });
    });

    render(<MyCare />);
    await userEvent.click(await screen.findByRole('tab', { name: /^questions$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /read and reply/i }));

    // A care-team message is shown as characters, never executed as markup.
    const body = await screen.findByText('<script>alert(1)</script> please call the desk');
    expect(body).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    // A patient replies; they never answer a question as the care team.
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reply as reviewer/i })).not.toBeInTheDocument();
  });
});
