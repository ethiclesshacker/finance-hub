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
const BARE_AMOUNT_RE = /(?:^|[\s,(])(\d{2,7}(?:\.\d{1,2})?)(?!\s*(?:k\b|km|kg|mins?|hrs?|am|pm|%|:|\/|-|st|nd|rd|th))\b/gi;

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
