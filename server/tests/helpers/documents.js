'use strict';

// Synthetic document fixtures. Everything here is fabricated in memory - no
// real or patient data is ever used (product invariant).
//
// The text-layer builder is SHARED with the seed script (scripts/syntheticPdf.js)
// so the browser journey and the integration suite read the exact same synthetic
// document shape, and the two can never drift apart.
const { pdfWithTextPages, syntheticDischargeNote } = require('../../scripts/syntheticPdf');

function pdfBase(bodyLines = []) {
  const extra = bodyLines.length ? `${bodyLines.join('\n')}\n` : '';
  return Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n` +
      extra +
      `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`,
    'latin1'
  );
}

const pdfDocuments = {
  valid: () => pdfBase(),
  withToken: (token) => pdfBase([token]),
  // A PDF with a REAL text layer (one content stream per page), used by the
  // Part 6 extraction tests and by any test that needs readable text.
  withText: (pages) => pdfWithTextPages(pages),
  dischargeNote: () => syntheticDischargeNote(),
  malformed: () => Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\n', 'latin1'),
  trailing: () => Buffer.concat([pdfBase(), Buffer.from('GARBAGE-APPENDED', 'latin1')]),
  manyPages: (count) => {
    const lines = [];
    for (let i = 0; i < count; i += 1) {
      lines.push(`${100 + i} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj`);
    }
    return pdfBase(lines);
  },
  manyObjects: (count) => {
    const lines = [];
    for (let i = 0; i < count; i += 1) {
      lines.push(`${1000 + i} 0 obj\n<< /Kind /Annot >>\nendobj`);
    }
    return pdfBase(lines);
  },
};

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); // the inspector does not verify CRCs
  return Buffer.concat([length, typeBuf, data, crc]);
}

function pngImage(width, height, { animated = false } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type
  const chunks = [sig, pngChunk('IHDR', ihdr)];
  if (animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0); // 2 frames
    chunks.push(pngChunk('acTL', actl));
  }
  chunks.push(pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x00])), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const pngDocuments = {
  valid: () => pngImage(64, 64),
  pixelBomb: () => pngImage(60_000, 60_000),
  animated: () => pngImage(64, 64, { animated: true }),
  malformed: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
  trailing: () => Buffer.concat([pngImage(64, 64), Buffer.from('EXTRA', 'latin1')]),
};

function jpegFrame(width, height) {
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 3);
  sof.writeUInt16BE(sof.length - 2, 0); // segment length
  sof[2] = 8; // precision
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 1; // components
  return Buffer.concat([Buffer.from([0xff, 0xc0]), sof]);
}

function jpegImage(width, height, { frames = 1 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.alloc(16);
  app0.writeUInt16BE(16, 0);
  app0.write('JFIF\0', 2, 'latin1');
  parts.push(Buffer.from([0xff, 0xe0]), app0);
  for (let i = 0; i < frames; i += 1) parts.push(jpegFrame(width, height));
  const sos = Buffer.alloc(12);
  sos.writeUInt16BE(10, 0);
  sos[2] = 1;
  parts.push(Buffer.from([0xff, 0xda]), sos, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const jpegDocuments = {
  valid: () => jpegImage(128, 96),
  pixelBomb: () => jpegImage(60_000, 60_000),
  multiFrame: () => jpegImage(64, 64, { frames: 2 }),
  malformed: () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4)]),
  trailing: () => Buffer.concat([jpegImage(64, 64), Buffer.from('JUNK', 'latin1')]),
};

// Uploads raw bytes the way a browser would: declared type in Content-Type and
// the display filename in a header (never in the URL).
function upload(a, csrf, episodeId, { filename, mediaType, body }) {
  return a
    .post(`/api/episodes/${episodeId}/documents`)
    .set('X-CSRF-Token', csrf)
    .set('X-Document-Filename', filename)
    .set('Content-Type', mediaType)
    .send(body);
}

module.exports = {
  pdfDocuments,
  pngDocuments,
  jpegDocuments,
  pngImage,
  jpegImage,
  upload,
  pdfWithTextPages,
  syntheticDischargeNote,
};
