'use strict';

const assert = require('assert');
const { compareExtractions, sourceFrom } = require('../srv/document-ai');

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

console.log('compare tests passed');
