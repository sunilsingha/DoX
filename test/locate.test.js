'use strict';

const assert = require('assert');
const { normalize, needlesFor, findHits, boxFromCoordinates } = require('../app/locate');

assert.strictEqual(normalize('  ₹1,74,221.00 '), '174221.00');
assert.ok(needlesFor({ name: 'invoiceDate', type: 'date', value: '2019-02-18' }).includes('18feb2019'));
assert.ok(needlesFor({ name: 'invoiceDate', type: 'date', value: '2026-11-02' }).includes('02nov2026'));
assert.ok(needlesFor({ name: 'invoiceNumber', value: '174221' }).includes('174221'));

const pages = [{
  page: 1,
  items: [
    { str: 'Invoice', left: 0.1, top: 0.08, width: 0.08, height: 0.02 },
    { str: '174221', left: 0.2, top: 0.08, width: 0.1, height: 0.02 },
    { str: 'ABC Communication', left: 0.1, top: 0.2, width: 0.3, height: 0.02 },
    { str: 'Bolt M8', left: 0.1, top: 0.5, width: 0.2, height: 0.02 },
    { str: '2', left: 0.5, top: 0.5, width: 0.03, height: 0.02 },
    { str: 'Nut M8', left: 0.1, top: 0.56, width: 0.2, height: 0.02 },
    { str: '2', left: 0.5, top: 0.56, width: 0.03, height: 0.02 }
  ]
}];

const invoice = findHits(pages, { name: 'invoiceNumber', value: '174221' });
assert.strictEqual(invoice.length, 1);
assert.strictEqual(invoice[0].left, 0.2);
assert.ok(invoice[0].width >= 0.1);

const supplier = findHits(pages, { name: 'supplierName', value: 'ABC Communication' });
assert.strictEqual(supplier[0].left, 0.1);

const quantity = findHits(pages, { name: 'quantity', type: 'number', value: 2 }, {
  near: { page: 1, top: 0.5 },
  occurrence: 0
});
assert.strictEqual(quantity.length, 1);
assert.ok(Math.abs(quantity[0].top - 0.5) < 0.02);

const missing = findHits(pages, { name: 'buyerGstin', value: '29AABCU9603R1ZM' });
assert.strictEqual(missing.length, 0);

const box = boxFromCoordinates(2, [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.4 }, { x: 0.2, y: 0.4 }]);
assert.strictEqual(box.page, 2);
assert.strictEqual(box.left, 0.2);
assert.strictEqual(box.width, 0.3);
assert.ok(Math.abs(box.height - 0.1) < 1e-9);

console.log('locate tests passed');
