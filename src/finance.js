import { computeNet } from './networth-math.js';

// ======================================================
// Savings rate and financial-independence projections.
// Pure functions — no DOM, no Supabase, no settings imports — so the maths
// can be reasoned about (and tested) on its own.
// ======================================================

/**
 * Local-time ISO date (YYYY-MM-DD).
 *
 * NOT toISOString().slice(0,10) — that converts to UTC first, so in IST every
 * date built from a local midnight came out a day early.
 */
function toISODate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Fractional months between two ISO dates. Uses 30.44 days = 1 month. */
export function monthsBetween(fromISO, toISO) {
  const from = new Date(fromISO + 'T00:00:00');
  const to   = new Date(toISO + 'T00:00:00');
  if (isNaN(from) || isNaN(to)) return 0;
  return (to - from) / (1000 * 60 * 60 * 24 * 30.4375);
}

/**
 * Savings rate implied by how fast net worth actually moved.
 *
 * IMPORTANT: this is net-worth growth ÷ income, so it bundles investment
 * returns in with money you actually set aside. In a good market it reads
 * above 100%; in a bad one it can go negative while you're still saving hard.
 * A true contribution-only rate needs contributions logged separately — that's
 * the XIRR work, not this.
 *
 * @param {object[]} entries  net_worth_entries, ascending by date
 * @param {number} monthlyIncome
 * @param {number} windowMonths  how far back to look; 0 = all history
 */
export function impliedSavingsRate(entries, monthlyIncome, windowMonths = 12) {
  if (!entries?.length || entries.length < 2 || !(monthlyIncome > 0)) return null;

  const last = entries[entries.length - 1];
  let first = entries[0];

  if (windowMonths > 0) {
    // Earliest snapshot still inside the window, so a sparse history doesn't
    // silently compare across a much longer period than requested.
    const candidates = entries.filter(e => monthsBetween(e.date, last.date) <= windowMonths);
    if (candidates.length >= 2) first = candidates[0];
  }

  const months = monthsBetween(first.date, last.date);
  if (months <= 0) return null;

  const delta  = computeNet(last) - computeNet(first);
  const earned = monthlyIncome * months;
  if (earned <= 0) return null;

  return {
    rate: (delta / earned) * 100,
    delta,
    months,
    perMonth: delta / months,
    from: first.date,
    to: last.date,
  };
}

/**
 * Months until `target`, starting from `principal`, adding `monthly` at the end
 * of each month, compounding monthly at `annualRatePct`.
 *
 * Closed form of the future-value-of-an-annuity equation solved for n:
 *   FV = P(1+r)^n + C·((1+r)^n − 1)/r
 *   n  = ln((T·r + C) / (P·r + C)) / ln(1+r)
 *
 * Returns null when the target is unreachable (no contributions and no growth,
 * or the balance shrinks).
 */
export function monthsToTarget({ principal, monthly, annualRatePct, target }) {
  if (principal >= target) return 0;

  const r = annualRatePct / 100 / 12;

  if (Math.abs(r) < 1e-9) {
    if (monthly <= 0) return null;
    return (target - principal) / monthly;
  }

  const numerator   = target * r + monthly;
  const denominator = principal * r + monthly;
  if (numerator <= 0 || denominator <= 0) return null;

  const n = Math.log(numerator / denominator) / Math.log(1 + r);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Month-by-month balance projection, for plotting.
 * @returns {{date: string, value: number}[]} starting at `startISO`
 */
export function projectSeries({ principal, monthly, annualRatePct, months, startISO }) {
  const r = annualRatePct / 100 / 12;
  const start = new Date(startISO + 'T00:00:00');
  const out = [];
  let balance = principal;

  for (let i = 0; i <= Math.ceil(months); i++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    out.push({ date: toISODate(d), value: balance });
    balance = balance * (1 + r) + monthly;
  }
  return out;
}

/**
 * Coast FI: the amount that, left completely alone, compounds to `target` by
 * the time you stop working. Cross it and every further rupee is optional.
 */
export function coastFINumber({ target, annualRatePct, yearsToRetirement }) {
  if (yearsToRetirement <= 0) return target;
  const r = annualRatePct / 100;
  return target / Math.pow(1 + r, yearsToRetirement);
}

/** Add `months` to an ISO date and return the ISO date. */
export function addMonthsISO(iso, months) {
  const d = new Date(iso + 'T00:00:00');
  d.setMonth(d.getMonth() + Math.round(months));
  return toISODate(d);
}

/** "7 yrs 3 mos" — null-safe. */
export function formatDuration(months) {
  if (months == null || !Number.isFinite(months)) return '—';
  if (months < 1) return 'Reached';
  const y = Math.floor(months / 12);
  const m = Math.round(months % 12);
  if (y === 0) return `${m} mo${m === 1 ? '' : 's'}`;
  if (m === 0) return `${y} yr${y === 1 ? '' : 's'}`;
  return `${y} yr${y === 1 ? '' : 's'} ${m} mo${m === 1 ? '' : 's'}`;
}
