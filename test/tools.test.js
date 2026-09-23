// Run with: npm test
// The tool layer's pure parts: how a date phrase becomes a range, and what the
// manifest and the MCP server can rely on the tool table for. No database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, TOOL_SPECS, READ_ONLY_TOOLS, resolveRange, resolveDays } from '../ledger/tools.js';
import { dayStartISO, localDateISO, shiftISO, startOfWeek } from '../src/ledger/dates.js';

const IST = 'Asia/Kolkata';
const today = localDateISO(new Date(), IST);
// A range is [midnight of the first day, midnight after the last day).
const span = (from, to) => ({ from: dayStartISO(from, IST), to: dayStartISO(shiftISO(to, 1), IST) });

test('resolveRange reads the phrases a person uses', () => {
  assert.deepEqual(resolveRange('today', IST), span(today, today));
  assert.deepEqual(resolveRange('yesterday', IST), span(shiftISO(today, -1), shiftISO(today, -1)));
  assert.deepEqual(resolveRange('this week', IST), span(startOfWeek(today), today));
  assert.deepEqual(resolveRange('last week', IST),
    span(shiftISO(startOfWeek(today), -7), shiftISO(startOfWeek(today), -1)));
  assert.deepEqual(resolveRange('this month', IST), span(`${today.slice(0, 8)}01`, today));
  assert.deepEqual(resolveRange('this year', IST), span(`${today.slice(0, 4)}-01-01`, today));
  // Case and whitespace are not the model's problem.
  assert.deepEqual(resolveRange('  Last Week ', IST), resolveRange('last week', IST));
});

test('resolveRange: last month is the whole previous calendar month', () => {
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  assert.deepEqual(resolveRange('last month', IST), span(first, last));
});

test('resolveRange: "last N days" counts back from today, today included', () => {
  assert.deepEqual(resolveRange('last 7 days', IST), span(shiftISO(today, -7), today));
  assert.deepEqual(resolveRange('last 1 day', IST), span(shiftISO(today, -1), today));
  assert.deepEqual(resolveRange('last 30 days', IST), span(shiftISO(today, -30), today));
});

test('resolveRange: an explicit span, a bare date, an instant, and nothing', () => {
  const august = { from: '2026-07-31T18:30:00.000Z', to: '2026-08-31T18:30:00.000Z' };
  assert.deepEqual(resolveRange('2026-08-01..2026-08-31', IST), august);
  assert.deepEqual(resolveRange('2026-08-01 to 2026-08-31', IST), august);
  assert.deepEqual(resolveRange({ from: '2026-08-01', to: '2026-08-31' }, IST), august);
  // A single day is that day, midnight to midnight.
  assert.deepEqual(resolveRange('2026-08-20', IST), span('2026-08-20', '2026-08-20'));
  // An instant is taken as given, not snapped to a day.
  assert.deepEqual(resolveRange({ from: '2026-08-20T11:02:00Z', to: '2026-08-20T12:00:00Z' }, IST),
    { from: '2026-08-20T11:02:00.000Z', to: '2026-08-20T12:00:00.000Z' });
  assert.deepEqual(resolveRange(null, IST), { from: null, to: null });
  assert.deepEqual(resolveRange('', IST), { from: null, to: null });
});

test('resolveDays gives the health functions inclusive local dates', () => {
  assert.deepEqual(resolveDays('2026-08-01..2026-08-31', 'today', IST), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(resolveDays('yesterday', 'today', IST), { from: shiftISO(today, -1), to: shiftISO(today, -1) });
  // The fallback is what an absent range means.
  assert.deepEqual(resolveDays(null, 'last 7 days', IST), { from: shiftISO(today, -7), to: today });
  assert.deepEqual(resolveDays(undefined, 'today', IST), { from: today, to: today });
});

test('every tool says whether it reads or writes, and the manifest covers all of them', () => {
  const names = Object.keys(TOOLS);
  assert.deepEqual(TOOL_SPECS.map(s => s.function.name), names);
  for (const spec of TOOL_SPECS) {
    assert.equal(spec.type, 'function');
    assert.ok(spec.function.description, `${spec.function.name} has no description`);
    assert.equal(spec.function.parameters.type, 'object', spec.function.name);
  }

  // Naming is the contract: a get_/list_/search_/export_ tool never writes.
  for (const name of names) {
    const reads = /^(get|list|search|export)_/.test(name);
    assert.equal(READ_ONLY_TOOLS.has(name), reads, `${name} should${reads ? '' : ' not'} be read-only`);
  }
  // The ones the hand-kept list in the MCP server used to leave out.
  for (const name of ['get_day', 'get_net_worth', 'get_card_points', 'get_targets', 'get_health_overview',
                      'get_health_metric', 'get_health_day_detail', 'get_sleep', 'get_workouts', 'list_health_metrics']) {
    assert.ok(READ_ONLY_TOOLS.has(name), name);
  }
  assert.ok(!READ_ONLY_TOOLS.has('log_meal'));
  assert.ok(!READ_ONLY_TOOLS.has('delete_or_dismiss_event'));
});

test('the day-ranged health tools carry their range default in the schema', () => {
  assert.equal(TOOLS.get_health_overview.parameters.properties.date_range.default, 'last 7 days');
  assert.equal(TOOLS.get_workouts.parameters.properties.date_range.default, 'last 30 days');
  assert.deepEqual(TOOLS.get_health_metric.parameters.required, ['type']);
  assert.ok(TOOLS.get_health_metric.parameters.properties.type);
  assert.equal(TOOLS.get_sleep.parameters.required, undefined);
});
