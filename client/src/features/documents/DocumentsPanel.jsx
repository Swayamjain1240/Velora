'use strict';

import ResponsiveTable from '../../components/ResponsiveTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadDocument } from '../../lib/api';
import DocumentUpload from './DocumentUpload';
import {
  STATUS_LABELS,
  STATUS_NOTES,
  formatBytes,
  isDenied,
  safeMessage,
} from './documentRules';

const PAGE_SIZE = 10;
// The blob URL is revoked shortly after the browser has taken the stream, and
// again on unmount, so an authenticated object URL never lingers in memory.
const REVOKE_DELAY_MS = 1000;

// Private episode documents. Staff with an active team assignment on a draft
// episode may upload; the patient owner may only read and download. A `ready`
// document is technically accepted for later review - never clinically approved.
export default function DocumentsPanel({
  episodeId,
  basePath,
  canUpload = false,
  readOnlyReason = null,
  onDenied,
}) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  // A denied read hides the document area entirely: no stale metadata and no
  // empty-state that could be mistaken for "there are no documents".
  const [denied, setDenied] = useState(false);
  const objectUrls = useRef([]);

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => window.URL.revokeObjectURL(url));
      objectUrls.current = [];
    },
    []
  );

  const load = useCallback(
    async (nextPage = page) => {
      try {
        const data = await api(`${basePath}/documents?page=${nextPage}&limit=${PAGE_SIZE}`);
        setItems(data.items || []);
        setTotal(data.total || 0);
        setPage(nextPage);
      } catch (err) {
        // A denied read clears any loaded document metadata before the message
        // is shown, so nothing stale stays on screen.
        if (isDenied(err)) {
          setItems([]);
          setTotal(0);
          setShowUpload(false);
          setDenied(true);
          if (onDenied) onDenied(err);
        }
        setError(safeMessage(err));
      }
    },
    [basePath, page, onDenied]
  );

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, episodeId]);

  async function download(doc) {
    setError(null);
    setNotice(null);
    setBusyId(doc.id);
    try {
      const { blob, filename } = await downloadDocument(
        `${basePath}/documents/${doc.id}/download`
      );
      // Defence in depth: the server already verified size and checksum, and the
      // browser must not save a truncated file if anything went wrong in transit.
      if (blob.size !== doc.byteSize) {
        setError('The downloaded file did not match the stored copy. The download was cancelled.');
        return;
      }
      const url = window.URL.createObjectURL(blob);
      objectUrls.current.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setNotice('Download started.');
      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
        objectUrls.current = objectUrls.current.filter((u) => u !== url);
      }, REVOKE_DELAY_MS);
    } catch (err) {
      if (isDenied(err)) {
        setItems([]);
        setTotal(0);
        setDenied(true);
        if (onDenied) onDenied(err);
      }
      setError(safeMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const counts = items.reduce((acc, doc) => {
    acc[doc.status] = (acc[doc.status] || 0) + 1;
    return acc;
  }, {});

  // The wizard stays open on its result step (so the user reads the outcome),
  // while the list behind it refreshes with the new row.
  async function afterUpload(data) {
    const status = data && data.document ? data.document.status : null;
    setNotice(status === 'rejected' ? 'Document refused. Nothing was stored.' : 'Document uploaded.');
    await load(1);
  }

  return (
    <div className="documents">
      <div className="documents__head">
        <h2>Documents</h2>
        {denied ? (
          <span className="muted">Not available to you.</span>
        ) : canUpload ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setShowUpload((open) => !open)}
          >
            {showUpload ? 'Cancel upload' : 'Upload document'}
          </button>
        ) : (
          <span className="muted">{readOnlyReason || 'Read-only access.'}</span>
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

      {!denied && (
        <>
          {showUpload && canUpload && (
            <DocumentUpload
              basePath={basePath}
              onUploaded={afterUpload}
              onFailure={() => setNotice(null)}
            />
          )}

          <div className="documents__summary" aria-label="Technical status summary">
            <span className="pill pill--ready">{counts.ready || 0} ready for review</span>
            <span className="pill pill--quarantined">{counts.quarantined || 0} quarantined</span>
            <span className="pill pill--rejected">{counts.rejected || 0} rejected</span>
            <span className="pill pill--failed">{counts.failed || 0} failed</span>
          </div>

          <div className="panel-scroll">
            <ResponsiveTable>
              <caption className="visually-hidden">Episode documents</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Type</th>
                  <th scope="col">Size</th>
                  <th scope="col">Technical status</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((doc) => (
                  <tr key={doc.id}>
                    <td className="truncate" title={doc.filename}>
                      {doc.filename}
                    </td>
                    <td>{doc.mediaType}</td>
                    <td>{formatBytes(doc.byteSize)}</td>
                    <td>
                      <span className={`pill pill--${doc.status}`}>
                        {STATUS_LABELS[doc.status]}
                      </span>
                      <span className="documents__note">{STATUS_NOTES[doc.status]}</span>
                      {doc.technical && doc.technical.pages ? (
                        <span className="documents__note">{doc.technical.pages} page(s)</span>
                      ) : null}
                      {doc.technical && doc.technical.width ? (
                        <span className="documents__note">
                          {doc.technical.width}×{doc.technical.height} px
                        </span>
                      ) : null}
                      {doc.rejectionCode ? (
                        <span className="documents__note">
                          {doc.rejectionCode.replace(/_/g, ' ').toLowerCase()}
                        </span>
                      ) : null}
                    </td>
                    <td>{new Date(doc.uploadedAt).toLocaleDateString()}</td>
                    <td className="table__actions">
                      {doc.status === 'ready' ? (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={busyId === doc.id}
                          onClick={() => download(doc)}
                        >
                          {busyId === doc.id ? 'Downloading…' : 'Download'}
                        </button>
                      ) : (
                        <span className="muted">Not downloadable</span>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6}>No documents have been uploaded for this episode.</td>
                  </tr>
                )}
              </tbody>
            </ResponsiveTable>
          </div>

          <nav className="pager" aria-label="Document pagination">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={page <= 1}
              onClick={() => load(page - 1)}
            >
              Previous
            </button>
            <span>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={page >= totalPages}
              onClick={() => load(page + 1)}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
