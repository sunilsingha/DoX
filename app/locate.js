'use strict';

const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function keepChar(ch) {
  return /[\p{L}\p{N}.%-]/u.test(ch);
}

function normalize(text) {
  return Array.from(String(text == null ? '' : text).normalize('NFKC').toLowerCase())
    .filter(ch => keepChar(ch) && ch !== ',')
    .join('');
}

function addNeedle(set, value) {
  const needle = normalize(value);
  if (!needle) return;
  if (needle.length < 2 && !/^\d+$/.test(needle)) return;
  set.add(needle);
}

function needlesFor(field) {
  if (!field || field.value === '' || field.value == null) return [];
  const raw = String(field.value);
  const set = new Set();
  addNeedle(set, raw);
  addNeedle(set, raw.replace(/\.0+$/, ''));
  const name = field.name || '';
  const dateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (field.type === 'date' || /date$/i.test(name) || dateMatch) {
    if (dateMatch) {
      const [, year, month, day] = dateMatch;
      addNeedle(set, `${day}/${month}/${year}`);
      addNeedle(set, `${day}-${month}-${year}`);
      addNeedle(set, `${day}.${month}.${year}`);
      addNeedle(set, `${day}${month}${year}`);
      addNeedle(set, `${month}/${day}/${year}`);
      addNeedle(set, `${Number(day)}${MONTHS_SHORT[Number(month) - 1]}${year}`);
      addNeedle(set, `${Number(day)}${MONTHS_LONG[Number(month) - 1]}${year}`);
      addNeedle(set, `${day}${MONTHS_SHORT[Number(month) - 1]}${year}`);
      addNeedle(set, `${day}${MONTHS_LONG[Number(month) - 1]}${year}`);
    }
  }
  const number = Number(field.value);
  if (Number.isFinite(number) && (typeof field.value === 'number' || field.type === 'number' || field.type === 'currency' || /amount|price|total|quantity|rate|taxable/i.test(name))) {
    addNeedle(set, String(number));
    if (Number.isInteger(number)) addNeedle(set, String(number));
    else addNeedle(set, number.toFixed(2));
    try {
      addNeedle(set, new Intl.NumberFormat('en-IN').format(number));
    } catch (error) {
      /* ignore */
    }
  }
  return [...set].sort((left, right) => right.length - left.length);
}

function flatten(items) {
  const chars = [];
  (items || []).forEach((item, itemIndex) => {
    Array.from(String(item.str || '').normalize('NFKC')).forEach(ch => {
      const lower = ch.toLowerCase();
      if (lower === ',' || lower === '₹' || lower === '$' || lower === '€' || lower === '£' || /\s/.test(lower)) return;
      if (!keepChar(lower)) return;
      chars.push({ itemIndex, ch: lower });
    });
    chars.push({ itemIndex: -1, ch: '\u0001' });
  });
  return chars;
}

function digitBoundary(hay, index, length) {
  const needle = hay.slice(index, index + length);
  if (!/^\d+(\.\d+)?$/.test(needle)) return true;
  const before = hay[index - 1];
  const after = hay[index + length];
  if (before && /\d/.test(before)) return false;
  if (after && /\d/.test(after)) return false;
  return true;
}

function findIndexGroups(chars, needle) {
  const hay = chars.map(item => item.ch).join('');
  const groups = [];
  if (!needle || !hay) return groups;
  let from = 0;
  while (from <= hay.length) {
    const index = hay.indexOf(needle, from);
    if (index < 0) break;
    if (digitBoundary(hay, index, needle.length)) {
      const slice = chars.slice(index, index + needle.length);
      groups.push([...new Set(slice.map(item => item.itemIndex).filter(itemIndex => itemIndex >= 0))]);
    }
    from = index + Math.max(1, needle.length);
  }
  return groups;
}

function unionBox(items, indices) {
  const boxes = (indices || []).map(index => items[index]).filter(item => item && Number.isFinite(item.left) && Number.isFinite(item.top));
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map(item => item.left));
  const top = Math.min(...boxes.map(item => item.top));
  const right = Math.max(...boxes.map(item => item.left + (item.width || 0)));
  const bottom = Math.max(...boxes.map(item => item.top + (item.height || 0)));
  return {
    left,
    top,
    width: Math.max(0.004, right - left),
    height: Math.max(0.004, bottom - top)
  };
}

function sameHit(left, right) {
  return left.page === right.page
    && Math.abs(left.left - right.left) < 0.01
    && Math.abs(left.top - right.top) < 0.01
    && Math.abs(left.width - right.width) < 0.01;
}

function findHits(pages, field, options = {}) {
  const needles = (options.needles || needlesFor(field)).filter(needle => needle.length >= 2 || options.near);
  if (!needles.length) return [];
  const hits = [];
  (pages || []).forEach(page => {
    const items = page.items || [];
    const chars = flatten(items);
    needles.forEach(needle => {
      findIndexGroups(chars, needle).forEach(indices => {
        const box = unionBox(items, indices);
        if (box) hits.push({ page: page.page, needle, ...box });
      });
    });
  });
  const unique = [];
  hits.sort((left, right) => right.needle.length - left.needle.length || left.page - right.page || left.top - right.top);
  hits.forEach(hit => {
    if (!unique.some(item => sameHit(item, hit))) unique.push(hit);
  });
  return pickHits(unique, options);
}

function pickHits(hits, options = {}) {
  if (!hits.length) return [];
  let pool = hits;
  const near = options.near;
  if (near && Number.isFinite(near.page)) {
    const close = hits.filter(hit => hit.page === near.page && Math.abs(hit.top - near.top) <= 0.06);
    if (close.length) pool = close;
    else {
      const samePage = hits.filter(hit => hit.page === near.page);
      if (samePage.length) pool = samePage;
    }
  }
  if (options.occurrence != null && pool.length) {
    const index = Math.min(Math.max(0, options.occurrence), pool.length - 1);
    return [pool[index]];
  }
  return pool.slice(0, options.limit || 8);
}

function boxFromCoordinates(page, coordinates) {
  const points = Array.isArray(coordinates) ? coordinates : [];
  const xs = points.map(point => Number(point && point.x)).filter(Number.isFinite);
  const ys = points.map(point => Number(point && point.y)).filter(Number.isFinite);
  if (xs.length < 2 || ys.length < 2) return null;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    page: Number.isFinite(Number(page)) && Number(page) > 0 ? Number(page) : 1,
    left,
    top,
    width: Math.max(0.004, Math.max(...xs) - left),
    height: Math.max(0.004, Math.max(...ys) - top)
  };
}

const api = {
  normalize,
  needlesFor,
  findHits,
  pickHits,
  boxFromCoordinates
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.invoiceLocate = api;
