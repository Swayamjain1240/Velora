'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

const PAGE_SIZE = 10;
const TABS = ['overview', 'consent', 'caregivers', 'team'];
const CATEGORIES = ['care_coordination', 'caregiver_access', 'future_ai_assistance'];
const SCOPES = ['view_profile', 'view_episodes', 'view_documents', 'view_plan', 'view_tasks', 'log_tasks'];
// `log_tasks` is a WRITE scope (Part 7): it lets a caregiver record an entry on
// the patient's behalf and is never implied by `view_tasks`, so the label says
// so plainly rather than reading like another read scope.
const SCOPE_LABELS = { log_tasks: 'log tasks (record entries on the patient\u2019s behalf)' };

// Staff patient detail. Each tab is a single scroll region inside the fixed
// shell, so the authenticated page never scrolls (control #25).
export default function PatientDetail({ patientId, onBack }) {
  const [patient, setPatient] = useState(null);
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [consent, setConsent] = useState({ items: [], total: 0, page: 1 });
  const [caregivers, setCaregivers] = useState([]);
  const [team, setTeam] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [consentForm, setConsentForm] = useState({ action: 'granted', purpose: '', categories: ['care_coordination'] });
  const [caregiverForm, setCaregiverForm] = useState({ email: '', scopes: ['view_profile'] });
  const [assigneeId, setAssigneeId] = useState('');
  const [activationEmail, setActivationEmail] = useState('');

  const fail = useCallback((err) => {
    // Authorization loss clears everything on screen: a denied refresh must
    // never leave previously loaded clinical data visible (control #3/#5).
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
      setPatient(null);
      setConsent({ items: [], total: 0, page: 1 });
      setCaregivers([]);
      setTeam([]);
      setCandidates([]);
      if (err.status === 404) onBack();
    }
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }, [onBack]);

  const loadPatient = useCallback(async () => {
    try {
      const data = await api(`/patients/${patientId}`);
      setPatient(data.patient);
    } catch (err) { fail(err); }
  }, [patientId, fail]);

  const loadConsent = useCallback(async (page = 1) => {
    try {
      const data = await api(`/patients/${patientId}/consent?page=${page}&limit=${PAGE_SIZE}`);
      setConsent({ items: data.items || [], total: data.total || 0, page, latest: data.latest });
    } catch (err) { fail(err); }
  }, [patientId, fail]);

  const loadCaregivers = useCallback(async () => {
    try {
      const data = await api(`/patients/${patientId}/caregivers`);
      setCaregivers(data.items || []);
    } catch (err) { fail(err); }
  }, [patientId, fail]);

  const loadTeam = useCallback(async () => {
    try {
      const [assignments, eligible] = await Promise.all([
        api(`/patients/${patientId}/assignments`),
        api('/patients/assignees'),
      ]);
      setTeam(assignments.items || []);
      setCandidates(eligible.items || []);
    } catch (err) { fail(err); }
  }, [patientId, fail]);

  useEffect(() => { loadPatient(); }, [loadPatient]);
  useEffect(() => {
    if (tab === 'consent') loadConsent(1);
    if (tab === 'caregivers') loadCaregivers();
    if (tab === 'team') loadTeam();
  }, [tab, loadConsent, loadCaregivers, loadTeam]);

  async function activate() {
    setError(null); setNotice(null);
    try {
      const data = await api(`/patients/${patientId}/activate`, { method: 'POST' });
      setPatient(data.patient);
      setNotice('Patient activated.');
    } catch (err) { fail(err); }
  }

  async function addConsent(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    try {
      await api(`/patients/${patientId}/consent`, {
        method: 'POST',
        body: { action: consentForm.action, purpose: consentForm.purpose, categories: consentForm.categories },
      });
      setConsentForm({ action: 'granted', purpose: '', categories: ['care_coordination'] });
      setNotice('Consent recorded.');
      await loadConsent(1);
    } catch (err) { fail(err); }
  }

  async function inviteCaregiver(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    try {
      const data = await api(`/patients/${patientId}/caregivers`, {
        method: 'POST',
        body: { email: caregiverForm.email, scopes: caregiverForm.scopes },
      });
      setCaregiverForm({ email: '', scopes: ['view_profile'] });
      // No mail provider is authorised yet, so surface the one-time link.
      setNotice(`Invitation link: ${window.location.origin}/caregiver-invite/${data.invitation.token}`);
      await loadCaregivers();
    } catch (err) { fail(err); }
  }

  async function revokeCaregiver(grantId) {
    setError(null); setNotice(null);
    try {
      await api(`/patients/${patientId}/caregivers/${grantId}`, { method: 'DELETE' });
      await loadCaregivers();
    } catch (err) { fail(err); }
  }

  async function assign(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    if (!assigneeId) return;
    try {
      await api(`/patients/${patientId}/assignments`, { method: 'POST', body: { memberUserId: assigneeId } });
      setAssigneeId('');
      await loadTeam();
    } catch (err) { fail(err); }
  }

  async function revokeAssignment(id) {
    setError(null); setNotice(null);
    try {
      await api(`/patients/${patientId}/assignments/${id}`, { method: 'DELETE' });
      await loadTeam();
    } catch (err) { fail(err); }
  }

  async function inviteActivation(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    try {
      const data = await api(`/patients/${patientId}/activation-invitation`, {
        method: 'POST',
        body: { email: activationEmail },
      });
      setActivationEmail('');
      setNotice(`Activation link: ${window.location.origin}/activate/${data.invitation.token}`);
    } catch (err) { fail(err); }
  }

  if (!patient) {
    return (
      <section className="card">
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn btn--ghost" onClick={onBack}>Back to patients</button>
      </section>
    );
  }

  const activeTeam = team.filter((t) => t.status === 'active');
  const consentPages = Math.max(1, Math.ceil(consent.total / PAGE_SIZE));

  return (
    <section className="card card--tabs" aria-labelledby="patient-title">
      <div className="detail-head">
        <button type="button" className="btn btn--ghost" onClick={onBack}>Back</button>
        <h1 id="patient-title">{patient.fullName}</h1>
        <span className="role-badge">{patient.status}</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="tabs" role="tablist" aria-label="Patient sections">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'tab tab--active' : 'tab'}
            onClick={() => setTab(t)}
          >
            {t === 'overview' ? 'Overview' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="panel-scroll">
        {tab === 'overview' && (
          <div>
            <dl className="summary">
              <dt>Reference</dt><dd>{patient.reference}</dd>
              <dt>Date of birth</dt><dd>{patient.dateOfBirth ? new Date(patient.dateOfBirth).toLocaleDateString() : '—'}</dd>
              <dt>Contact email</dt><dd>{patient.contactEmail || '—'}</dd>
              <dt>Contact phone</dt><dd>{patient.contactPhone || '—'}</dd>
              <dt>Active assignees</dt><dd>{activeTeam.length}</dd>
            </dl>
            {patient.status === 'draft' && (
              <div className="stack">
                <p className="muted">Activation requires recorded care-coordination consent and at least one active assignee.</p>
                <button type="button" className="btn btn--primary" onClick={activate}>Activate patient</button>
              </div>
            )}
            {patient.status === 'draft' && (
              <form className="inline-form" onSubmit={inviteActivation} noValidate>
                <label htmlFor="pa-email">Patient email for activation</label>
                <input
                  id="pa-email"
                  type="email"
                  value={activationEmail}
                  onChange={(e) => setActivationEmail(e.target.value)}
                />
                <button type="submit" className="btn" disabled={!activationEmail}>Send activation link</button>
              </form>
            )}
          </div>
        )}

        {tab === 'consent' && (
          <div>
            <form className="inline-form" onSubmit={addConsent} noValidate>
              <label htmlFor="c-action">Action</label>
              <select id="c-action" value={consentForm.action} onChange={(e) => setConsentForm({ ...consentForm, action: e.target.value })}>
                <option value="granted">granted</option>
                <option value="updated">updated</option>
                <option value="withdrawn">withdrawn</option>
              </select>
              <label htmlFor="c-purpose">Purpose</label>
              <input id="c-purpose" required value={consentForm.purpose} onChange={(e) => setConsentForm({ ...consentForm, purpose: e.target.value })} />
              <fieldset className="scopes">
                <legend>Categories</legend>
                {CATEGORIES.map((cat) => (
                  <label key={cat} className="check">
                    <input
                      type="checkbox"
                      checked={consentForm.categories.includes(cat)}
                      onChange={(e) => setConsentForm({
                        ...consentForm,
                        categories: e.target.checked
                          ? [...consentForm.categories, cat]
                          : consentForm.categories.filter((c) => c !== cat),
                      })}
                    />
                    {cat.replace(/_/g, ' ')}
                  </label>
                ))}
              </fieldset>
              <button type="submit" className="btn btn--primary" disabled={!consentForm.purpose}>Record consent</button>
            </form>

            <table className="table">
              <caption className="visually-hidden">Consent history</caption>
              <thead>
                <tr><th scope="col">Recorded</th><th scope="col">Action</th><th scope="col">Purpose</th><th scope="col">Categories</th></tr>
              </thead>
              <tbody>
                {consent.items.map((c) => (
                  <tr key={c.id}>
                    <td>{new Date(c.recordedAt || c.createdAt).toLocaleString()}</td>
                    <td>{c.action}</td>
                    <td className="truncate">{c.purpose}</td>
                    <td>{(c.categories || []).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <nav className="pager" aria-label="Consent pagination">
              <button type="button" className="btn btn--ghost" disabled={consent.page <= 1} onClick={() => loadConsent(consent.page - 1)}>Previous</button>
              <span>Page {consent.page} of {consentPages}</span>
              <button type="button" className="btn btn--ghost" disabled={consent.page >= consentPages} onClick={() => loadConsent(consent.page + 1)}>Next</button>
            </nav>
          </div>
        )}

        {tab === 'caregivers' && (
          <div>
            <form className="inline-form" onSubmit={inviteCaregiver} noValidate>
              <label htmlFor="cg-email">Caregiver email</label>
              <input id="cg-email" type="email" required value={caregiverForm.email} onChange={(e) => setCaregiverForm({ ...caregiverForm, email: e.target.value })} />
              <fieldset className="scopes">
                <legend>Scopes</legend>
                {SCOPES.map((s) => (
                  <label key={s} className="check">
                    <input
                      type="checkbox"
                      checked={caregiverForm.scopes.includes(s)}
                      onChange={(e) => setCaregiverForm({
                        ...caregiverForm,
                        scopes: e.target.checked ? [...caregiverForm.scopes, s] : caregiverForm.scopes.filter((x) => x !== s),
                      })}
                    />
                    {SCOPE_LABELS[s] || s.replace(/_/g, ' ')}
                  </label>
                ))}
              </fieldset>
              <button type="submit" className="btn btn--primary" disabled={!caregiverForm.email || caregiverForm.scopes.length === 0}>Invite caregiver</button>
            </form>
            <table className="table">
              <caption className="visually-hidden">Caregiver grants</caption>
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
                        <button type="button" className="btn btn--ghost" onClick={() => revokeCaregiver(g.id)}>Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
                {caregivers.length === 0 && <tr><td colSpan={4}>No caregiver grants yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'team' && (
          <div>
            <form className="inline-form" onSubmit={assign} noValidate>
              <label htmlFor="tm-assignee">Add assignee</label>
              <select id="tm-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Select staff…</option>
                {candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>{c.name} — {c.roleKey.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <button type="submit" className="btn btn--primary" disabled={!assigneeId}>Assign</button>
            </form>
            <table className="table">
              <caption className="visually-hidden">Care team</caption>
              <thead>
                <tr><th scope="col">Member</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Since</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {team.map((t) => (
                  <tr key={t.id}>
                    <td>{t.memberName || t.memberEmail || '—'}</td>
                    <td>{t.kind}</td>
                    <td>{t.status}</td>
                    <td>{t.assignedAt ? new Date(t.assignedAt).toLocaleDateString() : '—'}</td>
                    <td className="table__actions">
                      {t.status === 'active' && activeTeam.length > 1 && (
                        <button type="button" className="btn btn--ghost" onClick={() => revokeAssignment(t.id)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
