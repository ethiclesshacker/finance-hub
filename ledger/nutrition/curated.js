// ======================================================
// Rung 1 — the curated table.
//
// Deliberately small, and it is worth saying why, because the obvious mistake
// here is to make it large.
//
// This table is not "dishes we have estimates for" — it is "cases where a
// model reliably gets it wrong and the right answer is not a judgement call".
// There are three such cases, and they are all traps of the same shape: the
// name reads like a food whose calories are obvious, and the obvious answer is
// off by a factor.
//
//   zero-calorie drinks   "Coke Zero" and "Diet Coke" pattern-match to "Coke"
//                         and pick up 200 kcal that is not there
//   raw produce           "Onion" is 40 kcal/100g raw and 289 dried; every
//                         database and most models reach for the dried number
//   sachet condiments     a ketchup sachet is 20g, not the 100g a per-100g
//                         source implicitly assumes
//
// Everything else — every thali, dosa, pizza and combo — goes to the model,
// which is better at composed dishes than any table someone writes in one
// sitting. Filling this table with estimated rows would be worse than useless:
// `curated` outranks `llm` in food_source_rank(), so a guess written here
// would permanently shadow a better answer while carrying a provenance that
// implies a human checked it. Nothing goes in this file that was not looked up.
//
// The way to improve accuracy on the dishes you eat most is not to grow this
// table. It is to run the resolver, then correct the handful of rows that
// matter with `setManual()`, which writes source 'manual' and verified = true —
// an honest record that a person checked those specific numbers.
//
// Values are per serving as sold, and `g` is the assumed mass of that serving.
// ======================================================

/** @type {Array<{ re: RegExp, kcal: number, protein_g: number, carbs_g: number, fat_g: number, g: number, category: string }>} */
export const CURATED = [
  // ── Zero-calorie drinks. Definitional, not estimated: these are formulated
  //    to have no sugar, and the trap is that the name contains "Coke".
  { re: /coke zero|diet coke|coca cola zero|pepsi black/i, kcal: 1,  protein_g: 0, carbs_g: 0,  fat_g: 0, g: 300, category: 'zero_drink' },
  { re: /fresh lime soda|lime mint juice|jeera masala soda/i, kcal: 40, protein_g: 0, carbs_g: 10, fat_g: 0, g: 300, category: 'zero_drink' },

  // ── Raw produce sold as a side. USDA's top "ONION" row is 289 kcal/100g —
  //    a dried product. The raw onion that comes with a pizza is ~40.
  { re: /^onions?$/i,                    kcal: 20, protein_g: 1, carbs_g: 5, fat_g: 0, g: 50, category: 'condiment' },

  // ── Sachet condiments. The value is small; the error from assuming 100g is
  //    not, and these appear on 30+ orders.
  { re: /^tomato ketchup$/i,             kcal: 25, protein_g: 0, carbs_g: 6, fat_g: 0,  g: 20, category: 'condiment' },
  { re: /^cheesy dip$/i,                 kcal: 120, protein_g: 1, carbs_g: 4, fat_g: 11, g: 25, category: 'condiment' },
  { re: /^piri piri spice mix$/i,        kcal: 15, protein_g: 0, carbs_g: 3, fat_g: 0,  g: 5,  category: 'condiment' },
];

/** First matching curated row for a raw item name, or null. */
export function curatedLookup(name) {
  if (!name) return null;
  for (const row of CURATED) {
    if (row.re.test(name)) {
      const { re, g, ...rest } = row;
      return { ...rest, portion_g: g };
    }
  }
  return null;
}

// ── Things that are not food ──────────────────────────
//
// Quick-commerce orders (Zepto, Blinkit, Instamart) land under type 'food'
// because that is what the merchant is, and they carry whatever else was in
// the basket. Measured on this ledger: 10 of 433 line items. Resolving them
// would put a USB hub's "calories" in a daily total.
//
// This is a stopgap at the read layer. The real fix is upstream, in how
// quick-commerce baskets are classified at ingestion.
export const NON_FOOD = new RegExp([
  'usb hub', 'led string light', 'wireless microphone', 'longbook', 'notebook',
  'germ protection wipes', 'condom', 'lubricant', 'softgel', 'vitamin',
  'nurokind', 'd rise', 'string light', 'adapter', 'multiport',
].join('|'), 'i');

export const isNonFood = (name) => NON_FOOD.test(String(name || ''));

// ── Packaged goods ────────────────────────────────────
//
// The one place a structured database genuinely beats a model: a branded
// product with a barcode has a real label behind it. Measured on this ledger,
// 31 of 146 distinct names look like this. Everything else is a composed
// restaurant dish that Open Food Facts has never heard of.
//
// A misroute here is cheap in one direction and expensive in the other. Sending
// a restaurant dish to the databases costs one rejected lookup before it falls
// through to the model — harmless. But sending a *freshly made* item that
// shares a brand name with a packaged one is how "Kitkat Waffle" gets priced as
// a chocolate bar, which the gate cannot catch because the label match is
// genuine. Hence FRESH: it names the forms that are always made to order, and
// it wins over any brand match.
export const PACKAGED = new RegExp([
  "lay's", 'lays', 'snackible', 'britannia', 'amul', 'sunfeast', 'bikaji',
  'heka bites', "kwality wall", 'baskin robbins', 'cadbury', 'parle',
  'hide & seek', 'knorr', 'maggi', 'coca cola', 'thums up', 'frooti',
  'diet coke', 'coke zero', 'superyou', 'kitkat', 'nestle', 'dairy milk',
  'madras mixture', 'bhujia', '\\d+\\s?(g|gm|gms|ml|gram)\\b',
].join('|'), 'i');

// Made to order, whatever brand the name borrows. A bento cake sold by weight
// is still a bakery item, not a barcode.
const FRESH = /waffle|bento|cheesecake|pancake|\bcake\b|sundae|thali|dosa|pizza|burger|sandwich|combo|meal\b/i;

export const looksPackaged = (name) => {
  const s = String(name || '');
  return !FRESH.test(s) && PACKAGED.test(s);
};
