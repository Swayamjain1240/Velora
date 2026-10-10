'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

const PAGE_SIZE = 10;
const ROLES = ['admin', 'care_coordinator', 'clinical_reviewer'];

// Admin-only clinic & staff management. Every action is a server-checked
// mutation; the UI merely reflects permissions it was told about.
export default function ClinicSettings() {
  const [tab, setTab] = useState('members');
  const [members, setMembers] = useState({ items: [], total: 0, page: 1 });
  const [invites, setInvites] = useState({ items: [], total: 0, page: 1 });
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [inviteForm, setInviteForm] = useState({ email: '', roleKey: 'care_coordinator' });

  const fail = useCallback((err) => {
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }, []);

  const loadMembers = useCallback(async (p) => {
    try {
      setMembers(await api(`/staff/members?page=${p}&limit=${PAGE_SIZE}`));
    } catch (err) { fail(err); }
  }, [fail]);

  const loadInvites = useCallback(async (p) => {
    try {
      setInvites(await api(`/staff/invitations?page=${p}&limit=${PAGE_SIZE}`));
    } catch (err) { fail(err); }
  }, [fail]);

  useEffect(() => {
    if (tab === 'members') loadMembers(page);
    else loadInvites(page);
  }, [tab, page, loadMembers, loadInvites]);

  async function updateMember(id, changes) {
    setError(null); setNotice(null);
    try {
      await api(`/staff/members/${id}`, { method: 'PATCH', body: changes });
      await loadMembers(page);
    } catch (err) { fail(err); }
  }

  async function setEligibility(id, action) {
    setError(null); setNotice(null);
    try {
      await api(`/staff/members/${id}/reviewer-eligibility`, {
        method: 'POST',
        body: { action },
      });
      await loadMembers(page);
    } catch (err) { fail(err); }
  }

  async function sendInvite(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    try {
      await api('/staff/invitations', { method: 'POST', body: inviteForm });
      setNotice('Invitation created. In development the link is printed in the server console.');
      setInviteForm({ email: '', roleKey: 'care_coordinator' });
      await loadInvites(1);
      setPage(1);
    } catch (err) { fail(err); }
  }

  async function revokeInvite(id) {
    setError(null); setNotice(null);
    try {
      await api(`/staff/invitations/${id}`, { method: 'DELETE' });
      await loadInvites(page);
    } catch (err) { fail(err); }
  }

  const totalPages = Math.max(1, Math.ceil((tab === 'members' ? members.total : invites.total) / PAGE_SIZE));

  return (
    <section className="card card--tabs" aria-labelledby="clinic-title">
      <h1 id="clinic-title">Clinic &amp; staff</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="tabs" role="tablist" aria-label="Clinic sections">
        <button
          role="tab"
          aria-selected={tab === 'members'}
          className={tab === 'members' ? 'tab tab--active' : 'tab'}
          onClick={() => { setTab('members'); setPage(1); }}
        >Members</button>
        <button
          role="tab"
          aria-selected={tab === 'invites'}
          className={tab === 'invites' ? 'tab tab--active' : 'tab'}
          onClick={() => { setTab('invites'); setPage(1); }}
        >Invitations</button>
      </div>

      <div className="panel-scroll">
        {tab === 'members' && (
          <table className="table">
            <caption className="visually-hidden">Clinic members</caption>
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Reviewer eligibility</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {members.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.email}</td>
                  <td>{m.roleKey.replace(/_/g, ' ')}</td>
                  <td>{m.status}</td>
                  <td>{m.reviewerEligibility.status}</td>
                  <td className="table__actions">
                    <label className="visually-hidden" htmlFor={`role-${m.id}`}>Role for {m.name}</label>
                    <select
                      id={`role-${m.id}`}
                      value={m.roleKey}
                      onChange={(e) => updateMember(m.id, { roleKey: e.target.value })}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                    </select>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => updateMember(m.id, { status: m.status === 'active' ? 'inactive' : 'active' })}
                    >{m.status === 'active' ? 'Deactivate' : 'Activate'}</button>
                    {m.roleKey === 'clinical_reviewer' && m.reviewerEligibility.status !== 'verified' && (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setEligibility(m.id, 'verify')}
                      >Verify eligibility</button>
                    )}
                    {m.roleKey === 'clinical_reviewer' && m.reviewerEligibility.status === 'verified' && (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setEligibility(m.id, 'revoke')}
                      >Revoke eligibility</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'invites' && (
          <>
            <form className="inline-form" onSubmit={sendInvite} noValidate>
              <label htmlFor="invite-email">Email</label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteForm.email}
                onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
              />
              <label htmlFor="invite-role">Role</label>
              <select
                id="invite-role"
                value={inviteForm.roleKey}
                onChange={(e) => setInviteForm({ ...inviteForm, roleKey: e.target.value })}
              >
                {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
              <button className="btn btn--primary" type="submit">Send invitation</button>
            </form>
            <table className="table">
              <caption className="visually-hidden">Invitations</caption>
              <thead>
                <tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {invites.items.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.email}</td>
                    <td>{inv.roleKey.replace(/_/g, ' ')}</td>
                    <td>{inv.status}</td>
                    <td>{new Date(inv.expiresAt).toLocaleDateString()}</td>
                    <td className="table__actions">
                      {inv.status === 'pending' && (
                        <button type="button" className="btn btn--ghost" onClick={() => revokeInvite(inv.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
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
    </section>
  );
}
