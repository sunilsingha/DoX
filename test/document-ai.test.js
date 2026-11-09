'use strict';

const assert = require('assert');
const {
  normalizeSchema,
  loadSchemaSync,
  buildSampleResult,
  buildOptions,
  mergeExtraction,
  customSchemaChoices
} = require('../srv/document-ai');

const schema = loadSchemaSync();
assert.strictEqual(schema.name, 'ZSFL_GST_Invoice');
assert.strictEqual(schema.documentType, 'custom');
assert.strictEqual(schema.placeholder, false);
assert.ok(schema.headerFields.length >= 20);
assert.ok(schema.lineItemFields.some(field => field.name === 'hsnCode'));

const sample = buildSampleResult(schema, null);
const header = Object.fromEntries(sample.header.map(field => [field.name, field.value]));
const lines = sample.lineItems.map(row => Object.fromEntries(row.map(cell => [cell.name, cell.value])));
const { sampleLines, sampleHeader } = require('../srv/document-ai');
const computedLines = sampleLines();
const computedHeader = sampleHeader(computedLines);

assert.strictEqual(header.invoiceNumber, 'ZSFL/26-27/0148');
assert.strictEqual(header.cgstAmount, 2784.6);
assert.strictEqual(header.sgstAmount, 2784.6);
assert.strictEqual(lines[0].description, 'Deep groove ball bearing 6204');
assert.strictEqual(lines[0].quantity, 10);
assert.strictEqual(lines[2].hsnCode, '998739');
assert.strictEqual(
  Math.round((computedLines[0].lineTotal + computedLines[1].lineTotal + computedLines[2].lineTotal) * 100),
  Math.round(computedHeader.invoiceTotal * 100)
);

const versioned = normalizeSchema({
  name: 'FromExport',
  documentType: 'invoice',
  versions: [
    { version: 1, status: 'draft', headerFields: [{ name: 'old' }] },
    { version: 2, status: 'active', headerFields: [{ name: 'invoiceNumber', label: 'No.' }], lineItemFields: [{ name: 'qty', category: 'lineItem' }] }
  ]
});
assert.strictEqual(versioned.version, '2');
assert.strictEqual(versioned.headerFields[0].label, 'No.');
assert.strictEqual(versioned.documentType, 'invoice');

const categorized = normalizeSchema({
  name: 'Flat',
  fields: [
    { name: 'buyerName', category: 'header' },
    { name: 'description', category: 'lineItem' }
  ]
});
assert.deepStrictEqual(categorized.headerFields.map(field => field.name), ['buyerName']);
assert.deepStrictEqual(categorized.lineItemFields.map(field => field.name), ['description']);

const named = buildOptions({ schema, template: 'GST_TEMPLATE', schemaName: 'ZSFL_GST_Invoice' });
assert.strictEqual(named.templateName, 'GST_TEMPLATE');
assert.strictEqual(named.schemaName, 'ZSFL_GST_Invoice');
assert.strictEqual(named.clientId, 'default');

const identified = buildOptions({
  schema,
  template: '11111111-2222-3333-4444-555555555555',
  documentType: 'custom'
});
assert.strictEqual(identified.templateId, '11111111-2222-3333-4444-555555555555');
assert.ok(!identified.templateName);

const merged = mergeExtraction(schema, {
  status: 'DONE',
  extraction: {
    headerFields: [
      { name: 'invoiceNumber', value: 'INV-9', confidence: 0.95 },
      { name: 'extraNote', value: 'rush' }
    ],
    lineItems: [[
      { name: 'description', value: 'Bearing', confidence: 0.91 },
      { name: 'quantity', values: [{ value: '2', confidence: 0.4 }, { value: '3', confidence: 0.88 }] }
    ]]
  }
});
assert.strictEqual(merged.header.find(field => field.name === 'invoiceNumber').value, 'INV-9');
assert.ok(merged.header.some(field => field.name === 'extraNote'));
assert.strictEqual(merged.lineItems[0].find(cell => cell.name === 'quantity').value, '3');
assert.strictEqual(merged.lineItems[0].find(cell => cell.name === 'description').value, 'Bearing');

const choices = customSchemaChoices([
  {
    schemas: [
      { id: '1', name: 'B', predefined: false, documentType: 'custom', version: '1' },
      { id: '2', name: 'SAP_invoice_schema', predefined: true, documentType: 'invoice', version: '1' }
    ]
  },
  {
    schemas: [
      { id: '1', name: 'B', predefined: false, documentType: 'custom', version: '1' },
      { id: '3', name: 'A', predefined: false, documentType: 'invoice', version: '2' }
    ]
  }
]);
assert.deepStrictEqual(choices.map(schema => schema.name), ['A', 'B']);
assert.strictEqual(choices[0].version, '2');
assert.strictEqual(choices[0].documentType, 'invoice');

console.log('document-ai tests passed');
