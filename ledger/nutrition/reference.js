// ======================================================
// Rung 0.5 — the reference engine.
//
// Before a name is looked up or estimated, ask whether the dictionary already
// knows this dish under a different spelling. A year of receipts writes the
// same plate several ways:
//
//   "Idli (2pc)"          /  "Idly (2pc)"
//   "Crispy Veg Burger"   /  "Crispy Veg Burger."
//   "Onion Uttapam"       /  "Onion Uthappam"
//
// Re-estimating those is worse than wasteful. Two rows for one plate will
// disagree by a hundred calories, and the disagreement then shows up as noise
// in a daily total that has no real cause.
//
// The hard part is knowing when NOT to reuse. Trigram similarity is blind to
// meaning, and the pairs it gets wrong are exactly the pairs that matter:
//
//   "Paneer Butter Masala Mini Thali" / "Paneer Butter Masala Thali"   0.88  — same dish, different size
//   "Veg Fried Rice"                  / "Egg Fried Rice"               0.79  — different food
//   "Coke Zero 300ml"                 / "Coca Cola 300ml"              0.71  — 200 kcal apart
//   "Cheese Masala Dosa"              / "Masala Dosa"                  0.72  — the cheese is 140 kcal
//
// A score cannot separate those, so this module does not try. It reuses a row
// only when the two names differ by nothing that could change what is on the
// plate: the leftover tokens must all be noise (punctuation, "pcs", "regular"),
// and never a MODIFIER — a word that adds cheese, ghee, paneer, meat, a size,
// or removes the sugar. One modifier on one side and not the other, and the
// name goes to the model, which is cheap and knows the difference.
// ======================================================

import { db } from '../db.js';
import { normalizeName } from '../../src/ledger/normalize.js';

/**
 * Words that change the food rather than describe it.
 *
 * Grouped only for readability — the rule is the same for all of them: present
 * on one side and absent on the other means these are different dishes, no
 * matter how similar the strings look.
 */
const MODIFIERS = [
  // Ingredients that move the number a lot
  'cheese', 'cheesy', 'ghee', 'butter', 'paneer', 'egg', 'chicken', 'mutton',
  'fish', 'prawn', 'cream', 'malai', 'makhani', 'fried', 'roast', 'masala',
  'schezwan', 'peri', 'piri', 'tandoori', 'grilled', 'stuffed', 'loaded',
  // Sugar state — the Coke Zero trap
  'zero', 'diet', 'sugar', 'sugarfree', 'unsweetened',
  // Size, which changes the portion and therefore everything
  'mini', 'small', 'medium', 'large', 'regular', 'jumbo', 'half', 'full',
  'single', 'double', 'family', 'party',
  // Form
  'combo', 'meal', 'thali', 'bowl', 'wrap', 'roll', 'sandwich', 'burger',
  'pizza', 'shake', 'juice', 'soda',
];

// Tokens that carry no information about the food and may differ freely.
// Single characters are noise by construction — "Kapoor's" normalizes to
// "kapoor s", and that stray "s" must not count against the match.
const NOISE = new Set([
  'pc', 'pcs', 'piece', 'pieces', 'nos', 'no', 'qty', 'x', 'the', 'a', 'an',
  'and', 'with', 'in', 'of', 'plus', 'gm', 'gms', 'g', 'ml', 'gram', 'grams',
  'special', 'spl', 'new', 'fresh', 'hot', 'served',
]);

const tokenSet = (name) => new Set(String(normalizeName(name) || '').split(' ').filter(Boolean));

/** Levenshtein distance, capped at what we care about (small numbers). */
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Are these two tokens the same word, spelled differently?
 *
 * The tolerance scales with length, because a one-character difference means
 * something very different in a four-letter word than in a nine-letter one:
 * "idli"/"idly" is a transliteration, "veg"/"egg" is not. Short tokens get a
 * budget of one edit only if they are long enough for one edit to still leave
 * them recognisable.
 */
function sameWord(a, b) {
  if (a === b) return true;
  const len = Math.max(a.length, b.length);
  if (len < 4) return false;                       // "veg" vs "egg" must not pair
  const budget = Math.max(1, Math.floor(len / 4)); // uttapam/uthappam: 8 → 2
  return editDistance(a, b) <= budget;
}

/**
 * Pair off tokens that are the same word misspelled, and return what is left.
 *
 * Without this step a substitution can never read as a spelling difference: the
 * symmetric difference of {idli, 2pc} and {idly, 2pc} is {idli, idly}, two
 * tokens, which the "more than one unexplained word" rule then rejects. Pairing
 * collapses that to nothing, which is what it actually is.
 */
function unpaired(onlyA, onlyB) {
  const restB = [...onlyB];
  const restA = [];
  for (const a of onlyA) {
    const i = restB.findIndex((b) => sameWord(a, b));
    if (i === -1) restA.push(a);
    else restB.splice(i, 1);
  }
  return { restA, restB, paired: onlyA.length - restA.length };
}

/**
 * Is `candidate` safely the same dish as `query`?
 *
 * Returns { same, reason } — the reason is kept for the run log, because a
 * reference engine that silently reuses the wrong row is the failure nobody
 * notices until a yearly total is wrong.
 */
export function sameDish(query, candidate) {
  const q = tokenSet(query), c = tokenSet(candidate);

  // Symmetric difference: everything one side has and the other does not.
  const onlyQ = [...q].filter((t) => !c.has(t));
  const onlyC = [...c].filter((t) => !q.has(t));

  if (!onlyQ.length && !onlyC.length) return { same: true, reason: 'identical once normalized' };

  // A modifier is disqualifying wherever it appears, and it is checked BEFORE
  // spelling is paired off — otherwise "veg"/"egg" could be paired away as a
  // typo, which is exactly the mistake this module exists to avoid.
  const meaningfulOf = (list) => list.filter((t) =>
    t.length > 1 && !NOISE.has(t) && !/^\d+$/.test(t));
  const modifiers = [...meaningfulOf(onlyQ), ...meaningfulOf(onlyC)].filter((t) => MODIFIERS.includes(t));
  if (modifiers.length) {
    return { same: false, reason: `"${[...new Set(modifiers)].join('", "')}" changes the dish` };
  }

  // Now pair off the same word spelled two ways, so a substitution counts once
  // rather than twice.
  const { restA, restB, paired } = unpaired(meaningfulOf(onlyQ), meaningfulOf(onlyC));
  const leftover = [...restA, ...restB];

  if (!leftover.length) {
    return paired
      ? { same: true, reason: `${paired} spelling difference${paired === 1 ? '' : 's'}` }
      : { same: true, reason: 'differs only by noise' };
  }

  // A leftover word that is neither noise, nor a known modifier, nor a
  // misspelling of something on the other side is still an unknown. Allow
  // exactly one; two is a different dish.
  if (leftover.length > 1) {
    return { same: false, reason: `${leftover.length} unexplained words (${leftover.join(', ')})` };
  }

  return { same: true, reason: `one extra word (${leftover[0]})` };
}

/**
 * Ask the dictionary whether it already knows this dish.
 *
 * `minSimilarity` is the trigram floor for even considering a row; sameDish()
 * is what actually decides. Two gates rather than one, because each catches
 * what the other cannot: the score rules out unrelated dishes cheaply, and the
 * token rule rules out the near-identical ones a score would wave through.
 */
export async function findReference(userId, displayName, { minSimilarity = 0.55, log } = {}) {
  const { data, error } = await db().rpc('food_match_item', {
    p_name: displayName,
    p_threshold: minSimilarity,
    p_limit: 5,
    p_user_id: userId,
  });
  if (error) throw new Error(`food_match_item(${displayName}) failed: ${error.message}`);

  const candidates = data || [];
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    // An exact normalized hit needs no judgement — it is the same key.
    if (candidate.exact) {
      return { row: candidate, similarity: 1, reason: 'exact match after normalization' };
    }
    const verdict = sameDish(displayName, candidate.display_name);
    if (verdict.same) {
      return { row: candidate, similarity: Number(candidate.similarity), reason: verdict.reason };
    }
    log?.(`      "${displayName}" ≉ "${candidate.display_name}" (${candidate.similarity}) — ${verdict.reason}`);
  }

  return null;
}

/**
 * What a reference contributes, as a row the ladder can write.
 *
 * The numbers are copied, the provenance is not: the new row records that it
 * was taken from another dish and which one, so a wrong reuse is traceable to
 * the pair that caused it rather than looking like an independent estimate that
 * happened to agree. Confidence is knocked down a step, because "the same as
 * something we estimated" is one inference further from the receipt.
 */
export function rowFromReference(reference) {
  const { row, similarity, reason } = reference;
  return {
    kcal: row.kcal,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
    portion_g: row.portion_g,
    category: row.category,
    // Not its own rung: the row inherits where its numbers actually came from,
    // so a value that began as a model estimate never gets promoted to looking
    // like a checked one just by being copied.
    source: row.source === 'manual' ? 'curated' : row.source,
    confidence: Math.max(0.5, Number(row.confidence || 0.7) - 0.05),
    source_ref: {
      referenced: row.display_name,
      similarity,
      reason,
      inherited_source: row.source,
      verified_origin: Boolean(row.verified),
    },
  };
}
