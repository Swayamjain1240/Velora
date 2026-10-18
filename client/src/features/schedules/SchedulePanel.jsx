'use strict';

import ResponsiveTable from '../../components/ResponsiveTable';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';

const PAGE_SIZE = 8;
const OCCURRENCE_PAGE = 10;

const STATUS_LABELS = {
  needs_details: 'Needs schedule details',
  pending_activation: 'Awaiting activation',
  active: 'Active',
  superseded: 'Superseded',
  ended: 'Ended',
};

function statusClass(status) {
  if (status === 'active') return 'pill pill--ready';
  if (status === 'needs_details') return 'pill pill--plan-needs_clarification';
  if (status === 'pending_activation') return 'pill pill--plan-in_review';
  return 'pill pill--plan-superseded';
}

// Staff workspace for one episode's medication schedules and recovery tasks.
//
// Everything here is a REQUEST: the server re-derives the coordinator
// assignment, the current approved version and (for a medicine) the assigned,
// verified clinical reviewer before any change is accepted.
export default function SchedulePanel({ episodeId, episodePlanState, onDenied }) {
  const { memberships } = useAuth();
  const roleKey = memberships && memberships[0] ? memberships[0].roleKey : null;
  const canPrepare = roleKey === 'care_coordinator';
  const canActivate = roleKey === 'care_coordinator' || roleKey === 'clinical_reviewer';

  const [data, setData] = useState({ items: [], page: 1, total: 0 });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [occurrences, setOccurrences] = useState({ items: [], page: 1, total: 0 });
  const [occurrencePage, setOccurrencePage] = useState(1);
  const [logs, setLogs] = useState({ items: [], page: 1, total: 0 });
  const [logPage, setLogPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [denied, setDenied] = useState(false);

  const base = `/episodes/${episodeId}/schedules`;

  const fail = useCallback(
    (err) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        setData({ items: [], page: 1, total: 0 });
        setSelected(null);
        setDenied(true);
        if (onDenied) onDenied(err);
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    },
    [onDenied]
  );

  const load = useCallback(
    async (targetPage = page) => {
      try {
        const result = await api(`${base}?page=${targetPage}&limit=${PAGE_SIZE}`);
        setData({ items: result.items || [], total: result.total || 0, page: targetPage });
        setDenied(false);
        return result.items || [];
      } catch (err) {
        fail(err);
        return [];
      }
    },
    [base, page, fail]
  );

  const loadOccurrences = useCallback(
    async (scheduleId, targetPage = occurrencePage) => {
      try {
        const result = await api(
          `${base}/${scheduleId}/occurrences?page=${targetPage}&limit=${OCCURRENCE_PAGE}`
        );
        setOccurrences({ items: result.items || [], total: result.total || 0, page: targetPage });
      } catch (err) {
        fail(err);
      }
    },
    [base, occurrencePage, fail]
  );

  const loadLogs = useCallback(
    async (targetPage = logPage) => {
      try {
        const result = await api(`/episodes/${episodeId}/activity-logs?page=${targetPage}&limit=${PAGE_SIZE}`);
        setLogs({ items: result.items || [], total: result.total || 0, page: targetPage });
      } catch (err) {
        fail(err);
      }
    },
    [episodeId, logPage, fail]
  );

  useEffect(() => {
    load(1).then((items) => setSelected(items.length ? items[0].id : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  useEffect(() => {
    if (selected) loadOccurrences(selected, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    loadLogs(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  async function run(action, message) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load(data.page);
      if (selected) await loadOccurrences(selected, occurrencePage);
      await loadLogs(logPage);
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function prepare() {
    return run(
      () =>
        api(`${base}/prepare`, {
          method: 'POST',
          body: { horizonDays: 30 },
        }),
      'Prepared from the current approved plan. Each medicine still needs a clinical reviewer to activate it.'
    );
  }

  async function activate(schedule) {
    return run(
      () =>
        api(`${base}/${schedule.id}/activate`, {
          method: 'POST',
          body: { expectedRevision: schedule.revision },
        }),
      schedule.type === 'medication'
        ? 'Medication schedule activated. The patient now sees its due times.'
        : 'Task activated. The patient now sees it in the day view.'
    );
  }

  async function end(schedule) {
    return run(
      () =>
        api(`${base}/${schedule.id}/end`, {
          method: 'POST',
          body: { reason: 'Ended by the care team from the episode schedule panel.' },
        }),
      'Ended. Future occurrences are closed; everything already recorded is kept.'
    );
  }

  if (denied) {
    return (
      <div className="plans">
        <p className="muted">Medication schedules and daily tasks are not available to you.</p>
      </div>
    );
  }

  const selectedSchedule = data.items.find((item) => item.id === selected) || null;
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const occurrencePages = Math.max(1, Math.ceil(occurrences.total / OCCURRENCE_PAGE));

  return (
    <div className="plans">
      <div className="plans__head">
        <h2>Schedules and tasks</h2>
        <span className="muted">
          {episodePlanState === 'approved'
            ? 'Prepared only from the current approved plan version.'
            : 'An approved plan version is required first.'}
        </span>
        {canPrepare && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || episodePlanState !== 'approved'}
            onClick={prepare}
          >
            {busy ? 'Working…' : 'Prepare from approved plan'}
          </button>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="panel-scroll">
        <ResponsiveTable>
          <caption className="visually-hidden">Medication schedules and recovery tasks</caption>
          <thead>
            <tr>
              <th scope="col">Instruction</th>
              <th scope="col">Times</th>
              <th scope="col">Status</th>
              <th scope="col">Occurrences</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.medicationName || item.title || item.originalWording}
                  <span className="muted">
                    {item.medicationName ? ` · ${item.dose || 'dose not stated'}` : ''}
                    {item.condition ? ` · only ${item.condition}` : ''}
                  </span>
                </td>
                <td>{item.timesOfDay.length ? item.timesOfDay.join(', ') : item.scheduleKind === 'as_needed' ? 'As needed' : '—'}</td>
                <td>
                  <span className={statusClass(item.status)}>{STATUS_LABELS[item.status] || item.status}</span>
                  {item.needsDetailsReason && <span className="muted"> {item.needsDetailsReason}</span>}
                </td>
                <td>{item.generatedCount}</td>
                <td className="table__actions">
                  <button type="button" className="btn btn--ghost" onClick={() => setSelected(item.id)}>
                    View
                  </button>
                  {canActivate && item.status === 'pending_activation' && (
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => activate(item)}>
                      Activate
                    </button>
                  )}
                  {canPrepare && (item.status === 'active' || item.status === 'pending_activation') && (
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => end(item)}>
                      End
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr>
                <td colSpan={5}>
                  Nothing prepared yet. Only an approved, clinician-confirmed item can produce a schedule.
                </td>
              </tr>
            )}
          </tbody>
        </ResponsiveTable>
      </div>

      <nav className="pager" aria-label="Schedule pagination">
        <button type="button" className="btn btn--ghost" disabled={page <= 1 || busy} onClick={() => { setPage(page - 1); load(page - 1); }}>
          Previous
        </button>
        <span>
          {data.total} item(s) · page {page} of {pages}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={page >= pages || busy}
          onClick={() => { setPage(page + 1); load(page + 1); }}
        >
          Next
        </button>
      </nav>

      {selectedSchedule && (
        <>
          <h3>Occurrences · {selectedSchedule.medicationName || selectedSchedule.title}</h3>
          <p className="muted">
            Stored in UTC with the {selectedSchedule.timezone} scheduling timezone. {selectedSchedule.activationRequired === 'clinical_reviewer'
              ? 'A medicine becomes patient-visible only through a verified clinical reviewer.'
              : 'A task is activated operationally by the assigned coordinator.'}
          </p>
          <div className="panel-scroll">
            <ResponsiveTable>
              <caption className="visually-hidden">Generated occurrences</caption>
              <thead>
                <tr>
                  <th scope="col">Local date</th>
                  <th scope="col">Local time</th>
                  <th scope="col">UTC instant</th>
                  <th scope="col">Offset</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {occurrences.items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.localDate}</td>
                    <td>{row.localTime}</td>
                    <td>{new Date(row.scheduledAtUtc).toISOString()}</td>
                    <td>{row.offset || '—'}</td>
                    <td>{row.status}</td>
                  </tr>
                ))}
                {occurrences.items.length === 0 && (
                  <tr>
                    <td colSpan={5}>No occurrences: a conditional or unresolved instruction generates none.</td>
                  </tr>
                )}
              </tbody>
            </ResponsiveTable>
          </div>
          <nav className="pager" aria-label="Occurrence pagination">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={occurrencePage <= 1}
              onClick={() => { setOccurrencePage(occurrencePage - 1); loadOccurrences(selected, occurrencePage - 1); }}
            >
              Previous
            </button>
            <span>
              page {occurrencePage} of {occurrencePages}
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={occurrencePage >= occurrencePages}
              onClick={() => { setOccurrencePage(occurrencePage + 1); loadOccurrences(selected, occurrencePage + 1); }}
            >
              Next
            </button>
          </nav>
        </>
      )}

      <h3>Recorded entries</h3>
      <p className="muted">
        A patient or caregiver entry is a self-report and is never clinical verification. A missing entry is not a
        missed dose.
      </p>
      <div className="panel-scroll">
        <ResponsiveTable>
          <caption className="visually-hidden">Recorded entries for this episode</caption>
          <thead>
            <tr>
              <th scope="col">Recorded</th>
              <th scope="col">Entry</th>
              <th scope="col">By</th>
              <th scope="col">About</th>
              <th scope="col">Correction</th>
            </tr>
          </thead>
          <tbody>
            {logs.items.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.recordedAtUtc).toLocaleString()}</td>
                <td>{row.entryState.replace(/_/g, ' ')}</td>
                <td>
                  {row.selfReport ? 'Self-report' : `Staff (${row.actorRole.replace(/_/g, ' ')})`}
                </td>
                <td>{new Date(row.occurrenceTimeUtc).toLocaleString()}</td>
                <td className="truncate">{row.correctsLog ? `corrects ${row.correctsLog.slice(-6)}` : '—'}</td>
              </tr>
            ))}
            {logs.items.length === 0 && (
              <tr>
                <td colSpan={5}>Nothing recorded yet.</td>
              </tr>
            )}
          </tbody>
        </ResponsiveTable>
      </div>
      <nav className="pager" aria-label="Entry pagination">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={logPage <= 1}
          onClick={() => { setLogPage(logPage - 1); loadLogs(logPage - 1); }}
        >
          Previous
        </button>
        <span>
          {logs.total} entr(ies) · page {logPage}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={logs.items.length < PAGE_SIZE}
          onClick={() => { setLogPage(logPage + 1); loadLogs(logPage + 1); }}
        >
          Next
        </button>
      </nav>
    </div>
  );
}
