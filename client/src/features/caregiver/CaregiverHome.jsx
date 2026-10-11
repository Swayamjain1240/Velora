'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

const PAGE_SIZE = 10;

// The caregiver's scoped view. A caregiver holds no clinic-wide permission: the
// server only returns patients an ACTIVE, unexpired grant authorises, and only
// for scopes that were actually granted (Part 2 honours view_profile).
export default function CaregiverHome() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  const fail = useCallback((err) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
      setItems([]);
      setTotal(0);
      setSelected(null);
    }
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api(`/caregiver/me/patients?page=${page}&limit=${PAGE_SIZE}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) { fail(err); }
  }, [page, fail]);

  useEffect(() => { load(); }, [load]);

  async function open(patientId) {
    setError(null);
    try {
      const data = await api(`/caregiver/me/patients/${patientId}`);
      setSelected(data.patient);
    } catch (err) { fail(err); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (selected) {
    return (
      <section className="card" aria-labelledby="cg-detail-title">
        <button type="button" className="btn btn--ghost" onClick={() => setSelected(null)}>Back</button>
        <h1 id="cg-detail-title">{selected.fullName}</h1>
        <dl className="summary">
          <dt>Reference</dt><dd>{selected.reference}</dd>
          <dt>Status</dt><dd>{selected.status}</dd>
          <dt>Scopes</dt><dd>{(selected.scopes || []).join(', ')}</dd>
        </dl>
        <p className="muted">You are seeing the profile only. Episode, document, plan and task access require separate scopes.</p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="cg-title">
      <h1 id="cg-title">People who shared their care with me</h1>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="panel-scroll">
        <table className="table">
          <caption className="visually-hidden">Patients shared with you</caption>
          <thead>
            <tr><th scope="col">Reference</th><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.reference}</td>
                <td>{p.fullName}</td>
                <td>{p.status}</td>
                <td className="table__actions">
                  <button type="button" className="btn btn--ghost" onClick={() => open(p.id)}>Open</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4}>Nobody has shared their record with you.</td></tr>}
          </tbody>
        </table>
      </div>
      <nav className="pager" aria-label="Pagination">
        <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {totalPages}</span>
        <button type="button" className="btn btn--ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
      </nav>
    </section>
  );
}
