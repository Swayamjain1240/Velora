'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  LANGUAGE_LABELS,
  PAGE_SIZE,
  VARIANT_KIND_LABELS,
  fidelityWarningLabel,
  isExtractionDenied,
  isStaleExtraction,
  kindLabel,
  safeExtractionMessage,
  variantStateLabel,
} from './extractionRules';

// Reviewed Hindi/English presentation of the plan's instructions.
//
// A rendering is ALWAYS linked to the instruction it renders (the wording it was
// drafted from is captured on creation and shown beside it), it is VERSIONED (a
// revision is a new rendering, never an edit in place), and it needs an ASSIGNED
// clinical reviewer to approve it. It NEVER becomes patient-visible here: no
// patient screen reads renderings, and approving one changes presentation only -
// never an item's clinical fields or the plan's approval state.
export default function LanguagePanel({
  episodeId,
  planId,
  items,
  planEditable,
  canDraft,
  canReview,
  onDenied,
}) {
  const base = `/episodes/${episodeId}/plans/${planId}/variants`;

  const [list, setList] = useState({ items: [], total: 0, page: 1 });
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({ itemId: '', language: 'hi', kind: 'translation', text: '' });
  const [fidelityNote, setFidelityNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = useCallback(
    (err) => {
      if (isExtractionDenied(err)) {
        setList({ items: [], total: 0, page: 1 });
        setSelectedId(null);
        if (onDenied) onDenied(err);
      }
      setError(safeExtractionMessage(err));
    },
    [onDenied]
  );

  const load = useCallback(
    async (page = 1) => {
      try {
        const data = await api(`${base}?page=${page}&limit=${PAGE_SIZE}`);
        const rows = data.items || [];
        setList({ items: rows, total: data.total || 0, page });
        setSelectedId((prev) => (prev && rows.some((row) => row.id === prev) ? prev : rows.length ? rows[0].id : null));
        setFidelityNote('');
        setRejectReason('');
      } catch (err) {
        fail(err);
      }
    },
    [base, fail]
  );

  useEffect(() => {
    if (planId) load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  async function write(run, successMessage) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      await load(list.page);
      if (successMessage) setNotice(successMessage);
      return true;
    } catch (err) {
      fail(err);
      if (isStaleExtraction(err)) await load(list.page);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const selected = list.items.find((row) => row.id === selectedId) || null;
  const totalPages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const itemFor = (itemId) => items.find((item) => item.id === itemId) || null;

  return (
    <div className="plans">
      <div className="plans__head">
        <h3>Reviewed Hindi / English presentation</h3>
      </div>
      <p className="muted">
        A rendering is linked to one instruction, is versioned, and is used only after an assigned
        clinical reviewer states that the meaning is preserved. It never becomes patient-visible on
        its own, and approving one changes no clinical value.
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

      <div className="table__actions">
        <label htmlFor="lv-item">Instruction</label>
        <select
          id="lv-item"
          value={draft.itemId}
          onChange={(e) => setDraft({ ...draft, itemId: e.target.value })}
          disabled={busy || !canDraft || !planEditable}
        >
          <option value="">Select an item…</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.order}. {kindLabel(item.kind)} — {item.originalWording.slice(0, 60)}
            </option>
          ))}
        </select>
        <label htmlFor="lv-language">Language</label>
        <select
          id="lv-language"
          value={draft.language}
          onChange={(e) => setDraft({ ...draft, language: e.target.value })}
          disabled={busy || !canDraft || !planEditable}
        >
          {Object.entries(LANGUAGE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label htmlFor="lv-kind">Kind</label>
        <select
          id="lv-kind"
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
          disabled={busy || !canDraft || !planEditable}
        >
          {Object.entries(VARIANT_KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <label htmlFor="lv-text">Wording</label>
      <textarea
        id="lv-text"
        rows={2}
        maxLength={2000}
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        disabled={busy || !canDraft || !planEditable}
      />
      <div className="wizard__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !canDraft || !planEditable || !draft.itemId || draft.text.trim().length < 2}
          onClick={() =>
            write(
              () =>
                api(`/episodes/${episodeId}/plans/${planId}/items/${draft.itemId}/variants`, {
                  method: 'POST',
                  body: {
                    language: draft.language,
                    kind: draft.kind,
                    text: draft.text.trim(),
                  },
                }),
              'Rendering drafted. It is not published anywhere until a clinical reviewer approves it.'
            ).then((ok) => {
              if (ok) setDraft({ ...draft, text: '' });
            })
          }
        >
          Draft rendering
        </button>
      </div>

      {list.items.length === 0 && (
        <p className="muted">
          No rendering yet. The instruction and the clinical fields are unchanged by this panel.
        </p>
      )}

      {list.items.length > 0 && (
        <div className="plans__split">
          <div className="plans__pane">
            <h3>Renderings</h3>
            <div className="panel-scroll">
              <ul className="plans__list">
                {list.items.map((row) => (
                  <li
                    key={row.id}
                    className={row.id === selectedId ? 'plans__item plans__item--active' : 'plans__item'}
                  >
                    <div className="plans__item-head">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        aria-pressed={row.id === selectedId}
                        onClick={() => setSelectedId(row.id)}
                      >
                        {LANGUAGE_LABELS[row.language]} · {VARIANT_KIND_LABELS[row.kind]} · v{row.variant}
                      </button>
                      <span className="pill">{variantStateLabel(row.reviewState)}</span>
                    </div>
                    <p className="plans__quote">
                      {itemFor(row.item)
                        ? `Item ${itemFor(row.item).order} · ${kindLabel(itemFor(row.item).kind)}`
                        : `Item · ${kindLabel(row.itemKind)}`}
                    </p>
                    <p className="muted">
                      drafted by {row.producedBy === 'model' ? 'a model' : 'a person'} ·{' '}
                      {row.fidelity.passed
                        ? 'number guard passed'
                        : `${row.fidelity.warnings.length} guard warning(s)`}
                    </p>
                  </li>
                ))}
              </ul>
              <nav className="pager" aria-label="Rendering pagination">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={list.page <= 1 || busy}
                  onClick={() => load(list.page - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {list.page} of {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={list.page >= totalPages || busy}
                  onClick={() => load(list.page + 1)}
                >
                  Next
                </button>
              </nav>
            </div>
          </div>

          {selected && (
            <div className="plans__pane">
              <h3>
                {LANGUAGE_LABELS[selected.language]} · {VARIANT_KIND_LABELS[selected.kind]} · v
                {selected.variant}
              </h3>
              <div className="panel-scroll">
                <dl className="summary">
                  <dt>Instruction it renders</dt>
                  <dd>{selected.sourceWording}</dd>
                  <dt>Rendered wording</dt>
                  <dd>{selected.text}</dd>
                  <dt>State</dt>
                  <dd>{variantStateLabel(selected.reviewState)}</dd>
                  <dt>Drafted by</dt>
                  <dd>
                    {selected.producedBy === 'model' ? 'a model' : 'a person'}
                    {selected.provider ? ` (${selected.provider})` : ''}
                    {selected.createdByLabel ? ` · ${selected.createdByLabel}` : ''}
                  </dd>
                  {selected.fidelityNote && (
                    <>
                      <dt>Reviewer&apos;s fidelity statement</dt>
                      <dd>{selected.fidelityNote}</dd>
                    </>
                  )}
                  {selected.rejectionReason && (
                    <>
                      <dt>Rejection reason</dt>
                      <dd>{selected.rejectionReason}</dd>
                    </>
                  )}
                </dl>

                {selected.fidelity.warnings.length > 0 && (
                  <ul className="plans__blockers" role="status">
                    {selected.fidelity.warnings.map((code) => (
                      <li key={code}>{fidelityWarningLabel(code)}</li>
                    ))}
                  </ul>
                )}
                {selected.fidelity.passed && (
                  <p className="muted">
                    The number guard found no lost value. That is a guard, not a proof of meaning —
                    your own statement is what approves the wording.
                  </p>
                )}

                {selected.reviewState === 'draft' && (
                  <div className="wizard__actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !canDraft}
                      onClick={() =>
                        write(
                          () => api(`${base}/${selected.id}/submit`, { method: 'POST' }),
                          'Submitted for clinical review.'
                        )
                      }
                    >
                      Submit for review
                    </button>
                  </div>
                )}

                {selected.reviewState === 'in_review' && canReview && (
                  <div>
                    <label htmlFor="lv-fidelity">
                      State that the meaning is preserved (required to approve)
                    </label>
                    <input
                      id="lv-fidelity"
                      maxLength={500}
                      value={fidelityNote}
                      onChange={(e) => setFidelityNote(e.target.value)}
                      disabled={busy}
                    />
                    <div className="wizard__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy || fidelityNote.trim().length < 5}
                        onClick={() =>
                          write(
                            () =>
                              api(`${base}/${selected.id}/approve`, {
                                method: 'POST',
                                body: { fidelityNote: fidelityNote.trim() },
                              }),
                            'Rendering approved for presentation. No clinical value and no approval state changed.'
                          ).then((ok) => {
                            if (ok) setFidelityNote('');
                          })
                        }
                      >
                        Approve rendering
                      </button>
                    </div>

                    <label htmlFor="lv-reason">Reject with a reason</label>
                    <input
                      id="lv-reason"
                      maxLength={500}
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      disabled={busy}
                    />
                    <div className="wizard__actions">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={busy || rejectReason.trim().length < 5}
                        onClick={() =>
                          write(
                            () =>
                              api(`${base}/${selected.id}/reject`, {
                                method: 'POST',
                                body: { reason: rejectReason.trim() },
                              }),
                            'Rendering rejected. The coordinator can draft another version.'
                          ).then((ok) => {
                            if (ok) setRejectReason('');
                          })
                        }
                      >
                        Reject rendering
                      </button>
                    </div>
                  </div>
                )}

                <p className="muted">
                  A rendering is internal to the care team. The patient sees only an approved plan
                  version, exactly as in Part 5.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
