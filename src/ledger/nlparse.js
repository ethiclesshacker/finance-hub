// ======================================================
// "Had lunch at Third Wave around 1pm, ₹320" → a structured event.
//
// Deterministic and offline, which matters for two reasons: the quick-add box
// can show a live preview as you type, and adding an event never depends on a
// model being reachable. The UI shows what it understood before saving, so a
// wrong guess is corrected in the same keystroke rather than discovered later.
//
// Events created this way are `confirmed` with a null confidence — a person
// stating what they did is a fact, not an extraction. Where the parser *did*
// guess (an unstated mealtime), the guess is recorded in `inference`, never in
// `data`.
// ======================================================

import { canonicalMerchant, entityRef, localDateISO, parseDateParts,
         parseTimeParts, pickTotalAmount, zonedISO } from './normalize.js';
import { deriveDedupeKey, matchKeys } from './dedupe.js';
import { dishName, summariseItems } from './items.js';

const MEALS = {
  breakfast: { hour: 8,  minute: 30, meal: 'breakfast' },
  brunch:    { hour: 11, minute: 0,  meal: 'brunch' },
  lunch:     { hour: 13, minute: 0,  meal: 'lunch' },
  dinner:    { hour: 20, minute: 0,  meal: 'dinner' },
  supper:    { hour: 20, minute: 30, meal: 'dinner' },
  snack:     { hour: 17, minute: 0,  meal: 'snack' },
  coffee:    { hour: 16, minute: 30, meal: 'beverage' },
  drinks:    { hour: 20, minute: 0,  meal: 'beverage' },
};

// Verb → what kind of event it describes. First match wins, so the more
// specific patterns come first.
const INTENTS = [
  { re: /\b(had|ate|eating|grabbed|dined)\b/i,                       type: 'food',          subtype: 'meal' },
  { re: /\b(ordered\s+(?:in|food)|takeaway|delivery from)\b/i,        type: 'food',          subtype: 'food_delivery' },
  { re: /\b(bought|purchased|ordered|paid for|picked up)\b/i,         type: 'purchase',      subtype: null },
  { re: /\b(flew|flight|boarded)\b/i,                                 type: 'travel',        subtype: 'flight' },
  { re: /\b(train|railway)\b/i,                                       type: 'travel',        subtype: 'train' },
  { re: /\b(cab|uber|ola|taxi|auto|rode)\b/i,                         type: 'travel',        subtype: 'cab' },
  { re: /\b(drove|drive|road trip|travelled|traveled|trip to)\b/i,    type: 'travel',        subtype: 'trip' },
  { re: /\b(checked into|stayed at|hotel)\b/i,                        type: 'travel',        subtype: 'hotel' },
  { re: /\b(met|meeting|call with|spoke to|catch ?up)\b/i,            type: 'meeting',       subtype: null },
  { re: /\b(visited|went to|dropped by|stopped at)\b/i,               type: 'activity',      subtype: null },
  { re: /\b(worked on|shipped|finished|reviewed|presented)\b/i,       type: 'work',          subtype: 'project_activity' },
  { re: /\b(ran|run|gym|workout|walked|cycled|swim)\b/i,              type: 'health',        subtype: 'workout' },
  { re: /\b(watched|movie|concert|show|read)\b/i,                     type: 'entertainment', subtype: null },
  { re: /\b(doctor|dentist|appointment|clinic)\b/i,                   type: 'appointment',   subtype: null },
];

const FILLER = /\b(around|about|at|approx\.?|approximately|roughly|near|circa)\b/gi;

// A time of day named in words. Weaker than an explicit clock time, stronger
// than the midday fallback.
const DAYPARTS = [
  { re: /\b(last night|tonight|this evening)\b/i, hour: 20, minute: 0, label: 'evening' },
  { re: /\b(this morning|in the morning)\b/i,     hour: 9,  minute: 0, label: 'morning' },
  { re: /\b(this afternoon|afternoon)\b/i,        hour: 15, minute: 0, label: 'afternoon' },
  { re: /\b(midnight)\b/i,                        hour: 0,  minute: 0, label: 'midnight' },
  { re: /\b(noon)\b/i,                            hour: 12, minute: 0, label: 'noon' },
];

// Quick-add is typed by a person who knows what the number means, so a bare
// trailing number is money — the one place in the pipeline where that guess is
// safe. Units and clock times are excluded, and the assumption is recorded.
// A bare number is rupees — unless a unit follows it. "Coke Zero 250 mL" is a
// can, not a ₹250 dinner, and "2 pieces" is a count. The lookahead lists the
// units that turn up in what people eat and drink.
const BARE_AMOUNT_RE = /(?:^|[\s,(])(\d{2,7}(?:\.\d{1,2})?)(?!\s*(?:k\b|km|kg|kgs|mins?|hrs?|am|pm|%|:|\/|-|st|nd|rd|th|ml|mls|l\b|ltr|litres?|liters?|g\b|gm|gms|grams?|mg|kcal|cal\b|cals|pcs?\b|pieces?|slices?|packets?|packs?|cups?|glass|glasses|bowls?|plates?|nos?\b|x\b))\b/gi;

function bareAmount(text) {
  let last = null, m;
  const re = new RegExp(BARE_AMOUNT_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const value = parseFloat(m[1]);
    if (Number.isFinite(value) && value >= 20 && value < 10_000_000) last = value;
  }
  return last;
}

/**
 * Parse one line of natural language into a draft event.
 *
 * Returns { event, parsed } where `parsed` explains what was recognised, so
 * the UI can show "food · Third Wave Coffee · 13:00 · ₹320" rather than a
 * silent guess.
 */
export function parseQuickEntry(input, { now = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  const text = String(input || '').trim();
  if (!text) return null;

  let money = pickTotalAmount(text);
  let assumedCurrency = false;
  if (!money) {
    const bare = bareAmount(text);
    if (bare !== null) { money = { amount: bare, currency: 'INR' }; assumedCurrency = true; }
  }
  const explicitTime = parseTimeParts(text);
  const daypart = DAYPARTS.find(d => d.re.test(text)) || null;
  const explicitDate = parseDateParts(text);
  const dayOffset = relativeDayOffset(text);

  // Which kind of thing is this?
  let intent = INTENTS.find(i => i.re.test(text)) || null;

  // A meal word both classifies the event and supplies a default time.
  let meal = null;
  for (const [word, spec] of Object.entries(MEALS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) { meal = spec; break; }
  }
  if (meal && (!intent || intent.type === 'food' || intent.type === 'activity')) {
    intent = { type: 'food', subtype: meal.meal === 'beverage' ? 'beverage' : 'meal' };
  }
  if (!intent) intent = { type: 'note', subtype: 'observation' };

  const place = extractPlace(text);
  const people = extractPeople(text);
  const fallbackEntityType = intent.type === 'food' ? 'restaurant'
                           : intent.type === 'purchase' ? 'merchant'
                           : 'place';
  const canonical = place ? canonicalMerchant(place, fallbackEntityType) : null;

  // Date: an explicit date wins, then a relative word, then today.
  const base = explicitDate || shiftLocalDate(now, dayOffset ?? 0, timeZone);
  const time = explicitTime
    || (meal ? { hour: meal.hour, minute: meal.minute } : null)
    || (daypart ? { hour: daypart.hour, minute: daypart.minute } : null)
    || { hour: 12, minute: 0 };
  const occurredAt = zonedISO({ ...base, ...time }, timeZone);

  const data = {};
  if (canonical) {
    if (intent.type === 'food') data.restaurant = canonical.name;
    else if (intent.type === 'travel' || intent.type === 'meeting' || intent.type === 'activity') data.place = canonical.name;
    else data.merchant = canonical.name;
  }
  if (money) { data.amount = money.amount; data.currency = money.currency; }
  if (meal && intent.type === 'food') data.meal_type = meal.meal;

  const inference = {};
  if (!explicitTime) {
    inference.assumed_time = meal ? `${meal.meal} default`
                           : daypart ? `${daypart.label} default`
                           : 'midday default';
  }
  if (!explicitDate && dayOffset === null) inference.assumed_date = 'today';
  if (assumedCurrency) inference.assumed_currency = 'INR';

  const extraction = {
    type: intent.type,
    subtype: intent.subtype,
    title: buildTitle({ text, canonical, money, intent }),
    description: text,
    occurred_at: occurredAt,
    status: 'confirmed',
    confidence: null,          // stated by a person; not an extraction
    data,
    inference,
    entities: [
      canonical ? entityRef(canonical.type, canonical.name,
                            intent.type === 'food' ? 'restaurant'
                          : intent.type === 'purchase' ? 'merchant' : 'place') : null,
      ...people.map(p => entityRef('person', p, 'person')),
    ].filter(Boolean),
    extracted_by: 'nlparse',
  };

  return {
    event: { ...extraction, dedupe_key: deriveDedupeKey(extraction), match: matchKeys(extraction) },
    parsed: {
      type: intent.type,
      subtype: intent.subtype,
      place: canonical?.name || null,
      amount: money?.amount ?? null,
      currency: money?.currency ?? null,
      people,
      occurred_at: occurredAt,
      assumed: Object.keys(inference),
    },
  };
}

/** "yesterday" → -1, "today"/"tonight" → 0, "tomorrow" → +1, else null. */
function relativeDayOffset(text) {
  if (/\b(day before yesterday)\b/i.test(text)) return -2;
  if (/\b(yesterday|last night)\b/i.test(text)) return -1;
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/i.test(text)) return 0;
  if (/\b(tomorrow)\b/i.test(text)) return 1;
  return null;
}

function shiftLocalDate(now, days, timeZone) {
  const [year, month, day] = localDateISO(now, timeZone).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * The place or merchant named after "at" / "from" / "to" / "in".
 * Stops at a comma, a price, a time or a trailing preposition — "at Third Wave
 * around 1pm, ₹320" yields "Third Wave", not the rest of the sentence.
 */
function extractPlace(text) {
  const m = text.match(/\b(?:at|from|to|in)\s+([^,.;₹$]{2,60})/i);
  if (!m) return null;

  let place = m[1]
    .replace(/\b(around|about|approx\.?|approximately|roughly)\b.*$/i, '')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)\b.*$/i, '')
    .replace(/\b(today|tonight|yesterday|tomorrow|last night|this (morning|afternoon|evening))\b.*$/i, '')
    .replace(/\b(for|with|and)\b.*$/i, '')
    .replace(/^\s*the\s+/i, '')
    // A dangling preposition means the phrase ran into a clause we cut off.
    .replace(/\s+\b(at|on|in|for|to|around|near|by)\s*$/i, '')
    .replace(/\s+\d[\d.,]*\s*$/, '')
    .trim();

  place = place.replace(/\s+/g, ' ');
  return place.length >= 2 ? place : null;
}

/**
 * Capitalised names following a "who" verb. Conservative on purpose: a wrong
 * person entity pollutes every "what did I do with X" answer afterwards, and
 * the user can always add one in the detail view.
 */
function extractPeople(text) {
  const out = [];
  // The verb is matched in either case, the name only when capitalised — an
  // `i` flag on the whole pattern would make [A-Z] meaningless and turn every
  // word after "met" into a person.
  const re = /\b(?:[Mm]et|[Mm]eeting with|[Cc]all with|[Ss]poke (?:to|with)|[Cc]aught up with|[Ll]unch with|[Dd]inner with|[Cc]offee with|[Dd]rinks with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    if (!/^(The|A|An|My|Our|At|In|On)$/i.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function buildTitle({ canonical, money, intent }) {
  const symbol = money ? ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[money.currency] || '') : '';
  const amount = money ? `${symbol}${Math.round(money.amount).toLocaleString('en-IN')}` : null;
  const label = { food: 'Meal', purchase: 'Purchase', travel: 'Travel', meeting: 'Meeting',
                  work: 'Work', health: 'Activity', entertainment: 'Entertainment',
                  appointment: 'Appointment', activity: 'Activity', note: 'Note' }[intent.type] || 'Event';

  const who = canonical?.name;
  if (who && amount) return `${who} — ${amount}`;
  if (who) return `${label} at ${who}`;
  if (amount) return `${label} — ${amount}`;
  return label;
}

/** Strip the filler words the parser ignores — used by the preview. */
export function stripFiller(text) {
  return String(text).replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
}


// ======================================================
// Meals, specifically.
//
// parseQuickEntry above answers "what kind of event is this sentence". A meal
// asks a narrower question with a harder answer: *what*, in what quantity. The
// Food screen is built on `data.items`, so a meal typed at Hermes has to
// arrive in the same shape a receipt does, or it shows up as a nameless plate.
//
// Two sentences it has to get right, both of them real:
//
//   "going to Ravi's place for dinner"  → dinner tonight, at Ravi's place,
//                                         no dishes yet, and it has not
//                                         happened, so it is `scheduled`.
//   "making 2 packets maggi with 3 cheese slices"
//                                       → Maggi ×2, Cheese Slices ×3, now.
//
// Note what the second one demands: "packets" is a container and is dropped,
// while "slices" is part of what the thing is called and is kept. The rule
// that separates them is position — a unit sits between the number and the
// name, never after it.
// ======================================================

// Containers, not food. Only ever stripped when a name follows them.
const UNITS = /^(packets?|packs?|plates?|pieces?|pcs?|cups?|glass(?:es)?|bowls?|bottles?|boxe?s?|servings?|portions?|katoris?|scoops?|slices?\s+of|cans?|tins?)\s+/i;

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2,
};

// The verbs a meal sentence opens with, which say nothing about the food.
// Eating at home is a fact about the meal, not a restaurant to remember.
const AT_HOME = /^(home|my (?:place|house|flat|room)|the (?:house|flat)|here)$/i;

const PAST_TENSE = /\b(had|ate|made|cooked|ordered|got|grabbed|took|finished|was|were|went)\b/i;

const MEAL_VERBS = /^\s*(?:i(?:'m|\s+am)?\s+)?(?:going\s+to\s+(?:have|eat|make|order)|heading\s+(?:out\s+)?(?:for|to)|planning\s+to\s+(?:have|eat|make)|about\s+to\s+(?:have|eat|make)|will\s+(?:have|eat|make)|making|cooking|having|had|have|eating|ate|ordered|ordering|got|grabbed|grabbing|took|taking)\s+/i;

// Where the food ends and the circumstances begin.
const TRAILING_CLAUSE = /\s+\b(?:at|from|in|on|for|around|by|with\s+(?:ravi|friends?|family|them|him|her))\b[\s\S]*$/i;

const ITEM_SEPARATOR = /\s*(?:,|\band\b|\bwith\b|\bplus\b|\+|&)\s*/i;

// "lunch at home — rajma chawal": everything left of the dash is when and
// where, everything right of it is what. People write meals this way, and it
// is the one punctuation mark that reliably means "here comes the food".
const OCCASION_SPLIT = /\s+[—–]\s+|\s+-\s+|:\s+/;

// Words that survive the verb strip but name the occasion, not the food.
const NOT_A_DISH = /^(breakfast|brunch|lunch|dinner|supper|snacks?|meal|food|something|anything|it|lots|some|takeaway|delivery|order)$/i;

/**
 * "2 packets maggi with 3 cheese slices" → [{name: 'Maggi', qty: 2}, …]
 *
 * Only quantified phrases become items. A sentence that names no number names
 * no basket — "dinner at Kapoor's" is a meal whose dishes are not yet known,
 * and inventing "Dinner" as a dish would put a word you never ate into the
 * ranking of what you eat most.
 */
export function parseMealItems(input, { declared: forced = false } = {}) {
  const raw = String(input || '');
  // "making maggi" names a dish without counting it, and only the opening verb
  // tells us that the rest of the sentence is food at all. Without one, a bare
  // phrase is a circumstance ("going to Ravi's place"), so a number is what
  // makes it an item.
  const declared = forced || MEAL_VERBS.test(raw);
  let text = raw
    .replace(MEAL_VERBS, '')
    .replace(TRAILING_CLAUSE, '')
    // A trailing price is money, not a quantity.
    .replace(/(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d{1,2})?/gi, '')
    .replace(/\s+\d{2,7}(?:\.\d{1,2})?\s*$/, '')
    .trim();
  if (!text) return [];

  const items = [];
  for (const chunk of text.split(ITEM_SEPARATOR)) {
    const piece = chunk
      .replace(/^\s*(?:some|a\s+few)\s+/i, '')
      // "with a 3 cheese slices" — the article is filler in front of a number,
      // and read as the quantity it turns the 3 into part of the dish's name.
      .replace(/^\s*(?:a|an)\s+(?=\d)/i, '')
      .trim();
    if (!piece) continue;

    const m = piece.match(/^(\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple(?:\s+of)?)\s+(.+)$/i);
    if (!m && !declared) continue;

    let qty = 1;
    if (m) {
      const word = m[1].toLowerCase().replace(/\s+of$/, '');
      qty = /^\d+$/.test(word) ? Number(word) : WORD_NUMBERS[word];
      if (!Number.isFinite(qty) || qty < 1 || qty > 20) continue;
    }

    const name = dishName((m ? m[2] : piece).replace(UNITS, '').replace(/[.!?]+$/, '').trim());
    // "had dinner at Kapoor's" leaves "dinner" behind, which is when the meal
    // was, not a thing on the plate.
    if (name && !NOT_A_DISH.test(name)) items.push({ name, qty });
  }
  return items;
}

/**
 * One line about food → a `food` event carrying its dishes.
 *
 * The status is decided by the clock, not by the grammar: a meal whose time
 * has not arrived yet is `scheduled` — "going to Ravi's for dinner" is a plan,
 * and the ledger already distinguishes a plan from a thing that happened. It
 * becomes an ordinary meal the moment you add what you actually ate.
 */
export function parseMealEntry(input, { now = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  const text = String(input || '').trim();
  if (!text) return null;

  const explicitTime = parseTimeParts(text);
  const explicitDate = parseDateParts(text);
  const dayOffset = relativeDayOffset(text);
  const daypart = DAYPARTS.find(d => d.re.test(text)) || null;

  let meal = null;
  for (const [word, spec] of Object.entries(MEALS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) { meal = spec; break; }
  }

  const base = explicitDate || shiftLocalDate(now, dayOffset ?? 0, timeZone);
  const time = explicitTime
    || (meal ? { hour: meal.hour, minute: meal.minute } : null)
    || (daypart ? { hour: daypart.hour, minute: daypart.minute } : null)
    || localClock(now, timeZone);
  const occurredAt = zonedISO({ ...base, ...time }, timeZone);

  // Split the occasion from the food before reading either, so "at home" can
  // never swallow the dish that follows it.
  const [occasion, ...rest] = text.split(OCCASION_SPLIT);
  const foodText = rest.join(' ').trim();

  const place = extractPlace(occasion);
  const canonical = place && !AT_HOME.test(place) ? canonicalMerchant(place, 'restaurant') : null;
  const items = foodText
    ? parseMealItems(foodText, { declared: true })
    : parseMealItems(text);

  let money = pickTotalAmount(text);
  if (!money) {
    const bare = bareAmount(text);
    if (bare !== null) money = { amount: bare, currency: 'INR' };
  }

  const inference = {};
  if (!explicitTime) {
    inference.assumed_time = meal ? `${meal.meal} default`
                           : daypart ? `${daypart.label} default`
                           : 'now';
  }
  if (!explicitDate && dayOffset === null) inference.assumed_date = 'today';

  // Not yet eaten. The Food screen still shows it, so the plan is visible and
  // the dishes can be filled in when there are dishes to fill in.
  //
  // Except when the sentence is in the past: "had dinner at Kapoor's", typed
  // over breakfast, is last night's dinner and not tonight's — the meal's
  // default hour is ahead of the clock, and scheduling it would put a meal you
  // have already eaten in the future.
  const past = PAST_TENSE.test(text);
  let occurred = occurredAt;
  if (past && new Date(occurred).getTime() > now.getTime() && !explicitDate && dayOffset === null) {
    occurred = zonedISO({ ...shiftLocalDate(now, -1, timeZone), ...time }, timeZone);
    inference.assumed_date = 'yesterday, from the past tense';
  }
  const scheduled = !past && new Date(occurred).getTime() > now.getTime() + 60_000;

  const data = {};
  if (canonical) data.restaurant = canonical.name;
  if (items.length) data.items = items;
  if (money) { data.amount = money.amount; data.currency = money.currency; }
  if (meal) data.meal_type = meal.meal;

  const extraction = {
    type: 'food',
    subtype: meal?.meal === 'beverage' ? 'beverage' : 'meal',
    title: canonical?.name || summariseItems(items, 3) || (meal ? capitalise(meal.meal) : 'Meal'),
    description: text,
    occurred_at: occurred,
    status: scheduled ? 'scheduled' : 'confirmed',
    confidence: null,          // stated by a person; not an extraction
    data,
    inference,
    entities: canonical ? [entityRef(canonical.type, canonical.name, 'restaurant')].filter(Boolean) : [],
    extracted_by: 'nlparse:meal',
  };

  return {
    event: { ...extraction, dedupe_key: deriveDedupeKey(extraction), match: matchKeys(extraction) },
    parsed: {
      place: canonical?.name || null,
      items,
      meal: meal?.meal || null,
      occurred_at: occurred,
      status: extraction.status,
      amount: money?.amount ?? null,
      assumed: Object.keys(inference),
    },
  };
}

/** The wall clock where the user is, so "now" means now to them. */
function localClock(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(now).map(p => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

function capitalise(word) {
  return String(word).charAt(0).toUpperCase() + String(word).slice(1);
}
