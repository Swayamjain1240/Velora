'use strict';

import { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import ThreadView from './ThreadView';

// The assigned-team dashboard (Part 8).
//
// One viewport, tabs and pagination: the queue list scrolls inside its own panel,
// the page itself does not, and every count comes from the server, already scoped
// to the caller's active care-team assignments. Nothing here decides who may see
// what - an unassigned colleague simply receives an empty queue, and an
// administrator is refused by the server.
const QUEUES = [
  { key: 'pending_approvals', label: 'Approvals' },
  { key: 'open_questions', label: 'Open questions' },
  { key: 'check_in_reviews', label: 'Check-in reviews' },
  { key: 'failed_reminders', label: 'Failed reminders' },
  { key: 'missing_owners', label: 'Missing owners' },
];

const PAGE_SIZE = 10;

export default function AssignedQueues() {
  const [overview, setOverview] = useState(null);
  const [queueKey, setQueueKey] = useState('pending_approvals');
  const [page, setPage] = useState(1);
  const [mineOnly, setMineOnly] = useState(false);
  const [queue, setQueue] = useState(null);
  const [thread, setThread] = useState(null);
  const [response, setResponse] = useState(null);
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadOverview = useCallback(async () => {
    try {
      const data = await api('/dashboard');
      setOverview(data);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (mineOnly) params.set('mine', 'true');
      const data = await api(`/dashboard/queues/${queueKey}?${params.toString()}`);
      setQueue(data);
      // The queue response carries its own recomputed counts, which are fresher
      // than the ones from the first load. They are merged ON TOP of the overview
      // summary so the fields the queue does not compute stay intact.
      setOverview((current) =>
        current && current.summary && data.summary
          ? { ...current, summary: { ...current.summary, ...data.summary } }
          : current
      );
    } catch (err) {
      setError(err.message);
    }
  }, [queueKey, page, mineOnly]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    setThread(null);
    setResponse(null);
    setDetail(null);
    setNotice(null);
    loadQueue();
  }, [loadQueue]);

  async function claim(item) {
    setBusy(true);
    setError(null);
    try {
      await api(`/dashboard/queues/${queueKey}/${item.id}/claim`, { method: 'POST', body: {} });
      setNotice('This item is now assigned to you.');
      await loadQueue();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function release(item) {
    setBusy(true);
    setError(null);
    // The server scopes the release to the CALLER's own assignment, so this only
    // offers it for an item the caller owns: one they claimed themselves, or one
    // the queue derived as theirs.
    try {
      await api(`/dashboard/assignments/${item.owner.assignmentId}/release`, {
        method: 'POST',
        body: { reason: 'Released from the dashboard.' },
      });
      setNotice('Released back to the queue.');
      await loadQueue();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openItem(item) {
    setError(null);
    setNotice(null);
    setThread(null);
    setResponse(null);
    setDetail(null);
    try {
      if (item.targetType === 'clarification_thread') {
        const data = await api(`/episodes/${item.episode}/questions/${item.id}`);
        setThread(data.thread);
      } else if (item.targetType === 'check_in_response') {
        const data = await api(`/episodes/${item.episode}/check-ins/${item.id}`);
        setResponse(data.response);
      } else {
        // A plan version, a reminder or an episode has no separate reader here;
        // the item's own facts are shown rather than a dead click.
        setDetail(item);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function threadAction(action, payload) {
    setBusy(true);
    setError(null);
    try {
      const base = `/episodes/${thread.episode}/questions/${thread.id}`;
      if (action === 'reply') await api(`${base}/notes`, { method: 'POST', body: payload });
      if (action === 'answer') await api(`${base}/answer`, { method: 'POST', body: payload });
      if (action === 'note') await api(`${base}/notes`, { method: 'POST', body: payload });
      if (action === 'close') await api(`${base}/close`, { method: 'POST', body: {} });
      if (action === 'reopen') await api(`${base}/reopen`, { method: 'POST', body: {} });
      if (action === 'reclassify') await api(`${base}/reclassify`, { method: 'POST', body: {} });
      const refreshed = await api(base);
      setThread(refreshed.thread);
      setNotice('The question was updated and the history records it.');
      await loadQueue();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function reviewResponse() {
    setBusy(true);
    setError(null);
    try {
      await api(`/episodes/${response.episode}/check-ins/${response.id}/review`, {
        method: 'POST',
        body: { note },
      });
      setNotice('Review recorded. This was workflow attention, not a diagnosis.');
      setResponse(null);
      setNote('');
      await loadQueue();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function retry(item) {
    setBusy(true);
    setError(null);
    try {
      await api(`/episodes/${item.episode}/reminders/${item.id}/retry`, { method: 'POST', body: {} });
      setNotice('Retry queued. The attempt chain is bounded.');
      await loadQueue();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Defensive on the network boundary: a partial payload shows zero counts
  // rather than crashing the screen.
  const counts = (overview && overview.summary && overview.summary.counts) || {};
  const totalPages = queue ? Math.max(1, Math.ceil(queue.total / PAGE_SIZE)) : 1;

  return (
    <section className="card card--tabs" aria-labelledby="queues-title">
      <div className="detail-head">
        <h1 id="queues-title">Assigned queues</h1>
        {overview && overview.summary && (
          <span className="pill">{overview.summary.episodes || 0} episode(s) assigned to you</span>
        )}
      </div>
      <p className="muted">
        Every list and count here is limited to the episodes you are actively assigned to. An item
        appearing in a queue is workflow work, not a clinical finding.
      </p>

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

      <div className="tabs" role="tablist" aria-label="Assigned queues">
        {QUEUES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={queueKey === entry.key}
            className={queueKey === entry.key ? 'tab tab--active' : 'tab'}
            onClick={() => {
              setQueueKey(entry.key);
              setPage(1);
            }}
          >
            {entry.label}
            {counts.byQueue && counts.byQueue[entry.key] ? ` (${counts.byQueue[entry.key].count})` : ' (0)'}
          </button>
        ))}
      </div>

      <div className="queue__controls">
        <label className="inline-form">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(event) => {
              setMineOnly(event.target.checked);
              setPage(1);
            }}
          />
          <span>Only what I own</span>
        </label>
        <button type="button" className="btn btn--ghost" onClick={loadQueue} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="panel-scroll">
        {!queue && <p className="muted">Loading queue…</p>}
        {queue && queue.items.length === 0 && (
          <p className="muted">Nothing in this queue right now.</p>
        )}
        {queue && queue.items.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Workflow</th>
                <th scope="col">Owner</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {queue.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button type="button" className="link" onClick={() => openItem(item)}>
                      {item.title}
                    </button>
                  </td>
                  <td>
                    {item.requires && <span className="pill">{item.requires}</span>}
                    {item.missing && <span className="pill pill--none">Missing: {item.missing.join(', ')}</span>}
                    {item.attempts !== undefined && item.attempts !== null && item.queue === 'failed_reminders' && (
                      <span className="muted">{item.attempts} attempt(s)</span>
                    )}
                  </td>
                  <td>{item.owner ? item.owner.assigneeLabel : <span className="muted">Nobody</span>}</td>
                  <td className="table__actions">
                    {!item.owner && item.queue !== 'missing_owners' && (
                      <button type="button" className="btn" onClick={() => claim(item)} disabled={busy}>
                        Claim
                      </button>
                    )}
                    {item.owner && (item.owner.claimedBySelf || item.mine) && item.owner.assignmentId && (
                      <button type="button" className="btn btn--ghost" onClick={() => release(item)} disabled={busy}>
                        Release
                      </button>
                    )}
                    {item.queue === 'failed_reminders' && (
                      <button type="button" className="btn" onClick={() => retry(item)} disabled={busy}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="pager">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page <= 1 || busy}
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
          disabled={page >= totalPages || busy}
        >
          Next
        </button>
      </div>

      {thread && (
        <ThreadView
          thread={thread}
          capacities={['assign', 'answer', 'answerOperational', 'note', 'close', 'reopen']}
          onAction={threadAction}
          busy={busy}
          error={error}
        />
      )}

      {detail && (
        <section className="thread" aria-label="Queue item">
          <header className="thread__head">
            <h2>{detail.title}</h2>
            <span className={`pill pill--${detail.state}`}>{detail.state}</span>
          </header>
          <dl className="summary">
            {detail.version !== undefined && detail.version !== null && (
              <div>
                <dt>Plan version</dt>
                <dd>{detail.version}</dd>
              </div>
            )}
            {detail.attempts !== undefined && detail.attempts !== null && (
              <div>
                <dt>Delivery attempts</dt>
                <dd>{detail.attempts}</dd>
              </div>
            )}
            {detail.lastError && (
              <div>
                <dt>Last error</dt>
                <dd>{detail.lastError}</dd>
              </div>
            )}
            {detail.missing && (
              <div>
                <dt>Missing responsibility</dt>
                <dd>{detail.missing.join(', ')}</dd>
              </div>
            )}
            <div>
              <dt>Waiting since</dt>
              <dd>{new Date(detail.since).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="muted">
            {detail.targetType === 'plan_version'
              ? 'A plan version is reviewed and approved inside its episode workspace. This queue only tells you one is waiting for review.'
              : detail.targetType === 'notification'
                ? 'Delivery failed and is not an acknowledgement. Retrying re-queues the attempt chain, which is bounded.'
                : 'This episode has an unassigned responsibility on the care team. Assigning it needs the episode workspace.'}
          </p>
          {detail.attention && <p className="muted">{detail.attention}</p>}
        </section>
      )}

      {response && (
        <section className="thread" aria-label="Check-in review">
          <h2>{response.title || response.templateKey}</h2>
          <p className="muted">
            Answered {new Date(response.submittedAt).toLocaleString()}
            {response.isLate ? ' · after the window closed' : ''}
          </p>
          <ul className="checkin-form__options">
            {(response.triggeredRules || []).map((rule) => (
              <li key={rule.id}>{rule.label}</li>
            ))}
          </ul>
          {response.attentionNote && <p className="muted">{response.attentionNote}</p>}
          <dl className="summary">
            {(response.answers || []).map((answer) => (
              <div key={answer.questionId}>
                <dt>{answer.questionId}</dt>
                <dd>{answer.values ? answer.values.join(', ') : answer.value}</dd>
              </div>
            ))}
          </dl>
          <div className="inline-form">
            <label htmlFor="review-note">What did you do about it?</label>
            <input
              id="review-note"
              type="text"
              maxLength={1000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <button type="button" className="btn btn--primary" onClick={reviewResponse} disabled={busy}>
              Mark reviewed
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
