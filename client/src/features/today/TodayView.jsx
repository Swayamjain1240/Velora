'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import {
  ENTRY_ACTIONS,
  PAGE_SIZE,
  TABS,
  canRecord,
  correctionNote,
  dateInZone,
  describeDay,
  entryProvenance,
  formatLocalTime,
  latestEntry,
  missingEntryText,
  newRequestId,
  rowDetail,
  rowTitle,
  safetyLines,
  shiftDate,
  stateLabel,
  statePillClass,
} from './todayRules';

// One viewport (control #25): a date strip, two tabs, ONE bounded panel at a
// time and server pagination. Mobile shows a single category at a time because
// only the selected tab renders at all.
export default function TodayView() {
  const { memberships } = useAuth();
  const roleKey = memberships && memberships[0] ? memberships[0].roleKey : null;
  const isCaregiver = roleKey === 'caregiver';

  const [patients, setPatients] = useState([]);
  const [patientId, setPatientId] = useState('');
  const [date, setDate] = useState('');
  const [tab, setTab] = useState('medication');
  const [page, setPage] = useState(1);
  const [day, setDay] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [correcting, setCorrecting] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ tab, page: String(page), limit: String(PAGE_SIZE) });
    if (date) params.set('date', date);
    if (patientId) params.set('patientId', patientId);
    try {
      const data = await api(`/today?${params.toString()}`);
      setDay(data);
      // The server owns the day boundary: the first response tells the client
      // which local date it answered for, in the record's own timezone.
      if (!date) setDate(data.date);
      return true;
    } catch (err) {
      setDay(null);
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      }
      return false;
    } finally {
      setLoaded(true);
    }
  }, [tab, page, date, patientId]);

  useEffect(() => {
    load();
  }, [load]);

  // A caregiver may hold several shared records: list them once for the picker.
  useEffect(() => {
    if (!isCaregiver) return;
    let active = true;
    async function loadPatients() {
      try {
        const data = await api('/caregiver/me/patients?page=1&limit=10');
        if (active) setPatients(data.items || []);
      } catch {
        if (active) setPatients([]);
      }
    }
    loadPatients();
    return () => {
      active = false;
    };
  }, [isCaregiver]);

  async function submit(item, entryState, extra) {
    if (!day) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = { entryState, clientRequestId: newRequestId(), ...extra };
      // An as-needed administration is a NEW event each time, so it is recorded
      // against the schedule. A correction must name the occurrence it corrects.
      const corrects = Boolean(extra && extra.correctsLogId);
      if (item.asNeeded && !corrects) body.scheduleId = item.owner;
      else if (item.id) body.occurrenceId = item.id;
      else body.scheduleId = item.owner;
      const result = await api('/today/entries', { method: 'POST', body });
      setNotice(
        result.idempotent
          ? 'That entry was already recorded — nothing was duplicated.'
          : `Recorded as “${stateLabel(entryState)}”. Your care team can see the entry and its time.`
      );
      setCorrecting(null);
      setReason('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function move(days) {
    setPage(1);
    setDate(shiftDate(date || dateInZone(day ? day.timezone : 'UTC'), days));
  }

  if (!loaded) return <p className="muted">Loading today…</p>;

  if (error && !day) {
    return (
      <section className="card" aria-labelledby="today-title">
        <h1 id="today-title">Today</h1>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }

  const totals = day ? day.total : 0;
  const pages = day ? day.pages : 1;
  const counts = day ? day.counts : {};
  const readOnly = Boolean(day && day.episode && day.episode.readOnly);
  const safety = safetyLines(day ? day.safety : {});

  return (
    <section className="card card--tabs today" aria-labelledby="today-title">
      <div className="today__head">
        <h1 id="today-title">Today</h1>
        {day && <span className="pill">{day.timezone}</span>}
        {day && day.episode && day.episode.status === 'closed' && (
          <span className="pill pill--none">Episode closed — read only</span>
        )}
        {day && !day.logAllowed && <span className="pill pill--none">Shared read-only with you</span>}
      </div>

      {isCaregiver && patients.length > 0 && (
        <label className="today__picker" htmlFor="today-patient">
          Shared record
          <select
            id="today-patient"
            value={patientId}
            onChange={(event) => {
              setPage(1);
              setPatientId(event.target.value);
            }}
          >
            <option value="">First shared record</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="today__dates">
        <button type="button" className="btn btn--ghost" onClick={() => move(-1)} disabled={busy}>
          ‹ Previous
        </button>
        <input
          id="today-date"
          type="date"
          aria-label="Day"
          value={date}
          onChange={(event) => {
            setPage(1);
            setDate(event.target.value);
          }}
        />
        <button type="button" className="btn btn--ghost" onClick={() => move(1)} disabled={busy}>
          Next ›
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setPage(1);
            setDate(day ? dateInZone(day.timezone) : '');
          }}
          disabled={busy}
        >
          Today
        </button>
        {day && <span className="muted">{describeDay(day.date, day.timezone)}</span>}
      </div>

      <div className="tabs" role="tablist" aria-label="Today categories">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={tab === entry.key}
            className={tab === entry.key ? 'tab tab--active' : 'tab'}
            onClick={() => {
              setPage(1);
              setTab(entry.key);
            }}
          >
            {entry.label}
            {day && day.countsByTab && day.countsByTab[entry.key]
              ? ` (${Object.entries(day.countsByTab[entry.key])
                  .filter(([state]) => state !== 'not_recorded')
                  .reduce((total, [, value]) => total + value, 0)} recorded)`
              : ''}
          </button>
        ))}
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
        {day && day.items.length === 0 && (
          <p className="muted">
            Nothing scheduled for this day yet. Schedules appear only after a clinical reviewer approves a plan
            and the care team activates a medicine or task.
          </p>
        )}
        <ul className="today__list">
          {day &&
            day.items.map((item) => {
              const entry = latestEntry(item);
              const provenance = entryProvenance(entry);
              const recordable = canRecord(day, item) && !busy;
              return (
                <li key={`${item.owner}-${item.id || 'asneeded'}`} className="today__row">
                  <div className="today__row-head">
                    <strong>{rowTitle(item)}</strong>
                    <span className={statePillClass(item.state)}>{stateLabel(item.state)}</span>
                    {item.asNeeded && <span className="pill pill--prn">As needed</span>}
                    {item.historical && <span className="pill pill--none">Earlier plan (history)</span>}
                    {item.dueAtUtc ? (
                      <span className="muted">{formatLocalTime(item.localTime, item.offset)}</span>
                    ) : (
                      <span className="muted">{item.asNeeded ? 'No due time' : '—'}</span>
                    )}
                  </div>

                  <p className="today__instruction">{item.instruction}</p>
                  <dl className="summary">
                    {rowDetail(item).map((line) => (
                      <div key={line} className="plans__field">
                        <dt>{line.split(':')[0]}</dt>
                        <dd>{line.slice(line.indexOf(':') + 1).trim()}</dd>
                      </div>
                    ))}
                  </dl>

                  {item.noEntryRecorded && <p className="muted">{missingEntryText()}</p>}
                  {provenance && (
                    <p className="muted">
                      {provenance.text}
                      {entry && entry.recordedAtUtc
                        ? ` · recorded ${new Date(entry.recordedAtUtc).toLocaleString()}`
                        : ''}
                      {` · ${provenance.kind === 'self_report' ? 'not clinician verified' : 'staff entry'}`}
                    </p>
                  )}
                  {correctionNote(item) && <p className="notice">{correctionNote(item)}</p>}
                  {item.entries && item.entries.length > 1 && (
                    <details className="plans__sources">
                      <summary>Entry history ({item.entries.length})</summary>
                      <ul className="today__history">
                        {item.entries.map((row) => (
                          <li key={row.id}>
                            <span className={statePillClass(row.entryState)}>{stateLabel(row.entryState)}</span>
                            <span className="muted">
                              {row.selfReport ? ' self-report' : ` ${row.actorRole.replace(/_/g, ' ')}`}
                              {` · ${new Date(row.recordedAtUtc).toLocaleString()}`}
                              {row.correctionReason ? ` · reason: ${row.correctionReason}` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {recordable && (
                    <div className="today__actions">
                      {ENTRY_ACTIONS.map((action) => (
                        <button
                          key={action.state}
                          type="button"
                          className="btn btn--ghost"
                          disabled={busy}
                          onClick={() => submit(item, action.state)}
                        >
                          {action.label}
                        </button>
                      ))}
                      {entry && (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={busy}
                          onClick={() => {
                            setCorrecting(item);
                            setReason('');
                          }}
                        >
                          Correct this entry
                        </button>
                      )}
                    </div>
                  )}

                  {correcting && correcting.owner === item.owner && correcting.id === item.id && (
                    <form
                      className="today__correct"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const target = latestEntry(item);
                        if (!target || reason.trim().length < 5) return;
                        submit(item, target.entryState, {
                          correctsLogId: target.id,
                          correctionReason: reason.trim(),
                        });
                      }}
                    >
                      <label htmlFor={`correction-${item.id || item.owner}`}>
                        Why is this entry being corrected? (a new entry is added; the old one is kept)
                      </label>
                      <input
                        id={`correction-${item.id || item.owner}`}
                        maxLength={300}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        disabled={busy}
                      />
                      <div className="today__actions">
                        <button type="submit" className="btn btn--primary" disabled={busy || reason.trim().length < 5}>
                          Add correction
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            setCorrecting(null);
                            setReason('');
                          }}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
        </ul>
      </div>

      <nav className="pager" aria-label="Today pagination">
        <button type="button" className="btn btn--ghost" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          {totals} item(s) · page {page} of {pages}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={page >= pages || busy}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
        <span className="muted">
          {`Recorded today: ${counts.taken || 0} taken · ${counts.skipped || 0} skipped · ${
            counts.reported_done || 0
          } reported done · ${counts.needs_help || 0} needs help · ${counts.not_recorded || 0} no entry`}
        </span>
      </nav>

      <div className="today__safety">
        {readOnly && <p className="notice">This episode is closed: nothing can be recorded, and the history stays readable.</p>}
        {safety.map((line) => (
          <p key={line} className="muted">
            {line}
          </p>
        ))}
      </div>
    </section>
  );
}
