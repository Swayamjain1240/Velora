'use strict';

import { useState } from 'react';
import { ITEM_KINDS } from './planRules';

// The clinical field set, split into two short steps so the editor fits one
// viewport on the smallest required screen instead of becoming a tall page.
const CORE_FIELDS = [
  ['medication', 'Medication name', 200],
  ['dose', 'Dose (as written)', 120],
  ['route', 'Route', 120],
  ['frequency', 'Frequency', 120],
  ['duration', 'Duration', 120],
];

const SECONDARY_FIELDS = [
  ['timing', 'Timing', 200],
  ['condition', 'Condition', 300],
  ['homeCare', 'Home care instruction', 500],
  ['dietActivity', 'Diet or activity instruction', 500],
  ['followUp', 'Follow-up information', 500],
  ['warning', 'Warning instruction', 500],
];

const EMPTY = {
  kind: 'instruction',
  originalWording: '',
  medication: '',
  dose: '',
  route: '',
  frequency: '',
  duration: '',
  timing: '',
  condition: '',
  homeCare: '',
  dietActivity: '',
  followUp: '',
  warning: '',
};

function initial(item) {
  if (!item) return { ...EMPTY };
  const next = { ...EMPTY };
  for (const key of Object.keys(EMPTY)) next[key] = item[key] || '';
  return next;
}

// Manual item editor. Nothing is inferred or completed for the coordinator: an
// absent value is submitted as absent and the server reports it as unresolved.
export default function PlanItemForm({ item, busy, error, onSave, onCancel }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(() => initial(item));

  function set(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    if (step === 1) {
      setStep(2);
      return;
    }
    // Only fields the coordinator actually typed are sent: an empty string stays
    // an explicit empty value rather than being silently dropped.
    onSave(form);
  }

  return (
    <form className="wizard" onSubmit={submit} noValidate aria-label="Care plan item">
      <ol className="stepper">
        <li className={`stepper__item${step === 1 ? ' stepper__item--active' : ''}`}>
          Step 1 · Content
        </li>
        <li className={`stepper__item${step === 2 ? ' stepper__item--active' : ''}`}>
          Step 2 · Extra instruction
        </li>
      </ol>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="wizard__body">
        {step === 1 && (
          <>
            <label htmlFor="item-kind">Item type</label>
            <select id="item-kind" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
              {ITEM_KINDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <label htmlFor="item-wording">Original wording (exactly as written)</label>
            <textarea
              id="item-wording"
              rows={3}
              maxLength={2000}
              value={form.originalWording}
              onChange={(e) => set('originalWording', e.target.value)}
            />
            <p className="muted">
              Copy the clinical text verbatim. Leave a field empty if the document does not state
              it — a missing or conflicting dose, frequency or duration will block approval.
            </p>

            <div className="plans__grid">
              {CORE_FIELDS.map(([field, label, max]) => (
                <div key={field}>
                  <label htmlFor={`item-${field}`}>{label}</label>
                  <input
                    id={`item-${field}`}
                    maxLength={max}
                    value={form[field]}
                    onChange={(e) => set(field, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <div className="plans__grid">
            {SECONDARY_FIELDS.map(([field, label, max]) => (
              <div key={field}>
                <label htmlFor={`item-${field}`}>{label}</label>
                <input
                  id={`item-${field}`}
                  maxLength={max}
                  value={form[field]}
                  onChange={(e) => set(field, e.target.value)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="wizard__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {step === 2 && (
          <button type="button" className="btn" onClick={() => setStep(1)} disabled={busy}>
            Back
          </button>
        )}
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !form.originalWording.trim()}
        >
          {busy ? 'Saving…' : step === 1 ? 'Continue' : item ? 'Save item' : 'Add item'}
        </button>
      </div>
    </form>
  );
}
