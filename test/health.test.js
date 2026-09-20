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

// ── The body section of a summary ──────────────────────
import { lifeSection, renderLifeLines } from '../src/ledger/summary.js';
import { resolveSettings, settingDefaults, SETTINGS_SCHEMA } from '../src/settings-schema.js';

const lifeDay = (day, over = {}) => ({
  day,
  body: { steps: 10000, sleep_hours: 5.07, fell_asleep: '00:44', woke: '05:49', resting_hr: 67, hrv_ms: 74 },
  food: { eaten_kcal: 2150, protein_g: 74, meals: 3, meals_unpriced: 0 },
  energy: { eaten_kcal: 2150, burned_kcal: 2441, balance_kcal: -291, target_kcal: 2000, eaten_vs_target: 150, complete: true },
  ...over,
});

test('lifeSection: nothing recorded is said, not left blank', () => {
  assert.deepEqual(lifeSection([]), { recorded: false });
  assert.deepEqual(lifeSection([{ day: '2026-09-20', events: 3, money: { spend: 10 } }]), { recorded: false });
  assert.deepEqual(renderLifeLines({ recorded: false }), []);
  assert.deepEqual(renderLifeLines(undefined), []);
});

test('lifeSection: one day reads as that day', () => {
  const body = lifeSection([lifeDay('2026-09-19', {
    activity: [{ activity: 'walking', minutes: 37, distance_km: 3.1, source: 'watch' }],
  })]);
  assert.equal(body.steps, 10000);
  assert.equal(body.balance_kcal, -291);
  assert.equal(body.energy_complete, true);
  assert.equal('weight_kg' in body, false);
  const text = renderLifeLines(body).join('\n');
  assert.match(text, /10,000 steps, slept 5h 04m \(00:44–05:49\), resting HR 67\./);
  assert.match(text, /ate 2,150 kcal, burned 2,441, balance −291 against a 2,000 target\./);
  assert.match(text, /Activity: walking 37 min, 3\.1 km \(watch\)/);
});

test('lifeSection: an incomplete day says so, and a day with no food does not invent a balance', () => {
  const partial = lifeSection([lifeDay('2026-09-18', {
    food: { eaten_kcal: 2076, meals: 3, meals_unpriced: 1 },
    energy: { eaten_kcal: 2076, burned_kcal: 2659, balance_kcal: -583, target_kcal: 2000, complete: false },
  })]);
  assert.match(renderLifeLines(partial).join('\n'), /provisional, 1 meal unpriced/);

  const noFood = lifeSection([{ day: '2026-09-19', body: { steps: 100 }, energy: { burned_kcal: 3096, target_kcal: 2000, complete: false } }]);
  assert.equal('balance_kcal' in noFood, false);
  assert.match(renderLifeLines(noFood).join('\n'), /burned 3,096 kcal; nothing eaten is on record/);
});

test('lifeSection: a range averages over the days that have the number', () => {
  const days = [
    lifeDay('2026-09-14', { body: { steps: 15000, sleep_hours: 8, resting_hr: 60, weight_kg: 87.4 } }),
    { day: '2026-09-15' },                                             // the Watch was on the charger
    lifeDay('2026-09-16', { body: { steps: 5000, resting_hr: 70, weight_kg: 86.1 },
      energy: { eaten_kcal: 1000, burned_kcal: 2500, balance_kcal: -1500, target_kcal: 2000, complete: false },
      activity: [{ activity: 'walking', minutes: 30, source: 'watch' }, { activity: 'cycling', source: 'ledger', note: 'Failed attempt' }] }),
  ];
  const body = lifeSection(days);
  assert.equal(body.days, 3);
  assert.equal(body.steps_avg, 10000);
  assert.equal(body.sleep_hours_avg, 8);
  assert.equal(body.nights_recorded, 1);
  assert.equal(body.weight_change_kg, -1.3);
  assert.equal(body.balance_kcal_avg, -291, 'only the complete day counts');
  assert.equal(body.balance_over_days, 1);
  assert.equal(body.workouts, 2);
  assert.equal(body.active_minutes, 30);
  const text = renderLifeLines(body).join('\n');
  assert.match(text, /Weight: 87\.4 → 86\.1 kg \(−1\.3 kg\)\./);
  assert.match(text, /balance −291 a day over the 1 fully logged day\./);
});

test('settings catalogue resolves stored values over defaults and says which is which', () => {
  assert.equal(Object.keys(settingDefaults()).length, Object.keys(SETTINGS_SCHEMA).length);
  const r = resolveSettings({ food_kcal_target: 2000, monthly_expenses: null });
  assert.deepEqual([r.food_kcal_target.value, r.food_kcal_target.set_by], [2000, 'user']);
  assert.deepEqual([r.monthly_expenses.value, r.monthly_expenses.set_by], [SETTINGS_SCHEMA.monthly_expenses.default, 'default']);
  assert.equal(resolveSettings().fi_multiplier.set_by, 'default');
});
