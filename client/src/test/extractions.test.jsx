import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// The role is a UI hint only (the server is the authority).
const authState = vi.hoisted(() => ({ roleKey: 'care_coordinator' }));

vi.mock('../features/auth/AuthContext', () => ({
  useAuth: () => ({ memberships: [{ roleKey: authState.roleKey }] }),
}));

const { default: ExtractionPanel } = await import('../features/extraction/ExtractionPanel');
const { default: LanguagePanel } = await import('../features/extraction/LanguagePanel');
const { default: CarePlanPanel } = await import('../features/plans/CarePlanPanel');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function job(overrides = {}) {
  return {
    id: 'j1',
    episode: 'e1',
    document: 'd1',
    documentFilename: 'synthetic-discharge-note.pdf',
    version: 'p1',
    targetRevision: 1,
    state: 'needs_review',
    provider: 'fake',
    model: 'fake-extractor-v1',
    attempts: 1,
    maxAttempts: 3,
    suggestionCount: 2,
    rejectedCount: 0,
    unresolvedCount: 1,
    injectionSignalCount: 0,
    injectionSignals: [],
    inputChars: 240,
    inputTruncated: false,
    pages: [1, 2],
    errorCode: null,
    errorMessage: null,
    latencyMs: 12,
    createdByLabel: 'plan.coordinator@synthetic.invalid',
    createdAt: '2026-10-01T10:00:00.000Z',
    startedAt: '2026-10-01T10:00:01.000Z',
    finishedAt: '2026-10-01T10:00:02.000Z',
    cancelledAt: null,
    terminal: true,
    manualFallbackAvailable: true,
    ...overrides,
  };
}

// One suggestion the source states in full, one with a conflict AND a missing
// duration, so both review states are exercised.
function suggestion(overrides = {}) {
  return {
    id: 's1',
    job: 'j1',
    version: 'p1',
    order: 1,
    kind: 'medication',
    originalWording: 'Medication: Paracetamol 500 mg orally every 6 hours for 3 days',
    fields: [
      { field: 'medication', value: 'Paracetamol', state: 'suggested', claimedMissing: false, claimedConflict: false, confidence: 0.8, evidenceText: 'Paracetamol', reasonCode: null, citation: 'c1' },
      { field: 'dose', value: '500 mg', state: 'suggested', claimedMissing: false, claimedConflict: false, confidence: 0.8, evidenceText: '500 mg', reasonCode: null, citation: 'c1' },
      { field: 'frequency', value: 'every 6 hours', state: 'suggested', claimedMissing: false, claimedConflict: false, confidence: 0.8, evidenceText: 'every 6 hours', reasonCode: null, citation: 'c1' },
      { field: 'duration', value: '3 days', state: 'suggested', claimedMissing: false, claimedConflict: false, confidence: 0.8, evidenceText: '3 days', reasonCode: null, citation: 'c1' },
    ],
    unresolvedFields: [],
    missingFields: [],
    proposed: { medication: 'Paracetamol', dose: '500 mg', frequency: 'every 6 hours', duration: '3 days' },
    confidence: 0.8,
    citationCount: 1,
    citations: [
      {
        id: 'c1',
        document: 'd1',
        documentFilename: 'synthetic-discharge-note.pdf',
        documentMediaType: 'application/pdf',
        page: 1,
        location: 'Page 1',
        text: 'Medication: Paracetamol 500 mg orally every 6 hours for 3 days',
        verified: true,
      },
    ],
    injectionSuspected: false,
    state: 'proposed',
    needsReview: false,
    appliedItem: null,
    appliedAt: null,
    appliedByLabel: null,
    dismissedAt: null,
    dismissedByLabel: null,
    dismissReason: null,
    createdAt: '2026-10-01T10:00:02.000Z',
    ...overrides,
  };
}

const conflictSuggestion = suggestion({
  id: 's2',
  order: 2,
  originalWording: 'Medication: Paracetamol 1000 mg orally every 8 hours',
  fields: [
    { field: 'medication', value: 'Paracetamol', state: 'suggested', claimedMissing: false, claimedConflict: false, confidence: 0.6, evidenceText: 'Paracetamol', reasonCode: null, citation: 'c2' },
    { field: 'dose', value: '1000 mg', state: 'conflicting', claimedMissing: false, claimedConflict: true, confidence: 0.6, evidenceText: '1000 mg', reasonCode: null, citation: 'c2' },
    { field: 'frequency', value: 'every 8 hours', state: 'suggested', claimedMissing: false, claimedConflict: false, confidence: 0.6, evidenceText: 'every 8 hours', reasonCode: null, citation: 'c2' },
    { field: 'duration', value: null, state: 'missing', claimedMissing: true, claimedConflict: false, confidence: 0.6, evidenceText: null, reasonCode: null, citation: null },
  ],
  unresolvedFields: ['dose', 'duration'],
  missingFields: ['duration'],
  proposed: { medication: 'Paracetamol', dose: '1000 mg', frequency: 'every 8 hours' },
  confidence: 0.6,
  citationCount: 1,
  citations: [
    {
      id: 'c2',
      document: 'd1',
      documentFilename: 'synthetic-discharge-note.pdf',
      documentMediaType: 'application/pdf',
      page: 2,
      location: 'Page 2',
      text: 'Medication: Paracetamol 1000 mg orally every 8 hours',
      verified: true,
    },
  ],
});

// Routes the three reads the extraction panel performs, and records mutations.
function extractionFetch({ detail = job(), rows = [suggestion(), conflictSuggestion], planRevision = 4 } = {}) {
  const calls = [];
  window.fetch = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return jsonResponse(200, { suggestion: rows[0], item: { id: 'i9' }, idempotent: false });
    }
    if (url.includes('/suggestions')) {
      return jsonResponse(200, { items: rows, total: rows.length, page: 1, limit: 8, planRevision, planState: 'draft' });
    }
    if (/\/extraction-jobs\/[^?]+$/.test(url)) {
      return jsonResponse(200, {
        job: detail,
        planState: 'draft',
        planRevision,
        modelRuns: [
          { id: 'r1', attempt: 1, provider: 'fake', model: 'fake-extractor-v1', network: false, status: 'ok', code: null, latencyMs: 12, inputChars: 240, outputBytes: 900, suggestionCount: rows.length, usage: null, startedAt: null, finishedAt: null },
        ],
        suggestionCounts: { proposed: rows.length },
      });
    }
    return jsonResponse(200, { items: [detail], total: 1, page: 1, limit: 8 });
  });
  return calls;
}

describe('ExtractionPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authState.roleKey = 'care_coordinator';
  });

  it('shows source, AI suggestion, missing and conflict state, and offers no clinical authority', async () => {
    extractionFetch();
    render(
      <ExtractionPanel
        episodeId="e1"
        planId="p1"
        planEditable
        readyDocuments={[{ id: 'd1', filename: 'synthetic-discharge-note.pdf' }]}
        canDraft
      />
    );

    // The permanent notice: AI cannot approve, publish or activate anything.
    expect(
      await screen.findByText(/cannot approve, publish, prescribe, change clinical state/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();

    // Source panel: the verbatim quote and its verification state.
    expect(
      screen.getAllByText('Medication: Paracetamol 500 mg orally every 6 hours for 3 days').length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Verified against the source/).length).toBeGreaterThan(0);

    // The second suggestion carries a conflict and a missing duration.
    await userEvent.click(screen.getByRole('button', { name: /2\. Medication/i }));
    await userEvent.click(screen.getByRole('tab', { name: 'AI suggestion', exact: true }));
    expect(screen.getByText('Conflicting instructions')).toBeInTheDocument();
    expect(screen.getAllByText('Not stated in the source').length).toBeGreaterThan(0);
    // The document wording is rendered as text, never as markup.
    expect(document.querySelector('script')).toBeNull();
  });

  it('applies only the values the coordinator accepted, with the revision it holds', async () => {
    const calls = extractionFetch();
    render(
      <ExtractionPanel
        episodeId="e1"
        planId="p1"
        planEditable
        readyDocuments={[{ id: 'd1', filename: 'synthetic-discharge-note.pdf' }]}
        canDraft
        onApplied={() => {}}
      />
    );

    await screen.findByText(/cannot approve, publish, prescribe/i);
    await userEvent.click(screen.getByRole('tab', { name: 'Accepted value', exact: true }));
    await userEvent.clear(screen.getByLabelText(/Dose/));
    await userEvent.type(screen.getByLabelText(/Dose/), '250 mg');
    await userEvent.click(screen.getByRole('tab', { name: 'Decision', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toContain('/suggestions/s1/apply');
    expect(calls[0].body).toEqual({ expectedRevision: 4, fields: { dose: '250 mg' } });
  });

  it('keeps the manual workflow usable when no provider is enabled', async () => {
    extractionFetch({
      detail: job({ state: 'failed', errorCode: 'PROVIDER_DISABLED', errorMessage: 'AI-assisted extraction is not enabled. Draft this plan by hand.', provider: 'none', suggestionCount: 0 }),
      rows: [],
    });
    render(
      <ExtractionPanel
        episodeId="e1"
        planId="p1"
        planEditable
        readyDocuments={[]}
        canDraft
      />
    );

    const disabled = await screen.findByRole('status');
    expect(disabled.textContent).toMatch(/Draft this plan by hand/i);
    expect(disabled.textContent).toMatch(/PROVIDER_DISABLED/);
    expect(screen.getByText(/manual workflow is still available/i)).toBeInTheDocument();
    // Nothing to apply, and nothing that could approve.
    expect(screen.queryByRole('button', { name: 'Apply to draft' })).toBeNull();
  });
});

describe('LanguagePanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authState.roleKey = 'clinical_reviewer';
  });

  function variant(overrides = {}) {
    return {
      id: 'v1',
      episode: 'e1',
      version: 'p1',
      item: 'i1',
      language: 'hi',
      kind: 'translation',
      variant: 1,
      sourceWording: 'Paracetamol 500 mg orally every 6 hours for 3 days',
      text: '\u092a\u0948\u0930\u093e\u0938\u093f\u091f\u093e\u092e\u0949\u0932 500 mg \u092e\u0941\u0902\u0939 \u0938\u0947 \u0939\u0930 6 \u0918\u0902\u091f\u0947 \u092e\u0947\u0902, 3 \u0926\u093f\u0928 \u0924\u0915',
      producedBy: 'human',
      provider: null,
      model: null,
      reviewState: 'in_review',
      fidelity: { checked: true, passed: true, warnings: [] },
      createdByLabel: 'plan.coordinator@synthetic.invalid',
      submittedAt: '2026-10-01T10:00:00.000Z',
      fidelityNote: null,
      approvedByLabel: null,
      approvedAt: null,
      rejectedByLabel: null,
      rejectedAt: null,
      rejectionReason: null,
      supersededBy: null,
      supersededAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      itemOrder: 1,
      itemKind: 'medication',
      clinicalValues: { medication: 'Paracetamol', dose: '500 mg', frequency: 'every 6 hours', duration: '3 days' },
      ...overrides,
    };
  }

  function languageFetch(rows) {
    const calls = [];
    window.fetch = vi.fn(async (url, options = {}) => {
      const method = options.method || 'GET';
      if (method !== 'GET') {
        calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
        return jsonResponse(200, { variant: rows[0], idempotent: false });
      }
      return jsonResponse(200, { items: rows, total: rows.length, page: 1, limit: 8 });
    });
    return calls;
  }

  const ITEMS = [
    {
      id: 'i1',
      order: 1,
      kind: 'medication',
      originalWording: 'Paracetamol 500 mg orally every 6 hours for 3 days',
      medication: 'Paracetamol',
      dose: '500 mg',
      frequency: 'every 6 hours',
      duration: '3 days',
      unresolvedFields: [],
      clinicalReviewState: 'accepted',
      sourceCount: 1,
      sources: [],
    },
  ];

  it('links a rendering to its instruction and requires a fidelity statement to approve', async () => {
    const calls = languageFetch([variant()]);
    render(
      <LanguagePanel
        episodeId="e1"
        planId="p1"
        items={ITEMS}
        planEditable
        canDraft
        canReview
      />
    );

    // The instruction it renders is shown beside the rendered wording.
    expect(await screen.findByText(/Instruction it renders/)).toBeInTheDocument();
    expect(screen.getAllByText(/Paracetamol 500 mg orally every 6 hours for 3 days/).length).toBeGreaterThan(0);

    const approve = screen.getByRole('button', { name: 'Approve rendering' });
    expect(approve).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText(/State that the meaning is preserved/i),
      'Same dose, frequency and duration. Meaning preserved.'
    );
    await userEvent.click(approve);

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toContain('/variants/v1/approve');
    expect(calls[0].body.fidelityNote).toMatch(/Meaning preserved\./);
  });

  it('shows the number guard warnings that block approval, and never claims meaning is proven', async () => {
    languageFetch([
      variant({
        fidelity: { checked: true, passed: false, warnings: ['missing_number_in_dose'] },
      }),
    ]);
    render(
      <LanguagePanel
        episodeId="e1"
        planId="p1"
        items={ITEMS}
        planEditable
        canDraft
        canReview
      />
    );

    expect(
      await screen.findByText(/The dose number is missing from this wording\./i)
    ).toBeInTheDocument();
    expect(screen.getByText(/never becomes patient-visible on its own/i)).toBeInTheDocument();
  });
});

describe('CarePlanPanel integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authState.roleKey = 'care_coordinator';
  });

  it('offers the AI-assisted tabs beside the manual workflow, not instead of it', async () => {
    const plan = {
      id: 'p1',
      version: 1,
      state: 'draft',
      revision: 2,
      title: null,
      summary: null,
      isCurrent: false,
      editable: true,
      clarificationReason: null,
      approvedAt: null,
      approvedByLabel: null,
      supersededAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    };
    window.fetch = vi.fn(async (url, options = {}) => {
      const method = options.method || 'GET';
      if (method === 'GET' && url.includes('/plans?')) {
        return jsonResponse(200, { items: [plan], total: 1, page: 1, limit: 8 });
      }
      if (method === 'GET' && url.includes('/items')) {
        return jsonResponse(200, { items: [], total: 0, page: 1, limit: 8 });
      }
      if (method === 'GET' && url.endsWith('/plans/p1')) {
        return jsonResponse(200, { plan, items: [], blockers: { approval: [], submit: [] }, events: [] });
      }
      if (method === 'GET' && url.includes('/documents')) {
        return jsonResponse(200, { items: [], total: 0, page: 1, limit: 50 });
      }
      if (method === 'GET' && url.includes('/extraction-jobs') && url.includes('/suggestions')) {
        return jsonResponse(200, { items: [], total: 0, page: 1, limit: 8, planRevision: 2, planState: 'draft' });
      }
      if (method === 'GET' && url.includes('/extraction-jobs')) {
        return jsonResponse(200, { items: [], total: 0, page: 1, limit: 8 });
      }
      return jsonResponse(200, { items: [], total: 0, page: 1, limit: 8 });
    });

    render(<CarePlanPanel episodeId="e1" episodeStatus="draft" />);

    expect(await screen.findByRole('tab', { name: 'Extraction', exact: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Language', exact: true })).toBeInTheDocument();
    // The manual path is still the first tab and still offers its own actions.
    expect(screen.getByRole('tab', { name: 'Draft', exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument();
  });
});
