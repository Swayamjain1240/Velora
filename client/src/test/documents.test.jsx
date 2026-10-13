import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentsPanel from '../features/documents/DocumentsPanel';
import DocumentUpload from '../features/documents/DocumentUpload';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readyDocument(overrides = {}) {
  return {
    id: 'd1',
    episode: 'e1',
    filename: 'discharge-summary.pdf',
    mediaType: 'application/pdf',
    byteSize: 8,
    sha256: 'a'.repeat(64),
    status: 'ready',
    rejectionCode: null,
    technical: { pages: 2, width: null, height: null },
    readyForReview: true,
    uploadedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

function pdfFile(name = 'discharge.pdf', bytes = BYTES) {
  return new File([bytes], name, { type: 'application/pdf' });
}

describe('DocumentsPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists documents, marks ready as technical review only, and hides downloads for held files', async () => {
    window.fetch = vi.fn(async () =>
      jsonResponse(200, {
        items: [
          readyDocument(),
          readyDocument({
            id: 'd2',
            filename: 'scan.png',
            mediaType: 'image/png',
            status: 'quarantined',
            technical: { pages: null, width: 64, height: 64 },
          }),
        ],
        total: 2,
        page: 1,
        limit: 10,
      })
    );

    render(<DocumentsPanel episodeId="e1" basePath="/episodes/e1" canUpload />);

    expect(await screen.findByText('discharge-summary.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Technically accepted for later review/)).toBeInTheDocument();
    expect(screen.getByText(/not clinical approval/i)).toBeInTheDocument();
    expect(screen.getByText('2 page(s)')).toBeInTheDocument();
    expect(screen.getByText('64×64 px')).toBeInTheDocument();
    // Only the ready document can be downloaded.
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
    expect(screen.getByText('Not downloadable')).toBeInTheDocument();
  });

  it('downloads the authenticated blob, names it from the disposition header and releases the object URL', async () => {
    const createObjectURL = vi.spyOn(window.URL, 'createObjectURL').mockReturnValue('blob:mock');
    const revokeObjectURL = vi.spyOn(window.URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    window.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/download')) {
        return new Response(BYTES, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="discharge-summary.pdf"',
          },
        });
      }
      return jsonResponse(200, { items: [readyDocument()], total: 1, page: 1, limit: 10 });
    });

    render(<DocumentsPanel episodeId="e1" basePath="/episodes/e1" />);

    await screen.findByText('discharge-summary.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(clickSpy).toHaveBeenCalled();

    // The authenticated fetch, not a public URL: credentials are always included.
    const call = window.fetch.mock.calls.find(([url]) => String(url).endsWith('/download'));
    expect(call[0]).toBe('/api/episodes/e1/documents/d1/download');
    expect(call[1].credentials).toBe('include');

    // The object URL is released again, so an authenticated blob never lingers.
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock'), {
      timeout: 2500,
    });
  });

  it('a denied read clears the list and shows a safe message', async () => {
    window.fetch = vi.fn(async () =>
      jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: 'You are not assigned to this episode.' },
      })
    );

    render(<DocumentsPanel episodeId="e1" basePath="/episodes/e1" canUpload />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not assigned/i);
    expect(screen.queryByText(/No documents have been uploaded/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload document' })).not.toBeInTheDocument();
  });
});

describe('DocumentUpload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses an empty, oversized or unsupported file before any request', async () => {
    window.fetch = vi.fn();
    render(<DocumentUpload basePath="/episodes/e1" />);
    const input = screen.getByLabelText('Document file');

    await userEvent.upload(
      input,
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.pdf', { type: 'application/pdf' })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/10 MiB/);

    await userEvent.upload(input, pdfFile('notes.txt', new Uint8Array()), {
      applyAccept: false,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/empty/i);

    await userEvent.upload(input, new File([BYTES], 'notes.txt', { type: 'text/plain' }), {
      applyAccept: false,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Only PDF, JPEG and PNG/);

    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('posts the raw bytes with the filename header and reports a technical result', async () => {
    window.fetch = vi.fn(async () =>
      jsonResponse(201, { document: readyDocument(), duplicate: false })
    );

    render(<DocumentUpload basePath="/episodes/e1" />);
    await userEvent.upload(screen.getByLabelText('Document file'), pdfFile());
    await userEvent.click(screen.getByRole('button', { name: 'Upload document' }));

    await waitFor(() => expect(screen.getByText(/Technically accepted for later review/)).toBeInTheDocument());

    const [url, options] = window.fetch.mock.calls[0];
    expect(url).toBe('/api/episodes/e1/documents');
    expect(options.method).toBe('POST');
    // The declared type travels in Content-Type and the display filename in a
    // header - never in the URL.
    expect(options.headers['Content-Type']).toBe('application/pdf');
    expect(options.headers['X-Document-Filename']).toBe('discharge.pdf');
    expect(url).not.toMatch(/discharge/);
  });

  it('shows the safe server message when a file is rejected', async () => {
    window.fetch = vi.fn(async () =>
      jsonResponse(400, {
        error: {
          code: 'PDF_ACTIVE_CONTENT',
          message: 'PDFs with scripts, actions or other active content are not accepted.',
        },
      })
    );

    render(<DocumentUpload basePath="/episodes/e1" />);
    await userEvent.upload(screen.getByLabelText('Document file'), pdfFile('active.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Upload document' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/active content are not accepted/);
    // The wizard returns to review so the user can pick another file.
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeInTheDocument();
  });
});
