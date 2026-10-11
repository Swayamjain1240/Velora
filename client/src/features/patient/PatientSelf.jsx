'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

const SCOPES = ['view_profile', 'view_episodes', 'view_documents', 'view_plan', 'view_tasks'];

// The patient's own view. Access is by OWNERSHIP of the profile; there is no
// clinic-wide permission here, so a patient can never browse other records.
export default function PatientSelf() {
  const [patient, setPatient] = useState(null);
  const [caregivers, setCaregivers] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ email: '', scopes: ['view_profile'] });

  const fail = useCallback((err) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
      setPatient(null);
      setCaregivers([]);
    }
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api('/patient/me/profile');
      setPatient(data.patient);
      const grants = await api(`/patient/me/${data.patient.id}/caregivers`);
      setCaregivers(grants.items || []);
    } catch (err) { fail(err); }
  }, [fail]);

  useEffect(() => { load(); }, [load]);

  async function invite(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    try {
      const data = await api(`/patient/me/${patient.id}/caregivers`, {
        method: 'POST',
        body: { email: form.email, scopes: form.scopes },
      });
      setForm({ email: '', scopes: ['view_profile'] });
      setNotice(`Invitation link: ${window.location.origin}/caregiver-invite/${data.invitation.token}`);
      await load();
    } catch (err) { fail(err); }
  }

  async function revoke(grantId) {
    setError(null); setNotice(null);
    try {
      await api(`/patient/me/${patient.id}/caregivers/${grantId}`, { method: 'DELETE' });
      await load();
    } catch (err) { fail(err); }
  }

  if (!patient) {
    return (
      <section className="card">
        {error && <p className="error" role="alert">{error}</p>}
        <p className="muted">No patient record is linked to this account.</p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="self-title">
      <h1 id="self-title">My records</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <dl className="summary">
        <dt>Reference</dt><dd>{patient.reference}</dd>
        <dt>Name</dt><dd>{patient.fullName}</dd>
        <dt>Status</dt><dd>{patient.status}</dd>
        <dt>Contact email</dt><dd>{patient.contactEmail || '—'}</dd>
      </dl>

      <h2>People I have shared my record with</h2>
      <form className="inline-form" onSubmit={invite} noValidate>
        <label htmlFor="ps-email">Caregiver email</label>
        <input id="ps-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <fieldset className="scopes">
          <legend>Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                checked={form.scopes.includes(s)}
                onChange={(e) => setForm({
                  ...form,
                  scopes: e.target.checked ? [...form.scopes, s] : form.scopes.filter((x) => x !== s),
                })}
              />
              {s.replace(/_/g, ' ')}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn btn--primary" disabled={!form.email || form.scopes.length === 0}>Share</button>
      </form>

      <div className="panel-scroll">
        <table className="table">
          <caption className="visually-hidden">Caregivers you have shared with</caption>
          <thead>
            <tr><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Scopes</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {caregivers.map((g) => (
              <tr key={g.id}>
                <td>{g.email}</td>
                <td>{g.status}</td>
                <td>{(g.scopes || []).join(', ')}</td>
                <td className="table__actions">
                  {g.status !== 'revoked' && (
                    <button type="button" className="btn btn--ghost" onClick={() => revoke(g.id)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
            {caregivers.length === 0 && <tr><td colSpan={4}>You have not shared your record with anyone.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
