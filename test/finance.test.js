// Run with: npm test
// Covers the pure maths only — no DOM, no network. These are the functions
// where a wrong answer is both plausible and invisible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAssets, computeLiquid, computeCashLike, computeEmergencyFund, computeNet,
} from '../src/networth-math.js';

import {
  monthsBetween, impliedSavingsRate, monthsToTarget,
  projectSeries, coastFINumber, formatDuration,
} from '../src/finance.js';

const snap = (over = {}) => ({
  date: '2026-01-01', stocks: 0, mutual_funds: 0, cash: 0,
  epf: 0, gold: 0, fds: 0, credit_cards: 0, ...over,
});

// ── net worth ────────────────────────────────────────────
test('computeAssets sums every class', () => {
  assert.equal(computeAssets(snap({ stocks: 1, mutual_funds: 2, cash: 3, epf: 4, gold: 5, fds: 6 })), 21);
});

test('compute* are null-safe', () => {
  for (const fn of [computeAssets, computeLiquid, computeCashLike, computeNet]) {
    assert.equal(fn(null), 0);
    assert.equal(fn(undefined), 0);
  }
});

test('computeNet subtracts liabilities and can go negative', () => {
  assert.equal(computeNet(snap({ cash: 100, credit_cards: 250 })), -150);
});

test('emergency fund basis changes what counts', () => {
  const e = snap({ cash: 100, fds: 50, stocks: 900, mutual_funds: 400 });
  assert.equal(computeEmergencyFund(e, 'cash_like'), 150);
  assert.equal(computeEmergencyFund(e, 'accessible'), 1400);
  // Unknown basis must not silently return 0.
  assert.equal(computeEmergencyFund(e, 'nonsense'), 1400);
});

// ── savings rate ─────────────────────────────────────────
test('monthsBetween is roughly right across a year', () => {
  assert.ok(Math.abs(monthsBetween('2025-01-01', '2026-01-01') - 12) < 0.05);
});

test('impliedSavingsRate needs two snapshots and an income', () => {
  assert.equal(impliedSavingsRate([], 1000), null);
  assert.equal(impliedSavingsRate([snap()], 1000), null);
  assert.equal(impliedSavingsRate([snap(), snap({ date: '2026-06-01' })], 0), null);
});

test('impliedSavingsRate: saved half of income over 12 months → 50%', () => {
  const entries = [
    snap({ date: '2025-01-01', cash: 0 }),
    snap({ date: '2026-01-01', cash: 600000 }),
  ];
  const r = impliedSavingsRate(entries, 100000, 12);
  assert.ok(Math.abs(r.rate - 50) < 0.5, `got ${r.rate}`);
  assert.equal(r.delta, 600000);
});

test('impliedSavingsRate goes negative when net worth falls', () => {
  const entries = [
    snap({ date: '2025-01-01', cash: 500000 }),
    snap({ date: '2026-01-01', cash: 200000 }),
  ];
  assert.ok(impliedSavingsRate(entries, 100000, 12).rate < 0);
});

test('impliedSavingsRate window ignores snapshots older than the window', () => {
  const entries = [
    snap({ date: '2020-01-01', cash: 0 }),
    snap({ date: '2025-06-01', cash: 100000 }),
    snap({ date: '2026-01-01', cash: 200000 }),
  ];
  const r = impliedSavingsRate(entries, 100000, 12);
  assert.equal(r.from, '2025-06-01');
});

// ── projections ──────────────────────────────────────────
test('monthsToTarget returns 0 when already there', () => {
  assert.equal(monthsToTarget({ principal: 100, monthly: 10, annualRatePct: 8, target: 100 }), 0);
});

test('monthsToTarget with zero return is plain division', () => {
  assert.equal(
    monthsToTarget({ principal: 0, monthly: 1000, annualRatePct: 0, target: 12000 }),
    12
  );
});

test('monthsToTarget is unreachable with no contributions and no growth', () => {
  assert.equal(monthsToTarget({ principal: 100, monthly: 0, annualRatePct: 0, target: 1000 }), null);
});

test('monthsToTarget agrees with the iterative projection', () => {
  const args = { principal: 1_500_000, monthly: 50_000, annualRatePct: 10 };
  const target = 10_500_000;
  const n = monthsToTarget({ ...args, target });

  // Step the same scenario forward month by month and find the crossing.
  const series = projectSeries({ ...args, months: 400, startISO: '2026-01-01' });
  const crossing = series.findIndex(p => p.value >= target);

  assert.ok(Math.abs(crossing - n) <= 1, `closed form ${n}, iterative ${crossing}`);
});

test('projectSeries compounds and contributes each month', () => {
  const s = projectSeries({ principal: 1000, monthly: 100, annualRatePct: 12, months: 2, startISO: '2026-01-01' });
  assert.equal(s[0].value, 1000);
  assert.ok(Math.abs(s[1].value - (1000 * 1.01 + 100)) < 1e-9);
  assert.equal(s[0].date, '2026-01-01');
  assert.equal(s[1].date, '2026-02-01');
});

test('coastFI discounts the target back over the horizon', () => {
  const target = 10_500_000;
  const coast = coastFINumber({ target, annualRatePct: 10, yearsToRetirement: 34 });
  assert.ok(coast < target);
  // Growing it forward again must land on the target.
  assert.ok(Math.abs(coast * Math.pow(1.1, 34) - target) < 1);
});

test('coastFI with no horizon left is just the target', () => {
  assert.equal(coastFINumber({ target: 500, annualRatePct: 10, yearsToRetirement: 0 }), 500);
});

// ── formatting ───────────────────────────────────────────
test('formatDuration', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(0), 'Reached');
  assert.equal(formatDuration(7), '7 mos');
  assert.equal(formatDuration(12), '1 yr');
  assert.equal(formatDuration(15), '1 yr 3 mos');
  assert.equal(formatDuration(24), '2 yrs');
});
