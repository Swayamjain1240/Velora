'use strict';

import ResponsiveTable from '../../components/ResponsiveTable';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

// Scoped, paginated audit search (Part 9). The category filters come from the
// server catalog so the UI can never offer one the API would reject, and the
// redaction note tells the reader what the trail deliberately does not contain.
const PAGE_SIZE = 20;

export default function AuditPanel() {
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ category: '', outcome: '', subjectId: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, note: '' });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (filters.category) params.set('category', filters.category);
      if (filters.outcome) params.set('outcome', filters.outcome);
      if (filters.subjectId) params.set('subjectId', filters.subjectId.trim());
      const result = await api(`/audit?${params.toString()}`);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setData({ items: [], total: 0, note: '' });
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  // The category list is derived from what the caller can actually search: the
  // known categories come from the same catalog the API validates against.
  useEffect(() => {
    const known = [
      'auth', 'read', 'download', 'membership', 'caregiver_grant', 'approval',
      'ai_application', 'log_write', 'checkin_response', 'clarification_response',
      'privacy_request', 'retention', 'closure', 'export', 'admin',
    ];
    setCategories(known);
  }, []);

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <section className="card card--tabs" aria-labelledby="audit-title">
      <h1 id="audit-title">Audit trail</h1>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted">{data.note}</p>

      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <label htmlFor="audit-category">Category</label>
        <select id="audit-category" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
        </select>
        <label htmlFor="audit-outcome">Outcome</label>
        <select id="audit-outcome" value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
          <option value="">Any outcome</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
          <option value="denied">denied</option>
        </select>
        <label htmlFor="audit-subject">Record id</label>
        <input id="audit-subject" value={filters.subjectId} onChange={(e) => setFilters({ ...filters, subjectId: e.target.value })} />
        <button type="submit" className="btn btn--primary" disabled={loading}>Search</button>
      </form>

      <div className="panel-scroll">
        <ResponsiveTable>
          <caption className="visually-hidden">Audit events</caption>
          <thead>
            <tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Category</th><th scope="col">Actor</th><th scope="col">Outcome</th></tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.at).toLocaleString()}</td>
                <td className="truncate">{row.action}</td>
                <td>{row.category}</td>
                <td className="truncate">{row.actorLabel || '—'}</td>
                <td>{row.outcome}</td>
              </tr>
            ))}
            {data.items.length === 0 && <tr><td colSpan={5}>{loading ? 'Loading…' : 'No events match this search.'}</td></tr>}
          </tbody>
        </ResponsiveTable>
      </div>

      <nav className="pager" aria-label="Audit pagination">
        <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pages}</span>
        <button type="button" className="btn btn--ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </nav>
    </section>
  );
}
