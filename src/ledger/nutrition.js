// ======================================================
// Nutrition rollup — line items plus the dish dictionary, summed per meal.
//
// This has a twin in SQL (public.food_event_nutrition in 0005_nutrition.sql),
// for the same reason normalizeName() does: the jobs and any non-browser
// consumer need the answer server-side, and the Food screen needs it without a
// round trip. The Food screen loads every food event once and then filters by
// period entirely in memory — changing the range is instant and free — so
// asking the database to re-roll on every range change would trade that away
// for nothing. Change one, change both. The rules are short on purpose.
//
// The honest part of this module is `basis`. A meal whose basket is half
// unresolved must never read as a light meal, so a partial total is reported
// with the shortfall attached and the UI is expected to say so.
// ======================================================

import { normalizeName } from './normalize.js';

/** Dictionary rows → a Map keyed the way the line items will be looked up. */
export function indexDictionary(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = row.normalized_name || normalizeName(row.display_name);
    if (key) map.set(key, row);
  }
  return map;
}

/**
 * What one event contributes.
 *
 * basis:
 *   'itemized'  every line item resolved — the number means something
 *   'partial'   some resolved; `missing` says how many did not
 *   'none'      no basket, or nothing in it resolved. kcal is null, never 0:
 *               an unknown meal is not a meal without calories, and a zero
 *               here would quietly drag every average down.
 */
export function eventNutrition(event, dict) {
  const items = event?.data?.items || [];
  if (!items.length) return { kcal: null, protein: null, carbs: null, fat: null, basis: 'none', total: 0, resolved: 0, missing: 0 };

  let kcal = 0, protein = 0, carbs = 0, fat = 0, resolved = 0;

  for (const item of items) {
    const qty = Number(item.qty) || 1;

    // A calorie count stated on the line item itself outranks the dictionary:
    // it came from the person or the menu, about this exact serving. Zero is a
    // legitimate statement (a Coke Zero), so the test is "is a number", never
    // truthiness. Macros still come from the dictionary when it knows the dish.
    const stated = Number(item?.kcal ?? item?.calories);
    const row = dict.get(normalizeName(item?.name));
    const hasRow = row && row.kcal !== null && row.kcal !== undefined;

    if (!Number.isFinite(stated) && !hasRow) continue;
    resolved++;
    kcal += (Number.isFinite(stated) ? stated : Number(row.kcal)) * qty;
    if (hasRow) {
      protein += (Number(row.protein_g) || 0) * qty;
      carbs   += (Number(row.carbs_g)   || 0) * qty;
      fat     += (Number(row.fat_g)     || 0) * qty;
    }
  }

  const missing = items.length - resolved;
  if (!resolved) return { kcal: null, protein: null, carbs: null, fat: null, basis: 'none', total: items.length, resolved: 0, missing };

  return {
    kcal: Math.round(kcal),
    protein: Math.round(protein),
    carbs: Math.round(carbs),
    fat: Math.round(fat),
    basis: missing ? 'partial' : 'itemized',
    total: items.length, resolved, missing,
  };
}

/**
 * Roll a list of events up into per-day totals and the coverage behind them.
 *
 * Days are the unit that matters for eating, and the denominator is deliberately
 * "days you actually ate something we could price" — not calendar days. A
 * ledger built from receipts has nothing to say about the days you cooked, and
 * averaging those in as zeroes would invent a number rather than report one.
 */
export function summarise(events, dict, { dateOf }) {
  const days = new Map();
  let priced = 0, partial = 0, unknown = 0;
  let kcal = 0, protein = 0;

  for (const event of events) {
    const n = eventNutrition(event, dict);
    if (n.basis === 'none') { unknown++; continue; }
    if (n.basis === 'partial') partial++;
    priced++;
    kcal += n.kcal;
    protein += n.protein;

    const day = dateOf(event.occurred_at);
    const row = days.get(day) || { day, kcal: 0, protein: 0, meals: 0 };
    row.kcal += n.kcal; row.protein += n.protein; row.meals++;
    days.set(day, row);
  }

  const dayList = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));

  return {
    kcal, protein,
    priced, partial, unknown,
    days: dayList,
    activeDays: dayList.length,
    kcalPerDay: dayList.length ? Math.round(kcal / dayList.length) : null,
    proteinPerDay: dayList.length ? Math.round(protein / dayList.length) : null,
    // What share of the meals in view carry a number at all. The UI shows this
    // next to any total, because a 1,900 kcal average over 40% of your meals
    // and the same average over 95% of them are different claims.
    coverage: priced + unknown ? priced / (priced + unknown) : 0,
  };
}

/**
 * Roll daily totals into day / week / month buckets.
 *
 * Weeks start on Monday. Months are calendar months. The value plotted is
 * always **kcal per eating day within the bucket**, never the bucket's sum —
 * switching the grain has to change the resolution, not the units, or the
 * y-axis silently multiplies by seven and the line looks like a diet change
 * that never happened.
 *
 * `days` is carried through so a bucket built from two eating days can be told
 * apart from one built from seven; a week averaged over two days is a much
 * weaker claim, and the tooltip says so.
 */
export function bucketDays(days, grain) {
  if (grain === 'day') {
    return days.map(d => ({ key: d.day, at: d.day, kcal: d.kcal, protein: d.protein, days: 1, meals: d.meals }));
  }

  const keyOf = (iso) => {
    if (grain === 'month') return `${iso.slice(0, 7)}-01`;
    // Monday of that ISO week, computed on a UTC date so a DST shift cannot
    // move a day into the neighbouring bucket.
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };

  const buckets = new Map();
  for (const day of days) {
    const key = keyOf(day.day);
    const b = buckets.get(key) || { key, at: key, kcal: 0, protein: 0, days: 0, meals: 0 };
    b.kcal += day.kcal; b.protein += day.protein; b.days += 1; b.meals += day.meals;
    buckets.set(key, b);
  }

  return [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(b => ({ ...b, kcal: Math.round(b.kcal / b.days), protein: Math.round(b.protein / b.days) }));
}

/** Per-dish calorie totals, for the dish catalogue. */
export function dishNutrition(name, count, dict) {
  const row = dict.get(normalizeName(name));
  if (!row || row.kcal === null || row.kcal === undefined) return null;
  return {
    each: Math.round(Number(row.kcal)),
    total: Math.round(Number(row.kcal) * count),
    protein: Number(row.protein_g) || null,
    portion: Number(row.portion_g) || null,
    source: row.source,
    confidence: row.confidence,
    verified: row.verified,
  };
}

/** How much to trust a row on sight: where the number came from. */
export const SOURCE_LABEL = {
  manual:    'checked by you',
  curated:   'curated table',
  off:       'Open Food Facts label',
  fdc:       'USDA FoodData Central',
  llm:       'model estimate',
  heuristic: 'scaled from the bill',
};
