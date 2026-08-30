// ======================================================
// Email → events, cheapest method first.
//
// The ladder, in the order it is climbed:
//
//   1. triage()          headers and subject only. Newsletters, OTPs, bulk mail
//                        and marketing never reach a parser, let alone a model.
//   2. extractJsonLd()   schema.org markup that the sender already embedded.
//                        Amazon, airlines, hotels and delivery services ship
//                        Order / FlightReservation / LodgingReservation /
//                        ParcelDelivery objects in the HTML because Gmail used
//                        to render cards from them. Exact, free, no inference.
//   3. parseICS()        calendar invitations, which are structured by
//                        definition.
//   4. SENDER_RULES      hand-written patterns for the senders that show up
//                        often enough to be worth a regex — bank alerts,
//                        food delivery, cabs.
//   5. (caller) LLM      only what survives all of the above *and* looks
//                        transactional. See ledger/extract/llm.js.
//
// Everything in this module is pure and synchronous: same input, same events,
// no network. That is what makes the expensive layer optional rather than
// load-bearing — if the model is unavailable, layers 1-4 still produce a
// ledger, and the rest lands in the review queue.
// ======================================================

import { canonicalMerchant, entityRef, isFoodMerchant, isPaymentRail, normalizeName, parseAddress,
         pickTotalAmount, parseDateParts, parseTimeParts, zonedISO } from './normalize.js';
import { deriveDedupeKey, matchKeys } from './dedupe.js';
import { parseOrderItems } from './items.js';

// ── Layer 1: triage ────────────────────────────────────
//
// Triage no longer decides whether an email is parsed — the free layers below
// always run. It decides one thing only: is this worth a model call?
//
// That inversion matters. Promotional mail is written to look transactional
// ("your order is waiting", "delivered to your door", "₹500 off"), so a
// keyword test run first sends half the inbox to the model. Run the cheap
// parsers first and the question becomes much narrower: nothing structured
// matched, nothing a rule knows matched — is there still real evidence of a
// transaction here, addressed to me, from something that is not a campaign?

// Subjects that are never an event, however transactional they look.
const NEVER = [
  /\b(otp|one[\s-]?time\s+(password|code|pin)|verification\s+code|security\s+code)\b/i,
  /\b(password\s+reset|reset\s+your\s+password|verify\s+your\s+(email|account)|sign[\s-]?in\s+(attempt|alert))\b/i,
  /\b(unsubscribe|newsletter|weekly\s+digest|daily\s+digest|blog\s+update)\b/i,
  /\b(webinar|survey|feedback|rate\s+your|review\s+your\s+(order|experience)|tell\s+us)\b/i,
  // A payment that failed is not a transaction. The mail still names the
  // restaurant, the order number and the amount, so left to the model it reads
  // as a meal — and spends a call to arrive there.
  /\bpayment\s+failed\b/i,
  // A payment that failed is not a transaction. The mail still names the
  // restaurant, the order number and the amount, so left alone it reads as a
  // meal — and asking the model about it only spends money to be told so.
  /\bpayment\s+failed\b/i,
  // A reminder is about something that has *not* happened. Recording it would
  // put a non-event in the ledger, and the real payment arrives by email later.
  /\b(payment\s+(overdue|due|reminder|pending)|overdue|due\s+(?:on|by|date)|pay\s+now|outstanding\s+(?:amount|balance)|renew(al)?\s+reminder|expiring\s+soon)\b/i,
];

// Campaign language. Any of these and it is marketing, whatever else it says.
const PROMOTIONAL = [
  /\b(\d{1,3}\s*%\s*off|flat\s+\d+|up\s+to\s+\d+\s*%|save\s+(big|up\s+to)|discount|coupon|promo\s*code)\b/i,
  /\b(sale|deals?\s+of\s+the\s+(day|week)|flash\s+sale|mega\s+sale|clearance|offer\s+(ends|inside|for\s+you))\b/i,
  /\b(limited\s+time|last\s+chance|hurry|ends\s+(today|tonight|soon)|don'?t\s+miss)\b/i,
  /\b(new\s+arrivals?|trending|recommended\s+for\s+you|just\s+for\s+you|picked\s+for\s+you|you\s+might\s+(also\s+)?like)\b/i,
  /\b(back\s+in\s+stock|price\s+drop|wishlist|in\s+your\s+cart|complete\s+your\s+purchase)\b/i,
  /\b(we\s+miss\s+you|come\s+back|reactivate|refer\s+(a\s+friend|and\s+earn)|invite\s+your\s+friends)\b/i,
  /\b(introducing|announcing|now\s+available|launch(ing)?)\b/i,
  /\b(cashback\s+offer|reward\s+points\s+expiring|claim\s+your)\b/i,
  // Card-benefit mailers. No transaction anywhere in them, but plenty of
  // rupee figures — which is exactly how one became a ₹50,000 "purchase".
  /\b(flat\s+(?:inr|rs\.?|₹)\s*\d+\s*(?:off|cashback)|surcharge\s+waiver|complimentary\s+\w+|lounge\s+(?:access|visit)|welcome\s+(?:offer|benefit)|milestone\s+benefit)\b/i,
  /\b(minimum\s+(?:transaction|spends?)\s+of|on\s+(?:the\s+)?spends?\s+of|eligible\s+spends?|reward\s+points\s+on)\b/i,
  /\b(remind\s+you\s+of\s+the\s+following|benefits\s+on\s+your\s+card|constant\s+endeavour)\b/i,
];

// Sender local-parts that only ever send campaigns.
const PROMO_SENDER = /^(marketing|promo(tions?)?|offers?|deals?|newsletter|news|campaign|mailer|blast|updates?-noreply|hello|hi|team|community|social|digest)@|@(marketing|email|mailer|campaign|news|promo|digest)[.-]/i;

// Publications and platforms. A market-news digest is full of amounts and the
// word "confirmed"; nothing in it happened to you.
const NEWSLETTER_SENDER = /(digest|newsletter|substack|beehiiv|mailchimp|convertkit|ghost\.io|medium\.com|quora|linkedin|reddit|pinterest|facebook|instagram|twitter)/i;

// Headers that only bulk senders set.
const BULK_HEADERS = ['list-unsubscribe', 'list-id', 'list-post', 'feedback-id',
                      'x-campaign-id', 'x-campaignid', 'x-mailer-campaign', 'x-csa-complaints'];

// A transaction leaves a reference behind: an order number, a PNR, an invoice.
const REFERENCE = /\b(order\s*(?:id|no|number|#)|booking\s*(?:id|ref|reference)|pnr|invoice\s*(?:no|number|#)|transaction\s*(?:id|ref)|txn\s*(?:id|no)|receipt\s*(?:no|number)|reference\s*(?:no|number))\b/i;

// And something actually happened to money or to a booking.
const TRANSACTIONAL_VERB = /\b(debited|credited|credit\s+of|charged|paid|payment\s+(of|received|successful)|purchase[ds]?|used\s+for|withdrawn|refunded|booked|confirmed|delivered|dispatched|shipped|checked[\s-]in|renewed|invoiced|billed)\b/i;

const MONEY = /(₹|rs\.?|inr|usd|\$|eur|€|gbp|£)\s*\d/i;

/**
 * Decide what an email deserves once the free layers have found nothing.
 *
 *   inspect — real evidence of a transaction, addressed to you, not a campaign.
 *             Worth a model call.
 *   reject  — record the source, create no event, spend nothing.
 *
 * `promotional` is returned separately because it also gates the regex rules:
 * a "60% off" blast from Swiggy must not be read as a food order just because
 * it contains a rupee sign and the word "order".
 */
export function triage(message, ctx = {}) {
  const subject = message?.subject || '';
  const headers = lowerKeys(message?.headers || {});
  const from = message?.from?.address
    ? { name: message.from.name, address: message.from.address }
    : parseAddress(message?.from);
  const address = (from.address || '').toLowerCase();

  for (const re of NEVER) {
    if (re.test(subject)) return { decision: 'reject', reason: 'never-an-event subject', promotional: false };
  }

  const body = `${subject}\n${message?.text || ''}`;
  const promotional = PROMOTIONAL.some(re => re.test(subject))
                   || PROMO_SENDER.test(address)
                   || PROMOTIONAL.filter(re => re.test(body)).length >= 2;

  const bulk = BULK_HEADERS.some(h => headers[h])
            || /bulk|list|junk/i.test(String(headers.precedence || ''));

  // Was this sent to you, or to a list you happen to be on? Campaigns are
  // rarely in your To/Cc line; receipts almost always are.
  const direct = isDirectlyAddressed(message, ctx.selfAddresses);

  if (promotional) {
    return { decision: 'reject', reason: 'promotional', promotional: true };
  }
  if (NEWSLETTER_SENDER.test(address)) {
    return { decision: 'reject', reason: 'newsletter or platform digest', promotional: true };
  }
  if (bulk && !direct) {
    return { decision: 'reject', reason: 'bulk mail, not addressed to you', promotional: true };
  }

  // The bar for spending a model call: a reference or an amount, AND something
  // having happened to it. "Your order has shipped" with a tracking number
  // qualifies; "your order is waiting in your cart" does not.
  const hasMoney = MONEY.test(body);
  const hasReference = REFERENCE.test(body);
  const hasVerb = TRANSACTIONAL_VERB.test(body);

  // "Available balance in your account ending XX9768 is Rs. 1,000.00" reports
  // a state, not an event. Sent to the model, one of these came back as a
  // ₹15,000 credit that never happened.
  if (BALANCE_NOTICE.test(body) && !MOVEMENT.test(body)) {
    return { decision: 'reject', reason: 'balance notification, nothing moved', promotional: false };
  }

  // Mail sent through a bulk system has to carry a reference — an order
  // number, a PNR, an invoice id. Real receipts from bulk senders always do;
  // newsletters, which are full of amounts and words like "confirmed", never
  // do. This is the line that separates the two.
  if (bulk && !hasReference) {
    return { decision: 'reject', reason: 'bulk mail with no reference number', promotional: false };
  }

  // Both present is not enough. A market-news digest contains "Rs 237 cr" and
  // "confirmed" — paragraphs apart, about different companies, neither about
  // you. On a receipt the amount and the verb are in the same sentence.
  if ((hasMoney || hasReference) && hasVerb && hasProximateSignal(body)) {
    return {
      decision: 'inspect',
      reason: `transactional signal (${[hasMoney && 'amount', hasReference && 'reference', 'verb'].filter(Boolean).join(' + ')})`,
      promotional: false,
    };
  }

  return {
    decision: 'reject',
    reason: !hasVerb ? 'no transactional signal'
          : (hasMoney || hasReference) ? 'amount and verb are unrelated'
          : 'transactional wording but no amount or reference',
    promotional: false,
  };
}

/** Is an amount or a reference within a sentence's reach of a transaction verb? */
function hasProximateSignal(body, window = 120) {
  const positions = re => {
    const found = [];
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = scan.exec(body)) !== null) {
      found.push(m.index);
      if (found.length > 200) break;      // pathological input guard
    }
    return found;
  };

  const verbs = positions(TRANSACTIONAL_VERB);
  if (!verbs.length) return false;
  const anchors = [...positions(MONEY), ...positions(REFERENCE)];

  return anchors.some(a => verbs.some(v => Math.abs(a - v) <= window));
}

/** Is one of my own addresses in To or Cc? */
function isDirectlyAddressed(message, selfAddresses = []) {
  if (!selfAddresses?.length) return true;   // unknown: do not penalise
  const mine = new Set(selfAddresses.map(a => String(a).toLowerCase()));
  const recipients = [...(message?.to || []), ...(message?.cc || [])]
    .map(r => (typeof r === 'string' ? r : r?.address || '').toLowerCase());
  return recipients.some(address => mine.has(address));
}

function lowerKeys(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(k).toLowerCase(), v]));
}

/**
 * Sender + shape-of-subject, with digits masked. Two Amazon dispatch mails for
 * different orders share a fingerprint; an Amazon dispatch and an Amazon
 * refund do not. The jobs cache extraction decisions against this, so a layout
 * only ever costs one model call.
 */
export function senderFingerprint(message) {
  const from = message?.from?.address || parseAddress(message?.from).address || 'unknown';
  const subject = String(message?.subject || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${from}|${subject}`;
}

// ── Layer 2: schema.org JSON-LD ────────────────────────

/** Every JSON-LD object in the HTML, flattened through @graph and arrays. */
export function extractJsonLd(html) {
  if (!html) return [];
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // a malformed block is not worth failing an ingestion run over
    }
    flattenLd(parsed, out);
  }
  return out;
}

function flattenLd(node, out) {
  if (Array.isArray(node)) { node.forEach(n => flattenLd(n, out)); return; }
  if (!node || typeof node !== 'object') return;
  if (node['@graph']) { flattenLd(node['@graph'], out); }
  if (node['@type']) out.push(node);
}

const ldType = node => String(node?.['@type'] || '').replace(/^https?:\/\/schema\.org\//, '');
const ldName = node => (typeof node === 'string' ? node : node?.name) || null;
const ldNum  = v => {
  const n = parseFloat(String(typeof v === 'object' ? (v?.price ?? v?.value) : v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Map one schema.org object to an extraction, or null if it is not a type we
 * record. Confidence is high because nothing here is guessed — the sender
 * stated it in machine-readable form.
 */
export function fromSchemaOrg(node, ctx = {}) {
  const type = ldType(node);
  const at = ctx.messageDate ? new Date(ctx.messageDate).toISOString() : new Date().toISOString();
  const currency = node.priceCurrency || node.totalPaymentDue?.priceCurrency || ctx.defaultCurrency || 'INR';

  switch (type) {
    case 'Order': {
      const merchant = canonicalMerchant(ldName(node.merchant) || ldName(node.seller) || ctx.senderName);
      const amount = ldNum(node.priceSpecification ?? node.price ?? node.totalPaymentDue);
      const items = asArray(node.acceptedOffer).map(o => ({
        name: ldName(o?.itemOffered) || null,
        quantity: o?.eligibleQuantity?.value ?? o?.orderQuantity ?? null,
        price: ldNum(o?.price),
      })).filter(i => i.name);

      return withKeys({
        type: 'purchase',
        subtype: merchant?.normalized_name === 'amazon' ? 'amazon_order' : 'order',
        title: `${merchant?.name || 'Order'}${amount ? ` — ${formatMoney(amount, currency)}` : ''}`,
        occurred_at: node.orderDate ? new Date(node.orderDate).toISOString() : at,
        data: prune({
          merchant: merchant?.name, amount, currency,
          order_id: node.orderNumber || null,
          order_status: String(node.orderStatus || '').replace(/^https?:\/\/schema\.org\//, '') || null,
          items,
          category: merchant?.category || null,
          url: node.url || null,
        }),
        entities: [entityRef(merchant?.type || 'merchant', merchant?.name, 'merchant')].filter(Boolean),
        confidence: 0.97,
        extracted_by: 'jsonld:Order',
      });
    }

    case 'ParcelDelivery': {
      const merchant = canonicalMerchant(ldName(node.deliveryAddress?.name) || ldName(node.provider) || ctx.senderName);
      const eta = node.expectedArrivalUntil || node.expectedArrivalFrom;
      return withKeys({
        type: 'delivery',
        subtype: 'package',
        title: `Delivery${merchant?.name ? ` — ${merchant.name}` : ''}`,
        occurred_at: eta ? new Date(eta).toISOString() : at,
        data: prune({
          merchant: merchant?.name,
          tracking_number: node.trackingNumber || null,
          carrier: ldName(node.carrier) || null,
          order_id: node.partOfOrder?.orderNumber || null,
          tracking_url: node.trackingUrl || null,
        }),
        entities: [entityRef(merchant?.type || 'merchant', merchant?.name, 'merchant')].filter(Boolean),
        confidence: 0.95,
        extracted_by: 'jsonld:ParcelDelivery',
        // The parcel and the purchase are two events about one order.
        relations: node.partOfOrder?.orderNumber && merchant?.name
          ? [{ related_dedupe_key: `order:${slugForKey(merchant.name)}:${slugForKey(node.partOfOrder.orderNumber)}`,
               relationship: 'part_of' }]
          : [],
      });
    }

    case 'FlightReservation': {
      const flight = node.reservationFor || {};
      const airline = canonicalMerchant(ldName(flight.airline) || ctx.senderName, 'company');
      const from = flight.departureAirport?.iataCode || ldName(flight.departureAirport);
      const to   = flight.arrivalAirport?.iataCode   || ldName(flight.arrivalAirport);
      const number = [flight.airline?.iataCode, flight.flightNumber].filter(Boolean).join('');

      return withKeys({
        type: 'travel',
        subtype: 'flight',
        title: `Flight ${from || '?'} → ${to || '?'}${number ? ` (${number})` : ''}`,
        occurred_at: flight.departureTime ? new Date(flight.departureTime).toISOString() : at,
        occurred_at_end: flight.arrivalTime ? new Date(flight.arrivalTime).toISOString() : null,
        data: prune({
          provider: airline?.name, origin: from, destination: to,
          flight_number: number || flight.flightNumber || null,
          booking_reference: node.reservationNumber || null,
          departure: flight.departureTime || null,
          arrival: flight.arrivalTime || null,
          passenger: ldName(node.underName) || null,
          status: String(node.reservationStatus || '').replace(/^https?:\/\/schema\.org\//, '') || null,
        }),
        entities: [
          entityRef('company', airline?.name, 'provider'),
          entityRef('place', to, 'destination'),
          entityRef('place', from, 'origin'),
        ].filter(Boolean),
        confidence: 0.97,
        extracted_by: 'jsonld:FlightReservation',
      });
    }

    case 'LodgingReservation': {
      const hotel = canonicalMerchant(ldName(node.reservationFor), 'company');
      const checkin = node.checkinTime || node.checkinDate;
      const checkout = node.checkoutTime || node.checkoutDate;
      const place = node.reservationFor?.address?.addressLocality || null;

      return withKeys({
        type: 'travel',
        subtype: 'hotel',
        title: `Hotel — ${hotel?.name || 'stay'}${place ? `, ${place}` : ''}`,
        occurred_at: checkin ? new Date(checkin).toISOString() : at,
        occurred_at_end: checkout ? new Date(checkout).toISOString() : null,
        data: prune({
          provider: hotel?.name, place,
          booking_reference: node.reservationNumber || null,
          checkin, checkout,
          guest: ldName(node.underName) || null,
          amount: ldNum(node.totalPrice ?? node.priceSpecification),
          currency,
        }),
        entities: [
          entityRef('company', hotel?.name, 'provider'),
          entityRef('place', place, 'place'),
        ].filter(Boolean),
        confidence: 0.96,
        extracted_by: 'jsonld:LodgingReservation',
      });
    }

    case 'FoodEstablishmentReservation': {
      const place = canonicalMerchant(ldName(node.reservationFor), 'restaurant');
      return withKeys({
        type: 'food',
        subtype: 'restaurant',
        title: `Table at ${place?.name || 'restaurant'}`,
        occurred_at: node.startTime ? new Date(node.startTime).toISOString() : at,
        data: prune({
          restaurant: place?.name,
          booking_reference: node.reservationNumber || null,
          party_size: node.partySize || null,
        }),
        entities: [entityRef('restaurant', place?.name, 'restaurant')].filter(Boolean),
        confidence: 0.95,
        extracted_by: 'jsonld:FoodEstablishmentReservation',
      });
    }

    case 'EventReservation': {
      const eventNode = node.reservationFor || {};
      const venue = ldName(eventNode.location);
      return withKeys({
        type: 'entertainment',
        subtype: 'event',
        title: ldName(eventNode) || 'Event',
        occurred_at: eventNode.startDate ? new Date(eventNode.startDate).toISOString() : at,
        occurred_at_end: eventNode.endDate ? new Date(eventNode.endDate).toISOString() : null,
        data: prune({
          place: venue,
          booking_reference: node.reservationNumber || null,
          ticket_count: node.numSeats || null,
        }),
        entities: [entityRef('place', venue, 'place')].filter(Boolean),
        confidence: 0.95,
        extracted_by: 'jsonld:EventReservation',
      });
    }

    case 'Invoice': {
      const provider = canonicalMerchant(ldName(node.provider) || ctx.senderName, 'company');
      const amount = ldNum(node.totalPaymentDue);
      const paid = /paid|complete/i.test(String(node.paymentStatus || ''));
      return withKeys({
        type: 'subscription',
        subtype: paid ? 'renewal' : 'invoice',
        title: `${provider?.name || 'Invoice'}${amount ? ` — ${formatMoney(amount, currency)}` : ''}`,
        occurred_at: node.paymentDueDate ? new Date(node.paymentDueDate).toISOString() : at,
        data: prune({
          merchant: provider?.name, amount, currency,
          invoice_number: node.confirmationNumber || node.accountId || null,
          payment_status: node.paymentStatus || null,
          category: provider?.category || null,
        }),
        entities: [entityRef(provider?.type || 'company', provider?.name, 'merchant')].filter(Boolean),
        confidence: 0.95,
        extracted_by: 'jsonld:Invoice',
      });
    }

    default:
      return null;
  }
}

/**
 * Accept a captured reference only if it looks like one.
 *
 * "CESC LTD - Mobile Payment Receipt" made the receipt-number pattern capture
 * the word "Payment", which became the dedupe key `invoice:cesc:payment` —
 * shared by every CESC bill, so the second one would have merged into the
 * first. A reference with no digit in it is a false capture.
 */
function reference(match) {
  const value = match?.[1]?.trim();
  if (!value || !/\d/.test(value)) return null;
  if (/^(payment|receipt|invoice|number|order|details|successful|confirmed)$/i.test(value)) return null;
  return value;
}

/**
 * First capture in `body` that survives reference(). Scanning every match
 * matters: "Mobile Payment Receipt. Payment received... Receipt No: RCP889912"
 * makes the first match the word "received", and stopping there would throw
 * away the real receipt number two sentences later.
 */
function matchReference(body, pattern) {
  const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let m;
  while ((m = scan.exec(body)) !== null) {
    const value = reference(m);
    if (value) return value;
  }
  return null;
}

/**
 * When did this happen?
 *
 * An alert arrives within moments of the transaction, so the email's own
 * timestamp is a good answer and always has a time on it. A date parsed out of
 * the body is only better when it also carries a time — otherwise it lands at
 * local midnight, which is why a timeline full of card purchases all read
 * 00:00. And a parsed date far from the email's date is not this transaction's
 * date at all; it is an offer expiry or a statement period that happened to
 * match the pattern.
 */
function resolveOccurredAt(message, text, ctx = {}) {
  const emailAt = new Date(message.date);
  const dateParts = parseDateParts(text);
  const timeParts = parseTimeParts(text);

  if (!dateParts || !timeParts) return emailAt.toISOString();

  const parsed = new Date(zonedISO({ ...dateParts, ...timeParts }, ctx.timeZone || 'Asia/Kolkata'));
  const daysApart = Math.abs(parsed - emailAt) / 86_400_000;
  return daysApart <= 3 ? parsed.toISOString() : emailAt.toISOString();
}

function issuerName(message) {
  const issuer = canonicalMerchant(message.from?.name || parseAddress(message.from).name || '', 'company');
  return issuer?.name || 'Card';
}

function asArray(v) { return v === null || v === undefined ? [] : (Array.isArray(v) ? v : [v]); }
function slugForKey(v) { return String(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function formatMoney(amount, currency) {
  const symbol = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }[currency] || '';
  // Round only where rounding is invisible. On a ₹10.64 refund it is not.
  const value = Math.abs(amount) < 100 && !Number.isInteger(amount)
    ? amount.toFixed(2)
    : Math.round(amount).toLocaleString('en-IN');
  return `${symbol}${value}`;
}
function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) =>
    v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
}

/**
 * Attach the dedupe key and fuzzy match keys an extraction implies.
 *
 * `match.types` is what lets a card alert find the food order it paid for. The
 * two arrive as different event types — `purchase` and `food` — so a
 * same-type-only match could never connect them, and you would end up with two
 * events for one ₹450 dinner. Crossing types is only allowed when there is an
 * amount to agree on, which is what keeps it from over-merging.
 */
export function withKeys(extraction) {
  return {
    ...extraction,
    // A rule may set its own key — a refund shares its order's number but is
    // emphatically not the same event, so it needs a key of its own.
    dedupe_key: extraction.dedupe_key ?? deriveDedupeKey(extraction),
    match: { ...matchKeys(extraction), types: matchTypes(extraction) },
  };
}

// One purchase can surface as any of these, depending on which source saw it.
const SPEND_TYPES = ['purchase', 'food', 'travel', 'subscription', 'entertainment', 'delivery'];

function matchTypes(extraction) {
  const hasAmount = Number.isFinite(Number(extraction?.data?.amount));
  if (hasAmount && SPEND_TYPES.includes(extraction.type)) return SPEND_TYPES;
  return [extraction.type];
}

// ── Layer 3: iCalendar ─────────────────────────────────

/**
 * Minimal RFC 5545 reader: unfold continuations, split VEVENTs, decode the
 * handful of properties an event ledger cares about. Deliberately not a
 * general iCalendar implementation — recurrence expansion belongs to a
 * calendar connector, not to an email parser.
 */
export function parseICS(text) {
  if (!text || !/BEGIN:VCALENDAR/i.test(text)) return [];

  const unfolded = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');

  const method = (lines.find(l => /^METHOD:/i.test(l)) || '').split(':')[1]?.trim().toUpperCase() || null;
  const events = [];
  let current = null;

  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { current = { method, attendees: [] }; continue; }
    if (/^END:VEVENT/i.test(line))   { if (current) events.push(current); current = null; continue; }
    if (!current) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const rawName = line.slice(0, colon);
    const value = unescapeICS(line.slice(colon + 1));
    const [name, ...paramParts] = rawName.split(';');
    const params = Object.fromEntries(paramParts.map(p => {
      const eq = p.indexOf('=');
      return eq === -1 ? [p.toUpperCase(), true] : [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, '')];
    }));

    switch (name.toUpperCase()) {
      case 'UID':           current.uid = value; break;
      case 'SUMMARY':       current.summary = value; break;
      case 'DESCRIPTION':   current.description = value; break;
      case 'LOCATION':      current.location = value; break;
      case 'STATUS':        current.status = value.toUpperCase(); break;
      case 'DTSTART':       current.start = { value, params }; break;
      case 'DTEND':         current.end = { value, params }; break;
      case 'RECURRENCE-ID': current.recurrenceId = value; break;
      case 'ORGANIZER':     current.organizer = { email: mailtoOf(value), name: params.CN || null }; break;
      case 'ATTENDEE':      current.attendees.push({ email: mailtoOf(value), name: params.CN || null,
                                                     status: params.PARTSTAT || null }); break;
      default: break;
    }
  }
  return events;
}

function unescapeICS(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\');
}
function mailtoOf(v) {
  const m = String(v).match(/mailto:([^\s;>]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** ICS timestamp → ISO instant. Floating times take the user's zone. */
export function icsToISO(field, timeZone = 'Asia/Kolkata') {
  if (!field?.value) return null;
  const v = String(field.value).trim();

  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    return zonedISO({ year: +dateOnly[1], month: +dateOnly[2] - 1, day: +dateOnly[3] }, timeZone);
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;

  // RFC 5545 forbids TZID together with a 'Z' suffix — a value is either in a
  // named zone or in UTC, never both. Senders emit it anyway:
  //
  //     DTSTART;TZID=Asia/Kolkata:20260816T130000Z
  //
  // for a table booking whose own subject line reads "for 1:00 PM". Believing
  // the 'Z' puts every such booking 5½ hours late. When both are present the
  // named zone is the one the sender went out of their way to state, so it
  // wins and the stray 'Z' is ignored.
  const tzid = field.params?.TZID || null;

  if (m[7] === 'Z' && !tzid) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  }
  const zone = tzid || timeZone;
  try {
    return zonedISO({ year: +m[1], month: +m[2] - 1, day: +m[3], hour: +m[4], minute: +m[5] }, zone);
  } catch {
    return zonedISO({ year: +m[1], month: +m[2] - 1, day: +m[3], hour: +m[4], minute: +m[5] }, timeZone);
  }
}

/**
 * A calendar entry is evidence that something was *planned*. It becomes
 * `scheduled`, not `confirmed`, and stays that way until other evidence — a
 * bill, a photo, a note to Hermes — reconciles it. A cancellation is recorded
 * as dismissed rather than deleted so the next sync cannot recreate it.
 */
export function fromICS(vevent, ctx = {}) {
  const tz = ctx.timeZone || 'Asia/Kolkata';
  const start = icsToISO(vevent.start, tz);
  if (!start) return null;

  const cancelled = vevent.status === 'CANCELLED' || vevent.method === 'CANCEL';
  const attendees = (vevent.attendees || []).filter(a => a.email || a.name);

  return withKeys({
    type: 'meeting',
    subtype: 'calendar_event',
    title: vevent.summary || 'Calendar event',
    description: vevent.description ? String(vevent.description).slice(0, 2000) : null,
    occurred_at: start,
    occurred_at_end: icsToISO(vevent.end, tz),
    status: cancelled ? 'dismissed' : 'scheduled',
    data: prune({
      calendar_uid: vevent.uid || null,
      recurrence_id: vevent.recurrenceId || null,
      place: vevent.location || null,
      organizer: vevent.organizer?.name || vevent.organizer?.email || null,
      attendees: attendees.map(a => a.name || a.email),
      cancelled: cancelled || null,
    }),
    entities: [
      ...attendees.map(a => entityRef('person', a.name || a.email, 'attendee', a.email ? { email: a.email } : {})),
      entityRef('place', vevent.location, 'place'),
    ].filter(Boolean),
    confidence: cancelled ? 0.99 : 0.96,
    extracted_by: 'ics:VEVENT',
  });
}

// ── Layer 4: per-sender rules ──────────────────────────

/**
 * Hand-written patterns for senders frequent enough to be worth one. Each rule
 * is a pure function returning an extraction or null; a rule that is unsure
 * returns null and lets the email fall through to the model.
 *
 * `tier` is what stops one email becoming two events. A Zomato receipt says
 * both "your order from Happiness Dhaba" and "paid ₹97 by card" — the food
 * rule and the generic payment rule both fire, and the ledger ends up with a
 * food event and a purchase event for one dinner. Only the most specific tier
 * that matched is kept: a merchant that tells you what you bought beats a
 * payment line that only tells you what it cost.
 *
 *   tier 1 — the merchant itself, so the event knows what it was
 *   tier 2 — a payment rail: right amount, no idea what for
 */
// Senders that issue payment alerts, and phrasing only a payment alert uses.
const BANK_SENDER = /(bank|hsbc|amex|american\s*express|citi|kotak|axis|icici|hdfc|sbi|idfc|indusind|rbl|yes\s*bank|federal|scb|standardchartered|paytm|phonepe|razorpay|payu|billdesk|cred|npci|upi|onecard|slice)/i;
const HARD_DEBIT = /\b(has been debited|was debited|debited from your|spent on your|charged to your|debited\s+(?:for|of)|upi\s+txn|transaction\s+alert)\b/i;

// The sentence a real alert is built from: an amount and a verb, touching.
//
// Requiring only the *word* "transaction" let a card-benefits mailer through —
// "Flat INR 120 off on a minimum transaction of INR 500… spends of INR 50,000" —
// which was recorded as a ₹50,000 purchase from a merchant called "INR 4".
// Marketing talks about transactions; an alert reports one.
const ALERT_SHAPE = new RegExp([
  String.raw`(?:inr|rs\.?|₹)\s*[\d,]+(?:\.\d{1,2})?\s*(?:is|has been|was|been)?\s*(?:debited|credited|spent|charged|withdrawn|paid)`,
  // "...has been used for INR 189.00 for payment to CTRLX TECHNOLOGIES P"
  String.raw`(?:inr|rs\.?|₹)\s*[\d,]+(?:\.\d{1,2})?\s+for\s+payment\s+to`,
  String.raw`(?:has been|was)?\s*used\s+for\s*(?:inr|rs\.?|₹)\s*[\d,]+`,
  // "...was used for a purchase transaction of INR 140.00 at TGIF"
  String.raw`(?:used for a|purchase|debit|credit)?\s*transaction of\s*(?:inr|rs\.?|₹)\s*[\d,]+`,
  String.raw`(?:purchase of|payment of|debited by|credited by)\s*(?:inr|rs\.?|₹)\s*[\d,]+`,
  String.raw`(?:debited|credited)\s+(?:from|to)\s+your\s+(?:a\/c|account|card)`,
].join('|'), 'i');
// A bare "transaction of" is back in the list above. It once let a
// card-benefits mailer through — "a minimum transaction of INR 500" — but the
// promotional gate now rejects those before any rule runs, and keeping the
// pattern out was silently dropping ~20 real HSBC alerts a month, which is the
// worse failure of the two.

// A balance notice quotes a rupee figure and nothing happened.
const BALANCE_NOTICE = /\b(available balance|balance in your account|account balance|closing balance|balance enquiry)\b/i;
const MOVEMENT = /\b(debited|credited|spent|withdrawn|purchase|paid|transferred)\b/i;

export const SENDER_RULES = [
  {
    id: 'insurance_policy',
    tier: 1,
    // A policy being issued or renewed is a real, dated commitment with a
    // premium attached — worth recording, and unambiguous enough not to need
    // a model.
    when: m => /(uiic|newindia|orientalinsurance|nationalinsurance|iffcotokio|hdfcergo|bajajallianz|icicilombard|tataaig|starhealth|nivabupa|acko|godigit|lic|maxlife|policybazaar|insurance)/i
                 .test(`${m.from?.address || ''} ${m.from?.name || ''}`) &&
               /\b(policy|premium|insurance|cover(age)?)\b/i.test(m.subject || '') &&
               /\b(issued|renewed|activated|confirmation|received|successful|generated)\b/i.test(`${m.subject || ''} ${m.text || ''}`),
    extract: (m) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      const policy = matchReference(body, /\b(?:policy|certificate)\s*(?:no\.?|number|id)?\s*[:#-]?\s*([A-Za-z0-9\/-]{6,30})\b/i);
      const money = pickTotalAmount(body);
      const insurer = canonicalMerchant(m.from?.name || (m.from?.address || '').split('@')[1]?.split('.')[0], 'company');

      // Without a policy number this is probably a marketing mail dressed up
      // as a notice; let it fall through rather than invent a commitment.
      if (!policy) return null;

      const kind = /\b(health|medi[\s-]?claim)\b/i.test(body) ? 'health'
                 : /\b(motor|vehicle|car|bike|two[\s-]?wheeler)\b/i.test(body) ? 'motor'
                 : /\b(travel)\b/i.test(body) ? 'travel'
                 : /\b(term|life)\b/i.test(body) ? 'life'
                 : /\b(personal\s+accident|\bPA\b)/.test(body) ? 'personal_accident'
                 : null;

      return withKeys({
        type: 'subscription',
        subtype: 'insurance',
        title: `${insurer?.name || 'Insurance'} policy${money ? ` — ${formatMoney(money.amount, money.currency)}` : ''}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          merchant: insurer?.name || null,
          invoice_number: policy,
          policy_number: policy,
          amount: money?.amount ?? null,
          currency: money?.currency ?? null,
          cover_type: kind,
          category: 'insurance',
        }),
        entities: [entityRef('company', insurer?.name, 'merchant')].filter(Boolean),
        confidence: 0.9,
        extracted_by: 'rules:insurance_policy',
      });
    },
  },

  {
    id: 'utility_bill',
    tier: 1,
    // Electricity, broadband, gas, water. A "payment received" is an event; a
    // "payment overdue" is a reminder about one that has not happened, and
    // recording it would put a thing that did not occur into the ledger.
    when: m => /(jio|airtel|vodafone|\bvi\b|bsnl|cesc|bescom|tatapower|adani|torrentpower|actcorp|hathway|excitel|mahanagar|indianoil|bharatgas|hpcl)/i
                 .test(`${m.from?.address || ''} ${m.from?.name || ''}`) &&
               /\b(payment\s+(received|successful|confirmation)|receipt|bill\s+paid|paid\s+successfully)\b/i
                 .test(`${m.subject || ''} ${m.text || ''}`),
    extract: (m) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      if (/\b(overdue|due\s+(on|by)|reminder|pay\s+now|outstanding)\b/i.test(m.subject || '')
          && !/\b(received|successful|receipt)\b/i.test(m.subject || '')) {
        return null;
      }

      const money = pickTotalAmount(body);
      if (!money) return null;

      const provider = canonicalMerchant(m.from?.name || (m.from?.address || '').split('@')[1]?.split('.')[0], 'company');
      const account = matchReference(body, /\b(?:consumer|account|connection|customer|subscriber)\s*(?:no\.?|number|id)?\s*[:#-]?\s*([A-Za-z0-9-]{4,24})\b/i);
      const receipt = matchReference(body, /\b(?:receipt|transaction|reference)\s*(?:no\.?|number|id)?\s*[:#-]?\s*([A-Za-z0-9-]{4,24})\b/i);

      const period = new Date(m.date).toISOString().slice(0, 7);

      return withKeys({
        type: 'subscription',
        subtype: 'bill_payment',
        title: `${provider?.name || 'Utility'} bill — ${formatMoney(money.amount, money.currency)}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          merchant: provider?.name || null,
          amount: money.amount, currency: money.currency,
          account,
          // One bill per account per month: an identifier even when the
          // receipt number is missing or unparseable.
          invoice_number: receipt || (account ? `${account}-${period}` : null),
          billing_period: period,
          category: 'utilities',
        }),
        entities: [entityRef('company', provider?.name, 'merchant')].filter(Boolean),
        confidence: 0.92,
        extracted_by: 'rules:utility_bill',
      });
    },
  },

  {
    id: 'shopify_order',
    tier: 1,
    // Every Shopify store sends the same template, so one rule covers a long
    // tail of small merchants. The store name is only in the From display name.
    when: m => /shopifyemail\.com|shopify\.com/i.test(m.from?.address || '') ||
               /^order\s*#\d+\s+confirmed/i.test(m.subject || ''),
    extract: (m) => {
      const orderNumber = (m.subject || '').match(/#\s*(\d{3,12})/);
      if (!orderNumber) return null;

      const store = canonicalMerchant(m.from?.name || 'Online store');
      const money = pickTotalAmount(`${m.subject || ''}\n${m.text || ''}`);

      return withKeys({
        type: 'purchase',
        subtype: 'order',
        title: `${store?.name || 'Order'}${money ? ` — ${formatMoney(money.amount, money.currency)}` : ` #${orderNumber[1]}`}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          merchant: store?.name || null,
          order_id: orderNumber[1],
          amount: money?.amount ?? null,
          currency: money?.currency ?? null,
          category: store?.category || 'shopping',
        }),
        entities: [entityRef(store?.type || 'merchant', store?.name, 'merchant')].filter(Boolean),
        confidence: money ? 0.92 : 0.85,
        extracted_by: 'rules:shopify_order',
      });
    },
  },

  {
    id: 'train_booking',
    tier: 1,
    // IRCTC confirmations carry a PNR, which identifies the journey across the
    // booking mail, the payment and any later cancellation.
    when: m => /irctc|indianrail/i.test(m.from?.address || '') &&
               /\b(booking|ticket|confirmation|pnr)\b/i.test(m.subject || ''),
    extract: (m, ctx) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      const pnr = matchReference(body, /\bPNR\s*(?:no\.?|number)?\s*[:#-]?\s*(\d{10})\b/i)
               || matchReference(body, /\b(\d{10})\b/);
      const train = body.match(/\bTrain\s*(?:no\.?|number)?\s*[:#-]?\s*(\d{5})\b/i);
      if (!pnr && !train) return null;

      const route = body.match(/\b([A-Z]{2,5})\s*(?:-|to|→)\s*([A-Z]{2,5})\b/);
      const dateParts = parseDateParts(body);
      const timeParts = parseTimeParts(body);
      const money = pickTotalAmount(body);

      return withKeys({
        type: 'travel',
        subtype: 'train',
        title: `Train${train ? ` ${train[1]}` : ''}${route ? ` ${route[1]} → ${route[2]}` : ''}`,
        occurred_at: dateParts
          ? zonedISO({ ...dateParts, ...(timeParts || {}) }, ctx.timeZone || 'Asia/Kolkata')
          : new Date(m.date).toISOString(),
        data: prune({
          provider: 'IRCTC',
          booking_reference: pnr,
          train_number: train ? train[1] : null,
          origin: route ? route[1] : null,
          destination: route ? route[2] : null,
          amount: money?.amount ?? null,
          currency: money?.currency ?? null,
        }),
        entities: [
          entityRef('company', 'IRCTC', 'provider'),
          entityRef('place', route ? route[2] : null, 'destination'),
        ].filter(Boolean),
        // The booking is certain; which date the journey falls on is read out
        // of prose, so it is the part most likely to be wrong.
        confidence: 0.93,
        extracted_by: 'rules:train_booking',
      });
    },
  },

  {
    id: 'ticket_booking',
    tier: 1,
    when: m => /(district\.in|bookmyshow|insider\.in|paytm.*insider|pvrcinemas|inox|ticketnew)/i.test(m.from?.address || '') &&
               /\b(ticket|booking|confirmed|showtime|order|reservation|table|bill)\b/i.test(m.subject || ''),
    extract: (m) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      const money = pickTotalAmount(body);
      const booking = matchReference(body, /\b(?:booking|order|ticket)\s*(?:id|no\.?|#)\s*[:#-]?\s*([A-Za-z0-9-]{5,24})\b/i);

      // District sells cinema tickets and restaurant bills from the same
      // domain — dining@ is a meal, tickets@ is a show. Filing a dinner under
      // entertainment would put it outside every "what did I spend on food"
      // answer, so the sender decides which this is.
      const dining = /^dining@|^restaurant@/i.test(m.from?.address || '')
                  || /\b(dining|restaurant|table|reservation)\b/i.test(`${m.from?.address || ''} ${m.subject || ''}`);

      if (dining) {
        const place = (m.subject || '').match(/\b(?:at|from|for)\s+([A-Z][A-Za-z0-9 .&'-]{2,40}?)(?=\s*(?:[,.!|]|is\b|on\b|$))/);
        const restaurant = place ? canonicalMerchant(place[1].trim(), 'restaurant') : null;

        return withKeys({
          type: 'food',
          subtype: 'restaurant',
          title: `${restaurant?.name || 'Restaurant'}${money ? ` — ${formatMoney(money.amount, money.currency)}` : ''}`,
          occurred_at: new Date(m.date).toISOString(),
          data: prune({
            restaurant: restaurant?.name || null,
            merchant: 'District',
            amount: money?.amount ?? null,
            currency: money?.currency ?? null,
            booking_reference: booking,
            ordered_via: 'District',
          }),
          entities: [
            entityRef('restaurant', restaurant?.name, 'restaurant'),
            entityRef('merchant', 'District', 'provider'),
          ].filter(Boolean),
          confidence: money ? 0.9 : 0.8,
          extracted_by: 'rules:dining_booking',
        });
      }

      // "Your movie ticket for Spider-Man is confirmed" → Spider-Man
      const title = (m.subject || '').match(/\b(?:ticket|tickets|booking)\s+(?:for|to)\s+(.{2,60}?)(?=\s*(?:[,.!|]|is\b|are\b|$))/i);
      const venue = body.match(/\b(?:at|venue)\s*[:#-]?\s*([A-Z][A-Za-z0-9 .&'-]{2,40}?)(?=\s*(?:[,.\n]|on\b|$))/);

      return withKeys({
        type: 'entertainment',
        subtype: 'movie',
        title: title ? `Ticket — ${title[1].trim()}` : 'Ticket booking',
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          place: venue ? venue[1].trim() : null,
          booking_reference: booking,
          amount: money?.amount ?? null,
          currency: money?.currency ?? null,
          provider: canonicalMerchant((m.from?.address || '').split('@')[1]?.split('.')[0], 'company')?.name || null,
        }),
        entities: [entityRef('place', venue ? venue[1].trim() : null, 'place')].filter(Boolean),
        confidence: 0.88,
        extracted_by: 'rules:ticket_booking',
      });
    },
  },

  {
    id: 'upi_payment',
    tier: 1,
    // "Your payment of ₹ 20.0 to Smartworks Tech Solutions is successful"
    // Amazon Pay, PhonePe, GPay and Paytm all use this shape, and it names the
    // payee — which is what makes it tier 1 rather than a bare card alert.
    when: m => {
      const combined = `${m.subject || ''} ${m.text || ''}`;
      return /\b(payment of|paid|sent|payment successful|refund of)\b/i.test(combined)
          && (/\b(to|for)\s+[A-Z0-9]/.test(combined) || /payment\s+successful/i.test(m.subject || ''));
    },
    extract: (m, ctx) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      // "Your refund of ₹143.44 for Zomato Limited is successful" is the same
      // sentence shape as a payment, pointing the other way.
      const refund = /\brefund\s+of\b/i.test(body);
      const payment = body.match(
        new RegExp(String.raw`\b(?:payment of|refund of|paid|sent)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:₹|rs\.?|inr)?\s*(?:to|for)\s+([A-Za-z0-9][A-Za-z0-9 .&'-]{1,40}?)(?=\s*(?:[,.!\n]|\bis\b|\bwas\b|\bhas\b|\busing\b|\bvia\b|\bon\b|$))`, 'i'));

      let amount = payment ? parseFloat(payment[1].replace(/,/g, '')) : null;
      let payeeName = payment ? payment[2].trim() : null;

      // Gateway receipts put the payee in the subject — "Onpoint - Payment
      // successful" — and the amount somewhere in the body.
      if (!payment && /payment\s+successful/i.test(m.subject || '')) {
        const money = pickTotalAmount(body);
        const fromSubject = (m.subject || '').match(/^\s*([A-Za-z0-9][A-Za-z0-9 .&'-]{1,40}?)\s*[-–|]\s*payment/i);
        if (!money) return null;
        amount = money.amount;
        payeeName = fromSubject ? fromSubject[1].trim() : null;
      }

      if (!Number.isFinite(amount)) return null;

      // "Payment to Easebuzz Private Limited" names the rail that collected
      // the money, not what was bought. Leaving merchant unset is honest, and
      // it also lets the deduplicator match this against the real purchase
      // instead of rejecting it over a name that was never a merchant.
      const payeeIsRail = payeeName ? isPaymentRail(payeeName) : false;
      const payee = payeeName && !payeeIsRail ? canonicalMerchant(payeeName) : null;
      const rail = canonicalMerchant((m.from?.address || '').split('@')[1]?.split('.')[0] || '', 'company');
      const ref = matchReference(body, /\b(?:transaction|txn|reference|utr|order)\s*(?:id|no\.?|number)?\s*[:#-]?\s*([A-Za-z0-9]{6,24})\b/i);

      // Same as the card alert: a UPI payment to a restaurant is a meal seen
      // from the payment's side, and belongs where meals are.
      const food = !refund && isFoodMerchant(payee, ctx.foodMerchants);

      return withKeys({
        type: refund ? 'transfer' : food ? 'food' : 'purchase',
        subtype: refund ? 'refund' : 'upi_payment',
        title: `${payee?.name || (refund ? 'Refund' : 'Payment')}${refund ? ' refund' : ''} — ${formatMoney(amount, 'INR')}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          merchant: payee?.name || null,
          amount, currency: 'INR',
          direction: refund ? 'credit' : 'debit',
          payment_method: payeeIsRail ? canonicalMerchant(payeeName)?.name : (rail?.name || 'UPI'),
          transaction_id: ref,
          category: payee?.category || null,
        }),
        entities: [entityRef(payee?.type || 'merchant', payee?.name, 'merchant')].filter(Boolean),
        confidence: 0.92,
        extracted_by: 'rules:upi_payment',
      });
    },
  },

  {
    id: 'shipment',
    tier: 1,
    // "your CAMPUS order is out for delivery" / "has been delivered".
    // Courier aggregators send these on behalf of whichever brand you bought
    // from, so the brand comes out of the subject, not the sender.
    when: m => /\b(out for delivery|has been delivered|is delivered|shipped|dispatched|on its way|arriving)\b/i
                 .test(m.subject || ''),
    extract: (m) => {
      const subject = m.subject || '';
      const delivered = /\b(has been delivered|is delivered|was delivered)\b/i.test(subject);
      const outFor = /\b(out for delivery|arriving|on its way)\b/i.test(subject);

      // "<Name>, your CAMPUS order is out for delivery" → CAMPUS
      const brandMatch = subject.match(/\byour\s+([A-Z][A-Za-z0-9&.' -]{1,30}?)\s+(?:order|parcel|shipment|package)\b/)
                      || subject.match(/\b(?:order|parcel|shipment)\s+from\s+([A-Za-z0-9][A-Za-z0-9&.' -]{1,30}?)\b/i);
      const brand = brandMatch ? canonicalMerchant(brandMatch[1].trim()) : null;

      const body = `${subject}\n${m.text || ''}`;
      const tracking = matchReference(body, /\b(?:awb|tracking|consignment)\s*(?:no\.?|number|id)?\s*[:#-]?\s*([A-Za-z0-9]{8,24})\b/i);
      const orderId = matchReference(body, /\border\s*(?:id|no\.?|#)\s*[:#-]?\s*([A-Za-z0-9-]{5,24})\b/i);

      return withKeys({
        type: 'delivery',
        subtype: delivered ? 'order_delivered' : outFor ? 'package' : 'order_shipped',
        title: `${brand?.name || 'Parcel'} ${delivered ? 'delivered' : outFor ? 'out for delivery' : 'dispatched'}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          merchant: brand?.name || null,
          carrier: (m.from?.address || '').split('@')[1]?.split('.')[0] || null,
          tracking_number: tracking,
          order_id: orderId,
        }),
        entities: [entityRef(brand?.type || 'merchant', brand?.name, 'merchant')].filter(Boolean),
        // A delivery notice is a reliable fact about a parcel, but which brand
        // it belongs to is read out of a subject line.
        confidence: brand ? 0.9 : 0.8,
        extracted_by: 'rules:shipment',
      });
    },
  },

  {
    id: 'card_alert',
    tier: 2,
    // "Rs.1299.00 was debited from your card ending 1234 at AMAZON on 20-08-26"
    //
    // The old test — a "paid" and a "card" anywhere in the body — matched every
    // merchant receipt that mentions how it was paid, which is most of them.
    // Now it needs a bank-shaped sender or unambiguous debit phrasing.
    when: m => {
      const text = m.text || '';
      const from = m.from?.address || '';
      return (BANK_SENDER.test(from) || HARD_DEBIT.test(text)) && ALERT_SHAPE.test(text);
    },
    extract: (m, ctx) => {
      const text = m.text || '';
      const money = pickTotalAmount(text);
      if (!money) return null;

      // Money moving *onto* the card — a bill payment or a refund — is a real
      // event with the opposite sign, not a purchase. Recording it as one
      // would quietly inflate every spend total.
      const credit = /\b(credited|credit\s+of|received\s+(?:a\s+)?credits?|refund(?:ed)?|added\s+to)\b/i.test(text)
                  && !/\bdebited\b/i.test(text);

      // Non-greedy, with an explicit stop: the descriptor runs straight into
      // " on 18/08/26", which a greedy capture swallows as part of the name.
      // "towards VPA uber@icici (UBER INDIA)" names the payee twice, as a
      // handle and as a person or business. Parsed first because it is the
      // better source: the card-descriptor pattern below cannot cross the '@'
      // in a handle, so on UPI alerts it captures "VPA uber" or nothing.
      const vpa = text.match(/\bVPA\s+(\S+@\S+?)\s*(?:\(([^)]{2,60})\))?/i);
      const vpaHandle = vpa ? vpa[1] : null;
      const vpaName = vpa && vpa[2] ? vpa[2].trim() : null;

      // Non-greedy, with an explicit stop: a card descriptor runs straight
      // into " on 18/08/26", which a greedy capture swallows into the name.
      const at = text.match(
        /\b(?:at|to|towards|in favou?r of)\s+([A-Z0-9][A-Za-z0-9 .&'*-]{1,40}?)(?=\s*(?:[.,;!|\n]|\bon\b\s*\d|\bwith\b|\bfor\b|\bavailable\b|$))/);
      const payeeRaw = at ? at[1].replace(/\s+on$/i, '').trim() : null;

      // Moving money between your own accounts is not spending. Left as a
      // purchase it shows up in the timeline as a shop you never visited, and
      // is added to every total you look at.
      const selfTransfer = isSelfPayee([vpaHandle, vpaName, payeeRaw], ctx.selfIdentifiers);

      const payee = vpaName || payeeRaw || (vpaHandle ? vpaHandle.split('@')[0] : null);
      // A gateway in the payee slot is how it was paid, not where.
      const merchant = payee && !isPaymentRail(payee) ? canonicalMerchant(payee) : null;

      const card = text.match(/\b(?:ending|xx+|ending with|no\.?)\s*(\d{4})\b/i);
      const ref  = matchReference(text, /\b(?:ref(?:erence)?(?:\s*(?:no|id|number))?|txn(?:\s*id)?|transaction id)\s*[:.#-]?\s*([A-Za-z0-9]{6,24})\b/i);
      const issuer = canonicalMerchant(m.from?.name || parseAddress(m.from).name || '', 'company');

      const occurred = resolveOccurredAt(m, text, ctx);

      // A swipe at a restaurant is a meal the ledger happens to have seen from
      // the bank's side. Typed as a purchase it never reaches the Food screen,
      // which is the one place you would add what was on the plate — so where
      // the merchant is somewhere you eat, the event is `food`.
      //
      // The subtype stays `card_transaction`: it is still how this was seen,
      // and the merge rules use exactly that value to let a restaurant's own
      // receipt take over the description when one arrives later.
      const food = !credit && !selfTransfer && isFoodMerchant(merchant, ctx.foodMerchants);

      return withKeys({
        // Neither a credit nor a self-transfer is a purchase. Filing either as
        // one adds it to every spend total, so both become transfers.
        type: (credit || selfTransfer) ? 'transfer' : food ? 'food' : 'purchase',
        subtype: selfTransfer ? 'self_transfer'
               : credit ? (/\brefund/i.test(text) ? 'refund' : 'credit')
               : 'card_transaction',
        title: selfTransfer
          ? `Transfer to own account — ${formatMoney(money.amount, money.currency)}`
          : credit
            ? `${merchant?.name || issuerName(m)} ${/\brefund/i.test(text) ? 'refund' : 'credit'} — ${formatMoney(money.amount, money.currency)}`
            : `${merchant?.name || 'Card transaction'} — ${formatMoney(money.amount, money.currency)}`,
        occurred_at: occurred,
        data: prune({
          merchant: selfTransfer ? null : (merchant?.name || null),
          amount: money.amount, currency: money.currency,
          direction: credit ? 'credit' : 'debit',
          vpa: vpaHandle,
          counterparty: selfTransfer ? 'self' : (vpaName || null),
          payment_method: card ? `card ending ${card[1]}` : 'card',
          account: card ? card[1] : null,
          transaction_id: ref,
          issuer: issuer?.name || null,
          category: merchant?.category || null,
        }),
        entities: [
          // A self-transfer has no merchant to remember.
          selfTransfer ? null : entityRef(merchant?.type || 'merchant', merchant?.name, 'merchant'),
          // `issuer`, not `provider`: the bank is where the money came from,
          // not where it went. Linked as a provider it collects the amount of
          // every transaction on the card and shows up as the biggest merchant
          // in your life.
          entityRef('company', issuer?.name, 'issuer'),
        ].filter(Boolean),
        // Merchant strings on card alerts are mangled ("AMAZON PAY IN*ABCD"),
        // so the amount is a fact and the merchant is a good guess.
        confidence: merchant ? 0.9 : 0.8,
        extracted_by: 'rules:card_alert',
      });
    },
  },

  {
    id: 'amazon_order',
    tier: 1,
    when: m => /amazon/i.test(m.from?.address || '') && /\border\b/i.test(m.subject || ''),
    extract: (m, ctx) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      const orderId = body.match(/\b(\d{3}-\d{7}-\d{7})\b/);
      if (!orderId) return null;

      const money = pickTotalAmount(body);
      const delivered = /\b(delivered|out for delivery)\b/i.test(m.subject || '');
      const dispatched = /\b(dispatched|shipped)\b/i.test(m.subject || '');

      if (delivered || dispatched) {
        return withKeys({
          type: 'delivery',
          subtype: delivered ? 'order_delivered' : 'order_shipped',
          title: `Amazon order ${delivered ? 'delivered' : 'dispatched'}`,
          occurred_at: new Date(m.date).toISOString(),
          data: prune({ merchant: 'Amazon', order_id: orderId[1], tracking_number: orderId[1] }),
          entities: [entityRef('merchant', 'Amazon', 'merchant')],
          confidence: 0.93,
          extracted_by: 'rules:amazon_order',
          relations: [{ related_dedupe_key: `order:amazon:${slugForKey(orderId[1])}`, relationship: 'part_of' }],
        });
      }

      return withKeys({
        type: 'purchase',
        subtype: 'amazon_order',
        title: `Amazon${money ? ` — ${formatMoney(money.amount, money.currency)}` : ' order'}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          merchant: 'Amazon', order_id: orderId[1],
          amount: money?.amount ?? null, currency: money?.currency ?? null,
          category: 'shopping',
        }),
        entities: [entityRef('merchant', 'Amazon', 'merchant')],
        confidence: money ? 0.93 : 0.85,
        extracted_by: 'rules:amazon_order',
      });
    },
  },

  {
    id: 'food_delivery',
    tier: 1,
    when: m => /(swiggy|zomato|blinkit|zepto|instamart|ownly|ctrlx|dominos)/i.test(`${m.from?.address || ''} ${m.from?.name || ''}`) &&
               /\b(order|delivered|bill|receipt)\b/i.test(m.subject || ''),
    extract: (m) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      const money = pickTotalAmount(body);
      const brand = canonicalMerchant(parseAddress(m.from?.address ? `<${m.from.address}>` : m.from).address?.split('@')[1] || m.from?.name);
      // A cancelled order is not a meal. It carries a restaurant, an order
      // number and an amount exactly like a delivered one, and read as food it
      // puts a dinner you never ate on the timeline.
      const reversed = /\b(refund|cancell?(ed|ation))\b/i.test(m.subject || '');
      // Stop at punctuation or a status verb: "from Nagarjuna has been
      // delivered" must yield "Nagarjuna", not the rest of the sentence.
      const named = body.match(
        /\bfrom\s+([A-Z][A-Za-z0-9 .&'-]{1,40}?)(?=\s*(?:[,.!\n]|\bhas\b|\bis\b|\bwas\b|\bwill\b|\bdelivered\b|\bdispatched\b|\bon\b|\bfor\b|$))/);
      const orderId = matchReference(body, /\border\s*(?:id|#|no\.?)\s*[:#-]?\s*([A-Za-z0-9-]{5,24})\b/i);
      const brandFromName = brand || canonicalMerchant(m.from?.name || '');

      // "Alert : Payment Failed for your Order #228036798252397" names a
      // restaurant and an order number for a meal that was never cooked. It is
      // not a purchase and not a refund — nothing happened.
      if (/\b(payment failed|failed|not completed|unsuccessful)\b/i.test(m.subject || '')) return null;

      const platform = brand?.name ? brand : brandFromName;

      // The basket, and the two things only the body knows: which restaurant
      // actually cooked it, and whether this was a meal or a grocery run.
      const order = parseOrderItems(m);

      // "Refund initiated for order #8401094000" carries the order's number,
      // so without a key of its own it matches the order's dedupe key and is
      // absorbed into it — the refund disappears and the order keeps a value
      // that is no longer what was paid. It is a separate event that happens
      // to be *about* the order, which is what event_relations is for.
      if (reversed) {
        const platformKey = platform?.normalized_name || 'unknown';
        return withKeys({
          type: 'transfer',
          subtype: 'refund',
          title: `${platform?.name || 'Refund'} refund${money ? ` — ${formatMoney(money.amount, money.currency)}` : ''}`,
          occurred_at: new Date(m.date).toISOString(),
          dedupe_key: orderId ? `refund:${slugForKey(platformKey)}:${slugForKey(orderId)}` : null,
          data: prune({
            merchant: platform?.name || null,
            amount: money?.amount ?? null,
            currency: money?.currency ?? null,
            direction: 'credit',
            order_id: orderId,
            ordered_via: platform?.name || null,
          }),
          entities: [entityRef('merchant', platform?.name, 'merchant')].filter(Boolean),
          relations: orderId
            ? [{ related_dedupe_key: `order:${slugForKey(platformKey)}:${slugForKey(orderId)}`,
                 relationship: 'refund_for' }]
            : [],
          confidence: money ? 0.9 : 0.75,
          extracted_by: 'rules:food_delivery_refund',
        });
      }

      // Instamart posts from a Swiggy address under a Swiggy sender name, so
      // the sender cannot tell a grocery run from a dinner. Only the subject
      // can, which is what parseOrderItems reads.
      const groceries = order ? order.kind === 'groceries'
                              : /(blinkit|zepto|instamart)/i.test(m.from?.address || '');

      // "Greetings from Swiggy" satisfies the prose pattern, and taking it
      // would record the delivery app as the restaurant — which then becomes
      // the name the deduplicator trusts and the biggest eatery in the ledger.
      const guessed = named?.[1]?.trim() || null;
      const restaurant = order?.restaurant
        || (guessed && normalizeName(guessed) !== platform?.normalized_name ? guessed : null);

      const items = order?.items || [];

      // "The next time you order…" and "We'll deliver even when you don't
      // order" are campaigns that clear the promotional gate — no offer, no
      // discount, just prose about ordering. They used to land as a meal from
      // a restaurant called Zomato. An order leaves something behind: a
      // number, a basket, or an amount. None of the three, no event.
      if (!orderId && !money && !items.length) return null;

      const where = restaurant || order?.vendor || platform?.name || 'Food delivery';

      return withKeys({
        type: 'food',
        subtype: groceries ? 'groceries' : order?.kind === 'dineout' ? 'restaurant' : 'food_delivery',
        title: `${where}${money ? ` — ${formatMoney(money.amount, money.currency)}` : ''}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          restaurant,
          merchant: platform?.name || null,
          // What you ate, as the receipt listed it. Names are facts the sender
          // stated; only the meal it counts as is inferred, and that is
          // derived from the clock at read time rather than stored.
          items,
          // The brand you ordered through, which is not always the company
          // that sent the mail: Instamart and Swiggy share an address.
          ordered_via: order?.vendor || platform?.name || null,
          amount: money?.amount ?? null, currency: money?.currency ?? null,
          order_id: orderId,
        }),
        entities: [
          entityRef('restaurant', restaurant, 'restaurant'),
          entityRef('merchant', platform?.name, 'provider'),
        ].filter(Boolean),
        confidence: money ? 0.9 : 0.78,
        extracted_by: 'rules:food_delivery',
      });
    },
  },

  {
    id: 'cab_receipt',
    tier: 1,
    when: m => /(uber|olacabs|ola|rapido|namma\s*yatri|blusmart)/i.test(m.from?.address || '') &&
               /\b(trip|ride|receipt|journey|invoice|bill)\b/i.test(m.subject || ''),
    extract: (m) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      const money = pickTotalAmount(body);
      const brand = canonicalMerchant((m.from?.address || '').split('@')[1]?.split('.')[0] || m.from?.name);
      if (!money) return null;

      return withKeys({
        type: 'travel',
        subtype: 'cab',
        title: `${brand?.name || 'Cab'} — ${formatMoney(money.amount, money.currency)}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          provider: brand?.name || null,
          amount: money.amount, currency: money.currency,
          category: 'transport',
        }),
        entities: [entityRef('merchant', brand?.name, 'provider')].filter(Boolean),
        confidence: 0.88,
        extracted_by: 'rules:cab_receipt',
      });
    },
  },

  {
    id: 'subscription_receipt',
    tier: 1,
    when: m => (/(apple|google|netflix|spotify|openai|microsoft|adobe|prime|youtube|notion|figma|dropbox|icloud)/i.test(m.from?.address || '')
                || /\b(uber one|swiggy one|zomato gold|prime membership|membership)\b/i.test(`${m.from?.name || ''} ${m.subject || ''}`)) &&
               /\b(receipt|invoice|subscription|renew(ed|al)?|payment|membership)\b/i.test(m.subject || ''),
    extract: (m) => {
      const body = `${m.subject || ''}\n${m.text || ''}`;
      const money = pickTotalAmount(body);
      if (!money) return null;
      const brand = canonicalMerchant((m.from?.address || '').split('@')[1]?.split('.')[0] || m.from?.name, 'company');
      const invoice = matchReference(body, /\b(?:invoice|receipt|order)\s*(?:no\.?|#|id)?\s*[:#-]?\s*([A-Z0-9-]{6,24})\b/i);

      return withKeys({
        type: 'subscription',
        subtype: 'renewal',
        title: `${brand?.name || 'Subscription'} — ${formatMoney(money.amount, money.currency)}`,
        occurred_at: new Date(m.date).toISOString(),
        data: prune({
          merchant: brand?.name || null,
          amount: money.amount, currency: money.currency,
          invoice_number: invoice,
          category: brand?.category || 'subscription',
        }),
        entities: [entityRef(brand?.type || 'company', brand?.name, 'merchant')].filter(Boolean),
        confidence: 0.9,
        extracted_by: 'rules:subscription_receipt',
      });
    },
  },
];

/**
 * Is this payee me?
 *
 * Configured in the `ledger_self_identifiers` setting — UPI handles, the name
 * your bank prints, an account number. Substring matching in both directions,
 * because banks render the same person as "aadityavs@slc" and
 * "ADITYA VIKRAM SINGHANIA".
 */
export function isSelfPayee(candidates, selfIdentifiers = []) {
  if (!selfIdentifiers?.length) return false;

  const mine = selfIdentifiers
    .map(id => normalizeName(String(id)))
    .filter(id => id && id.length >= 4);
  if (!mine.length) return false;

  return candidates.filter(Boolean).some(candidate => {
    const normalized = normalizeName(candidate);
    if (!normalized) return false;
    return mine.some(id => normalized.includes(id) || id.includes(normalized));
  });
}

export function applySenderRules(message, ctx = {}, ruleErrors = []) {
  const matches = [];

  for (const rule of SENDER_RULES) {
    let matched = false;
    try { matched = rule.when(message); } catch { matched = false; }
    if (!matched) continue;
    try {
      const extraction = rule.extract(message, ctx);
      if (extraction) matches.push({ tier: rule.tier ?? 2, extraction });
    } catch (err) {
      // A rule must not take the run down over one odd layout — but silence
      // hid a ReferenceError that disabled a rule on every email it matched.
      // Record it so the probe and the run log can show it.
      ruleErrors.push({ rule: rule.id, error: err.message });
    }
  }

  if (!matches.length) return [];

  // One email, one story. The merchant's own receipt supersedes the payment
  // line inside it; only if nothing more specific matched does the payment
  // rail get to describe the event.
  const best = Math.min(...matches.map(m => m.tier));
  return matches.filter(m => m.tier === best).map(m => m.extraction);
}

// ── Orchestration ──────────────────────────────────────

/** HTML → readable text. Good enough for regexes and for the model's input. */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** The .ics payloads carried by a message, from attachments or inline text. */
function icsPayloads(message) {
  const out = [];
  for (const a of message?.attachments || []) {
    if (!/calendar|\.ics$/i.test(`${a.contentType || ''} ${a.filename || ''}`)) continue;
    const content = typeof a.content === 'string' ? a.content : a.content?.toString('utf8');
    if (content) out.push(content);
  }
  if (/^BEGIN:VCALENDAR/m.test(message?.text || '')) out.push(message.text);
  return out;
}

/**
 * Run layers 1-4 over one message.
 *
 * Returns { decision, reason, extractions, fingerprint }:
 *   extracted — one or more events came out; no model call needed.
 *   llm       — looks transactional, nothing deterministic matched. The caller
 *               decides whether to spend a model call.
 *   reject    — record the source, create no event.
 *
 * `type: 'work'` emails are the deliberate gap here: an email existing is not
 * an event. Work mail becomes a source row and nothing more unless a rule or
 * the model finds a real activity in it.
 */
export function extractDeterministic(message, ctx = {}) {
  const fingerprint = senderFingerprint(message);

  const from = message.from?.address
    ? { name: message.from.name, address: message.from.address }
    : parseAddress(message.from);

  const parseCtx = {
    ...ctx,
    messageDate: message.date,
    senderName: from.name || from.address?.split('@')[1]?.split('.')[0] || null,
  };

  const extractions = [];

  // Layer 2 and 3 run unconditionally. They read data the sender put there
  // deliberately, so even a marketing-wrapped receipt yields the receipt, and
  // a JSON.parse costs nothing worth optimising.
  for (const node of extractJsonLd(message.html)) {
    const extraction = fromSchemaOrg(node, parseCtx);
    if (extraction) extractions.push(extraction);
  }

  for (const ics of icsPayloads(message)) {
    for (const vevent of parseICS(ics)) {
      const extraction = fromICS(vevent, parseCtx);
      if (extraction) extractions.push(extraction);
    }
  }

  if (extractions.length) {
    return { decision: 'extracted', reason: extractions.map(e => e.extracted_by).join(','), extractions, fingerprint };
  }

  const verdict = triage(message, ctx);

  // Layer 4 is regex over prose, which a campaign can trip: "60% off your next
  // order, up to ₹150" has a merchant, an amount and the word order. Rules only
  // run once the email is known not to be a campaign.
  const ruleErrors = [];
  if (!verdict.promotional) {
    extractions.push(...applySenderRules(message, parseCtx, ruleErrors));
    if (extractions.length) {
      return { decision: 'extracted', reason: extractions.map(e => e.extracted_by).join(','),
               extractions, fingerprint, ruleErrors };
    }
  }

  if (verdict.decision === 'inspect') {
    return { decision: 'llm', reason: verdict.reason, extractions: [], fingerprint, ruleErrors };
  }
  return { decision: 'reject', reason: verdict.reason, extractions: [], fingerprint, ruleErrors };
}

/**
 * The text handed to the model: subject, sender, and a truncated body. Never
 * the HTML — it is mostly markup, and markup is billed by the token.
 */
export function prepareForLLM(message, limit = 1500) {
  const body = message.text?.trim() || htmlToText(message.html);
  return [
    `From: ${message.from?.name ? `${message.from.name} ` : ''}<${message.from?.address || 'unknown'}>`,
    `Date: ${message.date instanceof Date ? message.date.toISOString() : message.date}`,
    `Subject: ${message.subject || ''}`,
    '',
    body.slice(0, limit),
  ].join('\n');
}

/**
 * Extraction + message → the payload ledger_ingest_event expects.
 *
 * Pass `extraction: null` for an email that carried no event: the source row is
 * still written, which is what stops the next run from re-reading it and what
 * lets a later correction point at the original mail.
 */
export function buildIngestPayload({ extraction, message, accountKey, storeSnippet = true }) {
  const from = message.from?.address
    ? { name: message.from.name, address: message.from.address }
    : parseAddress(message.from);

  const source = {
    source_type: 'email',
    external_id: message.messageId || `${accountKey}:${message.folder}:${message.uid}`,
    external_url: message.url || null,
    source_timestamp: message.date instanceof Date ? message.date.toISOString() : message.date,
    account_key: accountKey,
    // A pointer, not a copy: enough to find the original again.
    raw_reference: {
      account: accountKey,
      folder: message.folder || null,
      uid: message.uid ?? null,
      message_id: message.messageId || null,
    },
    metadata: prune({
      subject: message.subject || null,
      from: from.address || null,
      from_name: from.name || null,
      fingerprint: senderFingerprint(message),
      // Kept only for debugging an extraction, and purged on the retention
      // schedule by ledger_purge_snippets().
      snippet: storeSnippet ? (message.text || htmlToText(message.html) || '').slice(0, 300) || null : null,
    }),
  };

  if (!extraction) return { source, extracted_by: 'triage' };

  return {
    event: prune({
      occurred_at: extraction.occurred_at,
      occurred_at_end: extraction.occurred_at_end || null,
      type: extraction.type,
      subtype: extraction.subtype || null,
      title: extraction.title,
      description: extraction.description || null,
      data: extraction.data || {},
      inference: extraction.inference || {},
      confidence: extraction.confidence ?? null,
      status: extraction.status || null,
      dedupe_key: extraction.dedupe_key || null,
      source_type: 'email',
    }),
    source,
    entities: extraction.entities || [],
    relations: extraction.relations || [],
    match: extraction.match || {},
    extracted_by: extraction.extracted_by || 'unknown',
  };
}
