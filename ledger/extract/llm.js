// ======================================================
// The last rung of the extraction ladder.
//
// Reached only by mail that survived triage, carried no schema.org markup, no
// calendar attachment, and matched no sender rule — and that still reads as
// transactional. Everything here exists to make that set small and to make
// each call cheap:
//
//   - plain text only, truncated (HTML is mostly markup, and markup is billed)
//   - several messages per request
//   - a strict JSON schema, so the reply is parsed, not interpreted
//   - a hard per-run call ceiling from config
//
// The model is asked to classify and extract, never to embellish. What it
// returns lands in `data` as facts *it read*, with a confidence below the
// deterministic layers, so anything shaky surfaces in the review queue rather
// than being quietly asserted.
// ======================================================

import { config } from '../config.js';
import { chat } from './openai.js';
import { isSelfPayee, prepareForLLM, withKeys } from '../../src/ledger/email.js';
import { canonicalMerchant, entityRef } from '../../src/ledger/normalize.js';

const SYSTEM_PROMPT = `You extract real-world life events from transactional email.

Rules:
- Only report an event if the email is evidence that something HAPPENED or WAS BOOKED. An email existing is not an event.
- Marketing, newsletters, OTPs, password resets, social notifications, statements with no transaction, and generic work threads are NOT events.
- Record only what the email states. Never infer an amount, a merchant or a date that is not written in it.
- occurred_at is when the thing happened, not when the email was sent, when the email says so. Otherwise use the email date.
- One email may contain several events (an order and its delivery date). Report each separately.
- Money coming IN — a refund, a salary credit, a card bill payment, a transfer between the person's own accounts — is type "transfer", never "purchase". Filing it as a purchase adds it to their spending.
- A balance notification ("available balance is X") reports a state. Nothing happened; it is not an event.
- confidence: 0.9 if the email states everything plainly; 0.75-0.85 if you had to interpret layout; below 0.75 if you are unsure.`;

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'is_event', 'reason', 'events'],
        properties: {
          index: { type: 'integer', description: 'The email number this refers to.' },
          is_event: { type: 'boolean' },
          reason: { type: 'string', description: 'One short clause. Why it is or is not an event.' },
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'subtype', 'title', 'occurred_at', 'confidence',
                         'amount', 'currency', 'merchant', 'place', 'people',
                         'order_id', 'booking_reference', 'category', 'notes'],
              properties: {
                type: { type: 'string', enum: ['purchase', 'food', 'travel', 'delivery', 'subscription',
                                               'meeting', 'work', 'health', 'entertainment', 'appointment',
                                               'activity', 'location', 'transfer', 'other'] },
                subtype: { type: ['string', 'null'] },
                title: { type: 'string', description: 'Under 80 characters. What happened.' },
                occurred_at: { type: 'string', description: 'ISO 8601 with offset.' },
                confidence: { type: 'number' },
                amount: { type: ['number', 'null'] },
                currency: { type: ['string', 'null'] },
                merchant: { type: ['string', 'null'] },
                place: { type: ['string', 'null'] },
                people: { type: 'array', items: { type: 'string' } },
                order_id: { type: ['string', 'null'] },
                booking_reference: { type: ['string', 'null'] },
                category: { type: ['string', 'null'] },
                notes: { type: ['string', 'null'], description: 'Interpretation, kept apart from the facts.' },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Ask the model about a batch of messages.
 *
 * Returns a Map of message index → extractions. A failure returns an empty map
 * rather than throwing: the deterministic ledger is still worth having when
 * the model is down, and these messages simply stay unclassified until the
 * next run.
 */
export async function extractWithLLM(messages, options = {}) {
  if (!config.llm.enabled) return { results: new Map(), calls: 0, skipped: 'llm disabled' };
  if (!config.llm.apiKey) return { results: new Map(), calls: 0, skipped: 'OPENAI_API_KEY not set' };
  if (!messages.length) return { results: new Map(), calls: 0 };

  const numbered = messages.map((message, i) =>
    `--- EMAIL ${i} ---\n${prepareForLLM(message, options.textLimit ?? 1500)}`).join('\n\n');

  const { ok, content, usage, error } = await chat({
    job: 'ingest:extract',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content:
        `Today is ${new Date().toISOString()}. Timezone: ${config.timeZone}.\n\n` +
        `Classify each email below. Return one result per email, using its number as "index".\n\n${numbered}` },
    ],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'event_extraction', strict: true, schema: EVENT_SCHEMA },
    },
  });

  if (!ok) return { results: new Map(), calls: 1, error };

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { results: new Map(), calls: 1, error: 'completion was not valid JSON' };
  }

  const results = new Map();
  for (const result of parsed.results || []) {
    const message = messages[result.index];
    if (!message) continue;
    results.set(result.index, {
      isEvent: Boolean(result.is_event),
      reason: result.reason || '',
      extractions: (result.events || []).map(e => toExtraction(e, message, options)).filter(Boolean),
    });
  }

  return { results, calls: 1, usage };
}

/**
 * Model output → the same extraction shape the deterministic layers produce,
 * so everything downstream — dedupe keys, entity resolution, storage — is
 * identical regardless of which rung produced it.
 *
 * `notes` is the model's interpretation and goes to `inference`. It never
 * reaches `data`, which holds only what a source stated.
 */
function toExtraction(raw, message, options = {}) {
  if (!raw?.type || !raw?.title) return null;

  // Money arriving from your own other account names you as the counterparty.
  // Recorded as a person, you become an entity in your own ledger — and in
  // three spellings, because each source writes your name differently.
  const selfIdentifiers = options.selfIdentifiers || [];
  const people = (raw.people || []).filter(name => !isSelfPayee([name], selfIdentifiers));
  const isSelf = raw.type === 'transfer'
    && (raw.people || []).length > 0
    && people.length === 0;

  // A model with no time to work from answers with local midnight, which shows
  // up in the timeline as a run of 00:00 rows against emails that arrived at
  // 19:24. Judge the resulting instant, not the string: "…T00:00:00+05:30"
  // does contain a time, so testing for one let every case through.
  //
  // A real event at exactly 00:00:00 local is vanishingly rare, and where the
  // email itself arrived at midnight the fallback returns the same answer, so
  // this cannot make a correct timestamp worse.
  const stated = safeDate(raw.occurred_at);
  const zone = options.timeZone || config.timeZone;
  const occurredAt = (!stated || isLocalMidnight(stated, zone))
    ? new Date(message.date).toISOString()
    : stated;
  const merchant = raw.merchant ? canonicalMerchant(raw.merchant, raw.type === 'food' ? 'restaurant' : 'merchant') : null;

  const data = {};
  if (merchant) {
    if (raw.type === 'food') data.restaurant = merchant.name;
    else data.merchant = merchant.name;
  }
  if (typeof raw.amount === 'number' && Number.isFinite(raw.amount)) {
    data.amount = raw.amount;
    data.currency = raw.currency || 'INR';
  }
  if (raw.place) data.place = raw.place;
  if (raw.order_id) data.order_id = raw.order_id;
  if (raw.booking_reference) data.booking_reference = raw.booking_reference;
  if (raw.category) data.category = raw.category;

  // Capped below the confirmed threshold, whatever the model says about
  // itself. An extraction that was read off a regex and one that was inferred
  // from prose should not be able to arrive at the same status.
  const confidence = Math.min(Math.max(Number(raw.confidence) || 0.7, 0.3), 0.88);

  return withKeys({
    type: raw.type,
    subtype: isSelf ? 'self_transfer' : slugSubtype(raw.subtype),
    // Filtering the people list is not enough — the model also writes the name
    // into the title ("Received bank transfer from Aditya Vikram Singhania"),
    // which puts you in your own ledger as a counterparty to yourself.
    title: isSelf ? 'Transfer between your own accounts' : String(raw.title).slice(0, 300),
    description: null,
    occurred_at: occurredAt,
    data,
    inference: raw.notes ? { llm_note: raw.notes, model: config.llm.model } : { model: config.llm.model },
    entities: [
      merchant ? entityRef(merchant.type, merchant.name, raw.type === 'food' ? 'restaurant' : 'merchant') : null,
      raw.place ? entityRef('place', raw.place, 'place') : null,
      ...people.map(p => entityRef('person', p, 'person')),
    ].filter(Boolean),
    confidence,
    extracted_by: `llm:${config.llm.model}`,
  });
}

/**
 * The database constrains subtype to `^[a-z][a-z0-9_]{1,47}$`, and the model
 * returns prose: "medical appointment", "membership renewal". Left alone, the
 * first LLM-extracted event of each kind fails its check constraint and the
 * whole extraction is lost — so the value is shaped here rather than trusted.
 */
export function slugSubtype(value) {
  if (!value) return null;
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return /^[a-z][a-z0-9_]{1,47}$/.test(slug) ? slug : null;
}

export function isLocalMidnight(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(iso));
  const at = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${at.hour}:${at.minute}:${at.second}` === '00:00:00';
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
