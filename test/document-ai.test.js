'use strict';

const assert = require('assert');
const {
  normalizeSchema,
  loadSchemaSync,
  buildSampleResult,
  buildOptions,
  mergeExtraction,
  summarizeSchemaList
} = require('../srv/document-ai');

const schema = loadSchemaSync();
assert.strictEqual(schema.name, 'ZSFL_GST_Invoice');
assert.strictEqual(schema.documentType, 'custom');
assert.ok(schema.headerFields.length >= 20);
assert.ok(schema.lineItemFields.some(field => field.name === 'hsnSac'));

const sample = buildSampleResult(schema, null);
const header = Object.fromEntries(sample.header.map(field => [field.name, field.value]));
const lines = sample.lineItems.map(row => Object.fromEntries(row.map(cell => [cell.name, cell.value])));

assert.strictEqual(header.invoiceNumber, 'ZSFL/26-27/0148');
assert.strictEqual(header.taxableValue, 30940);
assert.strictEqual(header.cgstAmount, 2784.6);
assert.strictEqual(header.sgstAmount, 2784.6);
assert.strictEqual(header.invoiceTotal, 36509.2);
assert.strictEqual(lines[0].lineTotal, 14750);
assert.strictEqual(lines[1].taxableAmount, 3440);
assert.strictEqual(lines[2].hsnSac, '998739');
assert.strictEqual(
  Math.round((lines[0].lineTotal + lines[1].lineTotal + lines[2].lineTotal) * 100),
  Math.round(header.invoiceTotal * 100)
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

const listed = summarizeSchemaList({
  results: [
    {
      id: '11111111-2222-3333-4444-555555555555',
      name: 'ZSFL_Letter_of_Credit',
      documentType: 'custom',
      versions: [
        { version: '1', status: 'draft' },
        { schemaVersion: '2', status: 'active' }
      ]
    },
    {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      schemaName: 'SAP_invoice_schema',
      documentType: 'invoice',
      version: '1'
    }
  ]
});
assert.strictEqual(listed.length, 2);
assert.strictEqual(listed[0].name, 'ZSFL_Letter_of_Credit');
assert.strictEqual(listed[0].version, '2');
assert.strictEqual(listed[0].status, 'active');
assert.strictEqual(listed[0].standard, false);
assert.strictEqual(listed[1].standard, true);
assert.strictEqual(listed[1].documentType, 'invoice');

console.log('document-ai tests passed');
