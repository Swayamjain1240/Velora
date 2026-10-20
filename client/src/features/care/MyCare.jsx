'use strict';

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { onTabListKeyDown, tabStop } from '../../lib/tabs';
import CheckInForm from '../queues/CheckInForm';
import ThreadView from '../queues/ThreadView';

// The patient's own care panel, and the caregiver's scoped version of it.
//
// ONE mobile panel with tabs and pagination (control #25): a single column, a tab
// strip, and one item at a time on a small screen. The patient answers their own
// check-ins; a caregiver answers the ones their grant allows. Neither ever sees a
// care-team internal note, and neither surface classifies a missing check-in -
// the wording comes from the server.
const TABS = [
  { key: 'check-ins', label: 'Check-ins' },
  { key: 'questions', label: 'Questions' },
  { key: 'follow-ups', label: 'Follow-ups' },
];

const PAGE_SIZE = 10;

// The two surfaces differ only in their base paths, and the paths are built ONCE
// per mode: building them inline would give `load` a new dependency on every
// render and loop the fetch.
// The keys are the TAB keys, because a tab is loaded by indexing this map.
function endpoints(mode, patientId) {
  if (mode === 'caregiver') {
    return {
      'check-ins': (params) => `/caregiver/me/patients/${patientId}/check-ins?${params}`,
      questions: (params) => `/caregiver/me/patients/${patientId}/questions?${params}`,
      'follow-ups': (params) => `/caregiver/me/patients/${patientId}/follow-ups?${params}`,
      submit: (id) => `/caregiver/me/check-ins/${id}/submit`,
      openQuestion: (episodeId) => `/caregiver/me/episodes/${episodeId}/questions`,
      thread: (id) => `/caregiver/me/questions/${id}`,
      reply: (id) => `/caregiver/me/questions/${id}/messages`,
    };
  }
  return {
    'check-ins': (params) => `/patient/me/check-ins?${params}`,
    questions: (params) => `/patient/me/questions?${params}`,
    'follow-ups': (params) => `/patient/me/follow-ups?${params}`,
    submit: (id) => `/patient/me/check-ins/${id}/submit`,
    openQuestion: (episodeId) => `/patient/me/episodes/${episodeId}/questions`,
    thread: (id) => `/patient/me/questions/${id}`,
    reply: (id) => `/patient/me/questions/${id}/messages`,
  };
}

export default function MyCare({ mode = 'patient', patientId }) {
  const [tab, setTab] = useState('check-ins');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [guidance, setGuidance] = useState(null);
  const [activeSlot, setActiveSlot] = useState(null);
  const [thread, setThread] = useState(null);
  const [subject, setSubject] = useState('');
  const [kind, setKind] = useState('operational');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const caregiver = mode === 'caregiver';
  const paths = useMemo(() => endpoints(mode, patientId), [mode, patientId]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    try {
      const data = await api(paths[tab](params.toString()));
      setItems(data.items);
      setTotal(data.total);
      setGuidance(data.guidance || null);
      setError(null);
    } catch (err) {
      setError(err.message);
      setItems([]);
      setTotal(0);
    }
  }, [page, tab, paths]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitAnswers(answers) {
    setBusy(true);
    setError(null);
    try {
      const result = await api(paths.submit(activeSlot.id), { method: 'POST', body: { answers } });
      setActiveSlot(null);
      setNotice(
        result.attention
          ? 'Answers sent. A clinic rule asked a staff member to look at this response.'
          : 'Answers sent.'
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // A question is always asked ABOUT an episode. The ids come from the list the
  // caller can actually see (their own list, or the grant-scoped one), so the
  // form can never be pointed at an episode they have no access to.
  const episodeIds = useMemo(
    () => [...new Set((items || []).map((item) => item.episode).filter(Boolean))],
    [items]
  );

  async function askQuestion(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const episodeId = episodeIds[0] || null;
    if (!episodeId) {
      setError('There is no recovery episode to ask about yet.');
      setBusy(false);
      return;
    }
    try {
      await api(paths.openQuestion(episodeId), {
        method: 'POST',
        body: { kind, subject, body: question },
      });
      setSubject('');
      setQuestion('');
      setNotice('Your question was sent to the care team.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openThread(threadId) {
    setError(null);
    try {
      const data = await api(paths.thread(threadId));
      setThread(data.thread);
    } catch (err) {
      setError(err.message);
    }
  }

  async function reply(payload) {
    setBusy(true);
    setError(null);
    try {
      const data = await api(paths.reply(thread.id), { method: 'POST', body: payload });
      setThread(data.thread);
      setNotice('Sent. A reply on a settled question reopens it for the team.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="card card--tabs" aria-labelledby="mycare-title">
      <div className="detail-head">
        <h1 id="mycare-title">{caregiver ? 'Care you help with' : 'My care'}</h1>
        {guidance && <span className="pill">{guidance.configured ? 'Clinic hours published' : 'No hours published'}</span>}
      </div>
      {guidance && (
        <p className="muted">
          {guidance.note}
          {guidance.display ? ` (${guidance.display})` : ''}
        </p>
      )}

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

      <div
        className="tabs"
        role="tablist"
        aria-label="My care"
        onKeyDown={(event) =>
          onTabListKeyDown(event, TABS.map((entry) => entry.key), tab, (next) => {
            setTab(next);
            setPage(1);
            setActiveSlot(null);
            setThread(null);
          })
        }
      >
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            tabIndex={tabStop(entry.key, tab)}
            className={tab === entry.key ? 'tab tab--active' : 'tab'}
            onClick={() => {
              setTab(entry.key);
              setPage(1);
              setActiveSlot(null);
              setThread(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'questions' && thread && (
        <ThreadView
          thread={thread}
          capacities={['reply', 'close', 'reopen']}
          onAction={reply}
          busy={busy}
          error={error}
        />
      )}

      {tab === 'check-ins' && activeSlot && (
        <CheckInForm slot={activeSlot} onSubmit={submitAnswers} busy={busy} error={error} />
      )}

      {!(tab === 'check-ins' && activeSlot) && !(tab === 'questions' && thread) && (
        <div className="panel-scroll">
          {items === null && <p className="muted">Loading…</p>}
          {items && items.length === 0 && (
            <p className="muted">
              {tab === 'check-ins'
                ? 'No check-ins are waiting for you.'
                : tab === 'questions'
                  ? 'You have no open questions.'
                  : 'No follow-up appointments are prescribed.'}
            </p>
          )}
          {items && items.length > 0 && (
            <ul className="care-list">
              {items.map((item) => (
                <li key={item.id} className="care-list__item">
                  <div className="care-list__head">
                    <span className="care-list__title">
                      {tab === 'follow-ups' ? `${item.date} · ${item.location}` : item.title || item.subject}
                    </span>
                    <span className={`pill pill--${tab === 'follow-ups' ? item.status : item.state}`}>
                      {tab === 'follow-ups' ? item.status : item.state}
                    </span>
                  </div>
                  {tab === 'check-ins' && (
                    <>
                      <p className="muted">{item.slotDate} · {item.note}</p>
                      {item.state === 'open' && item.questions && (
                        <button type="button" className="btn" onClick={() => setActiveSlot(item)}>
                          Answer this check-in
                        </button>
                      )}
                    </>
                  )}
            {tab === 'questions' && (
              <button type="button" className="btn" onClick={() => openThread(item.id)}>
                Read and reply
              </button>
            )}
                  {tab === 'follow-ups' && (
                    <>
                      {item.contact && (
                        <p className="muted">
                          Contact: {item.contact.name || 'the clinic'}
                          {item.contact.phone ? ` · ${item.contact.phone}` : ''}
                        </p>
                      )}
                      {item.reminder && item.reminder.appearsOn && (
                        <p className="muted">
                          An in-app reminder appears on {item.reminder.appearsOn}.
                        </p>
                      )}
                      {item.note_wording && <p className="muted">{item.note_wording}</p>}
                      {item.cancelReason && <p className="muted">Cancelled: {item.cancelReason}</p>}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'questions' && !thread && (
        <form className="inline-form" onSubmit={askQuestion}>
          <label htmlFor="new-question">Start a question</label>
          <select
            id="new-question-kind"
            aria-label="Question kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="operational">Operational (arrangements, paperwork)</option>
            <option value="clinical">Clinical (about my recovery)</option>
          </select>
          <input
            id="new-question"
            type="text"
            maxLength={160}
            aria-label="Subject"
            placeholder="Subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
          <input
            type="text"
            maxLength={2000}
            aria-label="Your question"
            placeholder="Your question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              busy || !episodeIds.length || subject.trim().length < 3 || question.trim().length < 2
            }
          >
            Send question
          </button>
          <p className="muted">
            {episodeIds.length
              ? 'A clinical question is answered by an assigned clinical reviewer. It is not monitored continuously.'
              : 'You have no recovery episode yet, so there is nothing to ask about.'}
          </p>
        </form>
      )}

      <div className="pager">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setPage((current) => current + 1)}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </div>
    </section>
  );
}
