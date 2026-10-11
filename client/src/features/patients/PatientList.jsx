'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

const PAGE_SIZE = 10;
const STEPS = ['Details', 'Review'];

// Staff patient list. Only patients the caller is ACTIVELY assigned to are
// returned by the server, so this list is the caller's own working set, never
// the whole clinic.
export default function PatientList({ onOpen }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ fullName: '', dateOfBirth: '', contactEmail: '', contactPhone: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (query.trim()) params.set('query', query.trim());
      const data = await api(`/patients?${params.toString()}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }, [page, query]);

  useEffect(() => { load(); }, [load]);

  function resetWizard() {
    setWizardOpen(false);
    setStep(0);
    setForm({ fullName: '', dateOfBirth: '', contactEmail: '', contactPhone: '' });
  }

  async function submitNewPatient(event) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = { fullName: form.fullName };
      if (form.dateOfBirth) body.dateOfBirth = form.dateOfBirth;
      if (form.contactEmail) body.contactEmail = form.contactEmail;
      if (form.contactPhone) body.contactPhone = form.contactPhone;
      const data = await api('/patients', { method: 'POST', body });
      resetWizard();
      setNotice('Patient created and you are recorded as the responsible assignee.');
      setPage(1);
      await load();
      if (data.patient && onOpen) onOpen(data.patient.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="card" aria-labelledby="patients-title">
      <h1 id="patients-title">Patients</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      {!wizardOpen && (
        <>
          <div className="inline-form">
            <label htmlFor="patient-search">Search</label>
            <input
              id="patient-search"
              type="search"
              value={query}
              placeholder="Name or reference"
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            />
            <button type="button" className="btn btn--primary" onClick={() => { setNotice(null); setWizardOpen(true); }}>
              New patient
            </button>
          </div>
          <div className="panel-scroll">
            <table className="table">
              <caption className="visually-hidden">Patients assigned to you</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Account</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>{p.reference}</td>
                    <td>{p.fullName}</td>
                    <td>{p.status}</td>
                    <td>{p.hasAccount ? 'linked' : 'invited'}</td>
                    <td className="table__actions">
                      <button type="button" className="btn btn--ghost" onClick={() => onOpen(p.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={5}>No patients are assigned to you yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Pagination">
            <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>Page {page} of {totalPages}</span>
            <button type="button" className="btn btn--ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </nav>
        </>
      )}

      {wizardOpen && (
        <form className="wizard" onSubmit={submitNewPatient} noValidate>
          <ol className="stepper" aria-label="Steps">
            {STEPS.map((label, index) => (
              <li key={label} className={index === step ? 'stepper__item stepper__item--active' : 'stepper__item'} aria-current={index === step ? 'step' : undefined}>
                {index + 1}. {label}
              </li>
            ))}
          </ol>

          {step === 0 && (
            <div className="wizard__body">
              <label htmlFor="np-name">Full name</label>
              <input
                id="np-name"
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              />
              <label htmlFor="np-dob">Date of birth (optional)</label>
              <input
                id="np-dob"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
              />
              <label htmlFor="np-email">Contact email (optional)</label>
              <input
                id="np-email"
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
              />
              <label htmlFor="np-phone">Contact phone (optional)</label>
              <input
                id="np-phone"
                value={form.contactPhone}
                onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
              />
            </div>
          )}

          {step === 1 && (
            <div className="wizard__body">
              <h2>Review</h2>
              <dl className="summary">
                <dt>Name</dt><dd>{form.fullName || '—'}</dd>
                <dt>Date of birth</dt><dd>{form.dateOfBirth || '—'}</dd>
                <dt>Contact email</dt><dd>{form.contactEmail || '—'}</dd>
                <dt>Contact phone</dt><dd>{form.contactPhone || '—'}</dd>
              </dl>
              <p className="muted">The patient is created in draft. Record consent and activate when ready.</p>
            </div>
          )}

          <div className="wizard__actions">
            <button type="button" className="btn btn--ghost" onClick={resetWizard}>Cancel</button>
            {step > 0 && (
              <button type="button" className="btn" onClick={() => setStep(step - 1)}>Back</button>
            )}
            {step < STEPS.length - 1 && (
              <button type="button" className="btn btn--primary" disabled={!form.fullName.trim()} onClick={() => setStep(step + 1)}>
                Continue
              </button>
            )}
            {step === STEPS.length - 1 && (
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? 'Creating…' : 'Create patient'}
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
