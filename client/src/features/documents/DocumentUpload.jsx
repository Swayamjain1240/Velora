'use strict';

import { useRef, useState } from 'react';
import { uploadDocument } from '../../lib/api';
import {
  MAX_BYTES,
  STATUS_LABELS,
  STATUS_NOTES,
  formatBytes,
  mediaTypeFor,
  preflight,
  safeMessage,
} from './documentRules';

// Private discharge-document upload: choose -> review -> upload -> result.
// The display filename only ever travels in the X-Document-Filename request
// header, and nothing here ever suggests clinical approval.
const STEPS = ['choose', 'review', 'upload', 'result'];

export default function DocumentUpload({ basePath, onUploaded, onFailure }) {
  const [step, setStep] = useState('choose');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  function reset() {
    setStep('choose');
    setFile(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function choose(event) {
    const selected = event.target.files && event.target.files[0];
    if (!selected) return;
    const check = preflight(selected);
    if (!check.ok) {
      setError(check.reason);
      if (onFailure) onFailure(null);
      return;
    }
    setError(null);
    setFile(selected);
    setStep('review');
  }

  async function submit() {
    setError(null);
    setStep('upload');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const data = await uploadDocument(`${basePath}/documents`, {
        filename: file.name,
        mediaType: mediaTypeFor(file.name),
        bytes,
      });
      setResult(data.document);
      setStep('result');
      if (onUploaded) await onUploaded(data);
    } catch (err) {
      setStep('review');
      setError(safeMessage(err));
      if (onFailure) onFailure(err);
    }
  }

  const activeIndex = STEPS.indexOf(step);

  return (
    <div className="wizard">
      <ol className="stepper" aria-label="Upload steps">
        {STEPS.map((name, index) => (
          <li
            key={name}
            className={
              index === activeIndex ? 'stepper__item stepper__item--active' : 'stepper__item'
            }
            aria-current={index === activeIndex ? 'step' : undefined}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </li>
        ))}
      </ol>

      <div className="wizard__body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {step === 'choose' && (
          <div>
            <label htmlFor="doc-file">Document file</label>
            <input
              id="doc-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={choose}
            />
            <p className="muted">
              PDF, JPEG or PNG, up to {formatBytes(MAX_BYTES)}. This file is stored privately and
              reviewed by your care team.
            </p>
          </div>
        )}

        {step === 'review' && file && (
          <div>
            <h2>Review</h2>
            <dl className="summary">
              <dt>Filename</dt>
              <dd className="truncate" title={file.name}>
                {file.name}
              </dd>
              <dt>Type</dt>
              <dd>{mediaTypeFor(file.name)}</dd>
              <dt>Size</dt>
              <dd>{formatBytes(file.size)}</dd>
            </dl>
            <p className="muted">
              Uploading does not approve anything. A document that passes validation is only marked
              as technically accepted for later review.
            </p>
          </div>
        )}

        {step === 'upload' && (
          <p role="status">Uploading and validating the file…</p>
        )}

        {step === 'result' && result && (
          <div>
            <h2>Result</h2>
            <dl className="summary">
              <dt>File</dt>
              <dd className="truncate" title={result.filename}>
                {result.filename}
              </dd>
              <dt>Status</dt>
              <dd>
                <span className={`pill pill--${result.status}`}>{STATUS_LABELS[result.status]}</span>
              </dd>
              <dt>Technical</dt>
              <dd>
                {result.technical && result.technical.pages
                  ? `${result.technical.pages} page(s)`
                  : result.technical && result.technical.width
                    ? `${result.technical.width}×${result.technical.height} px`
                    : '—'}
              </dd>
              <dt>Size</dt>
              <dd>{formatBytes(result.byteSize)}</dd>
              <dt>Checksum</dt>
              <dd className="truncate" title={result.sha256}>
                {result.sha256}
              </dd>
            </dl>
            <p className="muted">{STATUS_NOTES[result.status]}</p>
            {result.rejectionCode && (
              <p className="muted">Reason code: {result.rejectionCode.replace(/_/g, ' ').toLowerCase()}</p>
            )}
          </div>
        )}
      </div>

      <div className="wizard__actions">
        {step === 'review' && (
          <>
            <button type="button" className="btn btn--ghost" onClick={reset}>
              Choose another file
            </button>
            <button type="button" className="btn btn--primary" onClick={submit}>
              Upload document
            </button>
          </>
        )}
        {step === 'upload' && (
          <button type="button" className="btn btn--primary" disabled>
            Uploading…
          </button>
        )}
        {step === 'result' && (
          <>
            <button type="button" className="btn btn--ghost" onClick={reset}>
              Upload another
            </button>
            <button type="button" className="btn btn--primary" onClick={reset}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
