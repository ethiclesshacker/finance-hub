// ======================================================
// Deduplication keys.
//
// The same real-world event arrives from several places: an Amazon order mail,
// a card-transaction alert, maybe a manual note. Only one event should exist,
// with all three sources attached.
//
// Two mechanisms, in order of trust:
//
//   1. dedupe_key — a deterministic identifier both sources agree on (order
//      number, booking reference, transaction id, calendar UID). A unique index
//      on (user_id, dedupe_key) makes this exact and race-proof.
//   2. match keys — amount and merchant/place name, handed to
//      ledger_find_duplicate for scored fuzzy matching inside a time window.
//
// A key is only emitted when every part of it is present. A half-built key
// ("order:amazon:") would collide two unrelated orders, which is worse than no
// key at all — the fuzzy pass is the designed fallback.
// ======================================================

import { canonicalMerchant } from './normalize.js';

function slug(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || null;
}

/** `kind:part:part`, or null if any part is missing. */
export function dedupeKey(kind, ...parts) {
  if (!kind || !parts.length) return null;
  const slugged = parts.map(slug);
  if (slugged.some(p => !p)) return null;
  return [kind, ...slugged].join(':').slice(0, 200);
}

/**
 * The strongest deterministic key an extraction supports, or null.
 *
 * Order matters: an order number identifies the purchase across the order mail,
 * the shipping mail and the card alert, whereas a transaction id only ever
 * appears on the bank's side of it.
 */
export function deriveDedupeKey(extraction) {
  const d = extraction?.data || {};

  // An order number identifies an *order*, and several distinct events refer
  // to one: the purchase, the parcel that ships against it, the refund that
  // reverses it. Namespacing by what kind of event this is keeps them from
  // colliding — otherwise a dispatch notice merges into the purchase and stops
  // being a thing that happened on its own day.
  const kind = extraction?.type === 'delivery' ? 'parcel'
             : extraction?.type === 'transfer' ? 'refund'
             : 'order';
  // Canonical, not merely normalized: the order mail says "Amazon" and the card
  // alert says "AMAZON PAY INDIA PRIVATE LIMITED". Those have to slug the same
  // way or the two sources build two different keys for one purchase.
  const who = canonicalMerchant(d.merchant || d.provider || d.restaurant || d.issuer)?.normalized_name || null;

  // A parcel is best identified by its tracking number when there is one.
  if (kind === 'parcel' && d.tracking_number) return dedupeKey('parcel', who || 'unknown', d.tracking_number);
  if (d.order_id)          return dedupeKey(kind,           who || 'unknown', d.order_id);
  if (d.booking_reference) return dedupeKey('booking',      who || 'unknown', d.booking_reference);
  if (d.invoice_number)    return dedupeKey('invoice',      who || 'unknown', d.invoice_number);
  if (d.transaction_id)    return dedupeKey('txn',          d.account || who || 'unknown', d.transaction_id);
  if (d.calendar_uid)      return dedupeKey('calendar',     d.calendar_uid, d.recurrence_id || 'single');
  if (d.tracking_number)   return dedupeKey('parcel',       who || 'unknown', d.tracking_number);

  // A flight is identified by its number on its date regardless of who sold it.
  if (extraction?.subtype === 'flight' && d.flight_number && d.departure) {
    return dedupeKey('flight', d.flight_number, String(d.departure).slice(0, 10));
  }
  return null;
}

/**
 * Fallback keys for the fuzzy pass. Returning a name with no amount is fine —
 * ledger_find_duplicate scores what it is given — but returning a wrong amount
 * is not, since an amount disagreement disqualifies a match outright.
 */
export function matchKeys(extraction) {
  const d = extraction?.data || {};
  const amount = typeof d.amount === 'number' && Number.isFinite(d.amount) ? d.amount : null;
  const name = d.merchant || d.restaurant || d.provider || d.place || null;
  return { amount, name: name || null };
}
