'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import PlanItemForm from './PlanItemForm';
import PlanReviewPanel from './PlanReviewPanel';
import PlanSourcePanel from './PlanSourcePanel';
import ExtractionPanel from '../extraction/ExtractionPanel';
import LanguagePanel from '../extraction/LanguagePanel';
import {
  PAGE_SIZE,
  clinicalValues,
  formatWhen,
  isPlanDenied,
  isStalePlan,
  reviewStateLabel,
  safePlanMessage,
  stateLabel,
  stateNote,
  unresolvedLabel,
} from './planRules';

// The AI-assisted tabs sit beside the manual ones and never replace them: with
// no provider enabled they simply report that extraction is unavailable, and the
// entire manual workflow below is unchanged.
const TABS = ['draft', 'extraction', 'language', 'sources', 'review', 'history'];
// `draft`/`sources` are drafting actions, `review` is clinical review; the two
// Part 6 tabs are shown to the same care team and the server re-checks authority
// on every request anyway.
const TEAM_TABS = ['extraction', 'language'];
const DOC_PAGE_SIZE = 50;
// The item fields the editor submits (the wording is handled separately).
const CLINICAL_KEYS = [
  'medication',
  'dose',
  'route',
  'frequency',
  'duration',
  'timing',
  'condition',
  'homeCare',
  'dietActivity',
  'followUp',
  'warning',
];

// The staff care-plan workspace for one episode. Every mutation carries the plan
// revision the screen currently holds; the server refuses a stale write with a
// 409, and the screen then clears its stale copy instead of showing actions that
// can no longer succeed.
export default function CarePlanPanel({ episodeId, episodeStatus, onDenied }) {
  const { memberships } = useAuth();
  const roleKey = memberships && memberships[0] ? memberships[0].roleKey : null;
  const canDraftHint = roleKey === 'care_coordinator';
  const canReviewHint = roleKey === 'clinical_reviewer';

  const base = `/episodes/${episodeId}/plans`;

  const [versions, setVersions] = useState({ items: [], total: 0, page: 1 });
  const [planId, setPlanId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('draft');
  const [itemPage, setItemPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [wizard, setWizard] = useState(null);
  const [readyDocs, setReadyDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // A denial or a lost revision clears the clinical content entirely.
  const [denied, setDenied] = useState(false);

  const clearClinicalState = useCallback(() => {
    setDetail(null);
    setVersions({ items: [], total: 0, page: 1 });
    setPlanId(null);
    setEditing(null);
    setWizard(null);
  }, []);

  const fail = useCallback(
    (err) => {
      if (isPlanDenied(err)) {
        clearClinicalState();
        setDenied(true);
        if (onDenied) onDenied(err);
      } else if (isStalePlan(err)) {
        // A stale screen must not keep offering an obsolete action.
        setEditing(null);
        setWizard(null);
      }
      setError(safePlanMessage(err));
    },
    [clearClinicalState, onDenied]
  );

  const loadVersions = useCallback(
    async (page = 1) => {
      try {
        const data = await api(`${base}?page=${page}&limit=${PAGE_SIZE}`);
        setVersions({ items: data.items || [], total: data.total || 0, page });
        return data.items || [];
      } catch (err) {
        fail(err);
        return [];
      }
    },
    [base, fail]
  );

  // One version is read twice on purpose: the paginated item route drives the
  // draft editor (one page at a time), while the version route supplies the
  // blocker list, the review timeline and the complete item set the review and
  // source panels need.
  const loadDetail = useCallback(
    async (id, page = 1) => {
      try {
        const [full, pageData] = await Promise.all([
          api(`${base}/${id}`),
          api(`${base}/${id}/items?page=${page}&limit=${PAGE_SIZE}`),
        ]);
        setDetail({
          plan: full.plan,
          allItems: full.items,
          items: pageData.items || [],
          itemTotal: pageData.total || 0,
          blockers: full.blockers ? full.blockers.approval : [],
          events: full.events || [],
        });
        setItemPage(page);
      } catch (err) {
        fail(err);
      }
    },
    [base, fail]
  );

  useEffect(() => {
    loadVersions(1).then((items) => {
      if (items.length) {
        const current = items.find((plan) => plan.isCurrent) || items.find((plan) => plan.editable) || items[0];
        setPlanId(current.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  useEffect(() => {
    if (planId) loadDetail(planId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  const loadReadyDocuments = useCallback(async () => {
    try {
      const data = await api(`/episodes/${episodeId}/documents?page=1&limit=${DOC_PAGE_SIZE}`);
      setReadyDocs((data.items || []).filter((doc) => doc.status === 'ready'));
    } catch {
      // A document-read denial is reported by the documents panel itself; the
      // plan screen simply offers no citable document.
      setReadyDocs([]);
    }
  }, [episodeId]);

  // The citable/ready documents are needed by BOTH the extraction panel (which
  // targets one ready document) and the sources panel. They are loaded with the
  // episode, not only on a manual reload, so a coordinator opening the
  // extraction tab always sees the episode's ready documents.
  useEffect(() => {
    loadReadyDocuments();
  }, [loadReadyDocuments]);

  // Every write: send the revision we hold, then re-read the version list and the
  // detail so the screen never keeps a stale projection.
  async function write(run, successMessage, { reloadList = false } = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      if (reloadList) await loadVersions(versions.page);
      if (planId) await loadDetail(planId, itemPage);
      if (successMessage) setNotice(successMessage);
      return true;
    } catch (err) {
      fail(err);
      // A stale write re-reads the authoritative state immediately, so the screen
      // stops offering the action that no longer applies.
      if (isStalePlan(err) && planId) await loadDetail(planId, itemPage);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function revisionOf() {
    return detail && detail.plan ? detail.plan.revision : null;
  }

  // Every clinical field is sent explicitly: an empty string clears the field,
  // and the server then reports it as unresolved rather than filling it in.
  function itemPayload(form) {
    const payload = {
      expectedRevision: revisionOf(),
      kind: form.kind,
      originalWording: form.originalWording,
    };
    for (const key of CLINICAL_KEYS) payload[key] = form[key] || '';
    return payload;
  }

  const totalItemPages = detail ? Math.max(1, Math.ceil(detail.itemTotal / PAGE_SIZE)) : 1;

  if (denied) {
    return (
      <div className="plans">
        <p className="muted">Care plans are not available to you.</p>
      </div>
    );
  }

  return (
    <div className="plans">
      <div className="plans__head">
        <h2>Care plan</h2>
        {detail && detail.plan ? (
          <span className={`pill pill--plan-${detail.plan.state}`}>
            v{detail.plan.version} · {stateLabel(detail.plan.state)}
          </span>
        ) : (
          <span className="muted">No plan version yet.</span>
        )}
        {!wizard && episodeStatus === 'draft' && canDraftHint && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setWizard({ step: 1, basis: 'blank', fromVersionId: '', title: '', summary: '' })}
          >
            New draft version
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

      {wizard && (
        <form
          className="wizard"
          onSubmit={(event) => event.preventDefault()}
          noValidate
          aria-label="New draft version"
        >
          <ol className="stepper">
            <li className={`stepper__item${wizard.step === 1 ? ' stepper__item--active' : ''}`}>
              Step 1 · Basis
            </li>
            <li className={`stepper__item${wizard.step === 2 ? ' stepper__item--active' : ''}`}>
              Step 2 · Framing
            </li>
            <li className={`stepper__item${wizard.step === 3 ? ' stepper__item--active' : ''}`}>
              Step 3 · Confirm
            </li>
          </ol>
          <div className="wizard__body">
            {wizard.step === 1 && (
              <fieldset className="scopes">
                <legend>Where does this draft start?</legend>
                <label className="check">
                  <input
                    type="radio"
                    name="basis"
                    checked={wizard.basis === 'blank'}
                    onChange={() => setWizard({ ...wizard, basis: 'blank', fromVersionId: '' })}
                  />
                  Start empty (manual authoring)
                </label>
                <label className="check">
                  <input
                    type="radio"
                    name="basis"
                    checked={wizard.basis === 'copy'}
                    onChange={() => setWizard({ ...wizard, basis: 'copy' })}
                  />
                  Copy an existing version (items come back unreviewed)
                </label>
                {wizard.basis === 'copy' && (
                  <select
                    aria-label="Version to copy"
                    value={wizard.fromVersionId}
                    onChange={(e) => setWizard({ ...wizard, fromVersionId: e.target.value })}
                  >
                    <option value="">Select a version…</option>
                    {versions.items.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        v{plan.version} · {stateLabel(plan.state)}
                      </option>
                    ))}
                  </select>
                )}
              </fieldset>
            )}

            {wizard.step === 2 && (
              <>
                <label htmlFor="wizard-title">Title (optional)</label>
                <input
                  id="wizard-title"
                  maxLength={200}
                  value={wizard.title}
                  onChange={(e) => setWizard({ ...wizard, title: e.target.value })}
                />
                <label htmlFor="wizard-summary">Summary (optional)</label>
                <textarea
                  id="wizard-summary"
                  rows={3}
                  maxLength={2000}
                  value={wizard.summary}
                  onChange={(e) => setWizard({ ...wizard, summary: e.target.value })}
                />
                <p className="muted">
                  The summary is non-clinical framing for the care team. Clinical instructions belong
                  in the items.
                </p>
              </>
            )}

            {wizard.step === 3 && (
              <div>
                <p>
                  A new draft version is created. Nothing is published to the patient until an
                  assigned clinical reviewer approves this version.
                </p>
                <ul>
                  <li>Basis: {wizard.basis === 'copy' ? 'copy of an existing version' : 'empty draft'}</li>
                  <li>Title: {wizard.title || '—'}</li>
                  <li>Every copied item returns to “Awaiting clinical review”.</li>
                </ul>
              </div>
            )}
          </div>

          <div className="wizard__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setWizard(null)}
              disabled={busy}
            >
              Cancel
            </button>
            {wizard.step > 1 && (
              <button
                type="button"
                className="btn"
                onClick={() => setWizard({ ...wizard, step: wizard.step - 1 })}
                disabled={busy}
              >
                Back
              </button>
            )}
            {wizard.step < 3 ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || (wizard.step === 1 && wizard.basis === 'copy' && !wizard.fromVersionId)}
                onClick={() => setWizard({ ...wizard, step: wizard.step + 1 })}
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={async () => {
                  const body = {};
                  if (wizard.title) body.title = wizard.title;
                  if (wizard.summary) body.summary = wizard.summary;
                  if (wizard.basis === 'copy') body.fromVersionId = wizard.fromVersionId;
                  const created = await write(
                    async () => {
                      const data = await api(base, { method: 'POST', body });
                      setPlanId(data.plan.id);
                    },
                    'Draft version created.',
                    { reloadList: true }
                  );
                  if (created) setWizard(null);
                }}
              >
                {busy ? 'Creating…' : 'Create draft version'}
              </button>
            )}
          </div>
        </form>
      )}

      {!wizard && !detail && <p className="muted">Loading care plan…</p>}

      {!wizard && detail && detail.plan && (
        <>
          <div className="tabs" role="tablist" aria-label="Care plan sections">
            {TABS.filter(
              (name) =>
                (name !== 'review' || canReviewHint) &&
                (!TEAM_TABS.includes(name) || canDraftHint || canReviewHint)
            ).map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={tab === name}
                className={tab === name ? 'tab tab--active' : 'tab'}
                onClick={() => setTab(name)}
              >
                {name[0].toUpperCase() + name.slice(1)}
              </button>
            ))}
          </div>

          <p className="muted">{stateNote(detail.plan.state)}</p>

          {detail.plan.state === 'needs_clarification' && detail.plan.clarificationReason && (
            <p className="notice" role="status">
              Reviewer clarification: {detail.plan.clarificationReason}
            </p>
          )}

          {editing ? (
            <PlanItemForm
              item={editing.item}
              busy={busy}
              error={error}
              onCancel={() => setEditing(null)}
              onSave={async (form) => {
                const ok = await write(
                  async () => {
                    if (editing.item) {
                      await api(`${base}/${planId}/items/${editing.item.id}`, {
                        method: 'PATCH',
                        body: itemPayload(form),
                      });
                    } else {
                      await api(`${base}/${planId}/items`, { method: 'POST', body: itemPayload(form) });
                    }
                  },
                  editing.item ? 'Item saved.' : 'Item added.'
                );
                if (ok) setEditing(null);
              }}
            />
          ) : (
            <div className="panel-scroll">
              {tab === 'draft' && (
                <>
                  <div className="table__actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy || !detail.plan.editable || !canDraftHint}
                      onClick={() => setEditing({ item: null })}
                    >
                      Add item
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !detail.plan.editable || !canDraftHint}
                      onClick={async () => {
                        await write(
                          () =>
                            api(`${base}/${planId}/submit`, {
                              method: 'POST',
                              body: { expectedRevision: revisionOf() },
                            }),
                          'Submitted for clinical review.',
                          { reloadList: true }
                        );
                      }}
                    >
                      Submit for review
                    </button>
                  </div>
                  {!detail.plan.editable && (
                    <p className="muted">
                      {detail.plan.state === 'approved'
                        ? 'This version is approved and immutable. Create a new draft version to change anything.'
                        : 'This version can no longer be edited.'}
                    </p>
                  )}

                  <ul className="plans__list">
                    {detail.items.map((item) => (
                      <li key={item.id} className="plans__item">
                        <div className="plans__item-head">
                          <strong>
                            {item.order}. {item.originalWording}
                          </strong>
                          <span className="pill">{reviewStateLabel(item.clinicalReviewState)}</span>
                        </div>
                        <dl className="summary">
                          {clinicalValues(item).map(([key, label, value]) => (
                            <div key={key} className="plans__field">
                              <dt>{label}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                        {item.unresolvedFields.length > 0 ? (
                          <p className="error" role="status">
                            Blocking approval: {item.unresolvedFields.map(unresolvedLabel).join(', ')}
                          </p>
                        ) : (
                          <p className="muted">All required clinical fields are stated.</p>
                        )}
                        <p className="muted">{item.sourceCount} source reference(s)</p>
                        <div className="table__actions">
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy || !detail.plan.editable || !canDraftHint}
                            onClick={() => setEditing({ item })}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy || !detail.plan.editable || !canDraftHint}
                            onClick={() =>
                              write(
                                () =>
                                  api(`${base}/${planId}/items/${item.id}/reorder`, {
                                    method: 'POST',
                                    body: { expectedRevision: revisionOf(), direction: 'up' },
                                  }),
                                null
                              )
                            }
                          >
                            Move up
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy || !detail.plan.editable || !canDraftHint}
                            onClick={() =>
                              write(
                                () =>
                                  api(`${base}/${planId}/items/${item.id}/reorder`, {
                                    method: 'POST',
                                    body: { expectedRevision: revisionOf(), direction: 'down' },
                                  }),
                                null
                              )
                            }
                          >
                            Move down
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy || !detail.plan.editable || !canDraftHint}
                            onClick={() =>
                              write(
                                () =>
                                  api(`${base}/${planId}/items/${item.id}`, {
                                    method: 'DELETE',
                                    body: { expectedRevision: revisionOf() },
                                  }),
                                'Item removed.'
                              )
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                    {detail.items.length === 0 && (
                      <li className="muted">
                        No items yet. Author each instruction by hand from the discharge document.
                      </li>
                    )}
                  </ul>
                </>
              )}

              {tab === 'extraction' && (
                <ExtractionPanel
                  episodeId={episodeId}
                  planId={planId}
                  planEditable={Boolean(detail.plan.editable)}
                  readyDocuments={readyDocs}
                  canDraft={canDraftHint}
                  onDenied={fail}
                  // An applied suggestion is an ordinary new draft item, so the
                  // whole version is re-read to show it in place.
                  onApplied={() => loadDetail(planId, itemPage)}
                />
              )}

              {tab === 'language' && (
                <LanguagePanel
                  episodeId={episodeId}
                  planId={planId}
                  items={detail.allItems}
                  planEditable={Boolean(detail.plan.editable)}
                  canDraft={canDraftHint}
                  canReview={canReviewHint}
                  onDenied={fail}
                />
              )}

              {tab === 'sources' && (
                <PlanSourcePanel
                  items={detail.allItems}
                  readyDocuments={readyDocs}
                  busy={busy}
                  error={error}
                  onReloadDocuments={loadReadyDocuments}
                  onLink={(itemId, body) =>
                    write(
                      () =>
                        api(`${base}/${planId}/items/${itemId}/sources`, {
                          method: 'POST',
                          body: { expectedRevision: revisionOf(), ...body },
                        }),
                      'Source reference linked.'
                    )
                  }
                  onRemove={(sourceId) =>
                    write(
                      () =>
                        api(`${base}/${planId}/sources/${sourceId}`, {
                          method: 'DELETE',
                          body: { expectedRevision: revisionOf() },
                        }),
                      'Source reference removed.'
                    )
                  }
                />
              )}

              {tab === 'review' && (
                <PlanReviewPanel
                  plan={detail.plan}
                  items={detail.allItems}
                  blockers={detail.blockers}
                  busy={busy}
                  error={error}
                  onItemDecision={(itemId, decision, note) =>
                    write(
                      () =>
                        api(`${base}/${planId}/items/${itemId}/review`, {
                          method: 'POST',
                          body: {
                            expectedRevision: revisionOf(),
                            decision,
                            note: note || undefined,
                          },
                        }),
                      decision === 'accepted' ? 'Item accepted.' : 'Clarification requested on the item.'
                    )
                  }
                  onClarify={(reason) =>
                    write(
                      () =>
                        api(`${base}/${planId}/clarification`, {
                          method: 'POST',
                          body: { expectedRevision: revisionOf(), reason },
                        }),
                      'Sent back to the coordinator.',
                      { reloadList: true }
                    )
                  }
                  onApprove={() =>
                    write(
                      () =>
                        api(`${base}/${planId}/approve`, {
                          method: 'POST',
                          body: { expectedRevision: revisionOf(), confirm: true },
                        }),
                      'Approved. The patient now sees this version.',
                      { reloadList: true }
                    )
                  }
                />
              )}

              {tab === 'history' && (
                <table className="table">
                  <caption className="visually-hidden">Care plan version history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Version</th>
                      <th scope="col">State</th>
                      <th scope="col">Created</th>
                      <th scope="col">Approved</th>
                      <th scope="col">Superseded by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.items.map((plan) => (
                      <tr key={plan.id}>
                        <td>
                          v{plan.version}
                          {plan.isCurrent ? ' (current)' : ''}
                        </td>
                        <td>{stateLabel(plan.state)}</td>
                        <td>{formatWhen(plan.createdAt)}</td>
                        <td>
                          {plan.approvedAt
                            ? `${formatWhen(plan.approvedAt)} · ${plan.approvedByLabel || 'reviewer'}`
                            : '—'}
                        </td>
                        <td>{plan.supersededAt ? formatWhen(plan.supersededAt) : '—'}</td>
                      </tr>
                    ))}
                    {versions.items.length === 0 && (
                      <tr>
                        <td colSpan={5}>No versions yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <nav className="pager" aria-label="Plan version pagination">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={itemPage <= 1 || busy}
              onClick={() => {
                const next = itemPage - 1;
                setItemPage(next);
                loadDetail(planId, next);
              }}
            >
              Previous
            </button>
            <span>
              Page {itemPage} of {totalItemPages}
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={itemPage >= totalItemPages || busy}
              onClick={() => {
                const next = itemPage + 1;
                setItemPage(next);
                loadDetail(planId, next);
              }}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
