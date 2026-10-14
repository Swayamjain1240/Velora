'use strict';

import { useState } from 'react';

// A COMPACT clarification thread: the conversation in one scrollable panel, the
// state and history in a single line, and one action row.
//
// Every message body is rendered as TEXT. React escapes it, and nothing here uses
// dangerouslySetInnerHTML, so a message that contains markup is displayed exactly
// as characters (control #7). System lines are visually distinguished but are
// ordinary text too - they describe the workflow, never a clinical conclusion.
//
// The response hours, the contact guidance and the emergency line are shown next
// to the conversation, so a patient never reads an answer without knowing when the
// clinic is actually watching the queue.
export default function ThreadView({ thread, capacities, onAction, busy, error }) {
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');

  if (!thread) return <p className="muted">Choose a question to read it.</p>;

  const can = (name) => capacities && capacities.includes(name);
  const settled = thread.state === 'answered' || thread.state === 'closed';

  function send(action, payload) {
    onAction(action, payload);
    setBody('');
    setNote('');
  }

  return (
    <section className="thread" aria-label="Question thread">
      <header className="thread__head">
        <h2>{thread.subject}</h2>
        <span className={`pill pill--${thread.state}`}>{thread.state}</span>
        <span className="muted">{thread.kind === 'clinical' ? 'Clinical queue' : 'Operational queue'}</span>
      </header>

      <dl className="summary">
        <div>
          <dt>Opened</dt>
          <dd>
            {thread.openedByLabel || 'A care-team member'} · {thread.openedByRole}
          </dd>
        </div>
        <div>
          <dt>Responsible</dt>
          <dd>{thread.assignedToLabel || 'Nobody yet'}</dd>
        </div>
        {thread.reopenCount > 0 && (
          <div>
            <dt>Reopened</dt>
            <dd>{thread.reopenCount} time(s)</dd>
          </div>
        )}
      </dl>

      <div className="panel-scroll thread__scroll">
        <ol className="thread__messages">
          {(thread.messages || []).map((message) => (
            <li key={message.id} className={`thread__message thread__message--${message.kind}`}>
              <div className="thread__meta">
                <span>{message.kind === 'system' ? 'Update' : message.authorLabel || 'Care team'}</span>
                <span className="muted">{new Date(message.at).toLocaleString()}</span>
                {message.answeredAs && <span className="pill">{message.answeredAs}</span>}
              </div>
              {/* Plain text, escaped by React - never markup. */}
              <p>{message.body}</p>
            </li>
          ))}
        </ol>
      </div>

      {thread.notes && (
        <p className="muted thread__notes">
          {thread.notes.state} {thread.notes.answered || ''} {thread.notes.reopened || ''}
        </p>
      )}

      {thread.guidance && (
        <div className="thread__guidance">
          <p className="muted">{thread.guidance.note}</p>
          {thread.guidance.display && <p className="muted">Response hours: {thread.guidance.display}</p>}
          {thread.guidance.emergency && (
            <p className="muted">
              {thread.guidance.emergency.display || thread.guidance.emergency.fallback}
              {thread.guidance.emergency.contactPhone ? ` · ${thread.guidance.emergency.contactPhone}` : ''}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="thread__actions">
        {can('reply') && (
          <div className="inline-form">
            <label htmlFor="thread-reply">Add to this question</label>
            <input
              id="thread-reply"
              type="text"
              maxLength={2000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || body.trim().length < 2}
              onClick={() => send('reply', { body })}
            >
              Send
            </button>
          </div>
        )}

        {can('answer') && thread.kind === 'clinical' && (
          <div className="inline-form">
            <label htmlFor="thread-answer">Clinical reply</label>
            <input
              id="thread-answer"
              type="text"
              maxLength={2000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || body.trim().length < 2}
              onClick={() => send('answer', { body })}
            >
              Reply as reviewer
            </button>
          </div>
        )}

        {can('answerOperational') && thread.kind === 'operational' && (
          <div className="inline-form">
            <label htmlFor="thread-answer-operational">Operational reply</label>
            <input
              id="thread-answer-operational"
              type="text"
              maxLength={2000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || body.trim().length < 2}
              onClick={() => send('answer', { body })}
            >
              Reply
            </button>
          </div>
        )}

        {can('note') && (
          <div className="inline-form">
            <label htmlFor="thread-note">Internal note (not shown to the patient)</label>
            <input
              id="thread-note"
              type="text"
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || note.trim().length < 2}
              onClick={() => send('note', { body: note })}
            >
              Save note
            </button>
          </div>
        )}

        {can('assign') && thread.kind === 'clinical' && (
          <div className="thread__close">
            <button type="button" className="btn" disabled={busy} onClick={() => send('close', {})}>
              Close
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => send('reopen', {})}>
              Reopen
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => send('reclassify', {})}
            >
              Move to clinical queue
            </button>
          </div>
        )}

        {settled && can('reply') && (
          <p className="muted">
            Sending another message reopens this question so the team sees it again. The earlier
            answer stays in the history.
          </p>
        )}
      </div>
    </section>
  );
}
