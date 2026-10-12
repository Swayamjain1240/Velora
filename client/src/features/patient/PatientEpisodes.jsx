'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import DocumentsPanel from '../documents/DocumentsPanel';
import PatientPlan from './PatientPlan';

const PAGE_SIZE = 10;

// The patient's own recovery episodes. Access is by OWNERSHIP of the profile;
// there is no clinic-wide permission and no caregiver path here.
export default function PatientEpisodes() {
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
      const data = await api(`/patient/me/episodes?page=${page}&limit=${PAGE_SIZE}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) { fail(err); }
  }, [page, fail]);

  useEffect(() => { load(); }, [load]);

  async function open(episodeId) {
    setError(null);
    try {
      const data = await api(`/patient/me/episodes/${episodeId}`);
      setSelected(data.episode);
    } catch (err) { fail(err); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (selected) {
    return (
      <section className="card" aria-labelledby="pe-title">
        <button type="button" className="btn btn--ghost" onClick={() => setSelected(null)}>Back</button>
        <h1 id="pe-title">{selected.reference}</h1>
        <dl className="summary">
          <dt>Discharge date</dt><dd>{selected.dischargeDate}</dd>
          <dt>Timezone</dt><dd>{selected.dischargeTimezone}</dd>
          <dt>Status</dt><dd>{selected.status}</dd>
        </dl>
        <p className="muted">Your care team reviews the discharge details. Contact them if something looks wrong.</p>
        {/* Part 5: only the CURRENT APPROVED plan is ever rendered here - the
            server never sends drafts or reviewer working state to this role. */}
        <PatientPlan episodeId={selected.id} />
        {/* Read and download only: a patient can never upload a document, and
            every request re-resolves ownership on the server. */}
        <DocumentsPanel
          episodeId={selected.id}
          basePath={`/patient/me/episodes/${selected.id}`}
          canUpload={false}
          readOnlyReason="Only your care team can upload documents."
          onDenied={fail}
        />
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="pe-list-title">
      <h1 id="pe-list-title">My recovery episodes</h1>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="panel-scroll">
        <table className="table">
          <caption className="visually-hidden">Your episodes</caption>
          <thead>
            <tr><th scope="col">Reference</th><th scope="col">Discharge</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td>{e.reference}</td>
                <td>{e.dischargeDate}</td>
                <td>{e.status}</td>
                <td className="table__actions">
                  <button type="button" className="btn btn--ghost" onClick={() => open(e.id)}>Open</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4}>No recovery episodes are linked to your record.</td></tr>}
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
