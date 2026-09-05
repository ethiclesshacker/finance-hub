// ======================================================
// Rung 3 — the model.
//
// The last rung, and for this ledger the one that answers most names: 104 of
// 146 distinct items are composed restaurant dishes that no structured food
// database contains. A model that knows what goes into a paneer do pyaaza mini
// thali is the only thing that can price one.
//
// Everything here exists to keep that cheap and honest:
//
//   - names are batched, so 146 dishes cost a handful of calls, not 146
//   - a strict JSON schema, so the reply is parsed, never interpreted
//   - the model must state the portion in grams it assumed, which is the term
//     the whole estimate hinges on and the thing a human can later correct
//   - it must return its own confidence, which the ladder writes through to
//     the row so a shaky dish is visible rather than silently averaged in
//
// Calls go through ledger/extract/openai.js — the single billable door — so
// every one of them lands in costs.jsonl without a second call site to forget.
// ======================================================

import { chat } from '../extract/openai.js';
import { retrieveINDB, referenceLine } from './indb.js';

const SYSTEM_PROMPT = `You estimate the nutrition of restaurant dishes and packaged foods, mostly Indian, from the name printed on a delivery receipt or a restaurant bill.

Your output feeds a personal food log. Someone will look at a daily total and decide something about how they eat. A number that is confidently 40% high is worse than one that is honestly uncertain, so calibration matters more than precision.

## The unit

Estimate ONE SERVING AS SOLD — the unit the receipt counts. One thali. One whole pizza. One dosa. One packet. Never per 100g, and never one slice of a pizza that was sold whole.

Always state portion_g: the total edible mass of that serving in grams. State it first, in your head, then derive the calories from it. Deriving calories from a portion keeps the two consistent; guessing calories and back-filling a portion does not.

## Calibrate portions against these

These are real Indian delivery portions, weighed. Anchor to them rather than to a nutrition label's idea of a serving:

| Dish | Portion | kcal |
|---|---|---|
| Mini thali (dal or rajma, 1 sabzi, 2 roti, small rice, curd) | 450-550 g | 600-700 |
| Full thali (adds a second sabzi, sweet, more rice) | 650-800 g | 850-1000 |
| Masala dosa, plain | 250-300 g | 450-500 |
| Cheese masala dosa | 300-350 g | 580-650 |
| Rajma/chole chawal, single box | 400-500 g | 520-600 |
| Aloo paratha (2) with chole and curd | 450-550 g | 700-820 |
| Regular pizza, 7 inch, whole | 350-450 g | 800-1000 |
| Medium pizza, 10 inch, whole | 550-700 g | 1400-1800 |
| Veg burger, single patty | 180-220 g | 400-480 |
| Fried rice or noodles with a gravy side | 550-700 g | 750-900 |
| Idli, 2 pieces with sambar | 200-250 g | 150-200 |
| Samosa, 1 piece | 90-110 g | 250-290 |

If your estimate for a comparable dish falls far outside the neighbouring row, you have the portion wrong, not the density.

## Density sanity

Home-style Indian restaurant food lands at 110-180 kcal/100g. Above 250 means something deep fried, heavily cheesed or dry. Above 400 is a packaged snack, chocolate or oil, not a meal. If your kcal divided by your portion_g times 100 is outside 90-450 for a cooked dish, one of the two numbers is wrong.

## Read the name literally

- Every ingredient named is present. "Cheese Burst", "Ghee Roast", "Desi Ghee", "Extra Cheese", "Loaded" and "Butter" each add real fat — typically 100-200 kcal over the plain version.
- A combo contains everything it names. "Corn & Cheese Burger + Veg Pizza McPuff" is both items. "Meal" or "Combo" usually implies fries and a drink unless the name says otherwise.
- "Zero", "Diet", "Sugar Free" and "Unsweetened" mean approximately zero calories. A regular 300 ml soft drink is ~130; a 500 ml one ~210. Getting this backwards is the single most common error, so check it explicitly.
- A number followed by pc/pcs is a count, not a size: "Idli (2pc)" is two idlis.
- A weight or volume in the name is the portion. Use it directly rather than assuming one.
- Ignore packaging, delivery and platform fees. They are not food.

## Be honest about uncertainty

- confidence 0.85 — a standard dish you know well, with the size stated or obvious.
- confidence 0.7 — the dish is clear but the portion is not, or the name is a restaurant's own invention you are inferring from its parts.
- confidence below 0.6 — you are guessing what the dish even is. Guess anyway, but say so; the log shows low-confidence rows differently and a human corrects them.

Do not inflate confidence to seem useful. A 0.55 that is honest is more useful than a 0.85 that is not.

## Not food

Quick-commerce baskets arrive mixed in: electronics, toiletries, medicine, stationery, cleaning supplies. Set is_food false and leave every number null. Do not price them.

## Fields

- kcal, protein_g, carbs_g, fat_g: per serving as sold.
- Macros must be consistent with kcal: protein and carbs ~4 kcal/g, fat ~9 kcal/g. Your macros will be checked against your calories and the row rejected if they disagree by more than a third.
- category: one of thali, north_indian, south_indian, chinese, pizza, burger, sandwich, pasta, instant, street, dessert, packaged_snack, sugary_drink, zero_drink, coffee, grocery, condiment, fried, other.
- note: one short clause naming what you assumed the dish contains and at what size — "2 roti, dal, sabzi, rice, curd, ~500g". This is what a human reads when a number looks wrong.`;


const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'nutrition_estimates',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['index', 'is_food', 'kcal', 'protein_g', 'carbs_g', 'fat_g',
                       'portion_g', 'category', 'confidence', 'note'],
            properties: {
              index:      { type: 'integer', description: 'The dish number this refers to.' },
              is_food:    { type: 'boolean' },
              kcal:       { type: ['number', 'null'], description: 'Per serving as sold.' },
              protein_g:  { type: ['number', 'null'] },
              carbs_g:    { type: ['number', 'null'] },
              fat_g:      { type: ['number', 'null'] },
              portion_g:  { type: ['number', 'null'], description: 'Assumed mass of one serving, grams.' },
              category:   { type: ['string', 'null'] },
              confidence: { type: ['number', 'null'] },
              note:       { type: 'string', description: 'One short clause: what you assumed the dish contains.' },
            },
          },
        },
      },
    },
  },
};

/** kcal implied by the macros, for the consistency check below. */
const impliedKcal = (r) =>
  (Number(r.protein_g) || 0) * 4 + (Number(r.carbs_g) || 0) * 4 + (Number(r.fat_g) || 0) * 9;

/**
 * Sanity gate on one returned row.
 *
 * The model is good at this and still occasionally returns a per-100g figure
 * for a whole thali, or macros that do not add up to the calories beside them.
 * Both are cheap to catch here and expensive to notice later in a yearly total.
 */
function validate(row, name) {
  if (row.is_food === false) return { ok: false, reason: 'model says not food' };

  const kcal = Number(row.kcal);
  // Zero is a legitimate answer, not a missing one. Coke Zero, black coffee and
  // sugar-free soda are exactly the items this feature must get right, and an
  // earlier version of this check rejected all of them as "no kcal" — which
  // sent them to the unresolved pile, where they read as unknown rather than
  // as the nothing they actually are.
  if (!Number.isFinite(kcal) || kcal < 0) return { ok: false, reason: 'no kcal' };
  if (kcal > 4000) return { ok: false, reason: `${kcal} kcal for one serving is not credible` };

  const portion = Number(row.portion_g);
  if (!Number.isFinite(portion) || portion <= 0) return { ok: false, reason: 'no portion_g' };

  if (kcal > 0) {
    // Energy density has to be physically possible. Pure fat is 900 kcal/100g;
    // anything above ~700 means the portion and the calories disagree.
    const density = (kcal / portion) * 100;
    if (density > 700) return { ok: false, reason: `${Math.round(density)} kcal/100g exceeds what food can be` };

    // Macros and calories must tell the same story, within a wide tolerance —
    // rounding and fibre make exact agreement unrealistic.
    const implied = impliedKcal(row);
    if (implied > 0 && Math.abs(implied - kcal) / kcal > 0.35) {
      return { ok: false, reason: `macros imply ${Math.round(implied)} kcal but kcal says ${Math.round(kcal)}` };
    }
  } else if (impliedKcal(row) > 25) {
    // The mirror of the above: macros that add up to real food beside a zero.
    return { ok: false, reason: `zero kcal but macros imply ${Math.round(impliedKcal(row))}` };
  }

  return { ok: true };
}

/**
 * Estimate a batch of dish names.
 *
 * Returns { ok, rows: Map<displayName, row>, rejected: [], usage }. Never
 * throws: a model outage should leave the dictionary short a few rows, not end
 * the run — the same contract the extraction ladder keeps.
 */
export async function estimateBatch(names) {
  if (!names.length) return { ok: true, rows: new Map(), rejected: [], usage: null };

  const listing = names.map((n, i) => `${i + 1}. ${n}`).join('\n');

  // Ground the batch in measured recipes. For each name, the closest rows from
  // the Anuvaad INDB (vegetarian subset) ride along as anchors, so "Cheese
  // Masala Dosa" is estimated as INDB's measured masala dosa plus cheese, not
  // from memory. Deduplicated across the batch — thirty dosas need one anchor.
  const seen = new Set();
  const references = [];
  for (const n of names) {
    for (const f of retrieveINDB(n, 2)) {
      if (seen.has(f.code)) continue;
      seen.add(f.code);
      references.push(referenceLine(f));
    }
  }
  const grounding = references.length
    ? `\n\nMeasured reference recipes (Indian Nutrient Databank, per standard home serving). `
      + `Anchor to these where a dish matches or is a variant; restaurant versions of the same dish `
      + `typically run 10-30% richer in fat:\n${references.map(r => `- ${r}`).join('\n')}`
    : '';

  const result = await chat({
    job: 'nutrition',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Estimate one serving as sold for each dish:\n\n${listing}${grounding}` },
    ],
    responseFormat: SCHEMA,
  });

  if (!result.ok) return { ok: false, error: result.error, rows: new Map(), rejected: [], usage: result.usage };

  let parsed;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return { ok: false, error: 'model returned unparseable JSON', rows: new Map(), rejected: [], usage: result.usage };
  }

  const rows = new Map();
  const rejected = [];

  for (const r of parsed.results || []) {
    const name = names[Number(r.index) - 1];
    if (!name) continue;

    const verdict = validate(r, name);
    if (!verdict.ok) {
      rejected.push({ name, reason: verdict.reason });
      continue;
    }

    rows.set(name, {
      kcal: Math.round(Number(r.kcal) * 10) / 10,
      protein_g: Number.isFinite(Number(r.protein_g)) ? Math.round(Number(r.protein_g) * 10) / 10 : null,
      carbs_g: Number.isFinite(Number(r.carbs_g)) ? Math.round(Number(r.carbs_g) * 10) / 10 : null,
      fat_g: Number.isFinite(Number(r.fat_g)) ? Math.round(Number(r.fat_g) * 10) / 10 : null,
      portion_g: Math.round(Number(r.portion_g) * 10) / 10,
      category: r.category || null,
      source: 'llm',
      // The model's own confidence, floored — it is one opinion, and the ladder
      // ranks it below a label or a checked row no matter how sure it sounds.
      confidence: Math.min(Number(r.confidence) || 0.7, 0.85),
      source_ref: { model: true, note: String(r.note || '').slice(0, 300) },
    });
  }

  return { ok: true, rows, rejected, usage: result.usage };
}
