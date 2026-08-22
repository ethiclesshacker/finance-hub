// ======================================================
// Normalization — merchants, people, places, amounts, dates.
//
// Everything here is deterministic and pure. It runs in three places:
// the browser (quick-add preview), the ingestion jobs, and the tests.
//
// normalizeName() has a twin in SQL (public.ledger_normalize_name). They must
// agree, because one produces entities.normalized_name and the other is what
// ledger_find_duplicate matches against. Change one, change both.
// ======================================================

const CORPORATE_SUFFIX = /\s+(pvt|private|ltd|limited|inc|llc|india|technologies|services)\s*$/g;

/** Lowercase, strip accents and punctuation, drop trailing corporate noise. */
export function normalizeName(value) {
  if (value === null || value === undefined) return null;
  let s = String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

  let previous;
  do { previous = s; s = s.replace(CORPORATE_SUFFIX, ''); } while (s !== previous);

  s = s.trim();
  return s || null;
}

// Curated aliases for the senders that actually show up. Not an attempt at a
// merchant database — just enough that "AMAZON PAY INDIA", "Amazon.in" and
// "Amazon Seller Services" are one entity rather than three.
const ALIASES = [
  { match: ['amazon'],        name: 'Amazon',        type: 'merchant',   category: 'shopping' },
  { match: ['flipkart'],      name: 'Flipkart',      type: 'merchant',   category: 'shopping' },
  { match: ['myntra'],        name: 'Myntra',        type: 'merchant',   category: 'clothing' },
  { match: ['ajio'],          name: 'Ajio',          type: 'merchant',   category: 'clothing' },
  { match: ['swiggy',    'instamart'], name: 'Swiggy',   type: 'merchant', category: 'food_delivery' },
  // Zomato bills as Eternal Limited, which is what lands on card statements.
  { match: ['zomato', 'eternal'], name: 'Zomato', type: 'merchant', category: 'food_delivery' },
  { match: ['blinkit', 'blink commerce'], name: 'Blinkit', type: 'merchant', category: 'groceries' },
  { match: ['zepto'],         name: 'Zepto',         type: 'merchant',   category: 'groceries' },
  // Ownly is CTRLX Tech on statements and card alerts; one entity, not two.
  { match: ['ownly', 'ctrlx', 'ctrl x'], name: 'Ownly', type: 'merchant', category: 'food_delivery' },
  { match: ['bigbasket'],     name: 'BigBasket',     type: 'merchant',   category: 'groceries' },
  { match: ['dunzo'],         name: 'Dunzo',         type: 'merchant',   category: 'delivery' },
  { match: ['uber'],          name: 'Uber',          type: 'merchant',   category: 'transport' },
  { match: ['ola'],           name: 'Ola',           type: 'merchant',   category: 'transport' },
  { match: ['rapido'],        name: 'Rapido',        type: 'merchant',   category: 'transport' },
  { match: ['indigo', 'goindigo'], name: 'IndiGo',   type: 'company',    category: 'travel' },
  { match: ['air india'],     name: 'Air India',     type: 'company',    category: 'travel' },
  { match: ['vistara'],       name: 'Vistara',       type: 'company',    category: 'travel' },
  { match: ['akasa'],         name: 'Akasa Air',     type: 'company',    category: 'travel' },
  { match: ['irctc'],         name: 'IRCTC',         type: 'company',    category: 'travel' },
  { match: ['makemytrip'],    name: 'MakeMyTrip',    type: 'company',    category: 'travel' },
  { match: ['goibibo'],       name: 'Goibibo',       type: 'company',    category: 'travel' },
  { match: ['booking com'],   name: 'Booking.com',   type: 'company',    category: 'travel' },
  { match: ['airbnb'],        name: 'Airbnb',        type: 'company',    category: 'travel' },
  { match: ['oyo'],           name: 'OYO',           type: 'company',    category: 'travel' },
  { match: ['netflix'],       name: 'Netflix',       type: 'company',    category: 'entertainment' },
  { match: ['spotify'],       name: 'Spotify',       type: 'company',    category: 'entertainment' },
  { match: ['apple'],         name: 'Apple',         type: 'company',    category: 'technology' },
  { match: ['google'],        name: 'Google',        type: 'company',    category: 'technology' },
  { match: ['microsoft'],     name: 'Microsoft',     type: 'company',    category: 'technology' },
  { match: ['openai'],        name: 'OpenAI',        type: 'company',    category: 'technology' },
  { match: ['third wave'],    name: 'Third Wave Coffee', type: 'restaurant', category: 'cafe' },
  { match: ['starbucks'],     name: 'Starbucks',     type: 'restaurant', category: 'cafe' },
  { match: ['blue tokai'],    name: 'Blue Tokai',    type: 'restaurant', category: 'cafe' },
  { match: ['hsbc'],          name: 'HSBC',          type: 'company',    category: 'banking' },
  { match: ['hdfc'],          name: 'HDFC Bank',     type: 'company',    category: 'banking' },
  { match: ['icici'],         name: 'ICICI Bank',    type: 'company',    category: 'banking' },
  { match: ['axis bank'],     name: 'Axis Bank',     type: 'company',    category: 'banking' },
  { match: ['sbi', 'state bank'], name: 'State Bank of India', type: 'company', category: 'banking' },
];

/**
 * Payment rails, not merchants.
 *
 * A card alert saying "EASEBUZZ PRIVATE LIMITED" tells you how the money moved,
 * not what was bought. Recorded as a merchant it produces an entity you never
 * actually shopped at, and — worse — it asserts a *name* the deduplicator will
 * then use to reject a match with the real purchase.
 */
const PAYMENT_RAILS = [
  'razorpay', 'easebuzz', 'payu', 'cashfree', 'billdesk', 'ccavenue', 'instamojo',
  'juspay', 'pinelabs', 'phonepe', 'paytm', 'amazonpay', 'amazon pay', 'bharatpe',
  'gpay', 'google pay', 'upi', 'nach', 'neft', 'imps', 'rtgs',
];

export function isPaymentRail(name) {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  return PAYMENT_RAILS.some(rail => hasTokenRun(normalized, rail));
}

/**
 * Card and UPI descriptors are not merchant names.
 *
 * Acquirers prefix their own code — "CAS*ONPOINT", "RSP*DISTRICT DINING RZ" —
 * and append routing markers. Left in, each variant becomes its own entity, so
 * "what have I spent at District" answers only for whichever spelling won.
 */
export function stripCardDescriptor(raw) {
  if (!raw) return raw;
  return String(raw)
    .replace(/^[A-Za-z]{2,6}\*/, '')                              // CAS*, RSP*, RZP*, PAYU*
    .replace(/^(POS|UPI|NEFT|IMPS|ACH|ATW|MPS|ECOM|IB)[\s\-*\/]+/i, '')
    .replace(/[\s\-*]+(RZ|RZP|PAYU|PYTM|BBPS|IN|IND)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True when `alias` appears in `normalized` as a run of whole tokens. */
function hasTokenRun(normalized, alias) {
  const hay = normalized.split(' ');
  const needle = alias.split(' ');
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((tok, j) => hay[i + j] === tok)) return true;
  }
  return false;
}

/**
 * Resolve a raw merchant string to a canonical entity descriptor.
 * Unknown names pass through with a title-cased display form rather than being
 * dropped — an unrecognised merchant is still a merchant.
 */
export function canonicalMerchant(raw, fallbackType = 'merchant') {
  const cleaned = stripCardDescriptor(raw);
  const normalized = normalizeName(cleaned);
  if (!normalized) return null;

  // A UPI transfer to a phone number names a person, not a shop. Recording
  // "7308080808" as a merchant creates an entity that means nothing and can
  // never be recognised again.
  if (/^\d[\d ]{6,}$/.test(normalized)) return null;

  for (const alias of ALIASES) {
    for (const m of alias.match) {
      if (hasTokenRun(normalized, m)) {
        return { name: alias.name, normalized_name: normalizeName(alias.name),
                 type: alias.type, category: alias.category };
      }
    }
  }
  return { name: titleCase(String(cleaned).trim()), normalized_name: normalized,
           type: fallbackType, category: null };
}

function titleCase(s) {
  // Card descriptors shout. "ONPOINT" and "DISTRICT DINING" should read as
  // names, not as alarms — but short all-caps strings are usually acronyms
  // (IRCTC, OYO, HDFC), and "Irctc" would be worse than leaving them alone.
  const text = (s === s.toUpperCase() && s.replace(/[^A-Za-z]/g, '').length >= 6)
    ? s.toLowerCase()
    : s;

  return text.replace(/\s+/g, ' ')
             .replace(/\b[a-z]/g, c => c.toUpperCase())
             .slice(0, 200);
}

// ── Money ──────────────────────────────────────────────

const CURRENCY_SYMBOLS = { '₹': 'INR', 'rs': 'INR', 'rs.': 'INR', 'inr': 'INR',
                           '$': 'USD', 'usd': 'USD', '€': 'EUR', 'eur': 'EUR',
                           '£': 'GBP', 'gbp': 'GBP' };

// Symbol-before ("₹1,299.00", "Rs. 1299") and symbol-after ("1299 INR").
//
// The grouped alternative requires at least one comma. Written as
// `\d{1,3}(?:,\d{2,3})*` it also matches a bare "129", and since alternation
// takes the first branch that matches, "Rs.1299.00" was read as ₹129.
const NUMBER = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const AMOUNT_RE = new RegExp(
  String.raw`(₹|rs\.?|inr|usd|\$|eur|€|gbp|£)\s*(${NUMBER})` + '|' +
  String.raw`(${NUMBER})\s*(inr|usd|eur|gbp|rupees)`, 'gi');

/** Every currency amount in a string, with the offset it was found at. */
export function parseAmounts(text) {
  if (!text) return [];
  const out = [];
  const re = new RegExp(AMOUNT_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const symbol = (m[1] || m[4] || '').toLowerCase().trim();
    const digits = (m[2] || m[3] || '').replace(/,/g, '');
    const amount = parseFloat(digits);
    if (!Number.isFinite(amount)) continue;
    out.push({
      amount,
      currency: CURRENCY_SYMBOLS[symbol] || (symbol === 'rupees' ? 'INR' : 'INR'),
      index: m.index,
    });
  }
  return out;
}

// Words that tend to sit just before the number that actually matters.
const TOTAL_HINT = /(order\s+total|grand\s+total|total\s+amount|amount\s+paid|net\s+payable|bill\s+total|you\s+paid|amount\s+of|transaction\s+of|purchase\s+of|payment\s+of|refund\s+of|credits?\s+of|used\s+for|debited\s+(?:by|for|with)?|charged|spent|paid|total)/gi;

// Words that mean "this number is NOT what you spent".
//
// A card alert states the purchase, then the available limit, then the amount
// due. All three are rupee figures on one line, and the one you want is the
// smallest. Without this, an HSBC alert for a ₹140 coffee was recorded as
// ₹1,90,465 — the remaining credit limit — which inflated a month of spending
// by three orders of magnitude.
const NOT_AN_AMOUNT = /(available\s+(?:credit\s+)?limit|credit\s+limit|limit\s*[:.]|amount\s+due|total\s+due|due\s+amount|outstanding|balance|min(?:imum)?\s+due|reward\s+points?|points?\s+balance|cashback\s+earned|statement\s+balance|previous\s+balance|remaining\s+(?:payment|amount|balance)\s+of|make\s+the\s+(?:remaining\s+)?payment\s+of)/gi;

/**
 * The one amount worth recording. An order email lists item prices, delivery
 * charges, discounts and a total; picking the largest is wrong as often as it
 * is right, so prefer a number that follows a "total"-ish word and fall back to
 * the largest only when nothing is labelled.
 */
export function pickTotalAmount(text) {
  const amounts = parseAmounts(text);
  if (!amounts.length) return null;

  const spans = (pattern) => {
    const found = [];
    const re = new RegExp(pattern.source, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) found.push({ index: m.index, length: m[0].length });
    return found;
  };

  const hints = spans(TOTAL_HINT);
  const exclusions = spans(NOT_AN_AMOUNT);

  // Drop anything a disqualifying phrase introduces. Returning nothing is the
  // right answer when every figure on the page is a limit or a balance —
  // a wrong amount is far worse than a missing one, because it is silently
  // summed into your totals.
  const candidates = amounts.filter(a =>
    !exclusions.some(x => {
      const gap = a.index - (x.index + x.length);
      return gap >= 0 && gap <= 30;
    }));

  if (!candidates.length) return null;

  let best = null;
  for (const a of candidates) {
    let score = 0;
    for (const h of hints) {
      const gap = a.index - (h.index + h.length);
      if (gap >= 0 && gap <= 40) score = Math.max(score, 1 - gap / 40);
    }
    // Tie-break on position, not size. In a transactional email the operative
    // figure comes first and the incidental ones follow it; preferring the
    // largest is how a credit limit wins over a purchase.
    if (!best || score > best.score) best = { ...a, score };
  }
  return best ? { amount: best.amount, currency: best.currency } : null;
}

// ── Dates ──────────────────────────────────────────────

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };

/**
 * Parse the date formats that actually appear in transactional email:
 * 12-Aug-2025, 12 Aug 2025, Aug 12, 2025, 2025-08-12, 12/08/2025 (day-first —
 * these are Indian senders). Returns {year, month, day} or null; the caller
 * decides the timezone, because this module never guesses one.
 */
export function parseDateParts(text) {
  if (!text) return null;
  const s = String(text);

  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { year: +m[1], month: +m[2] - 1, day: +m[3] };

  m = s.match(/\b(\d{1,2})[\s\-\/]([a-z]{3,9})[\s\-\/,]+(\d{4})\b/i);
  if (m && MONTHS[m[2].slice(0, 4).toLowerCase()] !== undefined) {
    return { year: +m[3], month: MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()], day: +m[1] };
  }

  m = s.match(/\b([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    return { year: +m[3], month: MONTHS[m[1].slice(0, 3).toLowerCase()], day: +m[2] };
  }

  // Day-first, slash or dash separated. 12/08/2025 and 12-08-2025 are both
  // 12 August in every source this ingests. Checked after the ISO pattern, so
  // 2025-08-12 is never read this way.
  m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return { year, month: +m[2] - 1, day: +m[1] };
  }

  return null;
}

/** "13:45", "1:45 pm", "9pm" → {hour, minute}, or null. */
export function parseTimeParts(text) {
  if (!text) return null;
  const m = String(text).match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})(?::\d{2})?\b/i);
  if (!m) return null;

  if (m[3]) {
    let hour = +m[1] % 12;
    if (m[3].toLowerCase() === 'pm') hour += 12;
    return { hour, minute: m[2] ? +m[2] : 0 };
  }
  const hour = +m[4];
  if (hour > 23) return null;
  return { hour, minute: +m[5] };
}

/**
 * Build an ISO instant from date/time parts in a named IANA zone.
 *
 * Doing this without a date library means going through the zone twice: format
 * a guess in the target zone, measure how far off it landed, and correct. That
 * is exact for every offset, including the half-hour ones this app lives in.
 */
export function zonedISO({ year, month, day, hour = 0, minute = 0 }, timeZone = 'Asia/Kolkata') {
  const guess = Date.UTC(year, month, day, hour, minute, 0);
  const offset = zoneOffsetMs(guess, timeZone);
  const corrected = guess - offset;
  // A second pass catches a DST boundary falling between the two instants.
  const offset2 = zoneOffsetMs(corrected, timeZone);
  return new Date(guess - offset2).toISOString();
}

function zoneOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                         +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - utcMs;
}

/** The calendar date an instant falls on, in the user's zone. */
export function localDateISO(instant, timeZone = 'Asia/Kolkata') {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// ── Entity helpers ─────────────────────────────────────

/** Shape an entity for the `entities` array of an ingest payload. */
export function entityRef(type, name, relationship = 'related', metadata = {}) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return { type, name: String(name).trim().slice(0, 200), normalized_name: normalized, relationship, metadata };
}

/** Pull a display name and address out of "Amazon.in <auto@amazon.in>". */
export function parseAddress(raw) {
  if (!raw) return { name: null, address: null };
  const m = String(raw).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, address: m[2].trim().toLowerCase() };
  const bare = String(raw).trim();
  return bare.includes('@') ? { name: null, address: bare.toLowerCase() } : { name: bare, address: null };
}
