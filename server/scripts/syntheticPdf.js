'use strict';

// Dev/test-only helper that builds a SYNTHETIC PDF with a real, uncompressed
// text layer. Nothing here is clinical content: every caller passes fabricated
// strings, and the file exists only so the document pipeline (structural
// validation, text-layer reading, extraction, review) can be exercised end to
// end without any real or patient data.
//
// Layout produced (one content stream per page):
//   %PDF-1.4
//   1 Catalog -> 2 Pages -> 3..N Page objects (each with /Contents)
//   one content stream per page:  BT /F1 12 Tf ... (line) Tj T* ... ET
//   trailer /Root /startxref /%%EOF
// The structural validator accepts this shape: no /Encrypt, no active content,
// no forms, no attachments, no external references and no trailing bytes.

function escapeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // A literal newline cannot appear inside a PDF string operand.
    .replace(/[\r\n]+/g, ' ');
}

// Shows each line on its own text line (T*) so the text layer keeps the
// document's line structure - which is what the extraction provider reads.
function contentStreamFor(lines) {
  const ops = ['BT', '/F1 12 Tf', '72 720 Td', '14 TL'];
  lines.forEach((line) => {
    ops.push(`(${escapeText(line)}) Tj`);
    ops.push('T*');
  });
  ops.push('ET');
  return ops.join('\n');
}

function pdfWithTextPages(pages = []) {
  const pageList = pages.length ? pages : [['synthetic page']];
  const objectCount = 2 + pageList.length * 2; // catalog, pages, then page+contents pairs
  const parts = ['%PDF-1.4\n'];
  parts.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = [];
  for (let i = 0; i < pageList.length; i += 1) {
    kids.push(`${3 + i * 2} 0 R`);
  }
  parts.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageList.length} >>\nendobj\n`
  );

  for (let i = 0; i < pageList.length; i += 1) {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    const stream = contentStreamFor(pageList[i]);
    parts.push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ` +
        `/Contents ${contentObj} 0 R >>\nendobj\n`
    );
    parts.push(
      `${contentObj} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n` +
        `${stream}\nendstream\nendobj\n`
    );
  }

  parts.push(
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`
  );
  return Buffer.from(parts.join(''), 'latin1');
}

// A synthetic discharge note in the labelled layout the deterministic fake
// provider can read. Fabricated values only.
function syntheticDischargeNote() {
  return pdfWithTextPages([
    [
      'Synthetic Discharge Summary - fabricated test content only',
      'Medication: Paracetamol 500 mg orally every 6 hours for 3 days',
      'Home care: Keep the dressing dry for 48 hours',
      'Warning: Contact the clinic if the wound becomes hot or red',
    ],
    [
      'Synthetic Discharge Summary - page 2 - fabricated test content only',
      'Activity: Walk for 10 minutes three times a day',
      'Follow-up: Clinic review in 2 weeks',
      'Medication: Amoxicillin 250 mg orally',
    ],
  ]);
}

module.exports = { pdfWithTextPages, syntheticDischargeNote, contentStreamFor, escapeText };
