// ======================================================
// Rung 2 — structured food databases, kept in their lane.
//
// Open Food Facts and USDA FoodData Central are consulted for ONE kind of item:
// a branded packaged product with a barcode behind it. For those they are
// better than any model, because there is a real printed label.
//
// They are not consulted for composed restaurant dishes, and this is a measured
// decision rather than a taste. Probing this ledger's actual dish names:
//
//   "Bhindi Roti Thali"       → FDC: "Bread, chappatti or roti"   (a thali is
//                               roti PLUS dal PLUS sabzi PLUS rice)
//   "Paneer Grilled Sandwich" → FDC: "Fish sandwich, grilled"      (wrong food,
//                               plausible score — the dangerous kind of miss)
//   "Cheese Masala Dosa"      → both: nothing at all
//   "rajma chawal"            → OFF: two retort pouches at 73 and 285 kcal/100g,
//                               disagreeing by 4x with each other
//   "Onion"                   → FDC: "ONION" at 289 kcal/100g — an exact string
//                               match, and 7x wrong for the raw onion in a
//                               pizza order
//
// That last one is why acceptance here is not a string-similarity threshold.
// A perfect name match was the worst answer in the probe. Instead a candidate
// must clear three gates — token coverage, a plausible energy density, and
// agreement between the top candidates — and anything that does not is handed
// down to the model rather than accepted with a shrug.
// ======================================================

import { setTimeout as sleep } from 'node:timers/promises';

const OFF_URL = 'https://world.openfoodfacts.org/cgi/search.pl';
const FDC_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const UA = 'finance-hub-ledger/1.0 (personal event ledger; local job)';

const TIMEOUT_MS = 15000;
// Both services rate-limit aggressively and neither is on a critical path, so
// the resolver crawls rather than races. USDA's DEMO_KEY in particular is
// unusable in bulk — set FDC_API_KEY (free, api.data.gov) to use that rung.
const PACE_MS = 1200;

const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z]+/g) || []);

/**
 * How much of the *query* the candidate's name accounts for.
 *
 * Deliberately not Jaccard. Jaccard punishes a candidate for being verbose and
 * rewards it for being short, which is how "Onion" scores 1.00 against a
 * dried-onion product. Coverage asks the question that matters: does this
 * candidate name every part of what I asked for? "Bread, chappatti or roti"
 * covers one of three tokens in "Bhindi Roti Thali" and is correctly rejected.
 */
function coverage(query, candidate) {
  const q = tokens(query), c = tokens(candidate);
  if (!q.size || !c.size) return 0;
  const hit = [...q].filter((t) => c.has(t)).length;
  return hit / q.size;
}

// Nothing edible is outside this band per 100g. A candidate outside it is
// describing a different physical form of the food (a powder, a concentrate,
// a dehydrated mix) even when the name matches perfectly.
const PLAUSIBLE_KCAL_100G = [15, 650];

/**
 * Accept a database answer, or say why not.
 *
 * Three gates, all of which must pass. `reason` is kept on the rejection so a
 * run's log explains itself rather than just reporting a count.
 */
export function judge(query, candidates) {
  const scored = candidates
    .filter((c) => Number.isFinite(c.kcal_100g) && c.kcal_100g > 0)
    .map((c) => ({ ...c, coverage: coverage(query, c.name) }))
    .sort((a, b) => b.coverage - a.coverage);

  if (!scored.length) return { ok: false, reason: 'no candidate carried an energy value' };

  const best = scored[0];

  // Gate 1 — the candidate must account for essentially the whole query. A
  // thali is not a roti; a "Paneer Grilled Sandwich" is not a fish sandwich.
  if (best.coverage < 0.8) {
    return { ok: false, reason: `best candidate covers ${Math.round(best.coverage * 100)}% of the name ("${best.name}")`, best };
  }

  // Gate 2 — the energy density has to be physically sensible for a food.
  const [lo, hi] = PLAUSIBLE_KCAL_100G;
  if (best.kcal_100g < lo || best.kcal_100g > hi) {
    return { ok: false, reason: `${best.kcal_100g} kcal/100g is outside ${lo}–${hi}; likely a powder or concentrate ("${best.name}")`, best };
  }

  // Gate 3 — independent rows for the same product should roughly agree. When
  // the top two differ by more than half, the name is ambiguous (the "rajma
  // chawal" case) and no single row can be trusted.
  const peers = scored.filter((c) => c.coverage >= 0.8).slice(0, 3);
  if (peers.length >= 2) {
    const vals = peers.map((c) => c.kcal_100g);
    const spread = (Math.max(...vals) - Math.min(...vals)) / Math.min(...vals);
    if (spread > 0.5) {
      return { ok: false, reason: `top matches disagree ${vals.join(' vs ')} kcal/100g`, best };
    }
  }

  return { ok: true, best, considered: scored.length };
}

/** Grams in a serving, from a name like "Madras Mixture 100gms" or "Coke 475ml". */
export function gramsFromName(name) {
  const m = String(name || '').match(/(\d{2,4})\s?(g|gm|gms|gram|grams|ml)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 10 && n <= 2000 ? n : null;
}

async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

/** Open Food Facts. No key required. Best on Indian packaged snacks. */
export async function searchOFF(query) {
  const url = new URL(OFF_URL);
  url.searchParams.set('search_terms', query);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', '5');

  const res = await getJson(url);
  if (!res.ok) return { ok: false, error: res.error, candidates: [] };

  const candidates = (res.body.products || [])
    .map((p) => {
      const n = p.nutriments || {};
      return {
        name: p.product_name || '',
        kcal_100g: Number(n['energy-kcal_100g']),
        protein_100g: Number(n.proteins_100g),
        carbs_100g: Number(n.carbohydrates_100g),
        fat_100g: Number(n.fat_100g),
        serving_g: Number(String(p.serving_size || '').match(/(\d+(?:\.\d+)?)\s?g/)?.[1]),
        ref: { db: 'off', code: p.code, name: p.product_name },
      };
    })
    .filter((c) => c.name);

  return { ok: true, candidates };
}

/**
 * USDA FoodData Central. Needs a key.
 *
 * DEMO_KEY exists but is throttled to the point of uselessness — a probe of 30
 * names managed two before backing off for minutes. Without FDC_API_KEY this
 * rung reports itself unconfigured and the ladder moves on, which is the right
 * failure: a missing key should cost accuracy, not abort a run.
 */
export async function searchFDC(query) {
  const key = process.env.FDC_API_KEY;
  if (!key) return { ok: false, error: 'FDC_API_KEY not set', candidates: [], unconfigured: true };

  const url = new URL(FDC_URL);
  url.searchParams.set('api_key', key);
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', '5');

  const res = await getJson(url);
  if (!res.ok) return { ok: false, error: res.error, candidates: [] };

  const num = (f, name) => Number(
    (f.foodNutrients || []).find((n) => n.nutrientName === name)?.value);

  const candidates = (res.body.foods || []).map((f) => ({
    name: f.description || '',
    kcal_100g: Number((f.foodNutrients || [])
      .find((n) => n.nutrientName === 'Energy' && n.unitName === 'KCAL')?.value),
    protein_100g: num(f, 'Protein'),
    carbs_100g: num(f, 'Carbohydrate, by difference'),
    fat_100g: num(f, 'Total lipid (fat)'),
    serving_g: Number(f.servingSize) || null,
    ref: { db: 'fdc', fdcId: f.fdcId, name: f.description },
  })).filter((c) => c.name);

  return { ok: true, candidates };
}

/**
 * Look one product up by barcode.
 *
 * The one case where Open Food Facts is unambiguously the right answer, and it
 * is worth being clear about why it differs from everything else in this file:
 * a barcode is a *key*, not a search. There is no similarity score, no
 * candidate list and no judgement to make — the EAN either identifies a product
 * with a printed label or it does not. So `judge()` is not involved, and the
 * result is trusted at a confidence the text-search path never earns.
 *
 * Serving size comes from the label when the product states one; otherwise the
 * whole pack is the serving, because that is how a snack bought from a
 * quick-commerce basket is actually eaten. Either way `portion_g` records which,
 * so a wrong assumption is visible rather than baked into the calorie number.
 */
export async function lookupBarcode(code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length < 8 || clean.length > 14) {
    return { ok: false, error: `"${code}" is not a barcode — expected 8 to 14 digits.` };
  }

  const url = `https://world.openfoodfacts.org/api/v2/product/${clean}.json`;
  const res = await getJson(url);
  // Open Food Facts answers an unknown barcode with a 404, not a status flag,
  // so both shapes mean the same thing and must read the same way — "we do not
  // have this product" is an answer, not a failure of the lookup.
  if (!res.ok) {
    if (res.error === 'HTTP 404') return { ok: false, error: `Barcode ${clean} is not in Open Food Facts.`, notFound: true };
    return { ok: false, error: res.error };
  }
  if (res.body.status !== 1 || !res.body.product) {
    return { ok: false, error: `Barcode ${clean} is not in Open Food Facts.`, notFound: true };
  }

  const p = res.body.product;
  const n = p.nutriments || {};
  const kcal100 = Number(n['energy-kcal_100g']);
  if (!Number.isFinite(kcal100)) {
    return { ok: false, error: `Open Food Facts has ${clean} (${p.product_name || 'unnamed'}) but no energy value on it.` };
  }

  const name = [p.brands?.split(',')[0]?.trim(), p.product_name].filter(Boolean).join(' ').trim()
    || p.product_name || `Barcode ${clean}`;

  const servingG = Number(String(p.serving_size || '').match(/(\d+(?:\.\d+)?)\s?g/)?.[1]);
  const packG = Number(String(p.quantity || '').match(/(\d+(?:\.\d+)?)\s?g/)?.[1]);
  const grams = servingG || packG || 100;
  const basis = servingG ? 'label_serving' : packG ? 'whole_pack' : 'assumed_100g';
  const per = (v) => (Number.isFinite(v) ? Math.round((v * grams) / 100 * 10) / 10 : null);

  return {
    ok: true,
    display_name: name,
    row: {
      kcal: per(kcal100),
      protein_g: per(Number(n.proteins_100g)),
      carbs_g: per(Number(n.carbohydrates_100g)),
      fat_g: per(Number(n.fat_100g)),
      portion_g: grams,
      category: 'packaged_snack',
      source: 'off',
      // Higher than the text-search path earns: this is an exact identifier
      // resolving to a printed label, with no matching step to get wrong.
      confidence: 0.95,
      source_ref: {
        db: 'off', barcode: clean, name: p.product_name, brand: p.brands || null,
        kcal_100g: kcal100, quantity: p.quantity || null,
        portion_basis: basis, matched_by: 'barcode',
      },
    },
  };
}

/**
 * Resolve one packaged item from the structured databases.
 *
 * Returns a per-serving row in the same shape the curated table and the model
 * produce, so the caller never has to know which rung answered. Per-100g values
 * are converted using, in order: a weight written in the item name, the
 * database's own serving size, then 100g as a last resort — and whichever was
 * used is recorded in source_ref, because that choice is the estimate's
 * dominant error term.
 */
export async function resolveFromDatabases(displayName) {
  const attempts = [];

  for (const [source, search] of [['off', searchOFF], ['fdc', searchFDC]]) {
    const res = await search(displayName);
    await sleep(PACE_MS);

    if (!res.ok) {
      attempts.push({ source, error: res.error });
      continue;
    }

    const verdict = judge(displayName, res.candidates);
    if (!verdict.ok) {
      attempts.push({ source, rejected: verdict.reason });
      continue;
    }

    const c = verdict.best;
    const grams = gramsFromName(displayName) || c.serving_g || 100;
    const per = (v) => (Number.isFinite(v) ? Math.round((v * grams) / 100 * 10) / 10 : null);

    return {
      ok: true,
      row: {
        kcal: per(c.kcal_100g),
        protein_g: per(c.protein_100g),
        carbs_g: per(c.carbs_100g),
        fat_g: per(c.fat_100g),
        portion_g: grams,
        source,
        confidence: 0.85,
        source_ref: {
          ...c.ref,
          kcal_100g: c.kcal_100g,
          portion_basis: gramsFromName(displayName) ? 'name' : c.serving_g ? 'db_serving' : 'assumed_100g',
          coverage: Math.round(c.coverage * 100) / 100,
          attempts,
        },
      },
    };
  }

  return { ok: false, attempts };
}
