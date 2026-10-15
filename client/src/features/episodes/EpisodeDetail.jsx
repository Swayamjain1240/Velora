'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import DocumentsPanel from '../documents/DocumentsPanel';
import CarePlanPanel from '../plans/CarePlanPanel';
import SchedulePanel from '../schedules/SchedulePanel';
import ClosurePanel from '../closure/ClosurePanel';

const PAGE_SIZE = 10;
const TABS = ['overview', 'plan', 'schedule', 'corrections', 'team', 'documents', 'closure'];
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

// Staff episode detail. Each tab is one scroll region inside the fixed shell.
export default function EpisodeDetail({ episodeId, onBack }) {
  const [episode, setEpisode] = useState(null);
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ dischargeDate: '', dischargeTimezone: '' });
  const [corrections, setCorrections] = useState({ items: [], total: 0, page: 1 });
  const [team, setTeam] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [assignee, setAssignee] = useState({ userId: '', responsibility: 'care_coordinator' });
  const [busy, setBusy] = useState(false);
  // Once the user has edited the discharge form, a late-arriving load must not
  // overwrite what they typed (a double-mounted effect can resolve after the
  // first keystroke and would otherwise restore the stored values).
  const formTouched = useRef(false);

  const fail = useCallback((err) => {
    // Authorization loss clears loaded clinical data before showing the error.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
      setEpisode(null);
      setCorrections({ items: [], total: 0, page: 1 });
      setTeam([]);
      setCandidates([]);
      if (err.status === 404) onBack();
    }
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }, [onBack]);

  const loadEpisode = useCallback(async () => {
    try {
      const data = await api(`/episodes/${episodeId}`);
      setEpisode(data.episode);
      if (!formTouched.current) {
        setForm({
          dischargeDate: data.episode.dischargeDate || '',
          dischargeTimezone: data.episode.dischargeTimezone || '',
        });
      }
    } catch (err) { fail(err); }
  }, [episodeId, fail]);

  const loadCorrections = useCallback(async (page = 1) => {
    try {
      const data = await api(`/episodes/${episodeId}/corrections?page=${page}&limit=${PAGE_SIZE}`);
      setCorrections({ items: data.items || [], total: data.total || 0, page });
    } catch (err) { fail(err); }
  }, [episodeId, fail]);

  const loadTeam = useCallback(async () => {
    try {
      const [roster, eligible] = await Promise.all([
        api(`/episodes/${episodeId}/team`),
        api(`/episodes/${episodeId}/team/candidates`),
      ]);
      setTeam(roster.items || []);
      setCandidates(eligible.items || []);
    } catch (err) { fail(err); }
  }, [episodeId, fail]);

  useEffect(() => { loadEpisode(); }, [loadEpisode]);
  useEffect(() => {
    if (tab === 'corrections') loadCorrections(1);
    if (tab === 'team') loadTeam();
  }, [tab, loadCorrections, loadTeam]);

  async function correct(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    setBusy(true);
    try {
      const body = { expectedRevision: episode.revision };
      if (form.dischargeDate !== episode.dischargeDate) body.dischargeDate = form.dischargeDate;
      if (form.dischargeTimezone !== episode.dischargeTimezone) body.dischargeTimezone = form.dischargeTimezone;
      const data = await api(`/episodes/${episodeId}/discharge`, { method: 'PATCH', body });
      setEpisode(data.episode);
      setNotice('Discharge details corrected.');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function assign(event) {
    event.preventDefault();
    setError(null); setNotice(null);
    if (!assignee.userId) return;
    try {
      await api(`/episodes/${episodeId}/team`, {
        method: 'POST',
        body: { memberUserId: assignee.userId, responsibility: assignee.responsibility },
      });
      setAssignee({ userId: '', responsibility: 'care_coordinator' });
      await loadTeam();
    } catch (err) { fail(err); }
  }

  async function revoke(id) {
    setError(null); setNotice(null);
    try {
      await api(`/episodes/${episodeId}/team/${id}`, { method: 'DELETE' });
      await loadTeam();
    } catch (err) { fail(err); }
  }

  if (!episode) {
    return (
      <section className="card">
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn btn--ghost" onClick={onBack}>Back to episodes</button>
      </section>
    );
  }

  const activeTeam = team.filter((t) => t.status === 'active');
  const correctionPages = Math.max(1, Math.ceil(corrections.total / PAGE_SIZE));
  const changed = form.dischargeDate !== episode.dischargeDate || form.dischargeTimezone !== episode.dischargeTimezone;

  return (
    <section className="card card--tabs" aria-labelledby="episode-title">
      <div className="detail-head">
        <button type="button" className="btn btn--ghost" onClick={onBack}>Back</button>
        <h1 id="episode-title">{episode.reference}</h1>
        <span className="role-badge">{episode.status}</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="tabs" role="tablist" aria-label="Episode sections">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'tab tab--active' : 'tab'}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="panel-scroll">
        {tab === 'overview' && (
          <div>
            <dl className="summary">
              <dt>Discharge date</dt><dd>{episode.dischargeDate}</dd>
              <dt>Timezone</dt><dd>{episode.dischargeTimezone}</dd>
              <dt>Revision</dt><dd>{episode.revision}</dd>
              <dt>Approved plan</dt>
              <dd>{episode.approvedPlanVersion ? 'Published to the patient' : 'None yet'}</dd>
              <dt>Plan state</dt><dd>{(episode.planState || 'none').replace(/_/g, ' ')}</dd>
              <dt>Active team</dt><dd>{activeTeam.length}</dd>
            </dl>
            {episode.status === 'draft' ? (
              <form className="inline-form" onSubmit={correct} noValidate>
                <label htmlFor="ep-date">Discharge date</label>
                <input
                  id="ep-date"
                  type="date"
                  value={form.dischargeDate}
                  onChange={(e) => {
                    formTouched.current = true;
                    setForm({ ...form, dischargeDate: e.target.value });
                  }}
                />
                <label htmlFor="ep-tz">Timezone</label>
                <input
                  id="ep-tz"
                  list="ep-tz-list"
                  value={form.dischargeTimezone}
                  onChange={(e) => {
                    formTouched.current = true;
                    setForm({ ...form, dischargeTimezone: e.target.value });
                  }}
                />
                <datalist id="ep-tz-list">
                  {COMMON_ZONES.map((z) => <option key={z} value={z} />)}
                </datalist>
                <button type="submit" className="btn btn--primary" disabled={!changed || busy}>
                  {busy ? 'Saving…' : 'Correct discharge'}
                </button>
              </form>
            ) : (
              <p className="muted">This episode is {episode.status}; only draft episodes can be corrected.</p>
            )}
          </div>
        )}

        {tab === 'corrections' && (
          <div>
            <table className="table">
              <caption className="visually-hidden">Correction history</caption>
              <thead>
                <tr><th scope="col">When</th><th scope="col">Field</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Revision</th><th scope="col">By</th></tr>
              </thead>
              <tbody>
                {corrections.items.map((c) => (
                  <tr key={c.id}>
                    <td>{new Date(c.correctedAt).toLocaleString()}</td>
                    <td>{c.field.replace(/_/g, ' ')}</td>
                    <td>{c.previousValue || '—'}</td>
                    <td>{c.newValue || '—'}</td>
                    <td>{c.revisionBefore}→{c.revisionAfter}</td>
                    <td className="truncate">{c.actorLabel || '—'}</td>
                  </tr>
                ))}
                {corrections.items.length === 0 && <tr><td colSpan={6}>No corrections recorded.</td></tr>}
              </tbody>
            </table>
            <nav className="pager" aria-label="Correction pagination">
              <button type="button" className="btn btn--ghost" disabled={corrections.page <= 1} onClick={() => loadCorrections(corrections.page - 1)}>Previous</button>
              <span>Page {corrections.page} of {correctionPages}</span>
              <button type="button" className="btn btn--ghost" disabled={corrections.page >= correctionPages} onClick={() => loadCorrections(corrections.page + 1)}>Next</button>
            </nav>
          </div>
        )}

        {tab === 'team' && (
          <div>
            <form className="inline-form" onSubmit={assign} noValidate>
              <label htmlFor="tm-member">Add team member</label>
              <select id="tm-member" value={assignee.userId} onChange={(e) => setAssignee({ ...assignee, userId: e.target.value })}>
                <option value="">Select staff…</option>
                {candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>{c.name} — {c.roleKey.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <label htmlFor="tm-resp">Responsibility</label>
              <select id="tm-resp" value={assignee.responsibility} onChange={(e) => setAssignee({ ...assignee, responsibility: e.target.value })}>
                <option value="care_coordinator">care coordinator</option>
                <option value="clinical_reviewer">clinical reviewer</option>
              </select>
              <button type="submit" className="btn btn--primary" disabled={!assignee.userId}>Assign</button>
            </form>
            <table className="table">
              <caption className="visually-hidden">Care team</caption>
              <thead>
                <tr><th scope="col">Member</th><th scope="col">Responsibility</th><th scope="col">Status</th><th scope="col">Since</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {team.map((t) => (
                  <tr key={t.id}>
                    <td>{t.memberName || t.memberEmail || '—'}</td>
                    <td>{t.responsibility.replace(/_/g, ' ')}</td>
                    <td>{t.status}</td>
                    <td>{t.assignedAt ? new Date(t.assignedAt).toLocaleDateString() : '—'}</td>
                    <td className="table__actions">
                      {t.status === 'active' && activeTeam.length > 1 && (
                        <button type="button" className="btn btn--ghost" onClick={() => revoke(t.id)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'plan' && (
          // Part 5: manual drafting, clinical review, approval and version
          // history. The panel reads its own data and re-checks every action
          // against the current plan revision.
          <CarePlanPanel
            episodeId={episodeId}
            episodeStatus={episode.status}
            onDenied={fail}
          />
        )}

        {/* Part 7: approved medication schedules, recovery tasks and the
            actor-attributed entries recorded against them. */}
        {tab === 'schedule' && (
          // A denial here is shown inside the panel rather than clearing the
          // episode, because the caller already reads this episode.
          <SchedulePanel episodeId={episodeId} episodePlanState={episode.planState} />
        )}
        {tab === 'documents' && (
          <DocumentsPanel
            episodeId={episodeId}
            basePath={`/episodes/${episodeId}`}
            // Only an assigned team member may upload, and only to a draft
            // episode; the server re-checks both on every request.
            canUpload={episode.status === 'draft'}
            readOnlyReason={`Documents can only be added while the episode is a draft (this episode is ${episode.status}).`}
            onDenied={fail}
          />
        )}

        {/* Part 9: closure preflight, the clinic-policy checks, the closure
            history and an explicit reopen. Closure is an OPERATIONAL archive
            step; the server owns the wording and refuses a clinical one. */}
        {tab === 'closure' && (
          <ClosurePanel episodeId={episodeId} episode={episode} onChanged={loadEpisode} />
        )}
      </div>
    </section>
  );
}
