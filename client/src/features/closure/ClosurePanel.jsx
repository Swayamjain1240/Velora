'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

// Episode closure, history and reopen (Part 9). A three-step wizard keeps the
// preflight, the clinic-policy checks and the confirmation inside one viewport;
// the history and reopen live behind a switch so a long list never pushes the
// page taller than the shell.
//
// Closure is presented as an OPERATIONAL archive step. The server owns the
// wording and refuses a reason that reads as a clinical outcome.
const STEPS = ['preflight', 'checks', 'confirm'];

export default function ClosurePanel({ episodeId, episode, onChanged }) {
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState('wizard');
  const [preflight, setPreflight] = useState(null);
  const [history, setHistory] = useState({ items: [], total: 0, page: 1, retentionHolds: [] });
  const [reason, setReason] = useState('');
  const [closureDate, setClosureDate] = useState('');
  const [checks, setChecks] = useState({});
  const [overrides, setOverrides] = useState({});
  const [reopenReason, setReopenReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = useCallback((err) => {
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }, []);

  const loadPreflight = useCallback(async () => {
    try {
      const data = await api(`/episodes/${episodeId}/closure/preflight`);
      setPreflight(data);
      const next = {};
      for (const check of data.policyChecks || []) next[check.key] = false;
      setChecks(next);
    } catch (err) { fail(err); }
  }, [episodeId, fail]);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const data = await api(`/episodes/${episodeId}/closure?page=${page}&limit=10`);
      setHistory({ ...data, page });
    } catch (err) { fail(err); }
  }, [episodeId, fail]);

  useEffect(() => { loadPreflight(); }, [loadPreflight]);
  useEffect(() => { if (tab === 'history') loadHistory(1); }, [tab, loadHistory]);

  const blocking = (preflight && preflight.blocking) || [];
  const unresolved = (preflight && preflight.unresolved) || [];
  const cleared = blocking.filter((key) => (overrides[key] || '').trim().length >= 5);
  const checksComplete = preflight
    ? (preflight.policyChecks || []).every((c) => checks[c.key])
    : false;
  const canConfirm = blocking.length === cleared.length && checksComplete && reason.trim().length >= 5;

  async function submitClose() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const body = {
        expectedRevision: preflight.episode.revision,
        reason: reason.trim(),
        policyChecks: (preflight.policyChecks || []).map((c) => ({ key: c.key, confirmed: true })),
        overrides: blocking
          .filter((key) => (overrides[key] || '').trim().length >= 5)
          .map((key) => ({ key, reason: overrides[key].trim() })),
        confirm: true,
      };
      if (closureDate) body.closureDate = closureDate;
      await api(`/episodes/${episodeId}/closure`, { method: 'POST', body });
      setNotice('Episode closed. Records are archived as read-only.');
      setStep(0);
      setReason('');
      await loadPreflight();
      await loadHistory(1);
      await onChanged?.();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function submitReopen() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api(`/episodes/${episodeId}/closure/reopen`, {
        method: 'POST',
        body: { expectedRevision: preflight.episode.revision, reason: reopenReason.trim(), confirm: true },
      });
      setNotice('Episode reopened. Stopped work stays stopped until it is created again.');
      setReopenReason('');
      await loadPreflight();
      await loadHistory(1);
      await onChanged?.();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  if (!preflight) {
    return (
      <div>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="muted">Loading the closure preflight…</p>
      </div>
    );
  }

  const closed = preflight.episode.closureState === 'closed';
  const pages = Math.max(1, Math.ceil(history.total / 10));

  return (
    <div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="tabs" role="tablist" aria-label="Closure sections">
        <button
          type="button" role="tab" aria-selected={tab === 'wizard'}
          className={tab === 'wizard' ? 'tab tab--active' : 'tab'}
          onClick={() => setTab('wizard')}
        >Preflight</button>
        <button
          type="button" role="tab" aria-selected={tab === 'history'}
          className={tab === 'history' ? 'tab tab--active' : 'tab'}
          onClick={() => setTab('history')}
        >History</button>
      </div>

      {tab === 'wizard' && (
        <div className="panel-scroll">
          <p className="muted">
            {episode && episode.reference ? `${episode.reference}: ` : ''}
            {preflight.meaning}
          </p>
          <ol className="stepper" aria-label="Closure steps">
            {STEPS.map((label, index) => (
              <li key={label} className={index === step ? 'stepper__item stepper__item--active' : 'stepper__item'}>
                {index + 1}. {label}
              </li>
            ))}
          </ol>

          {step === 0 && (
            <div>
              <table className="table">
                <caption className="visually-hidden">Closure preflight</caption>
                <thead>
                  <tr><th scope="col">Outstanding work</th><th scope="col">Count</th><th scope="col">Blocks closure</th></tr>
                </thead>
                <tbody>
                  {preflight.items.map((item) => (
                    <tr key={item.key}>
                      <td>{item.label}</td>
                      <td>{item.count}</td>
                      <td>{item.blocking ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">
                {unresolved.length
                  ? `${unresolved.length} item(s) still need attention.`
                  : 'Nothing outstanding was found.'}
              </p>
              <button type="button" className="btn btn--primary" onClick={() => setStep(1)} disabled={closed}>
                Continue to policy checks
              </button>
            </div>
          )}

          {step === 1 && (
            <div>
              <fieldset className="scopes">
                <legend>Clinic-policy checks</legend>
                {(preflight.policyChecks || []).map((check) => (
                  <label key={check.key} className="check">
                    <input
                      type="checkbox"
                      checked={Boolean(checks[check.key])}
                      onChange={(e) => setChecks({ ...checks, [check.key]: e.target.checked })}
                    />
                    <span>{check.key.replace(/_/g, ' ')}</span>
                  </label>
                ))}
              </fieldset>
              <label htmlFor="closure-reason">Reason</label>
              <input
                id="closure-reason"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What operational step is this?"
              />
              <label htmlFor="closure-date">Closure date</label>
              <input id="closure-date" type="date" value={closureDate} onChange={(e) => setClosureDate(e.target.value)} />
              <div className="pager">
                <button type="button" className="btn btn--ghost" onClick={() => setStep(0)}>Back</button>
                <button type="button" className="btn btn--primary" onClick={() => setStep(2)} disabled={!checksComplete || closed}>
                  Review
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              {blocking.length > 0 && (
                <fieldset className="scopes">
                  <legend>Blocking items need a written reason</legend>
                  {blocking.map((key) => (
                    <div key={key}>
                      <label htmlFor={`override-${key}`}>{key.replace(/_/g, ' ')}</label>
                      <input
                        id={`override-${key}`}
                        value={overrides[key] || ''}
                        maxLength={300}
                        onChange={(e) => setOverrides({ ...overrides, [key]: e.target.value })}
                        placeholder="Why can this be closed anyway?"
                      />
                    </div>
                  ))}
                </fieldset>
              )}
              <p className="muted">{closed ? 'This episode is already closed.' : 'Closing archives this episode as read-only.'}</p>
              <div className="pager">
                <button type="button" className="btn btn--ghost" onClick={() => setStep(1)}>Back</button>
                <button type="button" className="btn btn--primary" onClick={submitClose} disabled={!canConfirm || busy || closed}>
                  {busy ? 'Closing…' : 'Close episode'}
                </button>
              </div>
            </div>
          )}

          {closed && (
            <div>
              <h2>Reopen</h2>
              <p className="muted">{preflight.reopenMeaning}</p>
              <label htmlFor="reopen-reason">Reason</label>
              <input
                id="reopen-reason"
                value={reopenReason}
                maxLength={500}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="Why is coordination resuming?"
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={submitReopen}
                disabled={busy || reopenReason.trim().length < 5}
              >
                {busy ? 'Reopening…' : 'Reopen episode'}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="panel-scroll">
          {history.retentionHolds && history.retentionHolds.length > 0 && (
            <p className="muted">
              Active retention holds: {history.retentionHolds.map((h) => h.category).join(', ')}
            </p>
          )}
          <table className="table">
            <caption className="visually-hidden">Closure history</caption>
            <thead>
              <tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Reason</th><th scope="col">By</th><th scope="col">Checks</th></tr>
            </thead>
            <tbody>
              {history.items.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.at).toLocaleString()}</td>
                  <td>{row.action}</td>
                  <td className="truncate">{row.reason}</td>
                  <td className="truncate">{row.actorLabel || '—'}</td>
                  <td>{row.policyChecks.length ? row.policyChecks.filter((c) => c.confirmed).length : '—'}</td>
                </tr>
              ))}
              {history.items.length === 0 && <tr><td colSpan={5}>No closure events yet.</td></tr>}
            </tbody>
          </table>
          <nav className="pager" aria-label="Closure history pagination">
            <button type="button" className="btn btn--ghost" disabled={history.page <= 1} onClick={() => loadHistory(history.page - 1)}>Previous</button>
            <span>Page {history.page} of {pages}</span>
            <button type="button" className="btn btn--ghost" disabled={history.page >= pages} onClick={() => loadHistory(history.page + 1)}>Next</button>
          </nav>
        </div>
      )}
    </div>
  );
}
