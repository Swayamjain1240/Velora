'use strict';

import { useState } from 'react';
import { reviewStateLabel, unresolvedLabel } from './planRules';

// Review and clarification panel. Only an assigned, clinic-verified clinical
// reviewer can reach these actions, and the server re-derives that on every
// request; this screen never decides authority by itself.
//
// Approval is explicitly two-step and states its consequences: the version is
// published to the patient, the previous approved version is superseded, and NO
// task, reminder or message is created.
export default function PlanReviewPanel({
  plan,
  items,
  blockers,
  busy,
  error,
  onItemDecision,
  onClarify,
  onApprove,
}) {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const canDecide = plan.state === 'in_review';
  const approvalBlockers = blockers || [];

  return (
    <div className="plans__split">
      <div className="plans__pane">
        <h3>Reviewed content</h3>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="panel-scroll">
          <ul className="plans__list">
            {items.map((item) => (
              <li key={item.id} className="plans__item">
                <div className="plans__item-head">
                  <strong>
                    {item.order}. {item.originalWording.slice(0, 70)}
                  </strong>
                  <span className="pill">{reviewStateLabel(item.clinicalReviewState)}</span>
                </div>
                {item.unresolvedFields.length > 0 && (
                  <p className="error" role="status">
                    Unresolved: {item.unresolvedFields.map(unresolvedLabel).join(', ')}
                  </p>
                )}
                <p className="muted">
                  {item.sourceCount} source reference(s)
                  {item.reviewedByLabel ? ` · reviewed by ${item.reviewedByLabel}` : ''}
                </p>
                {item.reviewNote && <p className="muted">Note: {item.reviewNote}</p>}
                <div className="table__actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={!canDecide || busy || item.unresolvedFields.length > 0}
                    onClick={() => onItemDecision(item.id, 'accepted', note)}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canDecide || busy}
                    onClick={() => onItemDecision(item.id, 'clarify', note)}
                  >
                    Ask for clarification
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="plans__pane">
        <h3>Decision</h3>

        <label htmlFor="review-note">Note added to a decision</label>
        <input
          id="review-note"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <label htmlFor="review-reason">Send the whole version back for clarification</label>
        <textarea
          id="review-reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="wizard__actions">
          <button
            type="button"
            className="btn"
            disabled={!canDecide || busy || reason.trim().length < 5}
            onClick={() => {
              onClarify(reason.trim());
              setReason('');
            }}
          >
            Request clarification
          </button>
        </div>

        <h3>Approve version {plan.version}</h3>
        {approvalBlockers.length > 0 ? (
          <ul className="plans__blockers" role="status">
            {approvalBlockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No blockers: every item is complete, sourced and accepted.</p>
        )}

        {!confirming ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canDecide || busy || approvalBlockers.length > 0}
            onClick={() => setConfirming(true)}
          >
            Review approval
          </button>
        ) : (
          <div className="plans__confirm" role="group" aria-label="Approval confirmation">
            <p>
              Approving publishes version {plan.version} to the patient as their current plan.
            </p>
            <ul>
              <li>The currently approved version is superseded and cannot be edited.</li>
              <li>
                Drafts, clarification notes and your working notes stay internal to the care team.
              </li>
              <li>No task, reminder or message is created by this approval.</li>
            </ul>
            <label className="check">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              I have reviewed the content and confirm this publication.
            </label>
            <div className="wizard__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setConfirming(false);
                  setAcknowledged(false);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!acknowledged || busy}
                onClick={onApprove}
              >
                {busy ? 'Approving…' : 'Approve and publish'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
