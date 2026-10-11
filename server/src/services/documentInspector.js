'use strict';

// Pure, dependency-free byte inspection for the three allowlisted document
// types. This module MUST NOT import application config, secrets or the
// database: it runs inside an isolated, memory- and time-limited worker with no
// application secrets in its environment.
//
// It returns a plain result object and never throws diagnostics to the caller:
// the caller maps a stable `code` to a safe error, so parser internals, file
// paths and stacks never reach a response.
//
// A result of `ok: true` means the file is TECHNICALLY acceptable for later
// clinical review. It never means clinically approved.

const LIMITS = Object.freeze({
  MAX_PAGES: 300,
  MAX_OBJECTS: 5000,
  MAX_DECLARED_STREAM_BYTES: 64 * 1024 * 1024,
  MAX_PIXELS: 40_000_000,
});

const MEDIA = Object.freeze({
  'application/pdf': { ext: ['pdf'], magic: 'pdf' },
  'image/jpeg': { ext: ['jpg', 'jpeg'], magic: 'jpeg' },
  'image/png': { ext: ['png'], magic: 'png' },
});

function fail(code) {
  return { ok: false, code };
}
function pass(result) {
  return { ok: true, result };
}

function cleanFilename(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) return null;
  // Control characters are never valid in a display filename.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  // Reject any path component: traversal, absolute paths and separators.
  if (/[\\/]/.test(trimmed)) return null;
  return trimmed;
}

function extensionOf(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

function detectMagic(buf) {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'pdf'; // %PDF
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

function isWhitespaceOnly(buf, from) {
  for (let i = from; i < buf.length; i += 1) {
    const b = buf[i];
    if (b !== 0x00 && b !== 0x0a && b !== 0x0d && b !== 0x20 && b !== 0x09 && b !== 0x0c) {
      return false;
    }
  }
  return true;
}

function inspectPdf(buf) {
  const head = buf.subarray(0, 1024).toString('latin1');
  const headerAt = head.search(/%PDF-\d\.\d/);
  if (headerAt === -1) return fail('PDF_MALFORMED');

  const text = buf.toString('latin1');
  const eofIdx = text.lastIndexOf('%%EOF');
  if (eofIdx === -1) return fail('PDF_MALFORMED');
  if (!text.includes('startxref')) return fail('PDF_MALFORMED');

  // Appended bytes after the final %%EOF are the classic polyglot/append attack.
  if (!isWhitespaceOnly(buf, eofIdx + 5)) return fail('PDF_TRAILING_DATA');

  if (/\/Encrypt\b/.test(text)) return fail('PDF_ENCRYPTED');
  if (
    /\/(JavaScript|JS|OpenAction|AA|Launch|RichMedia|Movie|Sound|SubmitForm|ImportData)\b/.test(text)
  ) {
    return fail('PDF_ACTIVE_CONTENT');
  }
  if (/\/(EmbeddedFile|Filespec|FileAttachment)\b/.test(text)) return fail('PDF_ATTACHMENT');
  if (/\/(AcroForm|XFA)\b/.test(text)) return fail('PDF_FORM');
  if (/\/(GoToR|GoToE|URI)\b/.test(text)) return fail('PDF_EXTERNAL_REF');

  const pages = (text.match(/\/Type\s*\/Page(?!s)/g) || []).length;
  if (pages > LIMITS.MAX_PAGES) return fail('PDF_TOO_MANY_PAGES');
  const objects = (text.match(/\d+\s+\d+\s+obj\b/g) || []).length;
  if (objects > LIMITS.MAX_OBJECTS) return fail('PDF_TOO_MANY_OBJECTS');

  let declaredStreamBytes = 0;
  const lengthRe = /\/Length\s+(\d+)/g;
  let match = lengthRe.exec(text);
  while (match) {
    declaredStreamBytes += Number(match[1]);
    match = lengthRe.exec(text);
  }
  if (declaredStreamBytes > LIMITS.MAX_DECLARED_STREAM_BYTES) return fail('PDF_STREAM_TOO_LARGE');

  return pass({ mediaType: 'application/pdf', pages, objects, detail: { pages } });
}

function inspectPng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8 + 25) return fail('IMAGE_MALFORMED');
  for (let i = 0; i < 8; i += 1) if (buf[i] !== sig[i]) return fail('IMAGE_MALFORMED');

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    if (length > buf.length) return fail('IMAGE_MALFORMED');
    const next = offset + 12 + length;
    if (next > buf.length) return fail('IMAGE_MALFORMED');

    if (type === 'IHDR') {
      if (sawIhdr) return fail('IMAGE_MALFORMED');
      sawIhdr = true;
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
    } else if (type === 'acTL' || type === 'fcTL') {
      // Animated PNG: multiple frames are not accepted.
      return fail('IMAGE_MULTIFRAME');
    } else if (type === 'IEND') {
      sawIend = true;
      offset = next;
      break;
    }
    offset = next;
  }

  if (!sawIhdr || !sawIend) return fail('IMAGE_MALFORMED');
  if (!isWhitespaceOnly(buf, offset)) return fail('TRAILING_DATA');
  if (width <= 0 || height <= 0) return fail('IMAGE_MALFORMED');
  if (width * height > LIMITS.MAX_PIXELS) return fail('IMAGE_PIXEL_BOMB');
  return pass({ mediaType: 'image/png', width, height, detail: { width, height } });
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return fail('IMAGE_MALFORMED');
  // The image must terminate with an EOI marker and nothing after it.
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (eoi === -1) return fail('IMAGE_MALFORMED');
  if (!isWhitespaceOnly(buf, eoi + 2)) return fail('TRAILING_DATA');

  const frames = [];
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    if (i + 4 > buf.length) return fail('IMAGE_MALFORMED');
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) return fail('IMAGE_MALFORMED');
    if (SOF_MARKERS.has(marker)) {
      if (i + 9 > buf.length) return fail('IMAGE_MALFORMED');
      frames.push({ height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) });
    }
    i += 2 + length;
  }

  if (frames.length === 0) return fail('IMAGE_MALFORMED');
  if (frames.length > 1) return fail('IMAGE_MULTIFRAME');
  const { width, height } = frames[0];
  if (width <= 0 || height <= 0) return fail('IMAGE_MALFORMED');
  if (width * height > LIMITS.MAX_PIXELS) return fail('IMAGE_PIXEL_BOMB');
  return pass({ mediaType: 'image/jpeg', width, height, detail: { width, height } });
}

// Entry point. `opts.maxBytes` is the hard upload ceiling.
function inspect(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const maxBytes = Number(opts.maxBytes) || 10 * 1024 * 1024;

  if (buf.length === 0) return fail('EMPTY');
  if (buf.length > maxBytes) return fail('TOO_LARGE');

  const filename = cleanFilename(opts.filename);
  if (!filename) return fail('BAD_FILENAME');

  const declared = String(opts.declaredMediaType || '').toLowerCase().split(';')[0].trim();
  const spec = MEDIA[declared];
  if (!spec) return fail('UNSUPPORTED_TYPE');

  const ext = extensionOf(filename);
  if (!spec.ext.includes(ext)) return fail('TYPE_MISMATCH');

  const detected = detectMagic(buf);
  if (!detected) return fail('UNSUPPORTED_TYPE');
  if (detected !== spec.magic) return fail('TYPE_MISMATCH');

  let outcome;
  if (detected === 'pdf') outcome = inspectPdf(buf);
  else if (detected === 'png') outcome = inspectPng(buf);
  else outcome = inspectJpeg(buf);

  if (!outcome.ok) return outcome;
  return pass({
    mediaType: declared,
    filename,
    byteSize: buf.length,
    ...outcome.result,
  });
}

module.exports = { inspect, cleanFilename, LIMITS, MEDIA };
