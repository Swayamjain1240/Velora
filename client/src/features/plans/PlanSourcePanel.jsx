'use strict';

import { useEffect, useState } from 'react';
import { unresolvedLabel } from './planRules';

// Source review. A citable source is a READY document of THIS episode; the
// server re-checks that on every link, so an unready or foreign document can
// never be attached even if the screen is out of date.
export default function PlanSourcePanel({
  items,
  readyDocuments,
  busy,
  error,
  onLink,
  onRemove,
  onReloadDocuments,
}) {
  const [itemId, setItemId] = useState(items.length ? items[0].id : '');
  const [form, setForm] = useState({ documentId: '', text: '', page: '', location: '' });

  useEffect(() => {
    if (!items.some((item) => item.id === itemId)) setItemId(items.length ? items[0].id : '');
  }, [items, itemId]);

  useEffect(() => {
    if (onReloadDocuments) onReloadDocuments();
    // The ready-document list is refreshed once when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = items.find((item) => item.id === itemId) || null;

  function submit(event) {
    event.preventDefault();
    if (!selected || !form.documentId || !form.text.trim()) return;
    onLink(selected.id, {
      documentId: form.documentId,
      text: form.text.trim(),
      page: form.page ? Number(form.page) : undefined,
      location: form.location.trim() || undefined,
    });
    setForm({ documentId: '', text: '', page: '', location: '' });
  }

  if (!items.length) {
    return <p className="muted">Add an item before citing a source document.</p>;
  }

  return (
    <div className="plans__split">
      <div className="plans__pane">
        <label htmlFor="source-item">Item</label>
        <select id="source-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.order}. {item.originalWording.slice(0, 60)}
            </option>
          ))}
        </select>

        {selected && (
          <>
            <p className="muted">
              {selected.sourceCount} source reference(s)
              {selected.unresolvedFields.length
                ? ` · ${selected.unresolvedFields.map(unresolvedLabel).join(', ')}`
                : ''}
            </p>
            <div className="panel-scroll">
              <ul className="plans__list">
                {selected.sources.map((source) => (
                  <li key={source.id} className="plans__source">
                    <span className="truncate" title={source.documentFilename || ''}>
                      {source.documentFilename || 'Document'}
                      {source.page ? ` · page ${source.page}` : ''}
                    </span>
                    <span className="plans__quote">{source.text}</span>
                    {source.location && <span className="muted">{source.location}</span>}
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy}
                      onClick={() => onRemove(source.id)}
                    >
                      Remove source
                    </button>
                  </li>
                ))}
                {selected.sources.length === 0 && (
                  <li className="muted">
                    No source yet. Every item needs a ready document before it can be submitted.
                  </li>
                )}
              </ul>
            </div>
          </>
        )}
      </div>

      <form className="plans__pane" onSubmit={submit} noValidate>
        <h3>Cite a ready document</h3>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <label htmlFor="source-document">Ready document</label>
        <select
          id="source-document"
          value={form.documentId}
          onChange={(e) => setForm({ ...form, documentId: e.target.value })}
        >
          <option value="">Select a ready document…</option>
          {readyDocuments.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.filename}
            </option>
          ))}
        </select>
        {readyDocuments.length === 0 && (
          <p className="muted">
            No ready document for this episode yet. Upload and validate one first — a rejected,
            quarantined or unclear document cannot be cited.
          </p>
        )}

        <label htmlFor="source-text">Quoted text</label>
        <textarea
          id="source-text"
          rows={3}
          maxLength={2000}
          value={form.text}
          onChange={(e) => setForm({ ...form, text: e.target.value })}
        />

        <div className="plans__grid">
          <div>
            <label htmlFor="source-page">Page</label>
            <input
              id="source-page"
              inputMode="numeric"
              value={form.page}
              onChange={(e) => setForm({ ...form, page: e.target.value.replace(/[^0-9]/g, '') })}
            />
          </div>
          <div>
            <label htmlFor="source-location">Location note</label>
            <input
              id="source-location"
              maxLength={300}
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </div>
        </div>

        <div className="wizard__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !form.documentId || !form.text.trim()}
          >
            {busy ? 'Linking…' : 'Link source'}
          </button>
        </div>
      </form>
    </div>
  );
}
