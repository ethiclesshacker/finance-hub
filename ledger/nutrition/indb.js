// ======================================================
// Anuvaad INDB — measured Indian recipes, used two ways.
//
// indb.json is the vegetarian subset of the Anuvaad Indian Nutrient Databank
// (2024.11): 859 standardized recipes with per-100g composition AND a named
// per-serving portion — the one thing no other database offered. The
// vegetarian filter ran at extraction time (see the regex in git history of
// the extraction script / docs): flesh, egg and egg-defined dishes (meringue,
// soufflé, classic mayonnaise) are gone; explicitly eggless variants and dairy
// stay.
//
// Two ways in, matching how useful the data actually is:
//
//   matchINDB()    a judged direct hit, for the generic names INDB really
//                  contains ("Masala dosa", "Pav bhaji"). Same three gates as
//                  the OFF/FDC rung, because the same traps exist here —
//                  "Onion" must not become "French onion soup".
//
//   retrieveINDB() top-k rows by token overlap, for grounding the model. The
//                  restaurant dishes INDB does not contain ("Cheese Masala
//                  Dosa", any thali) are composed FROM dishes it does, so the
//                  model estimates against measured Indian densities and
//                  portions instead of from memory.
// ======================================================

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from './databases.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let cache = null;

/** The vegetarian INDB, loaded once, with token sets precomputed. */
export function loadINDB() {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(resolve(HERE, 'indb.json'), 'utf8'));
  cache = raw.foods.map((f) => ({ ...f, tokens: tokenSet(f.name) }));
  return cache;
}

// Hindi glue words and generic cooking words carry no identity; a match made
// of them alone is noise. "ka sandwich" must not pull every sandwich.
const STOP = new Set(['ka', 'ki', 'ke', 'kay', 'aur', 'with', 'and', 'the', 'of', 'in', 'style', 'indian', 'home', 'made', 'plain', 'fresh', 'hot', 'cold']);

const tokenSet = (s) => new Set(
  String(s).toLowerCase().match(/[a-z]+/g)?.filter((t) => !STOP.has(t)) || []);

/**
 * Top-k INDB rows for a dish name, scored by how much of each side the shared
 * tokens explain. Recall is the job here — the model does the judging — so the
 * score is lenient where matchINDB() is strict.
 */
export function retrieveINDB(name, k = 3) {
  const q = tokenSet(name);
  if (!q.size) return [];

  return loadINDB()
    .map((f) => {
      const shared = [...q].filter((t) => f.tokens.has(t)).length;
      if (!shared) return null;
      // Query coverage dominates; candidate coverage breaks ties so "Masala
      // dosa" beats "Masala dosa with extra six words" for the same overlap.
      return { f, score: shared / q.size + 0.2 * (shared / f.tokens.size) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((x) => x.score >= 0.5)
    .map((x) => x.f);
}

/** One reference row as a line of prompt text. */
export function referenceLine(f) {
  const portion = f.serving_g ? `~${f.serving_g} g ${f.serving_unit || 'serving'}` : f.serving_unit || 'serving';
  const per = f.serving_kcal !== null
    ? `${Math.round(f.serving_kcal)} kcal per ${portion}`
    : `${Math.round(f.kcal_100g)} kcal/100g`;
  const macros = f.serving_protein_g !== null
    ? ` (P ${f.serving_protein_g} C ${f.serving_carbs_g} F ${f.serving_fat_g} per serving)`
    : '';
  return `${f.name}: ${per}, ${Math.round(f.kcal_100g)} kcal/100g${macros}`;
}

/**
 * A judged direct match, or nothing.
 *
 * Runs through the same judge() as the OFF/FDC rung — coverage of the query,
 * plausible density, agreement between candidates — so this rung inherits the
 * property the whole resolver is built on: a miss falls through to the model,
 * it never becomes a confident wrong answer.
 */
/**
 * Sanity for a DIRECT hit, learned from the databank's own defects: "Onion
 * tomato uttapam" is recorded at 462 kcal/100g and "Cheese toast" at 785 —
 * physically implausible for cooked flour dishes — and several servings are
 * one *piece* (a 56 g sandwich triangle), not one serving as sold. A row that
 * fails either test is still fine as grounding (the model judges the anchor);
 * it must not become a "measured" dictionary row on its own.
 */
const directOk = (f) =>
  Number.isFinite(f.kcal_100g) && f.kcal_100g <= 350 &&
  Number.isFinite(f.serving_g) && f.serving_g >= 120;

export function matchINDB(displayName) {
  const candidates = retrieveINDB(displayName, 5).filter(directOk).map((f) => ({
    name: f.name,
    kcal_100g: f.kcal_100g,
    protein_100g: f.protein_100g,
    carbs_100g: f.carbs_100g,
    fat_100g: f.fat_100g,
    serving_g: f.serving_g,
    ref: { db: 'indb', code: f.code, name: f.name, serving_unit: f.serving_unit },
  }));

  // An exact name — every meaningful token shared, both ways — is the recipe
  // itself, and skips the agreement gate. INDB legitimately holds several
  // variants of one dish ("Masala dosa", richer regional versions) whose
  // densities differ; that disagreement is real variety, not ambiguity, and
  // it must not veto the row whose name IS the query. The density gate still
  // applies via judge() for everything short of exact.
  const q = tokenSet(displayName);
  const exact = candidates.find((c) => {
    const ct = tokenSet(c.name);
    return q.size && ct.size === q.size && [...q].every((t) => ct.has(t));
  });

  let c;
  if (exact && Number.isFinite(exact.kcal_100g) && exact.kcal_100g > 10) {
    c = { ...exact, coverage: 1 };
  } else {
    const verdict = judge(displayName, candidates);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    c = verdict.best;

    // Reverse coverage: the candidate must not carry identity the query never
    // asked for. judge() checks that the candidate explains the query — which
    // a one-word query like "Onion" satisfies trivially against "French onion
    // soup". The soup is not the raw onion in a pizza order; two thirds of its
    // name is things nobody asked about, and that is the tell.
    const ct = tokenSet(c.name);
    const shared = [...q].filter((t) => ct.has(t)).length;
    if (ct.size && shared / ct.size < 0.6) {
      return { ok: false, reason: `"${c.name}" carries identity beyond the query (${shared}/${ct.size} tokens asked for)` };
    }
  }
  // INDB's own serving is the whole point of using it; 100g is the last resort
  // and is recorded as such.
  const grams = c.serving_g || 100;
  const per = (v) => (Number.isFinite(v) ? Math.round((v * grams) / 100 * 10) / 10 : null);

  return {
    ok: true,
    row: {
      kcal: per(c.kcal_100g),
      protein_g: per(c.protein_100g),
      carbs_g: per(c.carbs_100g),
      fat_g: per(c.fat_100g),
      portion_g: grams,
      source: 'indb',
      confidence: 0.8,
      source_ref: {
        ...c.ref,
        kcal_100g: c.kcal_100g,
        portion_basis: c.serving_g ? 'indb_serving' : 'assumed_100g',
        coverage: Math.round(c.coverage * 100) / 100,
      },
    },
  };
}
