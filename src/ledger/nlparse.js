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
// guess (an unstated mealtime, which Wednesday), the guess is recorded in
// `inference`, never in `data`.
//
// The sentence is read in layers, each of which only sees what the previous
// ones left behind: money first, then the date and the clock, then the verb
// that says what kind of thing happened, then the place and the people around
// it. Reading the place last is what stops "from Akansha on Wednesday evening"
// being a shop.
// ======================================================

import { canonicalMerchant, entityRef, parseDateParts, parseTimeParts, pickTotalAmount } from './normalize.js';
import { DEFAULT_TIME_ZONE, localClock, localDateISO, shiftLocalDate, zonedISO } from './dates.js';
import { deriveDedupeKey, matchKeys } from './dedupe.js';
import { dishName, summariseItems } from './items.js';

const MEALS = {
  breakfast: { hour: 8,  minute: 30, meal: 'breakfast' },
  brunch:    { hour: 11, minute: 0,  meal: 'brunch' },
  lunch:     { hour: 13, minute: 0,  meal: 'lunch' },
  dinner:    { hour: 20, minute: 0,  meal: 'dinner' },
  supper:    { hour: 20, minute: 30, meal: 'dinner' },
  snack:     { hour: 17, minute: 0,  meal: 'snack' },
  snacks:    { hour: 17, minute: 0,  meal: 'snack' },
  coffee:    { hour: 16, minute: 30, meal: 'beverage' },
  chai:      { hour: 16, minute: 30, meal: 'beverage' },
  tea:       { hour: 16, minute: 30, meal: 'beverage' },
  drinks:    { hour: 20, minute: 0,  meal: 'beverage' },
  beer:      { hour: 20, minute: 0,  meal: 'beverage' },
};

// The shorthand people actually type. Expanded before anything else reads
// the sentence, so every later pattern sees one spelling.
const SHORTHAND = [
  [/\byday\b/gi, 'yesterday'],
  [/\b(?:tmrw|tmr|tomo)\b/gi, 'tomorrow'],
  [/\btonite\b/gi, 'tonight'],
  [/\b(?:mrng|morn)\b/gi, 'morning'],
  [/\bevng\b/gi, 'evening'],
  [/\bb'?day\b/gi, 'birthday'],
  [/\bw\/\s*/g, 'with '],
  [/\bppl\b/gi, 'people'],
  [/\s*@\s*(?=[A-Za-z])/g, ' at '],
];

// "Received an Instax camera as a gift from Akansha", "Akansha gifted me a
// camera", "gave Rahul a book". The verb alone is not enough: "received a
// refund from HDFC" is money, and belongs to the transfer patterns below.
const GIFT_WORD = /\b(gifts?|gifted|presents?)\b/i;
const GIFT_RE = /\b(gifts?|gifted|presents?|gave)\b|\b(?:received|got)\b(?!\s+(?:a\s+|an\s+|the\s+|my\s+)?(?:refund|payment|salary|credit|cashback|invoice|bill|package|parcel|order|delivery|call|email|message|mail|money|cash|paid|back|up|promoted|married|engaged|home|sick|fever|haircut))/i;
const GIVEN_RE = /\b(gave|gifted|presented|sent)\s+(?!me\b)|\b(?:gift|present)\s+(?:for|to)\b/i;

// Money changing hands with nothing bought. Whether it was spent or arrived
// is decided by the verb, and recorded as `direction`, because a digest has
// to add one and subtract the other.
const TRANSFER_OUT = /\b(paid|sent|transferred|lent|repaid|returned|gave|settled|split)\b/i;
const TRANSFER_IN  = /\b(received|got|borrowed|credited|refunded|reimbursed|salary|refund|cashback|reimbursement)\b/i;
const BILL_RE      = /\b(rent|emi|electricity|power bill|water bill|gas bill|broadband|wifi|internet|phone bill|mobile bill|recharge|maintenance|fees?|tuition|insurance|premium|tax|fine|challan)\b/i;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_RE = /\b(?:(last|next|this|on|coming)\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|rsday|urday)?\b/i;
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Words that say the sentence is a plan rather than a memory.
const FUTURE_RE = /\b(tomorrow|next\s+\w+|will|going to|gonna|planning|planned|plan to|scheduled|upcoming|later today|tonight at|need to|have to|remind me|remember to|todo|to-do)\b/i;
const PAST_RE = /\b(had|ate|went|bought|met|was|were|did|got|received|paid|watched|visited|took|made|saw|came|left|flew|drove|ran|read|slept|woke|sent|gave|finished|spent|felt|played|caught|spoke|called|reached|landed|stayed|checked|ordered|cooked|walked|cycled|swam|worked|shipped|fixed|attended|booked)\b|\b\w{3,}ed\b/i;

// Verb → what kind of event it describes. First match wins, so the more
// specific patterns come first. `sub` may be a function of the sentence.
const INTENTS = [
  { re: /\b(todo|to-do|need to|have to|got to|gotta|remind me|remember to|don't forget)\b/i, type: 'task', sub: null },
  { re: /\b(subscribed|subscription|renewed|renewal|auto-?renew)\b/i,                   type: 'subscription', sub: t => /\b(cancel+ed|unsubscribed)\b/i.test(t) ? 'cancellation' : /\bsubscribed|signed up|trial\b/i.test(t) ? 'signup' : 'renewal' },
  { re: /\b(cancel+ed|unsubscribed)\s+(?:my\s+|the\s+)?(?:\w+\s+)?(?:subscription|plan|membership|netflix|spotify|prime|hotstar|youtube premium)\b/i, type: 'subscription', sub: 'cancellation' },
  { re: /\b(package|parcel|courier|shipment|order)\b.*\b(delivered|arrived|came|reached)\b|\b(delivered|arrived)\b.*\b(package|parcel|order|courier)\b|\bdelivered\b/i, type: 'delivery', sub: 'order_delivered' },
  { re: /\b(package|parcel|courier|shipment|order)\b.*\b(shipped|dispatched)\b|\bout for delivery\b|\bhas been shipped\b/i, type: 'delivery', sub: 'order_shipped' },
  // "for Rahul's birthday" is why there was a dinner, not a milestone of
  // yours; only a birthday or anniversary that is the point of the sentence.
  { re: /\b(got promoted|promotion|got married|got engaged|graduated|convocation|joined\s+[A-Z]|first day at|last day at|farewell|launched|went live)\b|^(?:it'?s |it was |today is |today was |celebrated )?(?:my |our |[A-Z][a-z]+'s )(?:\d+(?:st|nd|rd|th) )?(?:birthday|anniversary)\b/i, type: 'milestone', sub: t => /\b(promot|joined|first day|last day|farewell|launched|went live)/i.test(t) ? 'work' : 'personal' },
  { re: /\b(doctor|dentist|dermat|physio|clinic|hospital|check-?up|consultation|scan|x-?ray|blood test)\b/i, type: 'appointment', sub: 'medical' },
  { re: /\b(haircut|salon|barber|spa|massage|parlour|parlor|pedicure|manicure|facial)\b/i, type: 'appointment', sub: 'personal' },
  { re: /\b(car|bike|scooter|ac|laptop|phone|fridge|washing machine)\s+(?:service|servicing|repair)\b|\b(plumber|electrician|carpenter|mechanic|technician|serviced)\b/i, type: 'appointment', sub: 'service' },
  { re: /\b(took|had|taking)\s+(?:a\s+|my\s+|the\s+|\d+\s+)?(?:\w+\s+)?(?:medicine|medication|tablet|pill|paracetamol|dolo|crocin|antibiotic|vitamin|supplement|dose)\b|\b(medicine|medication)\b/i, type: 'health', sub: 'medication' },
  { re: /\b(fever|headache|migraine|cold|cough|flu|sick|unwell|ill|nausea|stomach ?ache|back ?ache|pain|sore|injured|injury|allergy|period|cramps)\b/i, type: 'health', sub: 'symptom' },
  { re: /\b(weigh(?:ed|t|s)?|kgs?|bp|blood pressure|blood sugar|glucose|hba1c|steps|heart rate|spo2|resting hr)\b/i, type: 'health', sub: 'measurement' },
  { re: /\b(slept|sleep|woke up|nap|napped|bedtime)\b/i,                              type: 'health',       sub: 'sleep' },
  { re: /\b(ran|run|running|jog|jogged|jogging|gym|workout|worked out|walk|walked|walking|cycled|cycling|ride|rode a bike|swim|swam|swimming|yoga|pilates|stretching|hike|hiked|trek|trekked|climbing|lifted|lifting|crossfit|badminton|football|cricket|tennis|squash|basketball|pickleball|table tennis|volleyball|marathon)\b/i, type: 'health', sub: 'workout' },
  { re: /\b(had|ate|eating|grabbed|dined|cooked|made|munched|devoured|finished)\b.*\b(breakfast|brunch|lunch|dinner|supper|snacks?|coffee|chai|tea|drinks|beer|meal|food|dosa|idli|biryani|pizza|burger|pasta|rice|roti|thali|noodles|maggi|sandwich|salad|soup|curry|dal|paneer|chicken|eggs?|toast|cake|dessert|ice ?cream|juice|smoothie|shake)\b/i, type: 'food', sub: 'meal' },
  { re: /\b(ordered\s+(?:in|food|from)|takeaway|take-?out|delivery from|swiggy|zomato|food delivery|ordered\s+\w+\s+(?:pizza|biryani|burger|food))\b/i, type: 'food', sub: 'food_delivery' },
  { re: /\b(groceries|grocery|bigbasket|blinkit|zepto|instamart|dmart|d-mart|supermarket|veggies|vegetables|fruits)\b/i, type: 'food', sub: 'groceries' },
  { re: /\b(had|ate|eating|grabbed|dined)\b/i,                                         type: 'food',         sub: 'meal' },
  { re: /\b(flew|flight|boarded|take-?off|took off|layover)\b/i,                        type: 'travel',       sub: 'flight' },
  { re: /\b(train|railway|rajdhani|shatabdi|vande bharat|metro|local train)\b/i,        type: 'travel',       sub: 'train' },
  { re: /\b(bus|volvo|redbus)\b/i,                                                     type: 'travel',       sub: 'bus' },
  { re: /\b(cab|uber|ola|taxi|auto|rickshaw|rapido|rode|ride to|lift to)\b/i,           type: 'travel',       sub: 'cab' },
  { re: /\b(checked into|checked in at|checked out|stayed at|staying at|hotel|airbnb|oyo|resort|hostel|homestay)\b/i, type: 'travel', sub: 'hotel' },
  { re: /\b(toll|fastag)\b/i,                                                          type: 'travel',       sub: 'toll' },
  { re: /\b(drove|drive|driving|road trip|travel+ed|travel+ing|trip to|reached|arrived in|arrived at|landed|left for|heading to|headed to|off to|back in|back to|weekend in|holiday in|vacation)\b/i, type: 'travel', sub: 'trip' },
  // Dropping or collecting a person is an errand, not a purchase.
  { re: /\b(?:[Dd]ropped|[Pp]icked up|[Dd]rop|[Pp]ick up)\s+(?:[A-Z][a-z]+|mom|mum|dad|papa|amma|appa|bhai|didi|him|her|them|the kids|kids)\b/, type: 'activity', sub: 'errand' },
  { re: /\b(bought|purchased|shopped|shopping|paid for|picked up|got myself|treated myself|splurged)\b/i, type: 'purchase', sub: null },
  { re: /\b(ordered|ordering)\b/i,                                                     type: 'purchase',     sub: null },
  { re: /\b(interview|interviewed)\b/i,                                               type: 'meeting',      sub: 'interview' },
  { re: /\b(1:1|1-1|one on one|one-on-one)\b/i,                                        type: 'meeting',      sub: 'one_on_one' },
  { re: /\b(call with|zoom with|meet with|on a call|video call|had a call|had a chat|chat with|spoke to|spoke with|talked to|talked with)\b/i, type: 'meeting', sub: 'call' },
  { re: /\b(met|meeting|catch ?up|caught up|standup|stand-up|sync|demo|review with|coffee chat|hung out|hangout)\b/i, type: 'meeting', sub: null },
  { re: /\b(called|phoned|rang|texted|messaged|emailed|mailed|whatsapped|pinged|dm'?d|replied to|wrote to|video ?called)\b/i, type: 'communication', sub: t => /\b(texted|messaged|whatsapped|pinged|dm'?d)\b/i.test(t) ? 'message' : /\b(emailed|mailed|wrote to|replied to)\b/i.test(t) ? 'email' : 'call' },
  { re: /\b(worked on|working on|shipped|deployed|released|merged|fixed|debugged|coded|wrote|drafted|refactored|reviewed|presented|pitched|submitted|finished|completed|wrapped up|deadline|office|wfh|work from home|standup)\b/i, type: 'work', sub: t => /\b(deadline)\b/i.test(t) ? 'deadline' : /\b(office|wfh|work from home)\b/i.test(t) ? 'work_task' : 'project_activity' },
  { re: /\b(watched|watching|movie|film|cinema|pvr|inox|imax|screening)\b/i,            type: 'entertainment', sub: t => /\b(netflix|prime|hotstar|series|episode|season|show)\b/i.test(t) ? 'streaming' : 'movie' },
  { re: /\b(concert|gig|live show|standup show|stand-up show|comedy show|theatre|theater|play at|musical|festival|fest)\b/i, type: 'entertainment', sub: 'concert' },
  { re: /\b(played|playing|gaming|gamed|ps5|xbox|switch|steam|fifa|valorant|chess)\b/i, type: 'entertainment', sub: 'game' },
  { re: /\b(read|reading|finished reading|started reading|book|novel|audiobook|kindle)\b/i, type: 'entertainment', sub: 'book' },
  { re: /\b(idea|thought|realised|realized|noticed|felt|feeling|mood|grateful|thankful)\b/i, type: 'note', sub: t => /\b(idea)\b/i.test(t) ? 'idea' : 'observation' },
  { re: /\b(visited|went to|went for|went out|dropped by|stopped at|stopped by|swung by|attended|party|wedding|reception|explored|wandered|strolled|checked out)\b/i, type: 'activity', sub: null },
];

// A time of day named in words. Weaker than an explicit clock time, stronger
// than the midday fallback. Phrases before bare words, so "last night" keeps
// its own hour and its own day.
const DAYPARTS = [
  { re: /\b(last night|tonight|this evening)\b/i,      hour: 20, minute: 0,  label: 'evening' },
  { re: /\b(early morning|first thing)\b/i,            hour: 7,  minute: 0,  label: 'early morning' },
  { re: /\b(this morning|in the morning)\b/i,          hour: 9,  minute: 0,  label: 'morning' },
  { re: /\b(late night|late at night)\b/i,             hour: 23, minute: 0,  label: 'late night' },
  { re: /\b(lunchtime|lunch time)\b/i,                 hour: 13, minute: 0,  label: 'lunchtime' },
  { re: /\b(this afternoon|afternoon)\b/i,             hour: 15, minute: 0,  label: 'afternoon' },
  { re: /\b(midnight)\b/i,                             hour: 0,  minute: 0,  label: 'midnight' },
  { re: /\b(noon|midday)\b/i,                          hour: 12, minute: 0,  label: 'noon' },
  { re: /\b(evening|eve)\b/i,                          hour: 19, minute: 0,  label: 'evening' },
  { re: /\b(night)\b/i,                                hour: 21, minute: 0,  label: 'night' },
  { re: /\b(morning)\b/i,                              hour: 9,  minute: 0,  label: 'morning' },
];

// Quick-add is typed by a person who knows what the number means, so a bare
// trailing number is money — the one place in the pipeline where that guess is
// safe. Units and clock times are excluded, and the assumption is recorded.
// A bare number is rupees — unless a unit follows it. "Coke Zero 250 mL" is a
// can, not a ₹250 dinner, and "2 pieces" is a count. The lookahead lists the
// units that turn up in what people eat and drink.
const BARE_AMOUNT_RE = /(?:^|[\s,(])(\d{2,7}(?:\.\d{1,2})?)(?!\s*(?:k\b|km|kg|kgs|mins?|minutes?|hrs?|hours?|am|pm|%|:|\/|-|st|nd|rd|th|ml|mls|l\b|ltr|litres?|liters?|g\b|gm|gms|grams?|mg|kcal|cal\b|cals|pcs?\b|pieces?|slices?|packets?|packs?|cups?|glass|glasses|bowls?|plates?|nos?\b|x\b|steps|reps|sets|people|guests|days?|weeks?|months?|years?|yrs?|bpm|mmhg|degrees?|°))\b/gi;

function bareAmount(text) {
  let last = null, m;
  const re = new RegExp(BARE_AMOUNT_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const value = parseFloat(m[1]);
    if (Number.isFinite(value) && value >= 20 && value < 10_000_000) last = value;
  }
  return last;
}

// "2k", "1.5k", "2 lakh", "320/-", "320 bucks", "320 rupees": money spelt
// the way people spell it rather than the way a receipt does.
function colloquialAmount(text) {
  let m = text.match(/(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*k\b/i);
  if (m) return { amount: Math.round(parseFloat(m[1]) * 1000), currency: 'INR', assumed: !/₹|rs/i.test(m[0]) };
  m = text.match(/(\d+(?:\.\d+)?)\s*(?:lakhs?|lacs?)\b/i);
  if (m) return { amount: Math.round(parseFloat(m[1]) * 100_000), currency: 'INR', assumed: false };
  m = text.match(/(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\/-|bucks|rupees?|rupee|rs\b)/i);
  if (m) return { amount: parseFloat(m[1].replace(/,/g, '')), currency: 'INR', assumed: false };
  return null;
}

/**
 * Parse one line of natural language into a draft event.
 *
 * Returns { event, parsed } where `parsed` explains what was recognised, so
 * the UI can show "food · Third Wave Coffee · 13:00 · ₹320" rather than a
 * silent guess.
 */
export function parseQuickEntry(input, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const text = expandShorthand(input);
  if (!text) return null;

  // ── Money ──
  let money = pickTotalAmount(text);
  let assumedCurrency = false;
  if (!money) {
    const spoken = colloquialAmount(text);
    if (spoken) { money = { amount: spoken.amount, currency: spoken.currency }; assumedCurrency = spoken.assumed; }
  }
  // Years and clock times are numbers too; they must not be read as rupees.
  const withoutDates = blankDatesAndTimes(text);
  if (!money) {
    const bare = bareAmount(withoutDates);
    if (bare !== null) { money = { amount: bare, currency: 'INR' }; assumedCurrency = true; }
  }

  // ── When ──
  const daypart = findDaypart(text);
  let [meal, mealWord] = findMeal(text);

  // ── What kind of thing ──
  const people = extractPeople(text);
  let intent = classify(text, { money, people });

  // A meal word both classifies the event and supplies a default time.
  if (meal && (!intent || intent.type === 'food' && intent.subtype === 'meal' || intent.type === 'activity' || intent.type === 'note')) {
    intent = { type: 'food', subtype: meal.meal === 'beverage' ? 'beverage' : (intent?.subtype === 'food_delivery' ? 'food_delivery' : 'meal') };
  }
  // Only a person named: a meeting, whatever else it was.
  if (!intent && people.length && text.split(' ').length <= 4) intent = { type: 'meeting', subtype: null };
  if (!intent) intent = { type: 'note', subtype: /\bidea\b/i.test(text) ? 'idea' : /\bremind/i.test(text) ? 'reminder' : 'observation' };


  // ── Who and where ──
  const gift = intent.type === 'gift' ? extractGift(text, intent.subtype) : null;
  const transfer = intent.type === 'transfer' ? extractCounterparty(text, intent.subtype) : null;
  const party = gift?.person || transfer?.person || null;
  if (party && !people.includes(party)) people.push(party);

  // A note or a task names no venue worth filing: "a page to edit the dish
  // dictionary" is an idea, and "Edit The Dish Dictionary" is not a shop.
  const placeless = gift || (transfer?.person) || ['note', 'task', 'milestone'].includes(intent.type);
  const places = placeless ? {} : extractPlaces(text);
  const fallbackEntityType = intent.type === 'food' ? 'restaurant'
                           : intent.type === 'purchase' ? 'merchant'
                           : 'place';
  const primaryPlace = places.at || (intent.type === 'travel' ? places.to || places.from : places.from || places.to) || null;
  let canonical = primaryPlace && !GENERIC_PLACE.test(primaryPlace) ? canonicalMerchant(primaryPlace, fallbackEntityType) : null;
  // A person's name is not a venue: "went to Ravi's" is a visit, "at Rahul's
  // place" too, and a name already read as a person is never also a shop.
  const host = primaryPlace?.match(/^([A-Z][a-z]+)'s(?:\s+(?:place|house|home|flat|apartment|room|office))?$/);
  if (host) {
    canonical = null;
    if (!people.includes(host[1])) people.push(host[1]);
  }
  if (canonical && people.some(p => canonical.name === p || canonical.name.startsWith(`${p}'`))) {
    canonical = null;
  }

  // Where a known brand tells us what happened: "ordered from Swiggy" is
  // food, "Uber to airport" is a cab, even when the verb said "ordered".
  if (canonical?.category === 'food_delivery' && intent.type !== 'food') intent = { type: 'food', subtype: 'food_delivery' };
  if (canonical?.category === 'groceries' && intent.type !== 'food') intent = { type: 'food', subtype: 'groceries' };
  if (canonical?.type === 'restaurant' && intent.type === 'purchase') intent = { type: 'food', subtype: /\bordered|delivery\b/i.test(text) ? 'food_delivery' : 'restaurant' };
  if (canonical?.category === 'transport' && intent.type !== 'travel') intent = { type: 'travel', subtype: 'cab' };

  // "2 dosas and a filter coffee this morning": the coffee is on the plate,
  // not the occasion, so it must not make this an afternoon beverage.
  let items = [];
  if (intent.type === 'food') {
    const [, ...rest] = text.split(OCCASION_SPLIT);
    const foodText = rest.join(' ').trim();
    items = foodText ? parseMealItems(foodText, { declared: true }) : parseMealItems(text);
    if (meal?.meal === 'beverage' && items.some(i => !new RegExp(`\\b${mealWord}\\b`, 'i').test(i.name))) {
      meal = null; mealWord = null;
      intent = { type: 'food', subtype: intent.subtype === 'beverage' ? 'meal' : intent.subtype };
    }
  }

  // ── The instant ──
  const { occurredAt, inference, scheduled } = resolveWhen(text, { now, timeZone, meal, daypart, money });
  if (assumedCurrency) inference.assumed_currency = 'INR';

  // ── Data ──
  const data = {};
  if (canonical) {
    if (intent.type === 'food' && intent.subtype !== 'groceries') data.restaurant = canonical.name;
    else if (['purchase', 'subscription', 'delivery', 'transfer', 'food'].includes(intent.type)) data.merchant = canonical.name;
    else data.place = canonical.name;
  }
  if (intent.type === 'travel') {
    if (places.from) data.origin = canonicalMerchant(places.from, 'place')?.name || places.from;
    if (places.to) data.destination = canonicalMerchant(places.to, 'place')?.name || places.to;
    if (!places.at && data.destination) data.place = data.destination;
  }
  if (money) { data.amount = money.amount; data.currency = money.currency; }
  if (meal && intent.type === 'food') data.meal_type = meal.meal;
  if (items.length) data.items = items;
  // "at home", "to office": worth keeping as where, not worth an entity.
  if (!canonical && primaryPlace && (GENERIC_PLACE.test(primaryPlace) || host) && intent.type !== 'purchase') {
    data.place = host ? `${host[1]}'s place` : capitalise(primaryPlace.replace(/^(?:the|my)\s+/i, ''));
    if (intent.type === 'travel' && places.to) data.destination = data.place;
  }
  if (gift) {
    data.direction = intent.subtype;
    if (gift.item) data.item = gift.item;
    if (gift.person) data[intent.subtype === 'given' ? 'to' : 'from'] = gift.person;
  }
  if (transfer) {
    data.direction = transfer.direction;
    if (transfer.person) data[transfer.direction === 'credit' ? 'from' : 'to'] = transfer.person;
    if (transfer.purpose) data.purpose = transfer.purpose;
  }
  if (intent.type === 'purchase' && intent.subtype === 'bill') {
    const bill = text.match(BILL_RE);
    if (bill) data.purpose = bill[1].toLowerCase();
  }
  const object = extractObject(text, intent);
  if (object && (intent.type === 'purchase' || intent.type === 'entertainment')) data.item = object;

  const relationshipFor = (person) => {
    if (person === gift?.person) return intent.subtype === 'given' ? 'recipient' : 'sender';
    if (person === transfer?.person) return transfer.direction === 'credit' ? 'sender' : 'recipient';
    if (host && person === host[1]) return 'place';
    if (intent.type === 'meeting') return 'attendee';
    return 'person';
  };

  const entities = [];
  if (canonical) {
    entities.push(entityRef(canonical.type, canonical.name,
      intent.type === 'food' && intent.subtype !== 'groceries' ? 'restaurant' : intent.type === 'purchase' || intent.subtype === 'groceries' ? 'merchant'
      : intent.type === 'travel' && !places.at ? 'destination' : 'place'));
  }
  if (intent.type === 'travel' && data.origin) entities.push(entityRef('place', data.origin, 'origin'));
  if (intent.type === 'travel' && data.destination && data.destination !== canonical?.name) entities.push(entityRef('place', data.destination, 'destination'));
  for (const p of people) entities.push(entityRef('person', p, relationshipFor(p)));

  const extraction = {
    type: intent.type,
    subtype: intent.subtype,
    title: buildTitle({ text, canonical, money, intent, gift, transfer, meal, mealWord, people, data, object, host: host?.[1] }),
    description: text,
    occurred_at: occurredAt,
    status: scheduled ? 'scheduled' : 'confirmed',
    confidence: null,          // stated by a person; not an extraction
    data,
    inference,
    entities: entities.filter(Boolean),
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
      status: extraction.status,
      assumed: Object.keys(inference),
    },
  };
}

function expandShorthand(input) {
  let text = String(input || '').replace(/\s+/g, ' ').trim();
  for (const [re, word] of SHORTHAND) text = text.replace(re, word);
  return text;
}

// ── Classifying ────────────────────────────────────────

function classify(text, { money, people }) {
  // Gifts and transfers share their verbs, so they are decided before the
  // verb table: the word "gift" settles it, then money with a person's name
  // after "to" or "from" is a transfer, then "received X from Y" is a gift.
  if (GIFT_WORD.test(text)) return { type: 'gift', subtype: GIVEN_RE.test(text) ? 'given' : 'received' };

  if (/\b(salary|payslip|got paid)\b/i.test(text)) return { type: 'transfer', subtype: 'salary' };
  if (/\b(refund(?:ed)?)\b/i.test(text)) return { type: 'transfer', subtype: 'refund' };
  if (/\b(cashback)\b/i.test(text)) return { type: 'transfer', subtype: 'cashback' };
  if (/\b(reimburse(?:d|ment))\b/i.test(text)) return { type: 'transfer', subtype: 'credit' };
  if (/\b(paid|payment)\b.*\b(credit card|card bill|cc bill)\b/i.test(text)) return { type: 'transfer', subtype: 'card_payment' };
  if (/\b(moved|transferred)\b.*\b(to|from)\s+(?:my\s+)?(?:savings|account|hdfc|icici|sbi|axis|kotak)\b/i.test(text)) return { type: 'transfer', subtype: 'self_transfer' };
  if (money && (TRANSFER_OUT.test(text) || TRANSFER_IN.test(text))) {
    const counterparty = extractCounterparty(text, null);
    if (counterparty?.person && !BILL_RE.test(text)) return { type: 'transfer', subtype: counterparty.direction === 'credit' ? 'credit' : 'payment' };
  }
  if (/\b(paid|payment|cleared|settled)\b/i.test(text) && BILL_RE.test(text)) return { type: 'purchase', subtype: 'bill' };
  if (GIFT_RE.test(text) && /\b(received|got)\b/i.test(text) && /\bfrom\s+[A-Z]/.test(text) && !money) {
    return { type: 'gift', subtype: 'received' };
  }
  // "Gave Rahul a book": a thing handed to a person, with no money in it.
  if (/\bgave\b/i.test(text) && !money && new RegExp(String.raw`\b[Gg]ave\s+${PERSON}\b`).test(text)) {
    return { type: 'gift', subtype: 'given' };
  }

  for (const intent of INTENTS) {
    if (!intent.re.test(text)) continue;
    const subtype = typeof intent.sub === 'function' ? intent.sub(text) : intent.sub;
    return { type: intent.type, subtype };
  }

  // Just a place: a check-in.
  if (/^\s*(?:at|in)\s+[A-Z]/i.test(text) && text.split(' ').length <= 5) return { type: 'location', subtype: 'checkin' };
  return null;
}

// ── When ───────────────────────────────────────────────

function findDaypart(text) {
  return DAYPARTS.find(d => d.re.test(text)) || null;
}

/** The first meal word in the sentence, with its spec: [spec, word] or [null, null]. */
function findMeal(text) {
  for (const [word, spec] of Object.entries(MEALS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return [spec, word];
  }
  return [null, null];
}

/**
 * Which day, which hour, and whether the sentence is a plan or a record.
 *
 * Shared by both parsers, which used to carry their own copy of this and
 * drifted in the details. The two differ on purpose in one place, `meal_mode`:
 *
 *   - a meal with no stated hour is "now" (you are telling Hermes as you eat),
 *     where any other event defaults to midday, or to now only before noon;
 *   - a meal is a plan whenever its hour is still to come, where any other
 *     event needs a word that says so or a stated hour, and is never a plan
 *     once money has been spent.
 *
 * Returns { occurredAt, inference, scheduled, past }.
 */
function resolveWhen(text, { now, timeZone, meal, daypart, money = null, meal_mode = false }) {
  const when = resolveDate(text, now, timeZone);
  const clock = resolveTime(text, { daypart, meal });

  // A named time of day beats a weak meal default: "coffee this morning" is
  // a morning coffee, not a four-thirty one.
  const weakMeal = !meal_mode && meal && (meal.meal === 'beverage' || meal.meal === 'snack');
  const mealDefault = meal && !(weakMeal && daypart) ? { hour: meal.hour, minute: meal.minute } : null;

  const past = meal_mode ? PAST_TENSE.test(text) : PAST_RE.test(text) && !FUTURE_RE.test(text);
  const future = !meal_mode && (FUTURE_RE.test(text)
    || (when.explicit === false && /\b(tomorrow|next|coming|in \d+ (?:days?|weeks?))\b/i.test(text)));

  const inference = {};
  let time = clock.time || mealDefault || (daypart ? { hour: daypart.hour, minute: daypart.minute } : null);
  if (!time) {
    // Nothing said about the hour. Midday for a day in the past; for today,
    // "just now" is the better guess when midday has not come yet.
    const nowClock = localClock(now, timeZone);
    const isToday = when.assumed === 'today' || (relativeDayOffset(text)?.days === 0);
    if (meal_mode || (isToday && !future && nowClock.hour < 12)) { time = nowClock; inference.assumed_time = 'now'; }
    else { time = { hour: 12, minute: 0 }; inference.assumed_time = 'midday default'; }
  } else if (!clock.time) {
    inference.assumed_time = mealDefault ? `${meal.meal} default` : `${daypart.label} default`;
  } else if (clock.assumed) inference.assumed_time = clock.assumed;
  if (when.assumed) inference.assumed_date = when.assumed;

  let occurredAt = zonedISO({ ...when.date, ...time }, timeZone);
  const isFuture = () => new Date(occurredAt).getTime() > now.getTime() + 60_000;

  // "Had dinner at 9pm" typed at eight is last night's dinner, not tonight's.
  if (past && isFuture() && when.assumed === 'today') {
    occurredAt = zonedISO({ ...shiftLocalDate(now, -1, timeZone), ...time }, timeZone);
    inference.assumed_date = 'yesterday, from the past tense';
  }
  // A plan needs a word that says so, or a stated hour still to come. A bare
  // "Groceries from BigBasket" is a record, however early it was typed; and
  // money already spent is never a plan.
  const scheduled = !past && isFuture() && (meal_mode || (!money && (future || Boolean(clock.time))));

  return { occurredAt, inference, scheduled, past };
}

// ── Dates ──────────────────────────────────────────────

/**
 * When the sentence says it happened, as a local calendar date.
 *
 * Returns { date: {year, month, day}, assumed, explicit }. `assumed` names the
 * guess when the sentence left room for one: "today" when it said nothing,
 * "the most recent Wednesday" when it named a weekday without saying which.
 */
function resolveDate(text, now, timeZone) {
  const explicit = parseDateParts(text) || dayMonthWithoutYear(text, now, timeZone);
  if (explicit) return { date: explicit, assumed: null, explicit: true };

  const offset = relativeDayOffset(text);
  if (offset !== null) return { date: shiftLocalDate(now, offset.days, timeZone), assumed: offset.assumed, explicit: false };

  const weekday = relativeWeekday(text, now, timeZone);
  if (weekday) return { date: weekday.date, assumed: weekday.assumed, explicit: false };

  return { date: shiftLocalDate(now, 0, timeZone), assumed: 'today', explicit: false };
}

/** "3 Sept", "Sept 3rd", "on the 3rd of September" → this year's, or last year's if that is still to come. */
function dayMonthWithoutYear(text, now, timeZone) {
  let m = text.match(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+${MONTH_RE.source.slice(2, -2)}\b(?!\s*,?\s*\d{4})`, 'i'));
  let day, month;
  if (m) { day = +m[1]; month = MONTHS[m[2].slice(0, 3).toLowerCase()]; }
  else {
    m = text.match(new RegExp(String.raw`${MONTH_RE.source}\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*,?\s*\d{4})`, 'i'));
    if (!m) return null;
    month = MONTHS[m[1].slice(0, 3).toLowerCase()]; day = +m[2];
  }
  if (month === undefined || day < 1 || day > 31) return null;

  const [year, thisMonth, today] = localDateISO(now, timeZone).split('-').map(Number);
  const candidate = Date.UTC(year, month, day);
  const todayUTC = Date.UTC(year, thisMonth - 1, today);
  // More than a day ahead and nothing says "next": it was last year.
  const ahead = (candidate - todayUTC) / 86_400_000;
  const y = ahead > 1 && !FUTURE_RE.test(text) ? year - 1 : year;
  return { year: y, month, day };
}

/**
 * "yesterday" → -1, "today"/"tonight" → 0, "tomorrow" → +1, "3 days ago",
 * "a week ago", "last weekend". Null when the sentence names no relative day.
 */
function relativeDayOffset(text) {
  let m;
  if (/\b(day before yesterday)\b/i.test(text)) return { days: -2, assumed: null };
  if (/\b(day after tomorrow)\b/i.test(text)) return { days: 2, assumed: null };
  if (/\b(yesterday|last night)\b/i.test(text)) return { days: -1, assumed: null };
  if (/\b(today|tonight|this (morning|afternoon|evening)|earlier|just now|right now)\b/i.test(text)) return { days: 0, assumed: null };
  if (/\b(tomorrow)\b/i.test(text)) return { days: 1, assumed: null };
  if ((m = text.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|couple of|few)\s+(days?|weeks?|months?)\s+(?:ago|back|earlier)\b/i))) {
    const n = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, 'couple of': 2, few: 3 }[m[1].toLowerCase()] ?? Number(m[1]);
    const unit = m[2].toLowerCase().startsWith('week') ? 7 : m[2].toLowerCase().startsWith('month') ? 30 : 1;
    if (Number.isFinite(n)) return { days: -n * unit, assumed: /few|month/i.test(m[0]) ? `about ${m[0]}` : null };
  }
  if ((m = text.match(/\bin\s+(\d+|a|an|one|two|three|four|five|six|seven|couple of|few)\s+(days?|weeks?)\b/i))) {
    const n = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, 'couple of': 2, few: 3 }[m[1].toLowerCase()] ?? Number(m[1]);
    const unit = m[2].toLowerCase().startsWith('week') ? 7 : 1;
    if (Number.isFinite(n)) return { days: n * unit, assumed: null };
  }
  if (/\b(last week)\b/i.test(text)) return { days: -7, assumed: 'a week ago, from "last week"' };
  if (/\b(last month)\b/i.test(text)) return { days: -30, assumed: 'a month ago, from "last month"' };
  return null;
}

/**
 * "on Wednesday", "last Wednesday", "Wednesday evening", "over the weekend" →
 * the most recent one, today included. This is a ledger of things that
 * happened, so a bare weekday looks backwards; only "next Wednesday" looks
 * forwards. The choice is recorded as an assumption when the sentence did not
 * say which.
 */
function relativeWeekday(text, now, timeZone) {
  const [year, month, day] = localDateISO(now, timeZone).split('-').map(Number);
  const today = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  let index, qualifier;
  const m = text.match(WEEKDAY_RE);
  if (m) {
    index = WEEKDAYS.findIndex(d => d.startsWith(m[2].slice(0, 3).toLowerCase()));
    qualifier = (m[1] || '').toLowerCase();
  } else if (/\b(?:(last|this|next|over the|on the)\s+)?weekend\b/i.test(text)) {
    index = 6;   // Saturday
    qualifier = (text.match(/\b(last|next)\s+weekend\b/i)?.[1] || '').toLowerCase();
    // A weekend that started yesterday is still "this weekend" on a Sunday.
    if (today === 0 && qualifier !== 'last' && qualifier !== 'next') return { date: shiftLocalDate(now, -1, timeZone), assumed: 'yesterday, from "weekend"' };
  } else return null;
  if (index < 0) return null;

  let offset;
  if (qualifier === 'next' || qualifier === 'coming') offset = ((index - today + 7) % 7) || 7;
  else {
    offset = -((today - index + 7) % 7);
    // "last Monday" said on a Monday means a week ago, not this morning.
    if (qualifier === 'last' && offset === 0) offset = -7;
  }

  const name = m ? WEEKDAYS[index].replace(/^\w/, c => c.toUpperCase()) : 'weekend';
  return {
    date: shiftLocalDate(now, offset, timeZone),
    assumed: qualifier === 'last' || qualifier === 'next' || qualifier === 'coming' ? null : `the most recent ${name}`,
  };
}

// ── Clock ──────────────────────────────────────────────

/**
 * The time of day, with the am/pm guessed when the sentence gave a bare hour:
 * "at 7 in the evening" is 19:00 and says so; "at 7" alone leans on the
 * daypart, then on the habit that small hours are afternoons.
 */
function resolveTime(text, { daypart, meal }) {
  const dotted = text.replace(/\b(\d{1,2})\.(\d{2})\s*(am|pm)\b/gi, '$1:$2 $3');
  const explicit = parseTimeParts(dotted);
  if (explicit) return { time: explicit, assumed: null };

  const m = text.match(/\b(?:at|around|about|by|till|until|from|@)\s*(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:am|pm|k\b|km|kg|%|st|nd|rd|th|\/|-|mins?|hrs?|hours?|days?|weeks?|people|guests|of\b|[a-z]{3,}))(?:\s*(?:ish|o'?clock))?/i)
       || text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:ish|o'?clock)\b/i)
       || text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s+in the (?:morning|afternoon|evening|night)\b/i);
  if (!m) return { time: null, assumed: null };
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || minute > 59) return { time: null, assumed: null };
  if (hour > 12) return { time: { hour, minute }, assumed: null };

  const part = daypart?.label || (meal ? { breakfast: 'morning', brunch: 'morning', lunch: 'afternoon', snack: 'afternoon', beverage: 'afternoon', dinner: 'evening' }[meal.meal] : null);
  if (part) {
    const pm = /afternoon|evening|night|lunchtime/.test(part) && hour < 12;
    return { time: { hour: pm ? hour + 12 : hour % 12 || (part === 'noon' ? 12 : 0), minute }, assumed: null };
  }
  // No clue at all: 1–6 is far more often afternoon than dawn.
  if (hour >= 1 && hour <= 6) return { time: { hour: hour + 12, minute }, assumed: 'pm assumed' };
  return { time: { hour, minute }, assumed: 'am assumed' };
}

/** Blank the spans a date or clock occupies, so a bare-number pass cannot mistake 2026 for rupees. */
function blankDatesAndTimes(text) {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[\s\-\/][a-z]{3,9}[\s\-\/,]+\d{4}\b/gi, ' ')
    .replace(/\b[a-z]{3,9}\s+\d{1,2},?\s+\d{4}\b/gi, ' ')
    .replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ')
    .replace(/\b(?:in|since|from|of)\s+(?:19|20)\d{2}\b/gi, ' ')
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(am|pm)\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b(?:at|around|about|by|till|until)\s*\d{1,2}\b/gi, ' ');
}

// ── Places ─────────────────────────────────────────────

const PLACE_STOP = new RegExp([
  String.raw`\b(around|about|approx\.?|approximately|roughly)\b.*$`,
  String.raw`\b\d{1,2}(?::\d{2})?\s*(am|pm)\b.*$`,
  String.raw`\b(today|tonight|yesterday|tomorrow|last night|this (morning|afternoon|evening)|earlier|just now|right now)\b.*$`,
  // "Akansha on Wednesday evening" is a person and a time, not a venue.
  String.raw`\b(?:(?:on|last|next|this|coming)\s+)?(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b.*$`,
  String.raw`\b(?:(?:on|last|next|this|over the)\s+)?weekend\b.*$`,
  String.raw`\b(early morning|late night|morning|afternoon|evening|night|noon|midday|midnight|lunchtime)\b.*$`,
  String.raw`\b(?:on\s+)?(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b.*$`,
  String.raw`\b(?:on\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b.*$`,
  String.raw`\b\d+\s+(?:days?|weeks?|months?)\s+(?:ago|back)\b.*$`,
  String.raw`\b(as an? (?:gift|present))\b.*$`,
  String.raw`\b(for|with|and|because|since|then|after|before|via|while|when|but|so|which|that|on the way)\b.*$`,
  String.raw`\s+[—–-]\s+.*$`,
  // "from Bangalore to Delhi": the next leg starts at the next preposition.
  String.raw`\s+(?:to|from|at|into|towards|via)\s+(?=[A-Z0-9]).*$`,
].join('|'), 'i');

// After "to", these are verbs, not destinations.
const TO_VERB = /^(get|buy|see|pick|drop|meet|have|eat|watch|make|do|check|visit|play|work|study|sleep|fix|order|call|be|go|grab|catch|collect|finish|start|try|find|take|bring|say|talk|help|use|read|write|learn|cook|clean|wash|pay|book|send|celebrate|attend|join|discuss|review|plan|prepare|edit|add|remove|update|change|create|build|design|test|run|ship|deploy|open|close|move|set|put|keep|leave|stop|begin|continue|improve|track|log|record|save|sort|search|show|hide|list|print|share|post|upload|download|install|sync|merge|split|figure|think|remember|forget|ask|tell|know|let|give|hear|feel|look|wait|stay|come|return|sign|apply|submit|renew|cancel|confirm|verify|schedule|reschedule|follow|fill|file|sell|rent|hire|borrow|lend|repay|settle|transfer|withdraw|deposit|invest|redeem|claim|die|rest|relax|chill|hang|walk|jog|swim|cycle|exercise|stretch|train|practise|practice|rehearse|perform|sing|dance|draw|paint|shoot|film|record|stream|tweet)\b/i;
// Where you were, but not an entity to file it under.
const GENERIC_PLACE = /^(home|my (?:place|house|flat|room|desk)|the (?:house|flat)|office|the office|work|the gym|gym|school|college|campus|the airport|airport|the station|station|the market|market|the mall|mall|the park|park|the beach|beach|the hospital|hospital|the temple|temple|church|the mosque|mosque|the club|club|the pool|pool|the terrace|terrace|the balcony|balcony)$/i;
const NOT_A_PLACE = /^(me|my|him|her|them|us|it|there|here|bed|all|least|once|first|last|this|that|these|those|which|what|where|a|an|the|some|each|every|one|two|three|noon|midnight|lunch|dinner|breakfast|brunch|coffee|drinks|snacks?|tea|chai|the same|the moment|the end|the time|the morning|the evening|the afternoon|the night|the weekend|the day|the week|the month|the year|the way|touch|scale|weight|height|length|peace|rest|risk|hand|heart|mind|line|play|full|long|short|a while|ages|general|particular|case|fact|short|total|advance|person|time|hand|order|return|response|reply|exchange|addition|spite|charge|control|touch|love|shape|good shape|bad shape|pain|tears|trouble|doubt|debt|cash|full)$/i;

/**
 * The venues named after "at" / "from" / "to" / "in", keyed by preposition.
 * Every occurrence is tried in turn, so "in the morning at Blue Tokai" finds
 * the café even though "in" came first. Each phrase stops at a comma, a
 * price, a time, a day, or a trailing preposition — "at Third Wave around
 * 1pm, ₹320" yields "Third Wave", not the rest of the sentence.
 */
function extractPlaces(text) {
  const out = {};
  const re = /\b(at|from|to|in|into|near|towards|via)\s+([^,.;:!?₹$(]{2,60})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    // "from Bangalore to Delhi": the next leg begins inside this capture.
    re.lastIndex = m.index + m[1].length + 1;
    const prep = m[1].toLowerCase();
    const key = prep === 'at' || prep === 'in' || prep === 'near' ? 'at' : prep === 'from' ? 'from' : 'to';
    if (out[key]) continue;
    if (key === 'to' && TO_VERB.test(m[2])) continue;

    let place = m[2]
      .replace(PLACE_STOP, '')
      .replace(/^\s*(?:the|a|an)\s+/i, '')
      // "Veena Stores at 7:30am" — the colon ends the capture, leaving "at 7".
      .replace(/\s+\d[\d.,]*\s*(?:k|\/-)?\s*$/i, '')
      // A dangling preposition means the phrase ran into a clause we cut off.
      .replace(/(\s+\b(?:at|on|in|for|to|around|near|by|of|from)\s*)+$/i, '')
      .replace(/[-–—]\s*$/, '')
      .trim()
      .replace(/\s+/g, ' ');

    if (place.length < 2 || /^\d/.test(place) || NOT_A_PLACE.test(place)) continue;
    // "to Rahul's" is a person's home; a visit, but not an entity to file it under.
    out[key] = place;
  }
  return out;
}

// ── People ─────────────────────────────────────────────

const NAME = String.raw`[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?`;
const FAMILY_WORDS = 'mom|mum|mummy|dad|papa|amma|appa|bhai|bhaiya|didi|nani|nana|dadi|dada|mausi|chacha|chachi|mama|mami|bua|nephew|niece|cousin|grandma|grandpa|wife|husband|partner|boss|manager';
const FAMILY = new RegExp(String.raw`\b(${FAMILY_WORDS})\b`, 'i');
// The same words in either case, for patterns that must stay case-sensitive
// so that a capital letter can still mean "this is a name".
const FAMILY_EITHER = FAMILY_WORDS.split('|').map(w => `${w}|${w.charAt(0).toUpperCase()}${w.slice(1)}`).join('|');
const PERSON = String.raw`(?:${NAME}|${FAMILY_EITHER})`;
const NOT_A_NAME = /^(The|A|An|My|Our|At|In|On|To|From|And|With|For|But|Or|So|If|Then|I|It|He|She|We|They|You|Just|Also|Some|All|Home|Office|Work|Amazon|Uber|Ola|Swiggy|Zomato|Netflix|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Today|Tonight|Yesterday|Tomorrow|Morning|Evening|Afternoon|Night|Lunch|Dinner|Breakfast|Coffee|Drinks|Instax|Kindle|Mac|Iphone|Ipad)$/i;

/**
 * The people in the sentence. Names are read after a "who" verb and after
 * "with", including lists — "with Rahul, Priya and Ankit" — and lowercase
 * family words count, because nobody capitalises "dinner with mom".
 * Conservative on purpose: a wrong person entity pollutes every "what did I
 * do with X" answer afterwards, and the user can always add one in the
 * detail view.
 */
function extractPeople(text) {
  const out = [];
  const add = (raw) => {
    const name = raw.trim().replace(/'s$/, '');
    if (!name || NOT_A_NAME.test(name) || out.includes(name)) return;
    // A brand read as a name: "with Amazon" is not a person.
    const known = canonicalMerchant(name, 'person');
    if (known && known.type !== 'person') return;
    out.push(name);
  };

  // The verb is matched in either case, the name only when capitalised — an
  // `i` flag on the whole pattern would make [A-Z] meaningless and turn every
  // word after "met" into a person.
  const verb = new RegExp(String.raw`\b(?:[Mm]et|[Mm]eeting with|[Cc]all with|[Cc]alled|[Pp]honed|[Tt]exted|[Mm]essaged|[Ee]mailed|[Ss]poke (?:to|with)|[Tt]alked (?:to|with)|[Cc]aught up with|[Cc]atch ?up with|[Vv]isited|[Hh]ung out with|[Ss]aw|[Bb]umped into|[Rr]an into|[Dd]ropped|[Pp]icked up|[Hh]osted|[Ii]nterviewed|[Ll]unch with|[Dd]inner with|[Bb]reakfast with|[Bb]runch with|[Cc]offee with|[Cc]hai with|[Dd]rinks with|[Bb]eer with|[Mm]ovie with|[Ww]alk with)\s+(${PERSON})(?!'s\s+(?:place|house|home|flat|office|wedding|birthday))`, 'g');
  let m;
  while ((m = verb.exec(text)) !== null) {
    const name = m[1];
    add(name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name);
  }

  // "with X", "with X and Y", "with X, Y and Z".
  const withRe = new RegExp(String.raw`\b[Ww]ith\s+(${PERSON}(?:\s*(?:,|and|&)\s*${PERSON})*)(?!'s\s+(?:place|house|home|flat|office))`, 'g');
  while ((m = withRe.exec(text)) !== null) {
    for (const part of m[1].split(/\s*(?:,|\band\b|&)\s*/)) {
      if (!part) continue;
      if (FAMILY.test(part) && part === part.toLowerCase()) add(part.charAt(0).toUpperCase() + part.slice(1));
      else if (/^[A-Z]/.test(part)) add(part);
    }
  }

  // "Akansha gifted me", "Rahul called".
  const subject = text.match(new RegExp(String.raw`^\s*(${NAME})\s+(?:gifted|gave|sent|called|texted|messaged|visited|dropped|invited|treated|got me|bought me)\b`));
  if (subject) add(subject[1]);

  return out;
}

// ── Gifts and transfers ────────────────────────────────

// Where a gift sentence ends: the giver, the occasion, the day.
const GIFT_ITEM_END = /\s+(?:as\s+an?\s+(?:gift|present)|from|to|for|on|at|in|yesterday|today|tonight|last|this|next|when|because|worth|costing)\b|[,.;!]|$/i;

/**
 * "Received Instax camera as a gift from Akansha" → { item: 'Instax camera',
 * person: 'Akansha' }. The item is whatever sits between the verb and the
 * first word that starts a new clause; the person follows "from" (received)
 * or "to" (given), or sits before the verb — "Akansha gifted me a camera".
 */
function extractGift(text, direction) {
  const out = { item: null, person: null };
  const person = direction === 'given'
    ? text.match(new RegExp(String.raw`\b(?:to|for)\s+(${NAME})`))
        || text.match(new RegExp(String.raw`\b(?:[Gg]ave|[Gg]ifted|[Pp]resented|[Ss]ent)\s+(${NAME})\b(?!\s+(?:gifted|gave))`))
    : text.match(new RegExp(String.raw`\bfrom\s+(${NAME})`))
        || text.match(new RegExp(String.raw`^\s*(${NAME})\s+(?:gifted|gave|got|sent|bought)\b`));
  if (person && !NOT_A_NAME.test(person[1])) out.person = person[1].trim();

  const verb = text.match(/\b(?:received|got|gifted|gave|presented|sent|bought)\b(?:\s+(?:me|him|her|them|us))?\s+/i);
  if (verb) {
    let rest = text.slice(verb.index + verb[0].length);
    // "gave Rahul a book": the recipient sits between the verb and the thing.
    if (out.person && rest.startsWith(out.person)) rest = rest.slice(out.person.length);
    rest = rest.replace(/^\s*(?:a|an|the|some|my|this|these)\s+/i, '').trim();
    const end = rest.search(GIFT_ITEM_END);
    const item = (end >= 0 ? rest.slice(0, end) : rest).replace(/\s+/g, ' ').trim();
    if (item && !/^(gift|present|it|this|that|something)$/i.test(item) && item.length <= 80) out.item = item;
  }
  if (!out.item) {
    // "Gift from Akansha: Instax camera", "Instax camera, gift from Akansha".
    const m = text.match(/:\s*(.+)$/) || text.match(/^(.+?),\s*(?:a\s+)?(?:gift|present)\b/i);
    if (m) out.item = m[1].trim();
  }
  return out;
}

/**
 * "Paid Rahul ₹2,000 for dinner", "sent 500 to Mom", "got 5k from Dad" →
 * who the money went to or came from, and which way it went.
 */
function extractCounterparty(text, subtype) {
  const direction = subtype === 'payment' || subtype === 'card_payment' ? 'debit'
                  : subtype && subtype !== 'self_transfer' ? 'credit'
                  : TRANSFER_IN.test(text) && !TRANSFER_OUT.test(text) ? 'credit'
                  : /\b(got|received|borrowed)\b/i.test(text) ? 'credit'
                  : 'debit';
  const person = text.match(new RegExp(String.raw`\b(?:to|from|by)\s+(${PERSON})\b`))
              || text.match(new RegExp(String.raw`\b(?:[Pp]aid|[Ss]ent|[Ll]ent|[Rr]epaid|[Oo]we|[Oo]wed)\s+(${PERSON})\b`));
  let who = person ? person[1].trim() : null;
  if (who) {
    if (FAMILY.test(who) && who === who.toLowerCase()) who = who.charAt(0).toUpperCase() + who.slice(1);
    if (NOT_A_NAME.test(who) || !/^[A-Z]/.test(who)) who = null;
    else {
      const known = canonicalMerchant(who, 'person');
      if (known && known.type !== 'person') who = null;
    }
  }
  const purpose = text.match(/\bfor\s+(?:the\s+|my\s+|our\s+)?([a-z][a-z' ]{2,40}?)(?=\s+(?:on|at|yesterday|today|last|this)\b|[,.;]|$)/i);
  return { direction, person: who, purpose: purpose ? purpose[1].trim() : null };
}

// ── Titles ─────────────────────────────────────────────

const TYPE_LABEL = {
  food: 'Meal', purchase: 'Purchase', travel: 'Travel', meeting: 'Meeting', work: 'Work',
  health: 'Activity', entertainment: 'Entertainment', appointment: 'Appointment',
  activity: 'Activity', note: 'Note', gift: 'Gift', transfer: 'Transfer',
  subscription: 'Subscription', delivery: 'Delivery', task: 'Task', milestone: 'Milestone',
  communication: 'Call', location: 'Check-in',
};

/**
 * The thing the verb acted on: "bought a keyboard" → "keyboard", "watched
 * Dune" → "Dune", "cab to airport" → null (the place is the point). Cut at
 * the first word that starts a circumstance. Only a purchase and a piece of
 * entertainment carry an object into `data` and the title, so only those two
 * are read.
 */
function extractObject(text, intent) {
  const verbs = {
    purchase: /\b(?:bought|purchased|ordered|picked up|got myself|treated myself to|paid for|renewed|subscribed to)\s+(?:a\s+|an\s+|the\s+|some\s+|new\s+|my\s+|\d+\s+)?/i,
    entertainment: /\b(?:watched|watching|saw|read|reading|finished reading|started reading|played|playing|listened to)\s+(?:a\s+|an\s+|the\s+|some\s+)?/i,
  }[intent.type];
  if (!verbs) return null;
  const m = text.match(verbs);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/\s+(?:from|at|in|on|for|with|to|via|yesterday|today|tonight|tomorrow|last|this|next|around|about|worth|costing)\b|[,.;!₹$]|\s+\d|\s+[—–-]\s|$/i);
  const object = (end >= 0 ? rest.slice(0, end) : rest).replace(/\s+/g, ' ').trim();
  if (!object || object.length > 60 || /^(it|this|that|something|stuff|things?)$/i.test(object)) return null;
  return object;
}

/**
 * The sentence with the when and the how-much taken out, which is what a
 * title should be for anything that is not a meal, a purchase or a trip:
 * "Met Priya at Blue Tokai on Thursday morning" → "Met Priya at Blue Tokai".
 */
function cleanedSentence(text) {
  let s = text
    .replace(/(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d{1,2})?(?:\s*\/-)?/gi, ' ')
    .replace(/\b[\d,]+(?:\.\d{1,2})?\s*(?:\/-|bucks|rupees?|rs\b|k\b)/gi, ' ')
    .replace(/\b(?:at|around|about|by|till|until)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|ish|o'?clock)?\b/gi, ' ')
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|ish|o'?clock)\b/gi, ' ')
    .replace(/\b(?:on\s+)?(?:(?:last|next|this|coming|over the)\s+)?(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\s*(?:early morning|late night|morning|afternoon|evening|night)?\b/gi, ' ')
    .replace(/\b(?:(?:last|next|this|over the|on the)\s+)?weekend\b/gi, ' ')
    .replace(/\b(?:in the |this |early |late |last )?(?:early morning|late night|morning|afternoon|evening|night|noon|midday|midnight|lunchtime)\b/gi, ' ')
    .replace(/\b(?:day before yesterday|day after tomorrow|yesterday|today|tonight|tomorrow|earlier|just now|right now|last week|last month)\b/gi, ' ')
    .replace(/\b(?:\d+|a|an|one|two|three|four|five|six|seven|couple of|few)\s+(?:days?|weeks?|months?)\s+(?:ago|back|earlier)\b/gi, ' ')
    .replace(/\b(?:on\s+)?(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s*,?\s*\d{4})?\b/gi, ' ')
    .replace(/\b(?:on\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,?\s*\d{4})?\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ')
    .replace(/\s+\d{2,7}(?:\.\d{1,2})?\s*$/, ' ')
    .replace(/^\s*(?:i|we|just|so|today i|i just|i've|we've|i have)\s+/i, '')
    .replace(/\s+(?:for|with|and|at|in|on|from|to|around|about|of|the|a|an|by|since|till|until|after|before)\s*$/i, '')
    .replace(/\s*[,;:—–-]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim()
    .replace(/[.!]+$/, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length > 80) s = `${s.slice(0, 77).replace(/\s+\S*$/, '')}…`;
  return s;
}

function buildTitle({ text, canonical, intent, gift, transfer, meal, mealWord, people, data, object, host }) {
  const who = canonical?.name || (data.place && !canonical && intent.type !== 'travel' ? data.place : null);
  const guests = people.filter(p => p !== host);
  const withPeople = guests.length ? ` with ${guests.slice(0, 2).join(' and ')}${guests.length > 2 ? ' and others' : ''}` : '';

  if (gift) {
    const thing = gift.item ? capitalise(gift.item) : 'Gift';
    const link = intent.subtype === 'given' ? 'to' : 'from';
    return gift.person ? `${thing} ${link} ${gift.person}` : thing;
  }

  if (transfer) {
    const verb = { salary: 'Salary', refund: 'Refund', cashback: 'Cashback', card_payment: 'Card bill paid',
                   self_transfer: 'Transfer', credit: 'Received' }[intent.subtype]
              || (/\blent\b/i.test(text) ? 'Lent' : /\brepaid|returned\b/i.test(text) ? 'Repaid' : /\bsplit|settled\b/i.test(text) ? 'Settled' : 'Paid');
    const link = transfer.direction === 'credit' ? 'from' : '';
    const purpose = transfer.purpose ? ` for ${transfer.purpose}` : '';
    if (transfer.person) return `${verb} ${link ? `${link} ` : ''}${transfer.person}${purpose}`.replace(/\s+/g, ' ');
    if (who) return `${verb} from ${who}`;
    return `${verb}${purpose}`;
  }

  if (intent.type === 'food') {
    const dishes = summariseItems(data.items, 3);
    const what = dishes || (mealWord ? capitalise(mealWord) : intent.subtype === 'groceries' ? 'Groceries' : intent.subtype === 'food_delivery' ? 'Food delivery' : 'Meal');
    if (who) return `${what} ${intent.subtype === 'food_delivery' || intent.subtype === 'groceries' ? 'from' : 'at'} ${who}${withPeople}`;
    return `${what}${withPeople}`;
  }

  if (intent.type === 'purchase') {
    if (intent.subtype === 'bill') return `${capitalise(data.purpose || 'bill')}${data.purpose && !/bill|rent|emi|fees?|tax|fine|challan|premium|insurance|recharge|maintenance|tuition/i.test(data.purpose) ? ' bill' : ''} paid`;
    const thing = object ? capitalise(object) : null;
    if (thing && who) return `${thing} from ${who}`;
    if (thing) return thing;
    if (who) return `${who}`;
    return 'Purchase';
  }

  if (intent.type === 'travel') {
    const mode = { flight: 'Flight', train: 'Train', bus: 'Bus', cab: 'Cab', hotel: 'Stay', trip: 'Trip', toll: 'Toll' }[intent.subtype] || 'Travel';
    if (intent.subtype === 'hotel') return who ? `Stay at ${who}` : cleanedSentence(text);
    const to = data.destination, from = data.origin;
    if (to && from) return `${mode} from ${from} to ${to}`;
    if (to) return `${mode} to ${to}`;
    if (from) return `${mode} from ${from}`;
    return cleanedSentence(text);
  }

  if (intent.type === 'entertainment' && object) {
    const thing = capitalise(object);
    return who ? `${thing} at ${who}${withPeople}` : `${thing}${withPeople}`;
  }

  if (intent.type === 'location' && who) return `At ${who}`;

  // Everything else reads best as what was said, minus the when and the price.
  const sentence = cleanedSentence(text);
  return sentence || TYPE_LABEL[intent.type] || 'Event';
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
export function parseMealEntry(input, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const text = String(input || '').trim();
  if (!text) return null;

  const daypart = findDaypart(text);
  const [meal] = findMeal(text);

  // Not yet eaten is `scheduled`: the Food screen still shows it, so the plan
  // is visible and the dishes can be filled in when there are dishes to fill
  // in. Except when the sentence is in the past — "had dinner at Kapoor's",
  // typed over breakfast, is last night's dinner and not tonight's, and
  // scheduling it would put a meal already eaten in the future.
  const { occurredAt: occurred, inference, scheduled } = resolveWhen(text, { now, timeZone, meal, daypart, meal_mode: true });

  // Split the occasion from the food before reading either, so "at home" can
  // never swallow the dish that follows it.
  const [occasion, ...rest] = text.split(OCCASION_SPLIT);
  const foodText = rest.join(' ').trim();

  const spots = extractPlaces(occasion);
  const place = spots.at || spots.from || spots.to || null;
  const canonical = place && !AT_HOME.test(place) ? canonicalMerchant(place, 'restaurant') : null;
  const items = foodText
    ? parseMealItems(foodText, { declared: true })
    : parseMealItems(text);

  let money = pickTotalAmount(text);
  if (!money) {
    const bare = bareAmount(text);
    if (bare !== null) money = { amount: bare, currency: 'INR' };
  }

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

function capitalise(word) {
  return String(word).charAt(0).toUpperCase() + String(word).slice(1);
}
