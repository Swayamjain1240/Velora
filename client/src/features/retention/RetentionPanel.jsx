'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

// Retention (Part 9). A dry-run view first: categories, their windows, what is
// eligible and what a hold freezes. Applying is a separate, deliberate action
// that requires an operator and a reason, and clinical categories are shown as
// report-only because automated destruction of those records is not implemented.
export default function RetentionPanel() {
  const [categories, setCategories] = useState([]);
  const [plan, setPlan] = useState([]);
  const [holds, setHolds] = useState([]);
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong.');

  const load = useCallback(async () => {
    try {
      const [cats, holdRows] = await Promise.all([
        api('/retention/categories'),
        api('/retention/holds?page=1&limit=10'),
      ]);
      setCategories(cats.categories || []);
      setHolds(holdRows.items || []);
    } catch (err) { fail(err); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function dryRun() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api('/retention/dry-run', { method: 'POST', body: {} });
      setPlan(result.plan || []);
      setNotice('Dry run complete. Nothing was changed.');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api('/retention/apply', {
        method: 'POST',
        body: {
          operator: operator.trim(),
          reason: reason.trim(),
          clientRequestId: `ui-${Date.now()}`,
          confirm: true,
        },
      });
      setNotice(`Retention run ${result.run.result}.`);
      await dryRun();
      await load();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function createHold(category) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api('/retention/holds', {
        method: 'POST',
        body: { scope: 'category', category, reason: 'Placed from the retention console.' },
      });
      setNotice(`Hold placed on ${category}.`);
      await load();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  return (
    <section className="card card--tabs" aria-labelledby="retention-title">
      <h1 id="retention-title">Retention</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <p className="muted">
        A dry run reports what would be eligible. Applying requires an operator and a reason, is bounded and
        idempotent, and never destroys clinical records automatically.
      </p>

      <div className="pager">
        <button type="button" className="btn btn--primary" disabled={busy} onClick={dryRun}>Run dry run</button>
      </div>

      <div className="panel-scroll">
        <table className="table">
          <caption className="visually-hidden">Retention categories</caption>
          <thead>
            <tr><th scope="col">Category</th><th scope="col">Window</th><th scope="col">Eligible</th><th scope="col">Held</th><th scope="col">Mode</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {categories.map((category) => {
              const row = plan.find((p) => p.category === category.key) || {};
              return (
                <tr key={category.key}>
                  <td className="truncate">{category.label}</td>
                  <td>{category.retainDays}d</td>
                  <td>{row.eligible ?? '—'}</td>
                  <td>{row.held ?? 0}</td>
                  <td>{category.reportOnly ? 'report-only' : 'applied'}</td>
                  <td className="table__actions">
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => createHold(category.key)}>
                      Hold
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <fieldset className="scopes">
          <legend>Apply a retention run</legend>
          <label htmlFor="ret-operator">Operator</label>
          <input id="ret-operator" value={operator} onChange={(e) => setOperator(e.target.value)} maxLength={200} />
          <label htmlFor="ret-reason">Reason</label>
          <input id="ret-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || operator.trim().length < 3 || reason.trim().length < 10}
            onClick={apply}
          >
            Apply retention
          </button>
        </fieldset>

        {holds.length > 0 && (
          <>
            <h2>Active holds</h2>
            <ul className="care-list">
              {holds.map((hold) => (
                <li key={hold.id} className="care-list__item">
                  <span className="care-list__title">{hold.category}</span>
                  <span className="muted">{hold.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
