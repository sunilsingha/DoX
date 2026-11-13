'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { parseModelContent, mapExtraction, extractionPrompt, publicStatus, prepareDocument, userContent, readPdfText } = require('../srv/ai-core');
const { loadSchemaSync, listLocalSchemas } = require('../srv/document-ai');

const schema = {
  name: 'ZSFL_GST_Invoice',
  headerFields: [
    { name: 'invoiceNumber', label: 'Invoice Number', type: 'string', description: 'Tax invoice number' },
    { name: 'invoiceDate', label: 'Invoice Date', type: 'date', description: '' }
  ],
  lineItemFields: [
    { name: 'description', label: 'Description', type: 'string', description: '' },
    { name: 'quantity', label: 'Quantity', type: 'number', description: '' }
  ]
};

const parsed = parseModelContent('```json\n{"header":{"invoiceNumber":{"value":"INV-1","confidence":0.91},"invoiceDate":"2026-11-02"},"lineItems":[{"description":{"value":"Bearing","confidence":0.8},"quantity":{"value":2,"confidence":0.7}}]}\n```');
const mapped = mapExtraction(schema, parsed);
assert.strictEqual(mapped.header.find(field => field.name === 'invoiceNumber').value, 'INV-1');
assert.strictEqual(mapped.header.find(field => field.name === 'invoiceDate').value, '2026-11-02');
assert.strictEqual(mapped.lineItems[0].find(field => field.name === 'quantity').value, 2);
assert.strictEqual(mapped.lineItems[0].find(field => field.name === 'description').confidence, 0.8);

const prompt = extractionPrompt(loadSchemaSync());
assert.ok(prompt.includes('invoiceNumber'));
assert.ok(prompt.includes('hsnCode'));
assert.ok(prompt.includes('ZSFL_GST_Invoice'));

const status = publicStatus();
assert.ok(Array.isArray(status.missing));
assert.ok(status.missing.includes('AICORE_DEPLOYMENT_ID'));

const local = listLocalSchemas();
assert.ok(local.some(item => item.name === 'ZSFL_GST_Invoice'));

function textPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
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

prepareDocument(textPdf('Invoice ZSFL 26-27 0148 taxable amount 30940 supplier Northwind Components'), 'invoice.pdf').then(async pdf => {
  assert.strictEqual(pdf.kind, 'pdf');
  const content = userContent(schema, pdf);
  assert.strictEqual(content[1].type, 'file');
  assert.ok(content[1].file.file_data.startsWith('data:application/pdf;base64,'));
  const text = await readPdfText(textPdf('Invoice ZSFL 26-27 0148 taxable amount 30940 supplier Northwind Components'));
  assert.ok(text.includes('ZSFL 26-27 0148'));
  const compressed = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Invoice ZSFL 26-27 0148 taxable amount 30940 supplier Northwind Components) Tj ET\n'));
  const compressedPdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${compressed.length} /Filter /FlateDecode >> stream\n`),
    compressed,
    Buffer.from('\nendstream\nendobj\n')
  ]);
  const compressedText = await readPdfText(compressedPdf);
  assert.ok(compressedText.includes('30940'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const image = await prepareDocument(png, 'scan.png');
  assert.strictEqual(image.kind, 'image');
  assert.strictEqual(image.mediaType, 'image/png');
  await assert.rejects(() => prepareDocument(Buffer.from('x'), 'scan.tif'), /TIFF/);
  console.log('ai-core tests passed');
}).catch(error => {
  console.error(error);
  process.exit(1);
});
