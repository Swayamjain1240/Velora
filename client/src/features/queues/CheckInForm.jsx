'use strict';

import { useState } from 'react';

// The check-in answer form. It fits ONE viewport: the questions of a slot are
// bounded by the clinic's own template (30 at the very most) and the panel
// scrolls internally rather than the page.
//
// Two things it deliberately does NOT do: it never states what a missing check-in
// means, and it never renders clinic or patient text as markup - everything is
// React text, so a pasted `<img>` shows up as characters rather than as HTML.
export default function CheckInForm({ slot, onSubmit, busy, error }) {
  const questions = slot.questions || [];
  const [answers, setAnswers] = useState(() =>
    Object.fromEntries(
      questions.map((question) => [
        question.id,
        question.kind === 'confirm' ? '' : question.kind === 'choice' && question.multi ? [] : '',
      ])
    )
  );

  function setAnswer(questionId, value) {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }

  function toggleMulti(questionId, option) {
    setAnswers((current) => {
      const list = Array.isArray(current[questionId]) ? current[questionId] : [];
      const next = list.includes(option)
        ? list.filter((value) => value !== option)
        : [...list, option];
      return { ...current, [questionId]: next };
    });
  }

  function submit(event) {
    event.preventDefault();
    const payload = questions
      .map((question) => {
        const value = answers[question.id];
        if (Array.isArray(value)) return { questionId: question.id, values: value };
        return { questionId: question.id, value };
      })
      // An unanswered optional question is simply not sent.
      .filter((answer) =>
        Array.isArray(answer.values) ? answer.values.length > 0 : String(answer.value ?? '').length > 0
      );
    onSubmit(payload);
  }

  return (
    <form className="checkin-form" onSubmit={submit}>
      <h2>{slot.title || slot.templateKey}</h2>
      <p className="muted">
        Due {slot.slotDate} · {slot.timezone}
        {slot.isLate ? ' · answering after the window closed' : ''}
      </p>
      {slot.note && <p className="muted">{slot.note}</p>}

      <div className="checkin-form__fields">
        {questions.map((question) => (
          <fieldset key={question.id} className="checkin-form__field">
            <legend>{question.prompt}</legend>
            {question.kind === 'scale' && (
              <input
                type="number"
                min={question.scaleMin}
                max={question.scaleMax}
                inputMode="numeric"
                aria-label={question.prompt}
                value={answers[question.id]}
                onChange={(event) => setAnswer(question.id, event.target.value)}
              />
            )}
            {question.kind === 'text' && (
              <input
                type="text"
                maxLength={500}
                aria-label={question.prompt}
                value={answers[question.id]}
                onChange={(event) => setAnswer(question.id, event.target.value)}
              />
            )}
            {question.kind === 'confirm' && (
              <select
                aria-label={question.prompt}
                value={answers[question.id]}
                onChange={(event) => setAnswer(question.id, event.target.value)}
              >
                <option value="">Choose…</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            )}
            {question.kind === 'choice' && (
              <div className="checkin-form__options">
                {(question.options || []).map((option) => (
                  <label key={option} className="checkin-form__option">
                    <input
                      type="checkbox"
                      checked={
                        Array.isArray(answers[question.id])
                          ? answers[question.id].includes(option)
                          : answers[question.id] === option
                      }
                      onChange={() =>
                        question.multi
                          ? toggleMulti(question.id, option)
                          : setAnswer(question.id, option)
                      }
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        ))}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? 'Sending…' : 'Send answers'}
      </button>
    </form>
  );
}
