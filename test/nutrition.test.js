// Run with: npm test
// Covers the nutrition rollup and the resolver's routing and gates — no DOM,
// no network. These are the places where a wrong answer is both plausible and
// invisible: a half-priced meal reported as a light one, or a confident
// database match for the wrong food.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  indexDictionary, eventNutrition, summarise, bucketDays, dishNutrition,
} from '../src/ledger/nutrition.js';
import { curatedLookup, isNonFood, looksPackaged } from '../ledger/nutrition/curated.js';
import { judge, gramsFromName } from '../ledger/nutrition/databases.js';
import { sameDish } from '../ledger/nutrition/reference.js';
import { loadINDB, retrieveINDB, matchINDB } from '../ledger/nutrition/indb.js';

const dict = indexDictionary([
  { display_name: 'Cheese Masala Dosa', normalized_name: 'cheese masala dosa',
    kcal: 620, protein_g: 16, carbs_g: 74, fat_g: 28, portion_g: 370, source: 'llm', confidence: 0.85, verified: false },
  { display_name: 'Coke Zero 300ml', normalized_name: 'coke zero 300ml',
    kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0, portion_g: 300, source: 'curated', confidence: 0.9, verified: true },
]);

const meal = (items) => ({ occurred_at: '2026-04-04T14:07:00+00:00', data: { items } });

// ── the rollup ───────────────────────────────────────────

test('a fully resolved basket is itemized and sums with quantity', () => {
  const n = eventNutrition(meal([{ name: 'Cheese Masala Dosa', qty: 2 }, { name: 'Coke Zero 300ml' }]), dict);
  assert.equal(n.basis, 'itemized');
  assert.equal(n.kcal, 620 * 2 + 1);
  assert.equal(n.protein, 32);
  assert.equal(n.missing, 0);
});

test('an unknown dish makes the meal partial, and says how short it is', () => {
  const n = eventNutrition(meal([{ name: 'Cheese Masala Dosa' }, { name: 'Something Nobody Resolved' }]), dict);
  assert.equal(n.basis, 'partial');
  assert.equal(n.kcal, 620);
  assert.equal(n.missing, 1);
  assert.equal(n.total, 2);
});

// The failure this whole module exists to prevent: an unresolved meal read as
// a meal with no calories, quietly dragging every average down.
test('an unresolved meal reports null calories, never zero', () => {
  const n = eventNutrition(meal([{ name: 'Nothing Known' }]), dict);
  assert.equal(n.basis, 'none');
  assert.equal(n.kcal, null);
});

test('a meal with no basket at all is none, not zero', () => {
  const n = eventNutrition(meal([]), dict);
  assert.equal(n.basis, 'none');
  assert.equal(n.kcal, null);
});

test('summarise averages over eating days, and excludes unpriced meals from the average', () => {
  const dateOf = iso => String(iso).slice(0, 10);
  const events = [
    { occurred_at: '2026-04-01T08:00:00Z', data: { items: [{ name: 'Cheese Masala Dosa' }] } },
    { occurred_at: '2026-04-01T20:00:00Z', data: { items: [{ name: 'Cheese Masala Dosa' }] } },
    { occurred_at: '2026-04-02T13:00:00Z', data: { items: [{ name: 'Unknown Thing' }] } },
  ];
  const s = summarise(events, dict, { dateOf });
  assert.equal(s.priced, 2);
  assert.equal(s.unknown, 1);
  // One eating day with two dosas — not two days averaging the unpriced one in.
  assert.equal(s.activeDays, 1);
  assert.equal(s.kcalPerDay, 1240);
  assert.equal(Math.round(s.coverage * 100), 67);
});

test('dishNutrition reports per serving and the period total', () => {
  const n = dishNutrition('Cheese Masala Dosa', 24, dict);
  assert.equal(n.each, 620);
  assert.equal(n.total, 14880);
  assert.equal(n.source, 'llm');
  assert.equal(dishNutrition('Never Eaten', 1, dict), null);
});

test('lookup is normalized, so spelling variants hit the same row', () => {
  assert.equal(eventNutrition(meal([{ name: "CHEESE  MASALA DOSA" }]), dict).kcal, 620);
});

// ── the ladder's routing ─────────────────────────────────

test('non-food items in quick-commerce baskets are caught', () => {
  assert.ok(isNonFood('STRIFF USB hub Type C Multiport Adapter'));
  assert.ok(isNonFood('D Rise 60K Softgel Capsule | Vitamin D3'));
  assert.ok(!isNonFood('Paneer Do Pyaaza Mini Thali'));
});

test('branded packages route to the databases, composed dishes do not', () => {
  assert.ok(looksPackaged("Lay's India's Magic Masala Chips"));
  assert.ok(looksPackaged('Madras Mixture 100gms'));
  assert.ok(!looksPackaged('Paneer Do Pyaaza Mini Thali'));
  assert.ok(!looksPackaged('Cheese Masala Dosa'));
});

// A freshly made item that borrows a packaged brand's name is the one misroute
// the acceptance gate cannot catch, because the label match would be genuine.
test('a made-to-order item never routes to the databases, whatever brand it borrows', () => {
  assert.ok(!looksPackaged('Kitkat Waffle'));
  assert.ok(!looksPackaged('Truffle Mini Cake (300 Gm)'));
  assert.ok(!looksPackaged('Lotus Biscoff Bento Cheesecake [320g]'));
});

test('the curated table stays out of the way of the model', () => {
  // It holds only the traps — not estimates for dishes the model handles.
  assert.ok(curatedLookup('Coke Zero 300ml'));
  assert.ok(curatedLookup('Onion'));
  assert.equal(curatedLookup('Paneer Do Pyaaza Mini Thali'), null);
  assert.equal(curatedLookup('Cheese Masala Dosa'), null);
});

test('curated rows carry the portion they assume', () => {
  assert.equal(curatedLookup('Tomato Ketchup').portion_g, 20);
});

// ── the acceptance gate ──────────────────────────────────
//
// Every case below was returned by the real API during the probe that decided
// this architecture. All four rejections are answers a similarity threshold
// would have accepted.

test('a candidate that names only part of the dish is rejected', () => {
  const v = judge('Bhindi Roti Thali', [{ name: 'Bread, chappatti or roti', kcal_100g: 299 }]);
  assert.equal(v.ok, false);
  assert.match(v.reason, /covers/);
});

test('the wrong food with a plausible score is rejected', () => {
  const v = judge('Paneer Grilled Sandwich', [{ name: 'Fish sandwich, grilled', kcal_100g: 180 }]);
  assert.equal(v.ok, false);
});

test('an exact name match to a different physical form is rejected', () => {
  // "ONION" at 289 kcal/100g is dried; the onion in a pizza order is ~40. This
  // scored a perfect string match and was the worst answer in the probe.
  const v = judge('Onion', [{ name: 'ONION', kcal_100g: 289 }, { name: 'Sour Cream & Onion', kcal_100g: 525 }]);
  assert.equal(v.ok, false);
});

test('candidates that disagree with each other are rejected', () => {
  const v = judge('rajma chawal', [
    { name: 'MTR Minute Meals Rajma Chawal', kcal_100g: 73 },
    { name: 'Daawat Cuppa Rice Rajma Chawal', kcal_100g: 285 },
  ]);
  assert.equal(v.ok, false);
  assert.match(v.reason, /disagree/);
});

test('a genuine branded label is accepted', () => {
  const v = judge("Lay's India's Magic Masala Chips",
    [{ name: "Lay's India's Magic Masala Chips", kcal_100g: 536 }]);
  assert.equal(v.ok, true);
  assert.equal(v.best.kcal_100g, 536);
});

test('an implausible energy density is rejected even on a perfect name', () => {
  const v = judge('Protein Powder', [{ name: 'Protein Powder', kcal_100g: 900 }]);
  assert.equal(v.ok, false);
});

test('a weight written in the name is what the portion comes from', () => {
  assert.equal(gramsFromName('Madras Mixture 100gms'), 100);
  assert.equal(gramsFromName('Coca Cola 475ml'), 475);
  assert.equal(gramsFromName('Cheese Masala Dosa'), null);
});

// ── bucketing ────────────────────────────────────────────
//
// The trap here is units. A week bucket must be the AVERAGE of its eating days,
// not their sum, or switching the grain multiplies the y-axis by seven and the
// line looks like a change in how someone eats.

const day = (d, kcal, meals = 1) => ({ day: d, kcal, protein: kcal / 20, meals });

test('day grain passes days through unchanged', () => {
  const b = bucketDays([day('2026-04-01', 1800), day('2026-04-02', 2200)], 'day');
  assert.equal(b.length, 2);
  assert.equal(b[0].kcal, 1800);
});

test('a week bucket averages its eating days, it does not sum them', () => {
  // Mon 30 Mar and Wed 1 Apr are the same ISO week, and cross a month boundary.
  const b = bucketDays([day('2026-03-30', 2000), day('2026-04-01', 1000)], 'week');
  assert.equal(b.length, 1);
  assert.equal(b[0].kcal, 1500);
  assert.equal(b[0].days, 2);
});

test('weeks start on Monday', () => {
  // Sun 5 Apr 2026 belongs to the week beginning Mon 30 Mar, not to 6 Apr.
  const b = bucketDays([day('2026-04-05', 1000)], 'week');
  assert.equal(b[0].key, '2026-03-30');
});

test('a month bucket averages across the calendar month', () => {
  const b = bucketDays([day('2026-04-01', 1000), day('2026-04-30', 3000), day('2026-05-02', 500)], 'month');
  assert.equal(b.length, 2);
  assert.equal(b[0].key, '2026-04-01');
  assert.equal(b[0].kcal, 2000);
  assert.equal(b[1].kcal, 500);
});

test('buckets come back in chronological order', () => {
  const b = bucketDays([day('2026-05-02', 1), day('2026-04-01', 1), day('2026-03-01', 1)], 'month');
  assert.deepEqual(b.map(x => x.key), ['2026-03-01', '2026-04-01', '2026-05-01']);
});

// ── the reference engine ─────────────────────────────────
//
// Trigram similarity cannot tell these pairs apart; the token rule must. Every
// "not the same" case below scores high enough that a threshold alone would
// have reused the wrong row.

test('a spelling variant is the same dish', () => {
  assert.equal(sameDish('Idli (2pc)', 'Idly (2pc)').same, true);
  assert.equal(sameDish('Onion Uttapam', 'Onion Uthappam').same, true);
  assert.equal(sameDish('Crispy Veg Burger.', 'Crispy Veg Burger').same, true);
});

test('punctuation and case alone never block a match', () => {
  assert.equal(sameDish("Kapoor's Cheese Dosa", 'KAPOORS CHEESE DOSA').same, true);
});

test('an ingredient that changes the food blocks the match', () => {
  assert.equal(sameDish('Cheese Masala Dosa', 'Masala Dosa').same, false);
  assert.equal(sameDish('Veg Fried Rice', 'Egg Fried Rice').same, false);
  assert.equal(sameDish('Paneer Butter Masala', 'Butter Masala').same, false);
});

test('a size difference blocks the match', () => {
  assert.equal(sameDish('Paneer Butter Masala Mini Thali', 'Paneer Butter Masala Thali').same, false);
});

// The Coke Zero trap, at the reference layer rather than the model layer.
test('sugar state blocks the match', () => {
  assert.equal(sameDish('Coke Zero 300ml', 'Coca Cola 300ml').same, false);
  assert.equal(sameDish('Diet Coke', 'Coke').same, false);
});

test('two unexplained words are a different dish', () => {
  assert.equal(sameDish('Rajma Chawal Bowl', 'Chole Kulcha Bowl').same, false);
});

test('a blocked match says which word blocked it', () => {
  assert.match(sameDish('Cheese Masala Dosa', 'Masala Dosa').reason, /cheese/);
});

// ── stated calories ──────────────────────────────────────
//
// Found in the field: "Maharaja Mac 833, fries 225, Coke Zero 0" rolled up as
// 1 kcal, because only the Coke Zero was in the dictionary and the rollup
// never read the numbers the person stated. Stated wins now.

test('a calorie count on the line item outranks the dictionary', () => {
  const n = eventNutrition(meal([{ name: 'Coke Zero 300ml', kcal: 0 }]), dict);
  assert.equal(n.kcal, 0);          // stated 0 beats the dictionary's 1
  assert.equal(n.basis, 'itemized');
});

test('the exact mislogged meal now sums to what was said', () => {
  const n = eventNutrition(meal([
    { qty: 1, name: 'Maharaja Mac', calories: 833 },
    { qty: 1, name: 'regular fries', calories: 225 },
    { qty: 1, name: 'Coke Zero 250ml', calories: 0 },
  ]), dict);
  assert.equal(n.kcal, 1058);
  assert.equal(n.basis, 'itemized');
  assert.equal(n.missing, 0);
});

test('stated kcal multiplies by quantity', () => {
  const n = eventNutrition(meal([{ name: 'Maharaja Mac', kcal: 833, qty: 2 }]), dict);
  assert.equal(n.kcal, 1666);
});

test('a stated count still takes macros from the dictionary when it knows the dish', () => {
  const n = eventNutrition(meal([{ name: 'Cheese Masala Dosa', kcal: 700 }]), dict);
  assert.equal(n.kcal, 700);        // stated calories win
  assert.equal(n.protein, 16);      // macros still from the dictionary row
});

// ── the INDB rung ────────────────────────────────────────
//
// A local file of measured Indian recipes. The dataset was filtered to
// vegetarian at extraction; the tests hold that line and the judge's.

test('the vegetarian filter held', () => {
  const foods = loadINDB();
  assert.ok(foods.length > 800);
  const flesh = /\b(chicken|mutton|fish|prawn|keema|omelette|meat)\b/i;
  const leak = foods.filter(f => flesh.test(f.name) && !/without egg|eggless/i.test(f.name));
  assert.deepEqual(leak.map(f => f.name), []);
  // Eggless items are vegetarian and must have survived the egg regex.
  assert.ok(foods.some(f => /without eggs?/i.test(f.name)));
});

test('a generic dish resolves to measured data with a real portion', () => {
  const m = matchINDB('Masala Dosa');
  assert.equal(m.ok, true);
  assert.equal(m.row.source, 'indb');
  assert.ok(m.row.kcal > 100 && m.row.kcal < 900, `kcal ${m.row.kcal}`);
  assert.ok(m.row.portion_g > 50, 'portion comes from the databank, not 100g');
});

test('the judge holds on INDB too — a partial name is not a match', () => {
  // "Onion" retrieves onion dishes; none may be accepted as raw onion.
  const m = matchINDB('Onion');
  assert.equal(m.ok, false);
  // A branded thali name has no INDB row and must fall through to the model.
  assert.equal(matchINDB('Paneer Do Pyaaza Mini Thali').ok, false);
});

test('retrieval grounds a variant dish with its base recipe', () => {
  const refs = retrieveINDB('Cheese Masala Dosa', 3).map(f => f.name.toLowerCase());
  assert.ok(refs.some(n => n.includes('masala dosa')), `got ${refs}`);
});

test('retrieval returns nothing rather than noise for a brand name', () => {
  assert.deepEqual(retrieveINDB('Snackible Piri Piri Ragi Chips', 3)
    .filter(f => !/ragi|chips/i.test(f.name)), []);
});

test('INDB rows with defective density or piece-sized servings never match directly', () => {
  // Both exist in the databank: 462 kcal/100g "uttapam" and a 56 g sandwich
  // "triangle". Real rows, wrong for a serving as sold — grounding only.
  assert.equal(matchINDB('Onion Tomato Uttapam').ok, false);
  assert.equal(matchINDB('Cheese and chilli sandwich').ok, false);
  // The guard must not take the good rows with it.
  assert.equal(matchINDB('Masala Dosa').ok, true);
  assert.equal(matchINDB('Pav Bhaji').ok, true);
});
