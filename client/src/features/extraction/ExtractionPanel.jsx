'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { onTabListKeyDown, tabStop } from '../../lib/tabs';
import {
  AI_AUTHORITY_NOTICE,
  FIELD_PAGE_SIZE,
  PAGE_SIZE,
  PANELS,
  fieldLabel,
  fieldStateClass,
  fieldStateLabel,
  isExtractionDenied,
  isFieldFlagged,
  isStaleExtraction,
  jobStateLabel,
  jobStateNote,
  kindLabel,
  safeExtractionMessage,
  suggestionStateLabel,
} from './extractionRules';

// The AI-assisted extraction review experience for one episode.
//
// What a coordinator can do here: create a job for ONE ready document and the
// current DRAFT version, run it, read the suggestions beside their source, and
// either APPLY one to the draft (an ordinary, actor-attributed draft edit that
// becomes a normal item, still awaiting clinical review) or DISMISS it. What
// nobody can do here: approve, publish, prescribe, change clinical state,
// activate a task or send a reminder. Those actions do not exist in this panel.
//
// When no provider is enabled the job fails closed with a readable code and this
// screen simply says so: the manual Part 5 workflow is unaffected.
export default function ExtractionPanel({
  episodeId,
  planId,
  planEditable,
  readyDocuments,
  canDraft,
  onDenied,
  onApplied,
}) {
  const base = `/episodes/${episodeId}/extraction-jobs`;

  const [jobs, setJobs] = useState({ items: [], total: 0, page: 1 });
  const [jobId, setJobId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [suggestions, setSuggestions] = useState({
    items: [],
    total: 0,
    page: 1,
    planRevision: null,
  });
  const [index, setIndex] = useState(0);
  const [panel, setPanel] = useState('source');
  const [fieldPage, setFieldPage] = useState(1);
  // The values the coordinator ACCEPTS, per field. They start empty: an empty
  // box means "use the suggestion", and a typed value always wins.
  const [values, setValues] = useState({});
  const [dismissReason, setDismissReason] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = useCallback(
    (err) => {
      if (isExtractionDenied(err)) {
        setDetail(null);
        setJobs({ items: [], total: 0, page: 1 });
        setSuggestions({ items: [], total: 0, page: 1, planRevision: null });
        setJobId(null);
        if (onDenied) onDenied(err);
      }
      setError(safeExtractionMessage(err));
    },
    [onDenied]
  );

  const loadJobs = useCallback(
    async (selectId) => {
      try {
        const data = await api(`${base}?page=1&limit=${PAGE_SIZE}`);
        const items = data.items || [];
        setJobs({ items, total: data.total || 0, page: 1 });
        const next = selectId || (items.length ? items[0].id : null);
        setJobId(next);
        return next;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [base, fail]
  );

  const loadJob = useCallback(
    async (id, page = 1) => {
      if (!id) return;
      try {
        const [full, list] = await Promise.all([
          api(`${base}/${id}`),
          api(`${base}/${id}/suggestions?page=${page}&limit=${PAGE_SIZE}`),
        ]);
        setDetail(full);
        setSuggestions({
          items: list.items || [],
          total: list.total || 0,
          page,
          planRevision: list.planRevision,
        });
        setIndex(0);
        setFieldPage(1);
        setValues({});
      } catch (err) {
        fail(err);
      }
    },
    [base, fail]
  );

  useEffect(() => {
    loadJobs().then((id) => {
      if (id) loadJob(id, 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  // Every write re-reads the job, so the screen never keeps a stale projection.
  async function write(run, successMessage, { refreshPlan = false } = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      if (jobId) await loadJob(jobId, suggestions.page);
      if (refreshPlan && onApplied) onApplied();
      if (successMessage) setNotice(successMessage);
      return true;
    } catch (err) {
      fail(err);
      if (isStaleExtraction(err)) {
        if (jobId) await loadJob(jobId, suggestions.page);
        if (refreshPlan && onApplied) onApplied();
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  const current = suggestions.items[index] || null;
  const job = detail && detail.job ? detail.job : null;
  const totalPages = Math.max(1, Math.ceil(suggestions.total / PAGE_SIZE));
  const fields = current ? current.fields : [];
  const fieldPages = Math.max(1, Math.ceil(fields.length / FIELD_PAGE_SIZE));
  const fieldSlice = fields.slice((fieldPage - 1) * FIELD_PAGE_SIZE, fieldPage * FIELD_PAGE_SIZE);
  // A suggestion is decidable while it is neither applied nor dismissed. A
  // `needs_review` suggestion (a missing or conflicting field, or a suspicious
  // instruction) is EXACTLY the one a human must decide: the server accepts an
  // apply with the coordinator's own accepted values, so the client must not
  // disable the only action that resolves it. Applied/dismissed are terminal.
  const decidable = Boolean(current && !['applied', 'dismissed'].includes(current.state));
  const canApply = Boolean(canDraft && planEditable && decidable);
  const canDecide = Boolean(canDraft && decidable);

  // Creating a job writes nothing but a queued record: the document is not read
  // and no provider is called until the job is run.
  async function createJob() {
    if (!documentId || !planId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api(base, { method: 'POST', body: { documentId, versionId: planId } });
      await loadJobs(data.job.id);
      await loadJob(data.job.id, 1);
      setNotice(
        data.deduplicated
          ? 'An identical job already existed, so it was reused instead of creating a second one.'
          : 'Extraction job created. Nothing is read until you run it.'
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function applySuggestion() {
    if (!current) return;
    const overrides = {};
    for (const field of fields) {
      const typed = values[field.field];
      if (typed !== undefined && typed !== null && String(typed).trim() !== '') {
        overrides[field.field] = String(typed).trim();
      }
    }
    await write(
      () =>
        api(`${base}/${jobId}/suggestions/${current.id}/apply`, {
          method: 'POST',
          body: {
            expectedRevision: suggestions.planRevision,
            ...(Object.keys(overrides).length ? { fields: overrides } : {}),
          },
        }),
      'Applied to the draft as a new item, awaiting clinical review. Nothing was approved.',
      { refreshPlan: true }
    );
  }

  return (
    <div className="plans">
      <div className="plans__head">
        <h3>AI-assisted draft extraction</h3>
        {job && <span className="pill">{jobStateLabel(job.state)}</span>}
        {job && job.provider && <span className="pill">provider: {job.provider}</span>}
      </div>
      <p className="muted">{AI_AUTHORITY_NOTICE}</p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="table__actions">
        <label htmlFor="ex-document">Ready document</label>
        <select
          id="ex-document"
          value={documentId}
          onChange={(e) => setDocumentId(e.target.value)}
          disabled={busy || !canDraft}
        >
          <option value="">Select a document…</option>
          {readyDocuments.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.filename}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !canDraft || !documentId || !planId || !planEditable}
          onClick={createJob}
        >
          Start extraction job
        </button>
        {jobs.items.length > 1 && (
          <label htmlFor="ex-job">
            Job
            <select id="ex-job" value={jobId || ''} onChange={(e) => loadJob(e.target.value, 1)}>
              {jobs.items.map((row) => (
                <option key={row.id} value={row.id}>
                  {jobStateLabel(row.state)} · {row.suggestionCount} suggestion(s)
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!planEditable && (
        <p className="muted">
          Suggestions can only target a draft or clarified plan version. An approved version is
          immutable — create a new draft version to change anything.
        </p>
      )}
      {jobs.items.length === 0 && (
        <p className="muted">
          No extraction job yet. Every instruction can be authored by hand on the Draft tab — that
          workflow never depends on this feature.
        </p>
      )}

      {job && (
        <>
          <p className="muted">
            {jobStateNote(job.state)} · {job.suggestionCount} suggestion(s), {job.unresolvedCount}{' '}
            needing a human, {job.rejectedCount} rejected by validation, {job.attempts}/
            {job.maxAttempts} attempt(s){job.inputTruncated ? ' · the document text was truncated' : ''}
          </p>
          {job.errorCode && (
            <p className="error" role="status">
              {job.errorMessage} ({job.errorCode}) — the manual workflow is still available.
            </p>
          )}
          {job.injectionSignalCount > 0 && (
            <p className="notice" role="status">
              The document contains text that tries to instruct the model (
              {job.injectionSignalCount} signal(s) at page/line{' '}
              {job.injectionSignals.map((s) => `${s.page}:${s.line}`).join(', ')}). It was treated
              as data and this job needs a human.
            </p>
          )}
          <div className="table__actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !canDraft || job.terminal}
              onClick={() =>
                write(
                  () => api(`${base}/${jobId}/run`, { method: 'POST' }),
                  'Extraction run finished.'
                )
              }
            >
              Run extraction job
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy || !canDraft || job.terminal}
              onClick={() =>
                write(() => api(`${base}/${jobId}/cancel`, { method: 'POST' }), 'Job cancelled.')
              }
            >
              Cancel job
            </button>
          </div>
        </>
      )}

      {job && !job.errorCode && suggestions.total === 0 && (
        <p className="muted">
          This job produced no suggestion. Every instruction can still be authored by hand on the
          Draft tab.
        </p>
      )}

      {job && current && (
        <div className="plans__split">
          <div className="plans__pane">
            <h3>Suggestions</h3>
            <div className="panel-scroll">
              <ul className="plans__list">
                {suggestions.items.map((row, rowIndex) => (
                  <li
                    key={row.id}
                    className={rowIndex === index ? 'plans__item plans__item--active' : 'plans__item'}
                  >
                    <div className="plans__item-head">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        aria-pressed={rowIndex === index}
                        onClick={() => {
                          setIndex(rowIndex);
                          setFieldPage(1);
                          setValues({});
                        }}
                      >
                        {row.order}. {kindLabel(row.kind)}
                      </button>
                      <span className="pill">{suggestionStateLabel(row.state)}</span>
                    </div>
                    <p className="plans__quote">{row.originalWording.slice(0, 120)}</p>
                    <p className="muted">
                      {row.citationCount} citation(s)
                      {row.missingFields.length
                        ? ` · not stated: ${row.missingFields.map(fieldLabel).join(', ')}`
                        : ''}
                      {row.unresolvedFields.length
                        ? ` · blocking: ${row.unresolvedFields.map(fieldLabel).join(', ')}`
                        : ''}
                    </p>
                  </li>
                ))}
                {suggestions.items.length === 0 && (
                  <li className="muted">
                    This job produced no suggestion. Draft the instructions by hand.
                  </li>
                )}
              </ul>
              <nav className="pager" aria-label="Suggestion pagination">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={suggestions.page <= 1 || busy}
                  onClick={() => loadJob(jobId, suggestions.page - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {suggestions.page} of {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={suggestions.page >= totalPages || busy}
                  onClick={() => loadJob(jobId, suggestions.page + 1)}
                >
                  Next
                </button>
              </nav>
            </div>
          </div>

          <div className="plans__pane">
            <div
              className="tabs"
              role="tablist"
              aria-label="Suggestion panels"
              onKeyDown={(event) =>
                onTabListKeyDown(event, PANELS.map(([name]) => name), panel, setPanel)
              }
            >
              {PANELS.map(([name, label]) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={panel === name}
                  tabIndex={tabStop(name, panel)}
                  className={panel === name ? 'tab tab--active' : 'tab'}
                  onClick={() => setPanel(name)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="panel-scroll">
              {panel === 'source' && (
                <div>
                  <h3>Where this came from</h3>
                  <p className="muted">
                    The wording is quoted from the document exactly as written; nothing is normalised
                    on display.
                  </p>
                  {current.citations.map((citation) => (
                    <div key={citation.id} className="plans__source">
                      <strong>
                        {citation.documentFilename || 'Document'} · {citation.location || `Page ${citation.page}`}
                      </strong>
                      <span className={`pill ${citation.verified ? 'pill--ready' : 'pill--rejected'}`}>
                        {citation.verified ? 'Verified against the source' : 'Not verified'}
                      </span>
                      <p className="plans__quote">{citation.text}</p>
                    </div>
                  ))}
                  {current.citations.length === 0 && (
                    <p className="error" role="status">
                      This suggestion has no verifiable source and cannot be applied.
                    </p>
                  )}
                </div>
              )}

              {panel === 'ai' && (
                <div>
                  <h3>What the model proposed</h3>
                  <p className="muted">
                    Confidence is the model&apos;s own claim, not a measured probability:{' '}
                    {current.confidence === null ? 'not reported' : current.confidence}. The state of
                    each field is decided by the server.
                  </p>
                  <ul className="plans__list">
                    {fieldSlice.map((field) => (
                      <li key={field.field} className="plans__item">
                        <div className="plans__item-head">
                          <strong>{fieldLabel(field.field)}</strong>
                          <span className={`pill ${fieldStateClass(field.state)}`}>
                            {fieldStateLabel(field.state)}
                          </span>
                        </div>
                        <p>{field.value || '—'}</p>
                        {field.evidenceText && (
                          <p className="plans__quote">Source: {field.evidenceText.slice(0, 160)}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                  {fieldPages > 1 && (
                    <nav className="pager" aria-label="Field pagination">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={fieldPage <= 1}
                        onClick={() => setFieldPage(fieldPage - 1)}
                      >
                        Previous fields
                      </button>
                      <span>
                        Fields {fieldPage} of {fieldPages}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={fieldPage >= fieldPages}
                        onClick={() => setFieldPage(fieldPage + 1)}
                      >
                        Next fields
                      </button>
                    </nav>
                  )}
                </div>
              )}

              {panel === 'manual' && (
                <div>
                  <h3>The value you accept</h3>
                  <p className="muted">
                    A box left empty keeps the suggestion. Anything you type overrides it and is what
                    the draft receives — this is the moment the suggestion stops being AI output and
                    becomes your clinical entry.
                  </p>
                  {fieldSlice.map((field) => (
                    <div key={field.field}>
                      <label htmlFor={`ex-field-${field.field}`}>
                        {fieldLabel(field.field)}
                        {isFieldFlagged(field) ? ` — ${fieldStateLabel(field.state)}` : ''}
                      </label>
                      <input
                        id={`ex-field-${field.field}`}
                        maxLength={200}
                        value={values[field.field] === undefined ? field.value || '' : values[field.field]}
                        onChange={(e) => setValues({ ...values, [field.field]: e.target.value })}
                        disabled={!canApply || busy}
                      />
                    </div>
                  ))}
                  {fieldPages > 1 && (
                    <nav className="pager" aria-label="Accepted value pagination">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={fieldPage <= 1}
                        onClick={() => setFieldPage(fieldPage - 1)}
                      >
                        Previous fields
                      </button>
                      <span>
                        Fields {fieldPage} of {fieldPages}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={fieldPage >= fieldPages}
                        onClick={() => setFieldPage(fieldPage + 1)}
                      >
                        Next fields
                      </button>
                    </nav>
                  )}
                </div>
              )}

              {panel === 'decision' && (
                <div>
                  <h3>Decision</h3>
                  <p className="muted">
                    Apply creates ONE new item in the draft version, attributed to you and cited to
                    the same source text. It stays “awaiting clinical review” until an assigned
                    clinical reviewer accepts it, and the plan still needs explicit approval before a
                    patient sees anything.
                  </p>
                  <div className="wizard__actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={!canApply || busy || current.citations.length === 0}
                      onClick={applySuggestion}
                    >
                      Apply to draft
                    </button>
                  </div>

                  <label htmlFor="ex-dismiss">Dismiss this suggestion</label>
                  <input
                    id="ex-dismiss"
                    maxLength={300}
                    value={dismissReason}
                    onChange={(e) => setDismissReason(e.target.value)}
                    disabled={!canDecide || busy}
                  />
                  <div className="wizard__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={!canDecide || busy || dismissReason.trim().length < 2}
                      onClick={() =>
                        write(
                          () =>
                            api(`${base}/${jobId}/suggestions/${current.id}/dismiss`, {
                              method: 'POST',
                              body: { reason: dismissReason.trim() },
                            }),
                          'Suggestion dismissed. Nothing changed in the draft.'
                        ).then((ok) => {
                          if (ok) setDismissReason('');
                        })
                      }
                    >
                      Dismiss suggestion
                    </button>
                  </div>
                  <p className="muted">
                    There is no approve or publish action here by design: an extraction suggestion
                    cannot change clinical state, activate a task or send a reminder.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
