import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import TodayView from '../features/today/TodayView';
import SchedulePanel from '../features/schedules/SchedulePanel';
import {
  canRecord,
  dateInZone,
  entryProvenance,
  missingEntryText,
  rowDetail,
  rowTitle,
  safetyLines,
  shiftDate,
  stateLabel,
  statePillClass,
} from '../features/today/todayRules';

// The panels read the caller's role from the auth context; the tests only need
// the role key, and the server remains the real boundary.
const authState = { roleKey: 'patient' };
vi.mock('../features/auth/AuthContext', () => ({
  useAuth: () => ({ memberships: [{ roleKey: authState.roleKey }] }),
}));

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DAY = {
  date: '2026-10-12',
  timezone: 'Europe/London',
  offset: '+01:00',
  episode: { id: 'e1', reference: 'EP-1', status: 'draft', readOnly: false },
  access: 'patient',
  logAllowed: true,
  tab: 'medication',
  page: 1,
  limit: 10,
  total: 2,
  pages: 1,
  counts: { taken: 0, skipped: 0, reported_done: 0, needs_help: 0, not_recorded: 2 },
  countsByTab: {
    medication: { taken: 0, skipped: 0, reported_done: 0, needs_help: 0, not_recorded: 2 },
    task: { taken: 1, skipped: 0, reported_done: 0, needs_help: 0, not_recorded: 0 },
  },
  items: [
    {
      id: 'o1',
      owner: 's1',
      ownerType: 'medication',
      asNeeded: false,
      historical: false,
      actionable: true,
      state: 'not_recorded',
      noEntryRecorded: true,
      selfReport: false,
      clinicianVerified: false,
      dueAtUtc: '2026-10-12T08:00:00.000Z',
      happenedAtUtc: null,
      localTime: '09:00',
      offset: '+01:00',
      recordedAtUtc: null,
      corrected: false,
      entryCount: 0,
      entries: [],
      medication: { name: 'Amoxicillin', dose: '500 mg', route: 'oral', frequency: 'three times daily', timing: null, condition: null },
      task: null,
      instruction: 'Amoxicillin 500 mg orally three times daily for 5 days',
      scheduleKind: 'fixed',
      planVersion: 'v1',
    },
    {
      id: 'o2',
      owner: 's2',
      ownerType: 'medication',
      asNeeded: true,
      historical: false,
      actionable: true,
      state: 'taken',
      noEntryRecorded: false,
      selfReport: true,
      clinicianVerified: false,
      dueAtUtc: null,
      happenedAtUtc: '2026-10-12T18:30:00.000Z',
      localTime: '19:30',
      offset: '+01:00',
      recordedAtUtc: '2026-10-12T18:31:00.000Z',
      corrected: false,
      entryCount: 1,
      entries: [
        {
          id: 'l1',
          entryState: 'taken',
          selfReport: true,
          actorRole: 'patient',
          actorLabel: 'patient@synthetic.invalid',
          recordedAtUtc: '2026-10-12T18:31:00.000Z',
          correctsLog: null,
          correctionReason: null,
        },
      ],
      medication: { name: 'Paracetamol', dose: '500 mg', route: 'oral', frequency: 'every 6 hours', timing: 'as needed for pain', condition: 'for pain only' },
      task: null,
      instruction: 'Paracetamol 500 mg orally every 6 hours as needed for pain',
      scheduleKind: 'as_needed',
      planVersion: 'v1',
    },
  ],
  safety: {
    missingEntryMeans: 'no_entry_recorded',
    notRecordedIsNotAMissedDose: true,
    adviceAboutExtraDose: 'none',
    note: 'An entry with nothing recorded is not a missed dose and never means you should take an extra or replacement dose.',
    asNeededNote: 'This medicine or task is conditional: record it when it happens.',
    selfReportNote: 'Entries recorded by a patient or caregiver are self-reports. They are not clinical verification.',
  },
};

describe('todayRules', () => {
  it('labels every recorded fact and never calls a missing entry a missed dose', () => {
    expect(stateLabel('taken')).toBe('Taken');
    expect(stateLabel('reported_done')).toBe('Reported done');
    expect(stateLabel('not_recorded')).toBe('No entry recorded');
    expect(missingEntryText()).toMatch(/not a missed dose/i);
    expect(missingEntryText()).not.toMatch(/you missed/i);
    expect(statePillClass('not_recorded')).toContain('pill--none');
  });

  it('states that a self-report is not clinician verification', () => {
    const self = entryProvenance({ selfReport: true, actorRole: 'caregiver' });
    expect(self.kind).toBe('self_report');
    expect(self.text).toMatch(/self-report/i);
    const staff = entryProvenance({ selfReport: false, actorRole: 'care_coordinator' });
    expect(staff.kind).toBe('staff');
    expect(staff.text).toMatch(/care staff/i);
  });

  it('shifts calendar dates without depending on the local clock', () => {
    expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(dateInZone('UTC', new Date('2026-10-12T23:30:00.000Z'))).toBe('2026-10-12');
    expect(dateInZone('Asia/Kolkata', new Date('2026-10-12T23:30:00.000Z'))).toBe('2026-10-13');
  });

  it('keeps recording unavailable when the day is read-only', () => {
    expect(canRecord({ logAllowed: true, episode: { readOnly: false } }, { actionable: true })).toBe(true);
    expect(canRecord({ logAllowed: false, episode: { readOnly: false } }, { actionable: true })).toBe(false);
    expect(canRecord({ logAllowed: true, episode: { readOnly: true } }, { actionable: true })).toBe(false);
    expect(canRecord({ logAllowed: true, episode: { readOnly: false } }, { actionable: false })).toBe(false);
  });

  it('describes rows from the approved wording only', () => {
    expect(rowTitle(DAY.items[0])).toBe('Amoxicillin · 500 mg');
    expect(rowDetail(DAY.items[0])).toContain('How often: three times daily');
    expect(rowTitle({ task: { title: 'Change the dressing' } })).toBe('Change the dressing');
    expect(safetyLines(DAY.safety)[0]).toMatch(/not a missed dose/i);
  });
});

describe('TodayView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authState.roleKey = 'patient';
  });

  it('renders the day with recorded states and no missed-dose wording', async () => {
    window.fetch = vi.fn(async () => jsonResponse(200, DAY));
    render(<TodayView />);

    expect(await screen.findByText(/Amoxicillin · 500 mg/)).toBeInTheDocument();
    expect(screen.getByText('No entry recorded')).toBeInTheDocument();
    expect(screen.getByText(/No entry recorded\. This is not a missed dose\./)).toBeInTheDocument();
    // The conditional medicine is shown as available, with no due time.
    expect(screen.getByText('As needed')).toBeInTheDocument();
    expect(screen.getByText('No due time')).toBeInTheDocument();
    expect(screen.getByText(/not clinician verified/)).toBeInTheDocument();
    expect(screen.queryByText(/missed a dose/i)).toBeNull();
    // The safety wording is on screen, not only in the payload.
    expect(screen.getByText(/never means you should take an extra or replacement dose/i)).toBeInTheDocument();
  });

  it('records an entry with an idempotency key and reloads the day', async () => {
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'POST') {
        return jsonResponse(201, { log: { id: 'l2', entryState: 'taken' }, idempotent: false });
      }
      return jsonResponse(200, DAY);
    });
    render(<TodayView />);
    const row = (await screen.findByText(/Amoxicillin · 500 mg/)).closest('.today__row');
    await userEvent.click(within(row).getByRole('button', { name: 'Taken' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.options.method === 'POST');
      expect(found).toBeTruthy();
      return found;
    });
    const body = JSON.parse(post.options.body);
    expect(post.url).toBe('/api/today/entries');
    expect(body.occurrenceId).toBe('o1');
    expect(body.entryState).toBe('taken');
    expect(typeof body.clientRequestId).toBe('string');
    expect(body.clientRequestId.length).toBeGreaterThan(7);
    // The day is re-read after a successful write.
    await waitFor(() =>
      expect(calls.filter((call) => !call.options.method || call.options.method === 'GET').length).toBeGreaterThan(1)
    );
  });

  it('records an as-needed medicine by schedule, never by a scheduled slot', async () => {
    let body = null;
    window.fetch = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') {
        body = JSON.parse(options.body);
        return jsonResponse(201, { log: { id: 'l9' }, idempotent: false });
      }
      return jsonResponse(200, DAY);
    });
    render(<TodayView />);
    const row = (await screen.findByText(/Paracetamol · 500 mg/)).closest('.today__row');
    await userEvent.click(within(row).getByRole('button', { name: 'Taken' }));
    await waitFor(() => expect(body).toBeTruthy());
    expect(body.scheduleId).toBe('s2');
    expect(body.occurrenceId).toBeUndefined();
  });

  it('appends a correction that names the entry it corrects', async () => {
    let body = null;
    window.fetch = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') {
        body = JSON.parse(options.body);
        return jsonResponse(201, { log: { id: 'l10' }, idempotent: false });
      }
      return jsonResponse(200, DAY);
    });
    render(<TodayView />);
    // The Paracetamol row already carries an entry, so it can be corrected.
    const row = (await screen.findByText(/Paracetamol · 500 mg/)).closest('.today__row');
    await userEvent.click(within(row).getByRole('button', { name: /Correct this entry/i }));
    await userEvent.type(
      within(row).getByLabelText(/why is this entry being corrected/i),
      'The dose was recorded against the wrong time.'
    );
    await userEvent.click(within(row).getByRole('button', { name: /Add correction/i }));
    await waitFor(() => expect(body).toBeTruthy());
    expect(body.correctsLogId).toBe('l1');
    expect(body.correctionReason).toMatch(/wrong time/);
    // A correction targets the existing occurrence, never a new as-needed slot.
    expect(body.occurrenceId).toBe('o2');
    expect(body.scheduleId).toBeUndefined();
  });

  it('switches day and category through the server, one panel at a time', async () => {
    const urls = [];
    window.fetch = vi.fn(async (url) => {
      urls.push(url);
      return jsonResponse(200, DAY);
    });
    render(<TodayView />);
    await screen.findByText(/Amoxicillin · 500 mg/);
    // Both the date strip and the pager say "Previous": the date one is first.
    await userEvent.click(screen.getAllByRole('button', { name: /Previous/ })[0]);
    await waitFor(() => expect(urls.some((url) => url.includes('date=2026-10-11'))).toBe(true));
    await userEvent.click(screen.getByRole('tab', { name: /Tasks/ }));
    await waitFor(() => expect(urls.some((url) => url.includes('tab=task'))).toBe(true));
  });

  it('hides every record control when the shared grant is read-only', async () => {
    window.fetch = vi.fn(async () => jsonResponse(200, { ...DAY, logAllowed: false, access: 'caregiver' }));
    render(<TodayView />);
    await screen.findByText(/Amoxicillin · 500 mg/);
    expect(screen.queryByRole('button', { name: 'Taken' })).toBeNull();
    expect(screen.getByText(/Shared read-only with you/)).toBeInTheDocument();
  });

  it('says the episode is read-only when it is closed', async () => {
    window.fetch = vi.fn(async () =>
      jsonResponse(200, { ...DAY, episode: { ...DAY.episode, status: 'closed', readOnly: true } })
    );
    render(<TodayView />);
    await screen.findByText(/Amoxicillin · 500 mg/);
    expect(screen.getByText(/Episode closed — read only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken' })).toBeNull();
  });

  it('shows a caregiver picker for the records shared with them', async () => {
    authState.roleKey = 'caregiver';
    window.fetch = vi.fn(async (url) => {
      if (url.startsWith('/api/caregiver/me/patients')) {
        return jsonResponse(200, {
          items: [
            { id: 'p1', fullName: 'Synthetic One' },
            { id: 'p2', fullName: 'Synthetic Two' },
          ],
          total: 2,
        });
      }
      return jsonResponse(200, { ...DAY, access: 'caregiver' });
    });
    render(<TodayView />);
    expect(await screen.findByLabelText(/Shared record/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Synthetic Two' })).toBeInTheDocument());
  });

  it('shows the server denial instead of an empty day', async () => {
    window.fetch = vi.fn(async () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Nothing to show for that record.' } }));
    render(<TodayView />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing to show for that record/);
  });
});

describe('SchedulePanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authState.roleKey = 'care_coordinator';
  });

  const SCHEDULES = {
    items: [
      {
        id: 's1',
        type: 'medication',
        medicationName: 'Enoxaparin',
        title: null,
        dose: '40 mg',
        originalWording: 'Enoxaparin 40 mg subcutaneously every 12 hours for 7 days',
        timesOfDay: [],
        scheduleKind: 'fixed',
        status: 'needs_details',
        needsDetailsReason: 'interval_without_anchor',
        generatedCount: 0,
        revision: 1,
        timezone: 'Europe/London',
        activationRequired: 'clinical_reviewer',
        condition: null,
      },
      {
        id: 's2',
        type: 'medication',
        medicationName: 'Amoxicillin',
        title: null,
        dose: '500 mg',
        originalWording: 'Amoxicillin 500 mg orally three times daily for 5 days',
        timesOfDay: ['09:00', '14:00', '21:00'],
        scheduleKind: 'fixed',
        status: 'pending_activation',
        generatedCount: 15,
        revision: 1,
        timezone: 'Europe/London',
        activationRequired: 'clinical_reviewer',
        condition: null,
      },
    ],
    total: 2,
    page: 1,
    limit: 8,
  };

  it('prepares only from an approved plan and states the activation rule', async () => {
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/schedules/prepare')) return jsonResponse(201, { summary: { created: [] } });
      if (url.includes('/occurrences')) return jsonResponse(200, { items: [], total: 0, page: 1 });
      if (url.includes('/activity-logs')) return jsonResponse(200, { items: [], total: 0, page: 1 });
      return jsonResponse(200, SCHEDULES);
    });
    render(<SchedulePanel episodeId="e1" episodePlanState="approved" />);

    expect(await screen.findByText(/Awaiting activation/)).toBeInTheDocument();
    expect(screen.getByText('Needs schedule details')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Prepare from approved plan/i }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/schedules/prepare'))).toBe(true));
    expect(screen.getByText(/needs a clinical reviewer to activate it/i)).toBeInTheDocument();
  });

  it('blocks preparation while no approved version exists', async () => {
    window.fetch = vi.fn(async (url) => {
      if (url.includes('/occurrences') || url.includes('/activity-logs')) {
        return jsonResponse(200, { items: [], total: 0, page: 1 });
      }
      return jsonResponse(200, SCHEDULES);
    });
    render(<SchedulePanel episodeId="e1" episodePlanState="draft" />);
    const button = await screen.findByRole('button', { name: /Prepare from approved plan/i });
    expect(button).toBeDisabled();
  });

  it('activates a prepared schedule with its revision and shows the UTC occurrences', async () => {
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/activate')) return jsonResponse(200, { schedule: { ...SCHEDULES.items[1], status: 'active' } });
      if (url.includes('/occurrences')) {
        return jsonResponse(200, {
          items: [
            {
              id: 'o1',
              localDate: '2026-10-12',
              localTime: '09:00',
              scheduledAtUtc: '2026-10-12T08:00:00.000Z',
              offset: '+01:00',
              status: 'scheduled',
            },
          ],
          total: 1,
          page: 1,
        });
      }
      if (url.includes('/activity-logs')) {
        return jsonResponse(200, {
          items: [
            {
              id: 'l1',
              entryState: 'taken',
              selfReport: true,
              actorRole: 'patient',
              recordedAtUtc: '2026-10-12T08:05:00.000Z',
              occurrenceTimeUtc: '2026-10-12T08:00:00.000Z',
              correctsLog: null,
            },
          ],
          total: 1,
          page: 1,
        });
      }
      return jsonResponse(200, SCHEDULES);
    });
    render(<SchedulePanel episodeId="e1" episodePlanState="approved" />);
    const activateButtons = await screen.findAllByRole('button', { name: 'Activate' });
    await userEvent.click(activateButtons[0]);
    const post = await waitFor(() => {
      const found = calls.find((call) => call.url.includes('/activate'));
      expect(found).toBeTruthy();
      return found;
    });
    expect(JSON.parse(post.options.body).expectedRevision).toBe(1);
    expect(post.url).toContain('/schedules/s2/activate');
    // Occurrences are shown with their UTC instant AND their local time/offset.
    expect(await screen.findByText('2026-10-12T08:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('+01:00')).toBeInTheDocument();
    expect(screen.getByText('Self-report')).toBeInTheDocument();
  });

  it('shows a denial instead of a clinical workspace', async () => {
    window.fetch = vi.fn(async () => jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Administrators cannot read clinical schedules.' } }));
    render(<SchedulePanel episodeId="e1" episodePlanState="approved" />);
    expect(await screen.findByText(/not available to you/i)).toBeInTheDocument();
  });
});
