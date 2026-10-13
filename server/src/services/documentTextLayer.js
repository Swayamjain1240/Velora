'use strict';

// Bounded TEXT-LAYER reader for the allowlisted document types.
//
// This module MUST NOT import application config, secrets, the database or any
// third-party package: like documentInspector.js it runs inside the isolated,
// memory- and time-limited worker with a reduced environment, because it parses
// bytes that arrived from outside the trust boundary (controls #7, #12).
//
// It reads the document's TEXT LAYER only - the strings a PDF already carries in
// its (uncompressed or FlateDecode-compressed) content streams. It performs no
// OCR, no image analysis and no layout inference: a scanned page has no text
// layer, and this module says so with the stable code NO_TEXT_LAYER rather than
// guessing. An OCR/vision provider is NOT selected (see
// docs/VELORA_AI_EXTRACTION.md); until one is, such a document is extracted by
// hand, which is exactly the manual fallback the workflow already has.
//
// Every bound is explicit: number of streams, inflated bytes, characters per
// page and characters overall. A hostile document cannot make this loop forever
// or allocate without limit - the parent additionally caps wall-clock time and
// worker memory.
const zlib = require('node:zlib');

const LIMITS = Object.freeze({
  MAX_STREAMS: 2000,
  MAX_STREAM_BYTES: 4 * 1024 * 1024,
  MAX_INFLATED_BYTES: 12 * 1024 * 1024,
  MAX_CHARS_PER_PAGE: 20_000,
  MAX_TOTAL_CHARS: 200_000,
  MAX_LINES_PER_PAGE: 800,
});

const CODES = Object.freeze({
  NO_TEXT_LAYER: 'NO_TEXT_LAYER',
  TEXT_TOO_LARGE: 'TEXT_TOO_LARGE',
  UNSUPPORTED_MEDIA: 'TEXT_LAYER_UNSUPPORTED_MEDIA',
  MALFORMED: 'TEXT_LAYER_MALFORMED',
});

function fail(code) {
  return { ok: false, code };
}

// ---- PDF string decoding ----------------------------------------------------

const PDF_ESCAPES = Object.freeze({
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '(': '(',
  ')': ')',
  '\\': '\\',
});

// A PDF literal string `(...)` with escapes including octal \ddd.
function decodeLiteralString(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (PDF_ESCAPES[next] !== undefined) {
      out += PDF_ESCAPES[next];
      i += 1;
      continue;
    }
    if (next >= '0' && next <= '7') {
      // Up to three octal digits.
      let octal = '';
      let j = i + 1;
      while (j < body.length && octal.length < 3 && body[j] >= '0' && body[j] <= '7') {
        octal += body[j];
        j += 1;
      }
      out += String.fromCharCode(parseInt(octal, 8) & 0xff);
      i = j - 1;
      continue;
    }
    if (next === '\n') {
      i += 1; // line continuation
      continue;
    }
    if (next === '\r') {
      i += next === '\r' && body[i + 2] === '\n' ? 2 : 1;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

function decodeHexString(body) {
  const hex = body.replace(/[^0-9a-fA-F]/g, '');
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  let out = '';
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

// A PDF string may be PDFDocEncoding (approximated as latin1) or UTF-16BE with a
// byte-order mark. Both are decoded; nothing is translated or guessed.
function decodePdfString(raw) {
  const bytes = Buffer.from(raw, 'latin1');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return out;
  }
  return raw;
}

// ---- PDF content-stream tokenizer ------------------------------------------

const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);
const TEXT_NEWLINE_OPS = new Set(['Td', 'TD', 'T*', 'TL', 'ET']);

// Walks one content stream and returns the shown text, in order. Non-text
// operands (names, numbers, dictionaries, arrays) are skipped: only strings that
// a text-showing operator actually displays become text.
function textFromContentStream(content) {
  const out = [];
  let pending = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content[i];

    if (ch === '%') {
      while (i < n && content[i] !== '\n' && content[i] !== '\r') i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      // Balanced literal string, honouring escapes.
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < n && depth > 0) {
        const c = content[j];
        if (c === '\\') {
          raw += c;
          if (j + 1 < n) raw += content[j + 1];
          j += 2;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
        raw += c;
        j += 1;
      }
      pending.push(decodePdfString(decodeLiteralString(raw)));
      i = j + 1;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i + 1);
      if (end === -1) break;
      pending.push(decodePdfString(decodeHexString(content.slice(i + 1, end))));
      i = end + 1;
      continue;
    }
    if (ch === '<' || ch === '[' || ch === '/' || ch === ']') {
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '{' || ch === '}') {
      i += 1;
      continue;
    }
    // Numbers and operators.
    let j = i;
    while (j < n && !' \n\r\t\f\0()<>[]{}/%'.includes(content[j])) j += 1;
    const token = content.slice(i, j);
    i = j === i ? i + 1 : j;
    if (!token) continue;

    if (TEXT_SHOW_OPS.has(token)) {
      if (pending.length) out.push(pending.join(''));
      pending = [];
      if (token === "'" || token === '"') out.push('\n');
      continue;
    }
    if (TEXT_NEWLINE_OPS.has(token)) {
      if (pending.length) {
        out.push(pending.join(''));
        pending = [];
      }
      out.push('\n');
      continue;
    }
    // Any other operator ends the pending operand list without emitting text.
    pending = [];
  }
  if (pending.length) out.push(pending.join(''));
  return out.join('');
}

function filterOf(dictionary) {
  const match = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dictionary);
  if (!match) return [];
  return [...match[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]);
}

// Extracts every content stream in encounter order, inflating only the filters
// this reader can handle. An unsupported filter is skipped, never guessed at.
function contentStreams(buffer) {
  const text = buffer.toString('latin1');
  const streams = [];
  let index = 0;
  let inflatedTotal = 0;

  while (streams.length < LIMITS.MAX_STREAMS) {
    const start = text.indexOf('stream', index);
    if (start === -1) break;
    // `endstream` also contains "stream": require a delimiter before it.
    const before = start === 0 ? ' ' : text[start - 1];
    if (before !== '\n' && before !== '\r' && before !== ' ') {
      index = start + 6;
      continue;
    }
    const dictStart = text.lastIndexOf('<<', start);
    const dictionary = dictStart === -1 ? '' : text.slice(dictStart, start);
    let dataStart = start + 6;
    if (text[dataStart] === '\r') dataStart += 1;
    if (text[dataStart] === '\n') dataStart += 1;
    const end = text.indexOf('endstream', dataStart);
    if (end === -1) break;
    const raw = buffer.subarray(dataStart, end);
    index = end + 9;

    if (raw.length > LIMITS.MAX_STREAM_BYTES) continue;

    const filters = filterOf(dictionary);
    let content = null;
    if (filters.length === 0) {
      content = raw.toString('latin1');
    } else if (filters.length === 1 && filters[0] === 'FlateDecode') {
      try {
        const inflated = zlib.inflateSync(raw, {
          maxOutputLength: LIMITS.MAX_INFLATED_BYTES,
        });
        inflatedTotal += inflated.length;
        if (inflatedTotal > LIMITS.MAX_INFLATED_BYTES) return fail(CODES.TEXT_TOO_LARGE);
        content = inflated.toString('latin1');
      } catch {
        content = null; // unreadable stream: skipped, never guessed
      }
    }
    if (content === null) continue;
    // A content stream is bounded per stream as well, so one hostile object
    // cannot dominate the budget.
    streams.push(content.slice(0, LIMITS.MAX_INFLATED_BYTES));
  }

  if (!streams.length) return fail(CODES.NO_TEXT_LAYER);
  return { ok: true, streams };
}

function countPdfPages(buffer) {
  const text = buffer.toString('latin1');
  const pageObjects = (text.match(/\/Type\s*\/Page(?![s])/g) || []).length;
  return pageObjects;
}

// Maps content streams onto pages. Streams are attributed in encounter order,
// which is how a linearised PDF writes them; when the page count is unknown the
// text is attributed to page 1 rather than invented across pages.
function attributePages(streams, pageCount) {
  const pages = [];
  const total = Math.max(1, pageCount);
  let streamIndex = 0;
  for (let page = 1; page <= total; page += 1) {
    if (streamIndex >= streams.length) {
      pages.push({ page, text: '' });
      continue;
    }
    const chunk = streams[streamIndex];
    streamIndex += 1;
    pages.push({ page, text: textFromContentStream(chunk) });
  }
  // Leftover streams (for example a stream whose page object we could not count)
  // are appended to the last page rather than dropped.
  if (streamIndex < streams.length) {
    const last = pages[pages.length - 1];
    for (; streamIndex < streams.length; streamIndex += 1) {
      last.text += `\n${textFromContentStream(streams[streamIndex])}`;
    }
  }
  return pages;
}

function tidyPageText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0);
  return lines.slice(0, LIMITS.MAX_LINES_PER_PAGE).join('\n');
}

// Entry point. Returns `{ ok: true, pages, charCount, truncated }` or a stable
// `{ ok: false, code }`. Never throws parser internals to the caller.
function extractTextLayer(buffer, opts = {}) {
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const mediaType = String(opts.mediaType || '').toLowerCase();
    const maxChars = Number(opts.maxChars) || LIMITS.MAX_TOTAL_CHARS;

    if (mediaType === 'image/jpeg' || mediaType === 'image/png') {
      // No text layer exists in a raster image, and no OCR provider is selected.
      return fail(CODES.NO_TEXT_LAYER);
    }
    if (mediaType !== 'application/pdf') return fail(CODES.UNSUPPORTED_MEDIA);

    const streamsResult = contentStreams(buf);
    if (!streamsResult.ok) return streamsResult;

    const pageCount = countPdfPages(buf);
    const pages = attributePages(streamsResult.streams, pageCount || streamsResult.streams.length);

    let charCount = 0;
    let truncated = false;
    const bounded = [];
    for (const page of pages) {
      let text = tidyPageText(page.text);
      if (text.length > LIMITS.MAX_CHARS_PER_PAGE) {
        text = text.slice(0, LIMITS.MAX_CHARS_PER_PAGE);
        truncated = true;
      }
      if (charCount + text.length > maxChars) {
        text = text.slice(0, Math.max(0, maxChars - charCount));
        truncated = true;
      }
      charCount += text.length;
      bounded.push({ page: page.page, text });
      if (charCount >= maxChars) {
        truncated = true;
        break;
      }
    }

    const withText = bounded.filter((page) => page.text.length > 0);
    if (!withText.length) return fail(CODES.NO_TEXT_LAYER);
    return { ok: true, pages: withText, charCount, truncated };
  } catch {
    return fail(CODES.MALFORMED);
  }
}

module.exports = { extractTextLayer, textFromContentStream, LIMITS, CODES };
