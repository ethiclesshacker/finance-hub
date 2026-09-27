// Tests for the table rules: sort by what a value is, search what is shown,
// page anywhere. Every case is a way the Grid.js tables got it wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sortRows, filterRows, paginate, pageWindow, nextSort, compareValues } from '../src/table-core.js';

const shown = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const columns = [
  { key: 'date', label: 'Date', type: 'date', render: r => shown(r.date) },
  { key: 'merchant', label: 'Merchant', render: r => `${r.merchant}${r.work ? ' <span class="badge">Work</span>' : ''}` },
  { key: 'amount', label: 'Amount', type: 'number', render: r => `<span class="num">₹${r.amount.toLocaleString('en-IN')}</span>` },
  { key: 'actions', label: 'Actions', actions: true, sortable: false, searchable: false, render: () => '<button>Edit</button>' },
];
const rows = [
  { date: '2026-01-30', merchant: 'uber', amount: 935, work: true },
  { date: '2025-09-12', merchant: 'Amazon', amount: 10000 },
  { date: '2026-08-01', merchant: 'Zomato', amount: 99 },
  { date: '2026-09-25', merchant: 'OnPoint', amount: 1000 },
];

test('dates sort by date, not by how they are written', () => {
  // As strings "01 Aug 2026" < "12 Sep 2025" < "25 Sep 2026" < "30 Jan 2026".
  assert.deepEqual(sortRows(rows, columns, { key: 'date', dir: 'desc' }).map(r => r.date),
    ['2026-09-25', '2026-08-01', '2026-01-30', '2025-09-12']);
  assert.deepEqual(sortRows(rows, columns, { key: 'date', dir: 'asc' }).map(r => r.date),
    ['2025-09-12', '2026-01-30', '2026-08-01', '2026-09-25']);
});

test('amounts sort as numbers, not as the HTML around them', () => {
  assert.deepEqual(sortRows(rows, columns, { key: 'amount', dir: 'desc' }).map(r => r.amount), [10000, 1000, 935, 99]);
});

test('text sorts ignoring case, and numbers inside text in order', () => {
  assert.deepEqual(sortRows(rows, columns, { key: 'merchant', dir: 'asc' }).map(r => r.merchant),
    ['Amazon', 'OnPoint', 'uber', 'Zomato']);
  assert.ok(compareValues('Row 2', 'Row 10') < 0);
});

test('an empty value goes last whichever way the column is sorted', () => {
  const cols = [{ key: 'v', type: 'number' }];
  const data = [{ v: 2 }, { v: null }, { v: 5 }, { v: undefined }];
  assert.deepEqual(sortRows(data, cols, { key: 'v', dir: 'asc' }).map(r => r.v), [2, 5, null, undefined]);
  assert.deepEqual(sortRows(data, cols, { key: 'v', dir: 'desc' }).map(r => r.v), [5, 2, null, undefined]);
});

test('ties keep the order the rows arrived in', () => {
  const data = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 0 }];
  assert.deepEqual(sortRows(data, [{ key: 'v', type: 'number' }], { key: 'v', dir: 'desc' }).map(r => r.id), ['a', 'b', 'c']);
});

test('a first click sorts dates and numbers newest or largest first, text A to Z', () => {
  assert.deepEqual(nextSort(null, columns[0]), { key: 'date', dir: 'desc' });
  assert.deepEqual(nextSort(null, columns[1]), { key: 'merchant', dir: 'asc' });
  assert.deepEqual(nextSort({ key: 'date', dir: 'desc' }, columns[0]), { key: 'date', dir: 'asc' });
  assert.deepEqual(nextSort({ key: 'date', dir: 'asc' }, columns[2]), { key: 'amount', dir: 'desc' });
});

test('search matches dates as they are shown, and by month name', () => {
  assert.deepEqual(filterRows(rows, columns, 'sep').map(r => r.date), ['2025-09-12', '2026-09-25']);
  assert.deepEqual(filterRows(rows, columns, 'september 2026').map(r => r.date), ['2026-09-25']);
  assert.deepEqual(filterRows(rows, columns, '2026-01').map(r => r.date), ['2026-01-30']);
});

test('search matches amounts with or without the rupee sign and commas', () => {
  for (const q of ['10000', '10,000', '₹10,000']) {
    assert.deepEqual(filterRows(rows, columns, q).map(r => r.merchant), ['Amazon'], q);
  }
});

test('every word must match, across columns, including badges', () => {
  assert.deepEqual(filterRows(rows, columns, 'uber work').map(r => r.merchant), ['uber']);
  assert.deepEqual(filterRows(rows, columns, 'zomato work'), []);
  // The actions column is not searched: "edit" is on every row.
  assert.deepEqual(filterRows(rows, columns, 'edit'), []);
});

test('pages are clamped, so a shrinking list never lands on an empty page', () => {
  assert.deepEqual(paginate(117, 11, 10), { page: 11, pages: 12, start: 110, end: 117 });
  assert.deepEqual(paginate(117, 40, 10), { page: 11, pages: 12, start: 110, end: 117 });
  assert.deepEqual(paginate(5, 3, 10), { page: 0, pages: 1, start: 0, end: 5 });
  assert.deepEqual(paginate(0, 0, 10), { page: 0, pages: 1, start: 0, end: 0 });
  // 0 means "all".
  assert.deepEqual(paginate(117, 4, 0), { page: 0, pages: 1, start: 0, end: 117 });
});

test('the page buttons keep the first, the last and the ones near you', () => {
  assert.deepEqual(pageWindow(0, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(pageWindow(0, 20), [0, 1, 2, 3, 4, 5, null, 19]);
  assert.deepEqual(pageWindow(9, 20), [0, null, 7, 8, 9, 10, 11, null, 19]);
  assert.deepEqual(pageWindow(19, 20), [0, null, 14, 15, 16, 17, 18, 19]);
  // Never a gap of one page: 0 … 2 would hide only page 1.
  for (let p = 0; p < 20; p++) {
    const w = pageWindow(p, 20);
    w.forEach((v, i) => {
      if (v === null) assert.ok(w[i + 1] - w[i - 1] > 2, `page ${p}: ${w}`);
    });
    assert.ok(w.includes(p), `page ${p} is shown`);
  }
});
