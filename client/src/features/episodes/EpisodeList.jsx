'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

const PAGE_SIZE = 10;
const STEPS = ['Patient', 'Discharge', 'Review'];

// A short, familiar list of timezones for the picker; any IANA zone can be typed.
const COMMON_ZONES = [
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

// Staff episode list. Only episodes the caller is actively on the team of are
// returned, so this is the caller's own working set.
export default function EpisodeList({ onOpen }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [patients, setPatients] = useState([]);
  const [form, setForm] = useState({
    patientId: '',
    dischargeDate: '',
    dischargeTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api(`/episodes?page=${page}&limit=${PAGE_SIZE}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  async function openWizard() {
    setError(null); setNotice(null); setStep(0); setWizardOpen(true);
    try {
      const data = await api('/patients?page=1&limit=50');
      setPatients(data.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  function resetWizard() {
    setWizardOpen(false);
    setStep(0);
    setForm({ patientId: '', dischargeDate: '', dischargeTimezone: form.dischargeTimezone });
  }

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const data = await api('/episodes', {
        method: 'POST',
        body: {
          patientId: form.patientId,
          dischargeDate: form.dischargeDate,
          dischargeTimezone: form.dischargeTimezone,
        },
      });
      resetWizard();
      setNotice('Episode created. You are recorded as the care coordinator.');
      setPage(1);
      await load();
      if (data.episode && onOpen) onOpen(data.episode.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedPatient = patients.find((p) => p.id === form.patientId);

  return (
    <section className="card" aria-labelledby="episodes-title">
      <h1 id="episodes-title">Recovery episodes</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      {!wizardOpen && (
        <>
          <div className="inline-form">
            <button type="button" className="btn btn--primary" onClick={openWizard}>New episode</button>
          </div>
          <div className="panel-scroll">
            <table className="table">
              <caption className="visually-hidden">Episodes you are on the team of</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Discharge</th>
                  <th scope="col">Timezone</th>
                  <th scope="col">Status</th>
                  <th scope="col">Rev</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td>{e.reference}</td>
                    <td>{e.dischargeDate}</td>
                    <td>{e.dischargeTimezone}</td>
                    <td>{e.status}</td>
                    <td>{e.revision}</td>
                    <td className="table__actions">
                      <button type="button" className="btn btn--ghost" onClick={() => onOpen(e.id)}>Open</button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && <tr><td colSpan={6}>No episodes are assigned to you yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Pagination">
            <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button type="button" className="btn btn--ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
          </nav>
        </>
      )}

      {wizardOpen && (
        <form className="wizard" onSubmit={submit} noValidate>
          <ol className="stepper" aria-label="Steps">
            {STEPS.map((label, index) => (
              <li key={label} className={index === step ? 'stepper__item stepper__item--active' : 'stepper__item'} aria-current={index === step ? 'step' : undefined}>
                {index + 1}. {label}
              </li>
            ))}
          </ol>

          {step === 0 && (
            <div className="wizard__body">
              <label htmlFor="ep-patient">Patient</label>
              <select id="ep-patient" value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })}>
                <option value="">Select a patient…</option>
                {patients.map((p) => <option key={p.id} value={p.id}>{p.reference} — {p.fullName}</option>)}
              </select>
            </div>
          )}

          {step === 1 && (
            <div className="wizard__body">
              <label htmlFor="ep-date">Discharge date</label>
              <input id="ep-date" type="date" value={form.dischargeDate} onChange={(e) => setForm({ ...form, dischargeDate: e.target.value })} />
              <label htmlFor="ep-tz">Discharge timezone (IANA)</label>
              <input id="ep-tz" list="ep-tz-list" value={form.dischargeTimezone} onChange={(e) => setForm({ ...form, dischargeTimezone: e.target.value })} />
              <datalist id="ep-tz-list">
                {COMMON_ZONES.map((z) => <option key={z} value={z} />)}
              </datalist>
            </div>
          )}

          {step === 2 && (
            <div className="wizard__body">
              <h2>Review</h2>
              <dl className="summary">
                <dt>Patient</dt><dd>{selectedPatient ? `${selectedPatient.reference} — ${selectedPatient.fullName}` : '—'}</dd>
                <dt>Discharge date</dt><dd>{form.dischargeDate || '—'}</dd>
                <dt>Timezone</dt><dd>{form.dischargeTimezone || '—'}</dd>
              </dl>
              <p className="muted">The episode is created in draft. Discharge details can be corrected while it stays draft.</p>
            </div>
          )}

          <div className="wizard__actions">
            <button type="button" className="btn btn--ghost" onClick={resetWizard}>Cancel</button>
            {step > 0 && <button type="button" className="btn" onClick={() => setStep(step - 1)}>Back</button>}
            {step < STEPS.length - 1 && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={step === 0 ? !form.patientId : !form.dischargeDate || !form.dischargeTimezone}
                onClick={() => setStep(step + 1)}
              >
                Continue
              </button>
            )}
            {step === STEPS.length - 1 && (
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? 'Creating…' : 'Create episode'}
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
