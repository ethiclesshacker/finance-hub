import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftISO, shortDay, longDay, formatHours, meanOf, latestOf, summarise, fillHours } from '../src/health/summary.js';
import { resolveDays } from '../ledger/tools.js';

test('shiftISO crosses months and years', () => {
  assert.equal(shiftISO('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftISO('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftISO('2026-09-20', -6), '2026-09-14');
});

test('day labels', () => {
  assert.equal(shortDay('2026-09-14'), '14 Sep');
  assert.equal(longDay('2026-09-14'), 'Mon 14 Sep');
});

test('formatHours', () => {
  assert.equal(formatHours(5.07), '5h 04m');
  assert.equal(formatHours(8), '8h 00m');
  assert.equal(formatHours(7.999), '8h 00m');
  assert.equal(formatHours(null), '—');
  assert.equal(formatHours(undefined), '—');
});

test('a day with no data is a gap, not a zero', () => {
  const days = [{ day: 'a', steps: 1000 }, { day: 'b' }, { day: 'c', steps: 3000 }];
  assert.equal(meanOf(days, 'steps'), 2000);
  assert.equal(meanOf([{ day: 'a' }], 'steps'), null);
  assert.deepEqual(latestOf(days, 'steps'), { day: 'c', value: 3000 });
  assert.equal(latestOf(days, 'weight_kg'), null);
});

test('summarise leaves the unfinished day out of step and energy averages only', () => {
  const days = [
    { day: '2026-09-18', steps: 5000, active_kcal: 400, basal_kcal: 2000, sleep_hours: 5, resting_hr: 60, hrv_ms: 40 },
    { day: '2026-09-19', steps: 10000, active_kcal: 800, basal_kcal: 2200, sleep_hours: 6, resting_hr: 66, hrv_ms: 70, weight_kg: 89.7 },
    { day: '2026-09-20', steps: 300, active_kcal: 30, basal_kcal: 500, sleep_hours: 7 },
  ];
  const s = summarise(days, '2026-09-20');
  assert.equal(s.stepsAvg, 7500);
  assert.equal(s.stepsToday, 300);
  assert.equal(s.activeAvg, 600);
  assert.equal(s.burnedAvg, 2700);
  assert.equal(s.sleepAvg, 6);
  assert.deepEqual(s.sleepLast, { day: '2026-09-20', value: 7 });
  assert.deepEqual(s.restingLatest, { day: '2026-09-19', value: 66 });
  assert.deepEqual(s.weightLatest, { day: '2026-09-19', value: 89.7 });
  assert.equal(s.daysWithData, 3);
});

test('summarise on nothing', () => {
  const s = summarise([{ day: '2026-09-20' }], '2026-09-20');
  assert.equal(s.stepsAvg, null);
  assert.equal(s.sleepLast, null);
  assert.equal(s.daysWithData, 0);
});

test('fillHours always yields a whole day', () => {
  const out = fillHours([{ at: '08:00', value: 1200 }, { at: '23:00', value: 5 }]);
  assert.equal(out.length, 24);
  assert.equal(out[8].value, 1200);
  assert.equal(out[23].value, 5);
  assert.equal(out[0].value, 0);
  assert.equal(out[8].label, '08:00');
  assert.equal(fillHours(null).length, 24);
});

test('resolveDays turns phrases into inclusive local dates', () => {
  const tz = 'Asia/Kolkata';
  assert.deepEqual(resolveDays('2026-09-14..2026-09-20', undefined, tz), { from: '2026-09-14', to: '2026-09-20' });
  assert.deepEqual(resolveDays('2026-09-19', undefined, tz), { from: '2026-09-19', to: '2026-09-19' });
  const week = resolveDays(undefined, 'last 7 days', tz);
  assert.equal(shiftISO(week.to, -7), week.from);
  const today = resolveDays('today', undefined, tz);
  assert.equal(today.from, today.to);
});
