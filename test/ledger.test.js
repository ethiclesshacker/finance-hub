// ======================================================
// Tests for the pure ledger core.
//
// These cover the parts where being wrong is expensive and silent: an amount
// misread by a factor of ten, a dedupe key that collides two unrelated
// purchases, a promotional email accepted as a transaction, an inflow counted
// as spending. Every case here comes from something the parser actually got
// wrong against real mail.
//
// Nothing here touches a network or a database — the extraction ladder is pure
// by design, which is what makes it testable at all.
// ======================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeName, canonicalMerchant, parseAmounts, pickTotalAmount,
  parseDateParts, parseTimeParts, zonedISO, localDateISO, parseAddress,
} from '../src/ledger/normalize.js';
import { dedupeKey, deriveDedupeKey } from '../src/ledger/dedupe.js';
import {
  triage, extractJsonLd, fromSchemaOrg, parseICS, fromICS, icsToISO,
  extractDeterministic, senderFingerprint, htmlToText, withKeys, isSelfPayee,
} from '../src/ledger/email.js';
import { parseQuickEntry } from '../src/ledger/nlparse.js';
import { buildDigest, isInflow } from '../src/ledger/summary.js';
import { slugSubtype, isLocalMidnight } from '../ledger/extract/llm.js';
import { resolvePeriod } from '../ledger/jobs/summarize.js';

const SELF = { selfAddresses: ['me@example.com'], timeZone: 'Asia/Kolkata' };
const to = [{ address: 'me@example.com' }];

// ── Normalization ──────────────────────────────────────

test('normalizeName strips punctuation, case and corporate suffixes', () => {
  assert.equal(normalizeName('AMAZON PAY INDIA PRIVATE LIMITED'), 'amazon pay');
  // The suffix list strips "india", not the ".in" TLD — canonicalMerchant is
  // what collapses that, via a token match on "amazon".
  assert.equal(normalizeName('Amazon.in'), 'amazon in');
  assert.equal(normalizeName('  '), null);
  assert.equal(normalizeName(null), null);
});

test('canonicalMerchant collapses aliases and keeps unknown names', () => {
  assert.equal(canonicalMerchant('AMAZON.IN').name, 'Amazon');
  assert.equal(canonicalMerchant('AMAZON PAY INDIA PRIVATE LIMITED').name, 'Amazon');
  // CTRLX Tech is what Ownly looks like on a card statement.
  assert.equal(canonicalMerchant('CTRLX TECH PVT LTD').name, 'Ownly');
  assert.equal(canonicalMerchant('Nagarjuna Restaurant').name, 'Nagarjuna Restaurant');
  assert.equal(canonicalMerchant('Amazon.in').normalized_name, 'amazon');
  assert.equal(canonicalMerchant(''), null);
});

test('canonicalMerchant does not match an alias inside a longer word', () => {
  // "pineapple" must not resolve to Apple.
  assert.notEqual(canonicalMerchant('Pineapple Express').name, 'Apple');
});

test('parseAmounts reads grouped and ungrouped amounts', () => {
  // Regression: "Rs.1299.00" was read as ₹129 because the comma-grouped
  // alternative matched the first three digits.
  assert.equal(parseAmounts('Rs.1299.00 debited')[0].amount, 1299);
  assert.equal(parseAmounts('₹1,299.00')[0].amount, 1299);
  assert.equal(parseAmounts('Rs. 45,000.75')[0].amount, 45000.75);
  assert.equal(parseAmounts('1299.50 INR')[0].amount, 1299.5);
  assert.equal(parseAmounts('$12.99')[0].currency, 'USD');
  assert.deepEqual(parseAmounts('no money here'), []);
});

test('pickTotalAmount prefers the labelled total over the largest number', () => {
  const text = 'Item ₹4,999 discount ₹500 delivery ₹40 Order Total ₹1,299.00';
  assert.equal(pickTotalAmount(text).amount, 1299);
});

test('pickTotalAmount falls back to the only amount present', () => {
  assert.equal(pickTotalAmount('You spent ₹320 at Third Wave').amount, 320);
  assert.equal(pickTotalAmount('nothing here'), null);
});

test('parseDateParts handles the formats Indian senders use', () => {
  assert.deepEqual(parseDateParts('on 20-08-2026 at 16:32'), { year: 2026, month: 7, day: 20 });
  assert.deepEqual(parseDateParts('2026-08-20'), { year: 2026, month: 7, day: 20 });
  assert.deepEqual(parseDateParts('12/08/2025'), { year: 2025, month: 7, day: 12 }); // day-first
  assert.deepEqual(parseDateParts('12-Aug-2025'), { year: 2025, month: 7, day: 12 });
  assert.equal(parseDateParts('no date'), null);
});

test('parseTimeParts reads 24-hour and am/pm', () => {
  assert.deepEqual(parseTimeParts('at 16:32'), { hour: 16, minute: 32 });
  assert.deepEqual(parseTimeParts('around 1pm'), { hour: 13, minute: 0 });
  assert.deepEqual(parseTimeParts('9:05 am'), { hour: 9, minute: 5 });
});

test('zonedISO converts a wall clock in a half-hour zone', () => {
  // 16:32 IST is 11:02 UTC. A naive Date() would be off by the offset.
  assert.equal(zonedISO({ year: 2026, month: 7, day: 20, hour: 16, minute: 32 }, 'Asia/Kolkata'),
               '2026-08-20T11:02:00.000Z');
});

test('localDateISO reports the local day, not the UTC day', () => {
  // 18:45 UTC is already the next day in IST.
  assert.equal(localDateISO('2025-08-12T18:45:00Z', 'Asia/Kolkata'), '2025-08-13');
});

test('parseAddress splits a display name from an address', () => {
  assert.deepEqual(parseAddress('"Amazon.in" <auto@amazon.in>'), { name: 'Amazon.in', address: 'auto@amazon.in' });
  assert.deepEqual(parseAddress('plain@example.com'), { name: null, address: 'plain@example.com' });
});

// ── Deduplication ──────────────────────────────────────

test('dedupeKey refuses to build a key with a missing part', () => {
  assert.equal(dedupeKey('order', 'Amazon', '403-1'), 'order:amazon:403-1');
  // A half-built key would collide every order from that merchant.
  assert.equal(dedupeKey('order', 'Amazon', null), null);
  assert.equal(dedupeKey('order', 'Amazon', ''), null);
});

test('the same order gets the same key from differently-worded sources', () => {
  const fromOrderMail = deriveDedupeKey({ data: { merchant: 'Amazon', order_id: '403-1234567-1234567' } });
  const fromCardAlert = deriveDedupeKey({ data: { merchant: 'AMAZON PAY INDIA PRIVATE LIMITED', order_id: '403-1234567-1234567' } });
  assert.equal(fromOrderMail, fromCardAlert);
});

test('an event with an amount may match across spend types', () => {
  // A card alert arrives as `purchase` and the food order it paid for as
  // `food`. Without a shared type set the two could never be merged, and one
  // dinner would sit in the ledger twice.
  const paid = withKeys({ type: 'purchase', data: { amount: 450, merchant: 'Ownly' } });
  assert.ok(paid.match.types.includes('food'));
  assert.ok(paid.match.types.includes('purchase'));
  assert.equal(paid.match.amount, 450);

  // With no amount to agree on, crossing types would be guesswork.
  const noAmount = withKeys({ type: 'meeting', data: {} });
  assert.deepEqual(noAmount.match.types, ['meeting']);
});

// ── Triage ─────────────────────────────────────────────

test('triage rejects OTPs, newsletters and campaigns', () => {
  assert.equal(triage({ subject: '123456 is your OTP', text: 'code' }, SELF).decision, 'reject');
  assert.equal(triage({ subject: 'Flat 60% OFF your next order', from: { address: 'offers@swiggy.in' },
                        text: 'Order now', to }, SELF).promotional, true);
  assert.equal(triage({ subject: 'Markets today', from: { address: 'noreply@digest.groww.in' },
                        text: 'Rs 237 cr loss confirmed', to }, SELF).decision, 'reject');
});

test('triage rejects a due-date reminder — nothing has happened yet', () => {
  const verdict = triage({ subject: 'Payment overdue for JioAirFiber connection',
                           from: { address: 'notifications@jio.com' },
                           text: 'Your payment of Rs.999 is overdue', to }, SELF);
  assert.equal(verdict.decision, 'reject');
});

test('bulk mail needs a reference number to be worth a model call', () => {
  const newsletter = {
    subject: 'China Closes AI Gap Again',
    from: { address: 'nivedan@example.in' },
    headers: { 'list-unsubscribe': '<https://x>' },
    text: 'The model was confirmed. Funding of $500 million announced.',
    to,
  };
  assert.equal(triage(newsletter, SELF).decision, 'reject');

  const receipt = { ...newsletter, subject: 'Your order', text: 'Order ID: SW123456 delivered. Paid ₹450' };
  assert.equal(triage(receipt, SELF).decision, 'inspect');
});

test('a genuine card alert is worth inspecting', () => {
  const verdict = triage({
    subject: 'Transaction alert', from: { address: 'alerts@mail.hsbc.co.in' },
    text: 'Rs.450.00 debited from your card ending 4321 at SWIGGY', to,
  }, SELF);
  assert.equal(verdict.decision, 'inspect');
});

test('senderFingerprint masks digits so one layout has one fingerprint', () => {
  const a = senderFingerprint({ from: { address: 'x@amazon.in' }, subject: 'Your order 403-1 has shipped' });
  const b = senderFingerprint({ from: { address: 'x@amazon.in' }, subject: 'Your order 999-7 has shipped' });
  assert.equal(a, b);
  const c = senderFingerprint({ from: { address: 'x@amazon.in' }, subject: 'Your refund was processed' });
  assert.notEqual(a, c);
});

// ── Structured extraction ──────────────────────────────

test('schema.org Order is read exactly, with no inference', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'http://schema.org', '@type': 'Order',
    merchant: { '@type': 'Organization', name: 'Amazon.in' },
    orderNumber: '403-1234567-1234567', priceCurrency: 'INR', price: '1299.00',
    acceptedOffer: [{ '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'USB-C cable' }, price: '499' }],
  })}</script>`;

  const [node] = extractJsonLd(html);
  const extraction = fromSchemaOrg(node, { messageDate: '2026-08-20T11:02:00Z' });

  assert.equal(extraction.type, 'purchase');
  assert.equal(extraction.data.amount, 1299);
  assert.equal(extraction.data.order_id, '403-1234567-1234567');
  assert.equal(extraction.dedupe_key, 'order:amazon:403-1234567-1234567');
  assert.ok(extraction.confidence >= 0.95);
});

test('malformed JSON-LD is skipped rather than throwing', () => {
  assert.deepEqual(extractJsonLd('<script type="application/ld+json">{not json</script>'), []);
});

test('a calendar invite becomes a scheduled event, not a confirmed one', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:abc-123',
    'SUMMARY:Product review', 'DTSTART;TZID=Asia/Kolkata:20260901T093000',
    'DTEND;TZID=Asia/Kolkata:20260901T103000', 'ATTENDEE;CN=Asha:mailto:asha@example.com',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\n');

  const [vevent] = parseICS(ics);
  const extraction = fromICS(vevent, { timeZone: 'Asia/Kolkata' });

  // A calendar entry is evidence of a plan, not of a thing that happened.
  assert.equal(extraction.status, 'scheduled');
  assert.equal(extraction.occurred_at, '2026-09-01T04:00:00.000Z');
  assert.equal(extraction.dedupe_key, 'calendar:abc-123:single');
  assert.ok(extraction.entities.some(e => e.type === 'person' && e.name === 'Asha'));
});

test('a cancelled invite is dismissed, so a later sync cannot revive it', () => {
  const ics = ['BEGIN:VCALENDAR', 'METHOD:CANCEL', 'BEGIN:VEVENT', 'UID:abc-123',
               'SUMMARY:Product review', 'DTSTART:20260901T040000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  assert.equal(fromICS(parseICS(ics)[0], {}).status, 'dismissed');
});

test('icsToISO handles UTC, zoned and date-only values', () => {
  assert.equal(icsToISO({ value: '20260901T040000Z', params: {} }), '2026-09-01T04:00:00.000Z');
  assert.equal(icsToISO({ value: '20260901', params: {} }, 'Asia/Kolkata'), '2026-08-31T18:30:00.000Z');
});

// ── The ladder end to end ──────────────────────────────

test('one merchant receipt produces one event, not one per rule', () => {
  // Regression: a Zomato receipt says both "your order from X" and "paid by
  // card", so the food rule and the card rule both fired and the ledger got
  // two events for one dinner.
  const message = {
    subject: 'Your Zomato order from Happiness Dhaba',
    date: new Date('2026-08-11T07:46:00Z'),
    from: { address: 'noreply@zomato.com' },
    text: 'Order ID: 8457098261 from Happiness Dhaba has been delivered. You paid ₹97.21 by card ending 1234.',
    to,
  };

  const result = extractDeterministic(message, SELF);
  assert.equal(result.decision, 'extracted');
  assert.equal(result.extractions.length, 1);
  assert.equal(result.extractions[0].type, 'food');
  assert.equal(result.extractions[0].data.amount, 97.21);
});

test('a promotional email never reaches the regex rules', () => {
  // "60% off your next order, up to ₹150" has a merchant, an amount and the
  // word order — everything a rule looks for, and none of it an event.
  const result = extractDeterministic({
    subject: 'Flat 60% OFF your next order',
    date: new Date(), from: { address: 'offers@zomato.com' },
    text: 'Order now and save up to ₹150 on your next order!', to,
  }, SELF);

  assert.equal(result.decision, 'reject');
  assert.equal(result.extractions.length, 0);
});

test('a card alert keeps the transaction time, not the email time', () => {
  const result = extractDeterministic({
    subject: 'Transaction alert', date: new Date('2026-08-20T18:00:00Z'),
    from: { name: 'HSBC India', address: 'alerts@mail.hsbc.co.in' },
    text: 'Rs.1299.00 has been debited from your card ending 4321 at AMAZON PAY INDIA on 20-08-2026 at 16:32. Ref no: TXN88213344',
    to,
  }, SELF);

  const [extraction] = result.extractions;
  assert.equal(extraction.occurred_at, '2026-08-20T11:02:00.000Z');  // 16:32 IST
  assert.equal(extraction.data.amount, 1299);
  assert.equal(extraction.dedupe_key, 'txn:4321:txn88213344');
});

test('money coming in is a transfer, never a purchase', () => {
  const refund = extractDeterministic({
    subject: 'Your refund of ₹143.44 for Zomato Limited is successful',
    date: new Date(), from: { address: 'no-reply@amazonpay.in' },
    text: 'Your refund of ₹143.44 for Zomato Limited is successful. Transaction ID: 88123456', to,
  }, SELF).extractions[0];

  assert.equal(refund.type, 'transfer');
  assert.equal(refund.data.direction, 'credit');
});

test('a reference capture with no digits in it is rejected', () => {
  // "Mobile Payment Receipt" made the receipt-number pattern capture the word
  // "Payment", which became a dedupe key shared by every bill from that sender.
  const bill = extractDeterministic({
    subject: 'CESC LTD - Mobile Payment Receipt',
    date: new Date('2026-07-31T04:45:00Z'),
    from: { name: 'CESC Ltd', address: 'cesc.receipts@cesc.co.in' },
    text: 'Payment received. Consumer No: 123456789. Amount Paid Rs. 2,450.00. Receipt No: RCP889912', to,
  }, SELF).extractions[0];

  assert.equal(bill.dedupe_key, 'invoice:cesc:rcp889912');
  assert.equal(bill.data.amount, 2450);
});

test('htmlToText strips markup without losing the text', () => {
  const text = htmlToText('<div>Order <b>total</b>:<br>₹1,299</div><script>evil()</script>');
  assert.match(text, /Order total/);
  assert.match(text, /₹1,299/);
  assert.doesNotMatch(text, /evil/);
});

// ── Quick add ──────────────────────────────────────────

test('quick add parses a sentence into a structured event', () => {
  const { event, parsed } = parseQuickEntry('Had lunch at Third Wave around 1pm, ₹320',
                                            { now: new Date('2026-08-22T09:00:00Z'), timeZone: 'Asia/Kolkata' });
  assert.equal(event.type, 'food');
  assert.equal(event.data.restaurant, 'Third Wave Coffee');
  assert.equal(event.data.amount, 320);
  assert.equal(event.data.meal_type, 'lunch');
  assert.equal(event.occurred_at, '2026-08-22T07:30:00.000Z');   // 13:00 IST
  assert.equal(event.status, 'confirmed');
  assert.equal(event.confidence, null);                          // stated by a person, not extracted
  assert.ok(parsed.assumed.includes('assumed_date'));
});

test('quick add records its guesses as inference, never as fact', () => {
  const { event } = parseQuickEntry('Dinner at Nagarjuna, 1250',
                                    { now: new Date('2026-08-22T09:00:00Z'), timeZone: 'Asia/Kolkata' });
  assert.equal(event.data.amount, 1250);
  assert.equal(event.inference.assumed_currency, 'INR');
  assert.ok(event.inference.assumed_time);
  assert.equal(event.data.assumed_time, undefined);
});

test('quick add reads relative days and times of day', () => {
  const now = new Date('2026-08-22T09:00:00Z');
  const yesterday = parseQuickEntry('Bought a keyboard from Amazon for ₹4,999 yesterday', { now });
  assert.match(yesterday.event.occurred_at, /^2026-08-21/);
  assert.equal(yesterday.event.data.merchant, 'Amazon');

  const tonight = parseQuickEntry('Cab to airport ₹640 tonight', { now });
  assert.equal(tonight.event.occurred_at, '2026-08-22T14:30:00.000Z');   // 20:00 IST
});

test('quick add extracts people only from a "who" verb', () => {
  const { event } = parseQuickEntry('Coffee with Rahul yesterday 240', { now: new Date('2026-08-22T09:00:00Z') });
  assert.ok(event.entities.some(e => e.type === 'person' && e.name === 'Rahul'));
});

// ── Summaries ──────────────────────────────────────────

test('a digest counts spending without counting money coming in', () => {
  const events = [
    { id: '1', occurred_at: '2026-08-22T07:30:00Z', type: 'food', subtype: 'meal', title: 'Lunch',
      status: 'confirmed', source_type: 'email', source_count: 1, data: { amount: 320 }, entities: [] },
    { id: '2', occurred_at: '2026-08-22T09:00:00Z', type: 'transfer', subtype: 'refund', title: 'Refund',
      status: 'confirmed', source_type: 'email', source_count: 1, data: { amount: 143, direction: 'credit' }, entities: [] },
    { id: '3', occurred_at: '2026-08-22T10:00:00Z', type: 'purchase', title: 'Dismissed thing',
      status: 'dismissed', source_type: 'email', source_count: 1, data: { amount: 9999 }, entities: [] },
  ];

  const digest = buildDigest(events, { timeZone: 'Asia/Kolkata' });
  assert.equal(digest.spend.total, 320);
  assert.equal(digest.inflow.total, 143);
  assert.equal(digest.event_count, 2);          // dismissed events are not counted
});

test('isInflow recognises both markers', () => {
  assert.equal(isInflow({ type: 'transfer' }), true);
  assert.equal(isInflow({ type: 'purchase', data: { direction: 'credit' } }), true);
  assert.equal(isInflow({ type: 'purchase', data: { direction: 'debit' } }), false);
});

test('a digest names what is missing instead of implying full coverage', () => {
  const digest = buildDigest([
    { id: '1', occurred_at: '2026-08-22T07:30:00Z', type: 'purchase', subtype: 'card_transaction',
      title: 'Card — ₹780', status: 'needs_review', confidence: 0.6, source_type: 'email',
      source_count: 1, data: { amount: 780, merchant: 'Unknown' }, entities: [] },
  ], { timeZone: 'Asia/Kolkata' });

  assert.ok(digest.open_questions.length > 0);
  assert.ok(digest.possibly_missing.some(text => /food/i.test(text)));
});

// ── Model output has to survive the database's constraints ──

test('a model-supplied subtype is shaped to what the column accepts', () => {
  // events.subtype is checked against ^[a-z][a-z0-9_]{1,47}$ and the model
  // answers in prose. Unshaped, the first LLM-extracted appointment fails its
  // check constraint and the extraction is lost.
  const valid = /^[a-z][a-z0-9_]{1,47}$/;

  assert.equal(slugSubtype('medical appointment'), 'medical_appointment');
  assert.equal(slugSubtype('Membership Renewal'), 'membership_renewal');
  assert.equal(slugSubtype('food_delivery'), 'food_delivery');

  // Anything that cannot be shaped into a legal value becomes null rather than
  // a value the insert would reject.
  assert.equal(slugSubtype('9lives'), null);   // must start with a letter
  assert.equal(slugSubtype('x'), null);        // too short
  assert.equal(slugSubtype(''), null);
  assert.equal(slugSubtype(null), null);

  for (const input of ['medical appointment', 'Membership Renewal', 'a'.repeat(60), 'Card Transaction']) {
    const out = slugSubtype(input);
    assert.ok(out === null || valid.test(out), `${input} → ${out}`);
  }
});

test('one order number does not collapse its purchase, parcel and refund', () => {
  // All three carry the same order id. Keyed on the order alone, the dispatch
  // notice and the refund merge into the purchase and stop existing.
  const order = { data: { merchant: 'Campus', order_id: '99881' } };
  const parcel = { type: 'delivery', data: { merchant: 'Campus', order_id: '99881' } };
  const refund = { type: 'transfer', data: { merchant: 'Campus', order_id: '99881' } };

  const keys = [deriveDedupeKey(order), deriveDedupeKey(parcel), deriveDedupeKey(refund)];
  assert.equal(new Set(keys).size, 3, keys.join(' / '));
  assert.equal(keys[0], 'order:campus:99881');
  assert.equal(keys[1], 'parcel:campus:99881');
  assert.equal(keys[2], 'refund:campus:99881');
});

test('a refund is its own event, related to the order rather than merged into it', () => {
  const refund = extractDeterministic({
    subject: 'Refund initiated for order #8401094000',
    date: new Date('2026-07-30T06:00:00Z'),
    from: { address: 'noreply@zomato.com' },
    text: 'Refund of ₹10.64 initiated for order 8401094000',
    to: [{ address: 'me@example.com' }],
  }, SELF).extractions[0];

  assert.equal(refund.type, 'transfer');
  assert.equal(refund.subtype, 'refund');
  assert.equal(refund.data.direction, 'credit');
  assert.equal(refund.data.amount, 10.64);
  // Its own identity...
  assert.equal(refund.dedupe_key, 'refund:zomato:8401094000');
  // ...and a link back to what it refunds.
  assert.deepEqual(refund.relations, [
    { related_dedupe_key: 'order:zomato:8401094000', relationship: 'refund_for' },
  ]);
});

test('a card alert records the purchase, not the credit limit', () => {
  // The real defect: an HSBC alert states the transaction, then the available
  // limit, then the amount due. Nothing on the line matches a "total"-ish
  // word, so a largest-number tie-break recorded a ₹140 coffee as ₹1,90,465.
  const text = 'We are writing to confirm that your HSBC Credit Card xx8965 was used for '
             + 'a transaction of INR 140.00 at TGIF OPULENCE LLP on 18/08/26. '
             + 'Available limit: INR 190465.90 Amount due: INR 17534.10';

  assert.deepEqual(pickTotalAmount(text), { amount: 140, currency: 'INR' });

  const [extraction] = extractDeterministic({
    subject: 'Credit Card Transaction Alert', date: new Date('2026-08-18T12:00:00Z'),
    from: { name: 'HSBC India', address: 'alerts@mail.hsbc.co.in' }, text, to,
  }, SELF).extractions;

  assert.equal(extraction.data.amount, 140);
  // And the merchant stops before the date that follows it.
  assert.equal(extraction.data.merchant, 'Tgif Opulence Llp');
});

test('an email of nothing but limits and balances yields no amount', () => {
  // Better to record no amount than a wrong one: a wrong amount is summed
  // into every total without ever announcing itself.
  assert.equal(pickTotalAmount('Available limit INR 190465.90. Reward points balance 12,500'), null);
  assert.equal(pickTotalAmount('Total amount due INR 17,534.10 by 05/09/26'), null);
});

test('card descriptors and payment rails are not merchant names', () => {
  assert.equal(canonicalMerchant('CAS*ONPOINT').name, 'Onpoint');
  assert.equal(canonicalMerchant('RSP*DISTRICT DINING RZ').name, 'District Dining');
  // Zomato bills as Eternal Limited on card statements.
  assert.equal(canonicalMerchant('ETERNAL LIMITED').name, 'Zomato');
  // Short all-caps stay acronyms rather than becoming "Irctc".
  assert.equal(canonicalMerchant('IRCTC').name, 'IRCTC');
});

test('TZID wins over a stray Z, because senders emit both', () => {
  // Real value from a restaurant booking whose subject read "for 1:00 PM":
  //   DTSTART;TZID=Asia/Kolkata:20260816T130000Z
  // RFC 5545 forbids the combination. Believing the Z put the booking 5½
  // hours late in the timeline.
  assert.equal(
    icsToISO({ value: '20260816T130000Z', params: { TZID: 'Asia/Kolkata' } }, 'Asia/Kolkata'),
    '2026-08-16T07:30:00.000Z');

  // A plain Z with no TZID still means UTC.
  assert.equal(icsToISO({ value: '20260816T130000Z', params: {} }), '2026-08-16T13:00:00.000Z');

  // And a floating time takes the user's zone.
  assert.equal(icsToISO({ value: '20260816T130000', params: {} }, 'Asia/Kolkata'),
               '2026-08-16T07:30:00.000Z');
});

test('a self-transfer is not a purchase', () => {
  // "towards VPA aadityavs@slc (ADITYA VIKRAM SINGHANIA)" — money moved
  // between the user's own accounts. As a purchase it appears in the timeline
  // as a shop that does not exist and inflates every total.
  const [extraction] = extractDeterministic({
    subject: 'You have done a UPI txn', date: new Date('2026-08-20T19:37:00Z'),
    from: { name: 'HDFC Bank', address: 'alerts@hdfcbank.net' }, to,
    text: 'Rs.15000.00 is debited from your account ending 9768 towards VPA aadityavs@slc '
        + '(ADITYA VIKRAM SINGHANIA) on 21-08-26. UPI transaction reference no.: 623320834703.',
  }, { ...SELF, selfIdentifiers: ['aadityavs', 'Aditya Vikram Singhania'] }).extractions;

  assert.equal(extraction.type, 'transfer');
  assert.equal(extraction.subtype, 'self_transfer');
  assert.equal(extraction.data.merchant, undefined);
  assert.equal(isInflow(extraction), true);        // kept out of spend totals
});

test('a UPI payee is read from the VPA name', () => {
  // The card-descriptor pattern cannot cross the '@' in a handle, so on UPI
  // alerts it captures "VPA uber" or nothing at all.
  const [extraction] = extractDeterministic({
    subject: 'You have done a UPI txn', date: new Date('2026-08-20T19:37:00Z'),
    from: { name: 'HDFC Bank', address: 'alerts@hdfcbank.net' }, to,
    text: 'Rs.149.00 is debited from your account ending 9768 towards VPA uber@icici (UBER INDIA) on 21-08-26.',
  }, { ...SELF, selfIdentifiers: ['aadityavs'] }).extractions;

  assert.equal(extraction.data.merchant, 'Uber');
  assert.equal(extraction.data.amount, 149);
});

test('a card-benefits mailer is not a transaction', () => {
  // "Flat INR 120 off on a minimum transaction of INR 500 … spends of INR
  // 50,000" was recorded as a ₹50,000 purchase from a merchant called "INR 4".
  const result = extractDeterministic({
    subject: 'Important communication regarding your MYZONE Credit Card',
    date: new Date('2026-07-28T08:10:00Z'),
    from: { name: 'Axis Bank', address: 'creditcards@axisbank.com' }, to,
    text: 'As a part of our constant endeavour we would like to remind you of the following '
        + 'benefits on your card. Flat INR 120 off on a minimum transaction of INR 500 on Swiggy. '
        + '1 Complimentary domestic airport lounge visit on the spends of INR 50,000. '
        + '1% Fuel surcharge waiver on transactions from INR 400 to INR 4,000 at fuel stations',
  }, SELF);

  assert.equal(result.decision, 'reject');
  assert.equal(result.extractions.length, 0);
});

test('an alert with no time in it uses the email clock, not midnight', () => {
  const at = (text) => extractDeterministic({
    subject: 'Credit Card Transaction Alert', date: new Date('2026-08-18T12:05:00Z'),
    from: { name: 'HSBC', address: 'alerts@mail.hsbc.co.in' }, to, text,
  }, SELF).extractions[0].occurred_at;

  // Date only: a parsed date with no time lands at local midnight, which is
  // both wrong and conspicuous in a timeline.
  assert.equal(at('card xx8965 was used for a transaction of INR 140.00 at TGIF on 18/08/26.'),
               '2026-08-18T12:05:00.000Z');

  // Date and time: believe the body, it is more precise than the send time.
  assert.equal(at('card xx8965 was used for a transaction of INR 140.00 at TGIF on 18/08/26 at 17:30.'),
               '2026-08-18T12:00:00.000Z');
});

test('both HSBC alert templates extract, not just the one I first saw', () => {
  // Tightening the alert pattern to keep a benefits mailer out silently
  // dropped ~20 real alerts a month, because HSBC sends two shapes.
  const alert = (text) => extractDeterministic({
    subject: 'Credit Card Transaction Alert', date: new Date('2026-07-23T12:00:00Z'),
    from: { name: 'HSBC', address: 'hsbc@mail.hsbc.co.in' }, to, text,
  }, SELF).extractions[0];

  const a = alert('We write to confirm that your Credit card no ending with 8965, has been used for '
                + 'INR 189.00 for payment to CTRLX TECHNOLOGIES P on 23 Jul 2026 at 12:41.');
  assert.equal(a.data.amount, 189);
  assert.equal(a.data.merchant, 'Ownly');          // CTRLX Technologies is Ownly

  const b = alert('your HSBC Credit Card xx8965 was used for a purchase transaction of INR 140.00 '
                + 'at TGIF OPULENCE LLP on 18/07/26. Available limit: INR 190465.90');
  assert.equal(b.data.amount, 140);
});

test('a card credit records the credit, not the balance still owed', () => {
  // "We have received credits of ₹484.80 … Kindly make the remaining payment
  // of ₹111,304.81" was recorded as a ₹1.11 lakh credit.
  const [extraction] = extractDeterministic({
    subject: 'We have received credits on your HSBC credit card',
    date: new Date('2026-07-22T18:00:00Z'),
    from: { name: 'HSBC India', address: 'alerts@mail.hsbc.co.in' }, to,
    text: 'We have received credits of ₹ 484.80 on your HSBC credit card ending with 0719 on 22/07/2026. '
        + 'The amount has been adjusted against your outstanding balance. Kindly make the remaining '
        + 'payment of ₹ 111,304.81 within timeline to avoid any finance charges.',
  }, SELF).extractions;

  assert.equal(extraction.data.amount, 484.8);
  assert.equal(extraction.type, 'transfer');
});

test('a balance notification is not an event', () => {
  // "Available balance ... is Rs. 1,000.00" reports a state. Sent to the model,
  // one came back as a ₹15,000 credit that never happened.
  const result = extractDeterministic({
    subject: 'View: Account update for your HDFC Bank A/c',
    date: new Date('2026-07-22T10:00:00Z'),
    from: { name: 'HDFC Bank', address: 'alerts@hdfcbank.bank.in' }, to,
    text: 'Available balance in your account ending XX9768 is Rs. INR 1,000.00 as on 22-JUL-26. '
        + 'The balance in the account does not include the uncleared cheque amount, if any.',
  }, SELF);

  assert.equal(result.decision, 'reject');
  assert.match(result.reason, /balance notification/);
});

// ── Scheduled summaries target the period that finished ──

test('the weekly retrospective summarises the week that ended', () => {
  // It runs Monday 00:10. Taking the week containing "today" made every
  // weekly summary describe a week that was ten minutes old, while the week
  // that actually happened was never summarised.
  const monday = resolvePeriod('week', { today: '2026-08-24' });      // a Monday
  assert.equal(monday.start, '2026-08-17');
  assert.equal(monday.end, '2026-08-23');

  // Mid-week runs behave the same: the last complete week.
  const wednesday = resolvePeriod('week', { today: '2026-08-26' });
  assert.equal(wednesday.start, '2026-08-17');

  // --current asks for the in-progress week explicitly.
  assert.equal(resolvePeriod('week', { today: '2026-08-26', current: true }).start, '2026-08-24');

  // An explicit date means the week containing that date.
  assert.equal(resolvePeriod('week', { date: '2026-08-26', today: '2026-09-30' }).start, '2026-08-24');
});

test('the monthly retrospective summarises the month that ended, in full', () => {
  // It used to run on the 28th and summarise the current month, dropping the
  // last two or three days of every one.
  const first = resolvePeriod('month', { today: '2026-09-01' });
  assert.equal(first.start, '2026-08-01');
  assert.equal(first.end, '2026-08-31');          // the whole month, not to the 28th
  assert.match(first.label, /August 2026/);

  // Year boundary.
  const january = resolvePeriod('month', { today: '2026-01-01' });
  assert.equal(january.start, '2025-12-01');
  assert.equal(january.end, '2025-12-31');

  // February, so the end-of-month arithmetic is doing real work.
  assert.equal(resolvePeriod('month', { today: '2026-03-02' }).end, '2026-02-28');
});

test('a model timestamp at local midnight is not a real time', () => {
  // The model answers with midnight when the email states no time, producing
  // rows reading 00:00 against emails that arrived at 19:24. The first guard
  // tested whether the string contained a time — "…T00:00:00+05:30" does.
  assert.equal(isLocalMidnight('2026-08-18T18:30:00.000Z', 'Asia/Kolkata'), true);   // 00:00 IST
  assert.equal(isLocalMidnight('2026-08-19T00:00:00.000Z', 'Asia/Kolkata'), false);  // 05:30 IST
  assert.equal(isLocalMidnight('2026-08-18T13:54:00.000Z', 'Asia/Kolkata'), false);  // 19:24 IST
  // Same instant, different zone: midnight is a local fact.
  assert.equal(isLocalMidnight('2026-08-19T00:00:00.000Z', 'UTC'), true);
});
