'use strict';

import ResponsiveTable from '../../components/ResponsiveTable';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

// Privacy requests (Part 9): export, correction and deletion_request.
//
// One panel, two tabs: a paginated request list and a detail view that walks the
// workflow (verify identity, assign, decide, execute). A deletion request is
// presented as an evaluation against retention, never as an instant delete, and
// an export download is a freshly authorized, short-lived link.
const PAGE_SIZE = 10;
const KINDS = [
  { value: 'export', label: 'Export a copy' },
  { value: 'correction', label: 'Correct a detail' },
  { value: 'deletion_request', label: 'Request deletion' },
];
const FIELDS = ['fullName', 'contactEmail', 'contactPhone'];

export default function PrivacyPanel() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ kind: 'export', detail: '', field: 'contactPhone', newValue: '', patientId: '' });
  const [decision, setDecision] = useState({ outcome: 'approved', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [download, setDownload] = useState(null);

  const fail = (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong.');

  const load = useCallback(async (p = 1) => {
    try {
      const data = await api(`/privacy-requests?page=${p}&limit=${PAGE_SIZE}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
      setPage(p);
      setDetail(null);
    } catch (err) { fail(err); }
  }, []);

  useEffect(() => { load(1); }, [load]);

  async function open(id) {
    setError(null); setNotice(null); setDownload(null);
    try {
      setDetail(await api(`/privacy-requests/${id}`));
    } catch (err) { fail(err); }
  }

  async function create(event) {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      const body = { kind: form.kind, detail: form.detail.trim() };
      if (form.kind === 'correction') body.correction = { field: form.field, newValue: form.newValue.trim() };
      // Staff raise a request for a specific patient; a patient's own request
      // ignores this and the server derives the subject from the caller.
      if (form.patientId.trim()) body.patientId = form.patientId.trim();
      await api('/privacy-requests', { method: 'POST', body });
      setNotice('Request received. Identity verification is the next step.');
      setForm({ ...form, detail: '', newValue: '' });
      await load(1);
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function act(path, bodyKey) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api(`/privacy-requests/${detail.request.id}/${path}`, {
        method: 'POST',
        body: bodyKey === undefined ? {} : bodyKey,
      });
      setDetail({ ...detail, ...result, export: detail.export });
      setNotice(`${path.replace(/-/g, ' ')} recorded.`);
      await load(page);
      await open(detail.request.id);
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function authorizeExport() {
    setBusy(true); setError(null);
    try {
      const grant = await api(`/privacy-requests/${detail.request.id}/export/authorize`, { method: 'POST', body: {} });
      setDownload(grant);
      setNotice('Download authorized. The link is short-lived and single-use.');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const request = detail && detail.request;

  return (
    <section className="card card--tabs" aria-labelledby="privacy-title">
      <h1 id="privacy-title">Privacy requests</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <form className="inline-form" onSubmit={create} noValidate>
        <label htmlFor="pr-kind">Type</label>
        <select id="pr-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {form.kind === 'correction' && (
          <>
            <label htmlFor="pr-field">Field</label>
            <select id="pr-field" value={form.field} onChange={(e) => setForm({ ...form, field: e.target.value })}>
              {FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <label htmlFor="pr-value">New value</label>
            <input id="pr-value" value={form.newValue} onChange={(e) => setForm({ ...form, newValue: e.target.value })} />
          </>
        )}
        <label htmlFor="pr-patient">Patient id (staff)</label>
        <input id="pr-patient" value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })} placeholder="Optional" />
        <label htmlFor="pr-detail">What is being asked</label>
        <input
          id="pr-detail"
          value={form.detail}
          maxLength={2000}
          onChange={(e) => setForm({ ...form, detail: e.target.value })}
          placeholder="Describe the request"
        />
        <button type="submit" className="btn btn--primary" disabled={busy || form.detail.trim().length < 5}>
          Raise request
        </button>
      </form>
      <p className="muted">
        A deletion request is evaluated against retention and may be denied or limited. No destructive deletion is performed automatically.
      </p>

      {!request && (
        <div className="panel-scroll">
          <ResponsiveTable>
            <caption className="visually-hidden">Privacy requests</caption>
            <thead>
              <tr><th scope="col">Reference</th><th scope="col">Type</th><th scope="col">State</th><th scope="col">Identity</th><th scope="col">Owner</th><th scope="col">Open</th></tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>{row.reference}</td>
                  <td>{row.kind}</td>
                  <td>{row.state}</td>
                  <td>{row.identity.status}</td>
                  <td className="truncate">{row.ownerLabel || '—'}</td>
                  <td><button type="button" className="btn btn--ghost" onClick={() => open(row.id)}>Open</button></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6}>No privacy requests yet.</td></tr>}
            </tbody>
          </ResponsiveTable>
          <nav className="pager" aria-label="Privacy request pagination">
            <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => load(page - 1)}>Previous</button>
            <span>Page {page} of {pages}</span>
            <button type="button" className="btn btn--ghost" disabled={page >= pages} onClick={() => load(page + 1)}>Next</button>
          </nav>
        </div>
      )}

      {request && (
        <div className="panel-scroll">
          <div className="detail-head">
            <button type="button" className="btn btn--ghost" onClick={() => setDetail(null)}>Back</button>
            <h2>{request.reference}</h2>
            <span className="role-badge">{request.state}</span>
          </div>
          <dl className="summary">
            <dt>Type</dt><dd>{request.kind}</dd>
            <dt>Identity</dt><dd>{request.identity.status}{request.identity.method ? ` (${request.identity.method})` : ''}</dd>
            <dt>Owner</dt><dd>{request.ownerLabel || 'Unassigned'}</dd>
            <dt>Deadline</dt><dd>{request.dueAt ? new Date(request.dueAt).toLocaleDateString() : '—'}</dd>
            <dt>Decision</dt><dd>{request.decision ? `${request.decision.outcome}: ${request.decision.reason}` : 'Not decided'}</dd>
            <dt>Execution</dt><dd>{request.execution.result || 'Not executed'}</dd>
          </dl>

          {request.execution.limited && (
            <p className="muted">This outcome was limited by retention; nothing was destroyed.</p>
          )}

          <div className="pager">
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => act('identity', { method: 'video_call' })}>Verify identity</button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => act('decide', decision)}>Decide</button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => act('execute', request.kind === 'deletion_request' ? { acknowledgeNoDestruction: true } : {})}
            >
              Execute
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => act('cancel', { reason: 'Withdrawn by the requester.' })}>Cancel</button>
          </div>

          <div className="inline-form">
            <label htmlFor="pr-outcome">Decision</label>
            <select id="pr-outcome" value={decision.outcome} onChange={(e) => setDecision({ ...decision, outcome: e.target.value })}>
              <option value="approved">approve</option>
              <option value="denied">deny</option>
            </select>
            <label htmlFor="pr-reason">Reason</label>
            <input id="pr-reason" value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} />
          </div>

          {request.execution.exportArtifact && (
            <div>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={authorizeExport}>Authorize download</button>
              {download && (
                <p className="muted">
                  Link expires {new Date(download.expiresAt).toLocaleTimeString()}. {download.note}
                </p>
              )}
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => act('revoke-export', { reason: 'Withdrawing the generated copy.' })}
              >
                Revoke export
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
