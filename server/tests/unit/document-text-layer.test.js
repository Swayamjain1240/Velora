'use strict';

// Unit tests for the bounded text-layer reader. It reads what the document
// already carries and never guesses: no OCR, no image analysis.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { extractTextLayer, CODES } = require('../../src/services/documentTextLayer');
const { pdfWithTextPages, contentStreamFor } = require('../../scripts/syntheticPdf');
const { pdfDocuments, pngDocuments } = require('../helpers/documents');

test('reads the text layer of every page, keeping line structure and page numbers', () => {
  const pdf = pdfWithTextPages([
    ['Medication: Paracetamol 500 mg orally every 6 hours for 3 days', 'Home care: Keep the dressing dry'],
    ['Follow-up: Clinic review in 2 weeks'],
  ]);
  const result = extractTextLayer(pdf, { mediaType: 'application/pdf', maxChars: 10_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pages.map((page) => page.page), [1, 2]);
  assert.ok(result.pages[0].text.includes('Medication: Paracetamol 500 mg'));
  assert.equal(result.pages[0].text.split('\n').length, 2);
  assert.ok(result.pages[1].text.includes('Follow-up'));
});

test('reads a FlateDecode-compressed content stream', () => {
  const stream = contentStreamFor(['Medication: Ibuprofen 200 mg orally every 8 hours for 5 days']);
  const deflated = zlib.deflateSync(Buffer.from(stream, 'latin1'));
  const pdf = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n' +
      `4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n` +
      deflated.toString('latin1') +
      '\nendstream\nendobj\n' +
      'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1'
  );
  const result = extractTextLayer(pdf, { mediaType: 'application/pdf' });
  assert.equal(result.ok, true);
  assert.ok(result.pages[0].text.includes('Ibuprofen 200 mg'));
});

test('an image has no text layer, and the reader says so instead of guessing', () => {
  const png = extractTextLayer(pngDocuments.valid(), { mediaType: 'image/png' });
  assert.equal(png.ok, false);
  assert.equal(png.code, CODES.NO_TEXT_LAYER);
  const jpeg = extractTextLayer(pngDocuments.valid(), { mediaType: 'image/jpeg' });
  assert.equal(jpeg.code, CODES.NO_TEXT_LAYER);
});

test('a PDF with no content stream reports NO_TEXT_LAYER', () => {
  const result = extractTextLayer(pdfDocuments.valid(), { mediaType: 'application/pdf' });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.NO_TEXT_LAYER);
});

test('an unsupported media type is refused', () => {
  const result = extractTextLayer(Buffer.from('hello'), { mediaType: 'text/plain' });
  assert.equal(result.code, CODES.UNSUPPORTED_MEDIA);
});

test('the extracted text is bounded by maxChars and reports truncation', () => {
  const pdf = pdfWithTextPages([['Medication: Paracetamol 500 mg '.repeat(50)]]);
  const result = extractTextLayer(pdf, { mediaType: 'application/pdf', maxChars: 100 });
  assert.equal(result.ok, true);
  assert.ok(result.charCount <= 100);
  assert.equal(result.truncated, true);
});

test('an unsupported filter is skipped, never guessed at', () => {
  const stream = contentStreamFor(['Medication: Paracetamol 500 mg orally']);
  const pdf = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
      `4 0 obj\n<< /Length ${stream.length} /Filter /LZWDecode >>\nstream\n${stream}\nendstream\nendobj\n` +
      'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1'
  );
  const result = extractTextLayer(pdf, { mediaType: 'application/pdf' });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.NO_TEXT_LAYER);
});
