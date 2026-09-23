// Run with: npm test
// The zone arithmetic every timeline row, summary and range query rests on.
// Every function here used to exist as two or three copies; these pin the one
// that remains to the behaviour the copies had.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIME_ZONE, zoneOffsetMs, zonedISO, localDateISO, dayStartISO, shiftISO, shiftLocalDate,
  startOfWeek, localClock, formatTime, formatDayHeading, toLocalInput, relativeTime,
} from '../src/ledger/dates.js';

const IST = 'Asia/Kolkata';

test('the default zone is the one the ledger lives in', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'Asia/Kolkata');
  // Every zoned function falls back to it, so a caller that passes nothing
  // gets the same answer as one that passes it.
  assert.equal(localDateISO('2025-08-12T18:45:00Z'), localDateISO('2025-08-12T18:45:00Z', IST));
  assert.equal(zonedISO({ year: 2026, month: 7, day: 20 }), zonedISO({ year: 2026, month: 7, day: 20 }, IST));
});

test('zoneOffsetMs knows a half-hour zone and a DST one', () => {
  assert.equal(zoneOffsetMs(Date.UTC(2026, 0, 1), IST), 5.5 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.UTC(2026, 0, 1), 'Europe/London'), 0);
  assert.equal(zoneOffsetMs(Date.UTC(2026, 6, 1), 'Europe/London'), 3_600_000);
});

test('zonedISO and localDateISO are inverses across the day boundary', () => {
  // 16:32 IST is 11:02 UTC.
  assert.equal(zonedISO({ year: 2026, month: 7, day: 20, hour: 16, minute: 32 }, IST), '2026-08-20T11:02:00.000Z');
  // 01:00 IST on the 21st is still the 20th in UTC; the local day must say the 21st.
  const late = zonedISO({ year: 2026, month: 7, day: 21, hour: 1 }, IST);
  assert.equal(late, '2026-08-20T19:30:00.000Z');
  assert.equal(localDateISO(late, IST), '2026-08-21');
  assert.equal(localDateISO(new Date(late), 'UTC'), '2026-08-20');
});

test('dayStartISO is local midnight as an instant', () => {
  assert.equal(dayStartISO('2026-08-01', IST), '2026-07-31T18:30:00.000Z');
  assert.equal(dayStartISO('2026-08-01', 'UTC'), '2026-08-01T00:00:00.000Z');
  // The instant it names is on that local day, at its first minute.
  assert.equal(localDateISO(dayStartISO('2026-08-01', IST), IST), '2026-08-01');
  assert.deepEqual(localClock(dayStartISO('2026-08-01', IST), IST), { hour: 0, minute: 0, second: 0 });
});

test('shiftISO crosses months and years without a zone', () => {
  assert.equal(shiftISO('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftISO('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftISO('2026-09-20', -6), '2026-09-14');
  assert.equal(shiftISO('2024-02-28', 1), '2024-02-29');   // leap year
});

test('shiftLocalDate shifts the local day of an instant, in the parts zonedISO takes', () => {
  // 18:45 UTC on the 12th is already the 13th in IST; yesterday is the 12th.
  const parts = shiftLocalDate('2025-08-12T18:45:00Z', -1, IST);
  assert.deepEqual(parts, { year: 2025, month: 7, day: 12 });
  assert.equal(zonedISO({ ...parts, hour: 9 }, IST), '2025-08-12T03:30:00.000Z');
  assert.deepEqual(shiftLocalDate('2025-08-12T18:45:00Z', -1, 'UTC'), { year: 2025, month: 7, day: 11 });
});

test('startOfWeek is the Monday, and a Monday is its own start', () => {
  assert.equal(startOfWeek('2026-04-05'), '2026-03-30');   // a Sunday, previous month
  assert.equal(startOfWeek('2026-08-24'), '2026-08-24');   // a Monday
  assert.equal(startOfWeek('2026-08-26'), '2026-08-24');   // a Wednesday
  assert.equal(startOfWeek('2027-01-01'), '2026-12-28');   // across the year
});

test('localClock is the wall clock where the user is', () => {
  assert.deepEqual(localClock('2026-08-26T08:00:00Z', IST), { hour: 13, minute: 30, second: 0 });
  assert.deepEqual(localClock('2026-08-26T08:00:00Z', 'Europe/London'), { hour: 9, minute: 0, second: 0 });
  // Midnight is hour 0, never 24, whatever ICU prints.
  assert.equal(localClock('2026-08-18T18:30:00Z', IST).hour, 0);
  assert.equal(localClock(new Date('2026-08-19T00:00:00Z'), 'UTC').hour, 0);
});

test('formatTime prints the clock in the zone it was given', () => {
  assert.equal(formatTime('2026-08-26T08:00:00Z', IST), '13:30');
  assert.equal(formatTime('2026-08-26T08:00:00Z', 'UTC'), '08:00');
  // Two-digit hours, 24-hour clock.
  assert.equal(formatTime('2026-08-26T03:05:00Z', 'UTC'), '03:05');
});

test('formatDayHeading names the day it was given, whatever zone the host is in', () => {
  const heading = formatDayHeading('2026-08-22');
  assert.match(heading, /Sat/);
  assert.match(heading, /22/);
  assert.match(heading, /Aug/);
  assert.match(heading, /2026/);

  const noYear = formatDayHeading('2026-08-22', { year: false });
  assert.match(noYear, /Sat/);
  assert.doesNotMatch(noYear, /2026/);

  const long = formatDayHeading('2026-08-22', { long: true });
  assert.match(long, /Saturday/);
  assert.match(long, /August/);
  assert.match(long, /2026/);
});

test('toLocalInput is in the browser\'s own zone, because the input reads it back there', () => {
  const iso = '2026-08-22T07:30:00.000Z';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  assert.equal(toLocalInput(iso),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  assert.match(toLocalInput(iso), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('relativeTime rounds to the unit a badge can show', () => {
  const now = Date.parse('2026-08-22T12:00:00Z');
  const at = ms => new Date(now - ms).toISOString();
  assert.equal(relativeTime(at(5 * 60_000), now), '5m ago');
  assert.equal(relativeTime(at(59 * 60_000), now), '59m ago');
  assert.equal(relativeTime(at(3 * 3_600_000), now), '3h ago');
  assert.equal(relativeTime(at(23 * 3_600_000 + 40 * 60_000), now), '24h ago');
  assert.equal(relativeTime(at(2 * 86_400_000), now), '2d ago');
});
