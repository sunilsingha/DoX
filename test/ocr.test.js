'use strict';

const assert = require('assert');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { inputModeFrom, linesFromOcr, joinPageTexts, ocrDocument, setCreateEngine, pdfPagePngs, publicOcrError, pngFromRgba, resizeRgba } = require('../srv/ocr');

assert.strictEqual(inputModeFrom('ocr'), 'ocr');
assert.strictEqual(inputModeFrom('PaddleOCR'), 'ocr');
assert.strictEqual(inputModeFrom('paddle-ocr'), 'ocr');
assert.strictEqual(inputModeFrom('vision'), 'vision');
assert.strictEqual(inputModeFrom('both'), 'both');
assert.strictEqual(inputModeFrom('ocr-vision'), 'both');
assert.strictEqual(inputModeFrom(''), 'vision');
assert.strictEqual(inputModeFrom(undefined), 'vision');

const ordered = linesFromOcr({
  texts: [
    { text: '08492', frame: { top: 40, left: 10 } },
    { text: 'TAX INVOICE', frame: { top: 8, left: 12 } },
    { text: '  ', frame: { top: 90, left: 10 } }
  ]
});
assert.strictEqual(ordered, 'TAX INVOICE\n08492');

const fromArray = linesFromOcr([
  { text: 'Hose', box: [[80, 20]] },
  { text: 'Qty 10', box: [[10, 20]] }
]);
assert.strictEqual(fromArray, 'Qty 10\nHose');

const joined = joinPageTexts([
  { number: 1, text: 'Invoice 08492' },
  { number: 2, text: 'Hose quantity 10' }
]);
assert.ok(joined.includes('Page 1'));
assert.ok(joined.includes('Invoice 08492'));
assert.ok(joined.includes('Page 2'));

function textPdf(text) {
  const texts = Array.isArray(text) ? text : [text];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  const fontId = 3 + (texts.length * 2);
  texts.forEach((pageText, index) => {
    const pageId = 3 + (index * 2);
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const stream = `BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });
  objects.splice(1, 0, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${texts.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((entry, index) => {
    offsets[index + 1] = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${entry}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

setCreateEngine(async () => ({
  detect: async () => ({
    texts: [
      { text: 'TAX INVOICE 08492 packing list hose quantity 10', score: 0.99, frame: { top: 10, left: 8, width: 200, height: 16 } }
    ]
  })
}));

(async () => {
  const image = await ocrDocument({ buffer: png, filename: 'scan.png' });
  assert.strictEqual(image.engine, 'paddleocr');
  assert.strictEqual(image.model, 'PP-OCRv4');
  assert.strictEqual(image.pageCount, 1);
  assert.ok(image.text.includes('TAX INVOICE 08492'));
  assert.ok(image.text.includes('Page 1'));

  const pdf = await ocrDocument({
    buffer: textPdf(['Invoice 08492 packing list', 'Hose quantity 10']),
    filename: 'invoice.pdf'
  });
  assert.strictEqual(pdf.engine, 'paddleocr');
  assert.strictEqual(pdf.pageCount, 2);
  assert.strictEqual(pdf.pageTexts.length, 2);
  assert.ok(pdf.text.includes('Page 1'));
  assert.ok(pdf.text.includes('Page 2'));
  assert.ok(pdf.text.includes('TAX INVOICE 08492'));

  setCreateEngine(async () => ({ detect: async () => ({ texts: [] }) }));
  const fallback = await ocrDocument({
    buffer: textPdf('Invoice 08492 packing list hose quantity 10'),
    filename: 'invoice.pdf'
  });
  assert.ok(fallback.text.includes('08492'), fallback.text);
  assert.ok(fallback.text.includes('Invoice'), fallback.text);

  await assert.rejects(() => ocrDocument({ buffer: Buffer.from('not-a-file'), filename: 'notes.txt' }), /PaddleOCR/);

  assert.ok(/scanned page/.test(publicOcrError('colourspace: parameter space not set')));
  assert.ok(/Try Vision LLM/.test(publicOcrError('')));
  const encoded = pngFromRgba(Buffer.alloc(4, 255), 1, 1);
  assert.strictEqual(encoded[0], 0x89);
  assert.strictEqual(encoded[1], 0x50);
  const line = await resizeRgba({ data: Buffer.alloc(40 * 10 * 4, 255), width: 40, height: 10 }, { height: 48 });
  assert.strictEqual(line.height, 48);
  assert.ok(line.width > 1);

  const pagePng = await sharp({
    create: { width: 120, height: 90, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).png().toBuffer();
  const imagePdf = await PDFDocument.create();
  const page = imagePdf.addPage([200, 200]);
  const embedded = await imagePdf.embedPng(pagePng);
  page.drawImage(embedded, { x: 10, y: 20, width: 120, height: 90 });
  const scanned = Buffer.from(await imagePdf.save());
  const extracted = await pdfPagePngs(scanned);
  assert.ok(extracted.length >= 1, 'expected an embedded page image');
  const meta = await sharp(extracted[0]).metadata();
  assert.ok(meta.width >= 80, meta.width);
  assert.ok(meta.height >= 80, meta.height);

  setCreateEngine(null);
  console.log('ocr tests passed');
})().catch(error => {
  setCreateEngine(null);
  console.error(error);
  process.exit(1);
});
