'use strict';

const assert = require('assert');
const { compareExtractions, comparisonFromJob, jobPhase, sourceFrom } = require('../srv/document-ai');

assert.strictEqual(sourceFrom(''), 'aicore');
assert.strictEqual(sourceFrom('document-ai'), 'document');
assert.strictEqual(sourceFrom('BOTH'), 'both');

const compared = compareExtractions({
  header: [
    { name: 'invoiceNumber', label: 'Invoice Number', value: '174221', confidence: 0.99 },
    { name: 'taxableAmount', label: 'Taxable Amount', value: '2,784.60', confidence: 0.9 },
    { name: 'supplierName', label: 'Supplier Name', value: 'ABC Communications', confidence: 0.8 }
  ],
  lineItems: [[
    { name: 'description', label: 'Description', value: 'Bearing', confidence: 0.7 },
    { name: 'quantity', label: 'Quantity', value: 10, confidence: 0.9 }
  ]]
}, {
  header: [
    { name: 'invoiceNumber', label: 'Invoice Number', value: '174221', confidence: 1 },
    { name: 'taxableAmount', label: 'Taxable Amount', value: 2784.6, confidence: 0.4 },
    { name: 'supplierName', label: 'Supplier Name', value: 'ABC Communication', confidence: 0.6 }
  ],
  lineItems: [[
    { name: 'description', label: 'Description', value: 'Bearing', confidence: 0.5 },
    { name: 'quantity', label: 'Quantity', value: '10', confidence: 0.5 }
  ], [
    { name: 'description', label: 'Description', value: 'Extra hose', confidence: 0.5 }
  ]]
});

const byName = Object.fromEntries(compared.header.map(field => [field.name, field.state]));
assert.strictEqual(byName.invoiceNumber, 'match');
assert.strictEqual(byName.taxableAmount, 'match');
assert.strictEqual(byName.supplierName, 'differ');
assert.strictEqual(compared.lineItems.length, 2);
assert.strictEqual(compared.lineItems[0].fields.find(field => field.name === 'quantity').state, 'match');
assert.strictEqual(compared.lineItems[1].state, 'differ');
assert.strictEqual(compared.summary.headerDiffer, 1);
assert.strictEqual(compared.summary.headerMatch, 2);
assert.strictEqual(compared.summary.documentLines, 1);
assert.strictEqual(compared.summary.coreLines, 2);

assert.strictEqual(jobPhase('PENDING'), 'pending');
assert.strictEqual(jobPhase('done'), 'done');
assert.strictEqual(jobPhase('FAILED'), 'failed');

const schema = {
  name: 'Demo',
  version: '1',
  documentType: 'custom',
  description: '',
  headerFields: [{ name: 'invoiceNumber', label: 'Invoice Number', type: 'string' }],
  lineItemFields: []
};
const saved = {
  jobId: 'job-12345678',
  schema,
  file: { originalname: 'invoice.pdf', size: 10 },
  coreSide: {
    ok: true,
    status: 'DONE',
    modelName: 'gpt-4o-mini',
    header: [{ name: 'invoiceNumber', label: 'Invoice Number', value: '174221', confidence: 1 }],
    lineItems: []
  }
};
const waiting = comparisonFromJob(saved, { status: 'PENDING' });
assert.strictEqual(waiting.pending, true);
assert.strictEqual(waiting.status, 'PENDING');
const ready = comparisonFromJob(saved, {
  status: 'DONE',
  extraction: { headerFields: [{ name: 'invoiceNumber', value: '174221', confidence: 0.91 }], lineItems: [] }
});
assert.strictEqual(ready.mode, 'compare');
assert.strictEqual(ready.documentAi.pending, false);
assert.strictEqual(ready.documentAi.status, 'DONE');
assert.strictEqual(ready.comparison.header[0].state, 'match');
assert.strictEqual(ready.comparison.header[0].aiCore.value, '174221');

console.log('compare tests passed');
