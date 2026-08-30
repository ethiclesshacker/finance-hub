// ======================================================
// The Hermes tool layer.
//
// Nine tools that map one-to-one onto the ledger's questions, plus a few that
// earn their place. Each is a thin wrapper over a SQL function — the logic
// lives in the database, so Hermes, the browser and a future client all get
// identical behaviour, and removing Hermes removes nothing but a caller.
//
// Two ways to reach it:
//   - shell out:  node ledger/cli.js tool search_events '{"query":"amazon"}'
//   - import it:  import { runTool, TOOL_SPECS } from './ledger/tools.js'
//
// A hosted Hermes with the user's JWT can skip this file entirely and POST to
// /rest/v1/rpc/ledger_search_events, where RLS enforces the same ownership
// rules. This module exists for the local case, where the service role is
// already on the machine.
//
// TOOL_SPECS is emitted in JSON-Schema function-calling form, so it can be
// handed to a model as a tool list without transformation.
// ======================================================

import { config } from './config.js';
import { db, resolveUserId } from './db.js';
import { parseQuickEntry, parseMealEntry } from '../src/ledger/nlparse.js';
import { dishName, summariseItems } from '../src/ledger/items.js';
import { localDateISO } from '../src/ledger/normalize.js';

async function rpc(fn, args) {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
  return data;
}



/**
 * Turn a date expression into an instant range.
 *
 * Accepts ISO dates, ISO instants, and the phrases a person actually uses.
 * Hermes should not have to do calendar arithmetic to ask "what did I spend on
 * food this month".
 */
export function resolveRange(range, timeZone = config.timeZone) {
  if (!range) return { from: null, to: null };
  if (typeof range === 'object' && (range.from || range.to)) {
    return { from: toInstant(range.from, timeZone, false), to: toInstant(range.to, timeZone, true) };
  }

  const phrase = String(range).trim().toLowerCase();
  const today = localDateISO(new Date(), timeZone);
  const day = (iso, offset) => shiftDate(iso, offset);

  const named = {
    today:      [today, today],
    yesterday:  [day(today, -1), day(today, -1)],
    'this week':  [startOfWeek(today), today],
    'last week':  [shiftDate(startOfWeek(today), -7), shiftDate(startOfWeek(today), -1)],
    'this month': [today.slice(0, 8) + '01', today],
    'last month': lastMonth(today),
    'this year':  [today.slice(0, 4) + '-01-01', today],
  };

  if (named[phrase]) {
    const [from, to] = named[phrase];
    return { from: toInstant(from, timeZone, false), to: toInstant(to, timeZone, true) };
  }

  const lastN = phrase.match(/^last\s+(\d{1,3})\s+days?$/);
  if (lastN) {
    return { from: toInstant(shiftDate(today, -parseInt(lastN[1], 10)), timeZone, false),
             to: toInstant(today, timeZone, true) };
  }

  // A bare date or instant means that single day.
  return { from: toInstant(phrase, timeZone, false), to: toInstant(phrase, timeZone, true) };
}

function toInstant(value, timeZone, endOfDay) {
  if (!value) return null;
  const text = String(value);
  if (/T\d{2}:\d{2}/.test(text)) return new Date(text).toISOString();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : localDateISO(new Date(text), timeZone);
  return zoneMidnight(endOfDay ? shiftDate(date, 1) : date, timeZone);
}

function zoneMidnight(isoDate, timeZone) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return new Date(guess - (asUTC - guess)).toISOString();
}

function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function startOfWeek(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return shiftDate(isoDate, -((date.getUTCDay() + 6) % 7));
}
function lastMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1));
  const end = new Date(Date.UTC(y, m - 1, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

// ── The tools ──────────────────────────────────────────

export const TOOLS = {
  search_events: {
    description: 'Search the event ledger by text, type, entity, status and date range. The primary way to answer questions about what happened.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against titles, descriptions and event data.' },
        types: { type: 'array', items: { type: 'string' }, description: 'e.g. ["purchase","food"]' },
        subtypes: { type: 'array', items: { type: 'string' } },
        statuses: { type: 'array', items: { type: 'string' }, description: 'Omit to exclude dismissed events.' },
        source_types: { type: 'array', items: { type: 'string' } },
        entity_name: { type: 'string', description: 'Restrict to events linked to this merchant/person/place.' },
        date_range: { description: 'ISO dates, {from,to}, or a phrase like "last 30 days" / "this month".' },
        min_confidence: { type: 'number' },
        limit: { type: 'integer', default: 50 },
        offset: { type: 'integer', default: 0 },
      },
    },
    handler: async (args) => {
      const { from, to } = resolveRange(args.date_range);
      return rpc('ledger_search_events', {
        p_query: args.query ?? null,
        p_types: args.types ?? null,
        p_subtypes: args.subtypes ?? null,
        p_statuses: args.statuses ?? null,
        p_source_types: args.source_types ?? null,
        p_entity_id: args.entity_id ?? null,
        p_entity_name: args.entity_name ?? null,
        p_from: from, p_to: to,
        p_min_confidence: args.min_confidence ?? null,
        p_limit: args.limit ?? 50,
        p_offset: args.offset ?? 0,
        p_ascending: args.ascending ?? false,
        p_user_id: await resolveUserId(),
      });
    },
  },

  get_event: {
    description: 'One event in full: structured fields, every source it came from, related entities and events, and its edit history.',
    parameters: { type: 'object', required: ['event_id'], properties: { event_id: { type: 'string' } } },
    handler: args => rpc('ledger_get_event', { p_event_id: args.event_id }),
  },

  create_event: {
    description: 'Record something that happened. Use natural_language for a phrase like "dinner at Nagarjuna last night, 1250", or pass structured fields directly.',
    parameters: {
      type: 'object',
      properties: {
        natural_language: { type: 'string' },
        occurred_at: { type: 'string', description: 'ISO 8601.' },
        type: { type: 'string' },
        subtype: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        data: { type: 'object', description: 'Facts: merchant, amount, currency, place, order_id…' },
        entities: { type: 'array', items: { type: 'object' } },
        allow_merge: { type: 'boolean', default: true, description: 'False forces a separate event even if a similar one exists.' },
      },
    },
    handler: async (args) => {
      let event = { ...args };
      let entities = args.entities || [];

      if (args.natural_language) {
        const parsed = parseQuickEntry(args.natural_language, { timeZone: config.timeZone });
        if (!parsed) throw new Error('Could not parse that phrase into an event.');
        event = { ...parsed.event, ...stripUndefined(args) };
        entities = args.entities || parsed.event.entities;
      }

      if (!event.occurred_at) throw new Error('occurred_at is required (or pass natural_language).');
      if (!event.title) throw new Error('title is required (or pass natural_language).');

      return rpc('ledger_create_event', {
        p_event: {
          occurred_at: event.occurred_at,
          occurred_at_end: event.occurred_at_end ?? null,
          type: event.type || 'note',
          subtype: event.subtype ?? null,
          title: event.title,
          description: event.description ?? null,
          data: event.data || {},
          inference: event.inference || {},
          status: 'confirmed',
        },
        p_entities: entities,
        p_source_type: 'hermes',
        p_allow_merge: args.allow_merge !== false,
        p_user_id: await resolveUserId(),
      });
    },
  },

  update_event: {
    description: 'Correct an event. A correction from a person overwrites extracted values; the previous values are kept in the audit log.',
    parameters: {
      type: 'object', required: ['event_id', 'changes'],
      properties: {
        event_id: { type: 'string' },
        changes: { type: 'object', description: 'Any of occurred_at, type, subtype, title, description, data, inference, status, confidence.' },
        replace_data: { type: 'boolean', default: false, description: 'True replaces data wholesale instead of merging.' },
      },
    },
    handler: args => rpc('ledger_update_event', {
      p_event_id: args.event_id, p_changes: args.changes, p_replace_data: Boolean(args.replace_data),
    }),
  },

  delete_or_dismiss_event: {
    description: 'Dismiss an event that did not happen (reversible, keeps provenance, stops re-creation), or delete it outright with hard=true.',
    parameters: {
      type: 'object', required: ['event_id'],
      properties: {
        event_id: { type: 'string' },
        reason: { type: 'string' },
        hard: { type: 'boolean', default: false },
        purge_sources: { type: 'boolean', default: false, description: 'With hard=true, also remove source rows nothing else references.' },
      },
    },
    handler: args => args.hard
      ? rpc('ledger_delete_event', { p_event_id: args.event_id, p_purge_sources: Boolean(args.purge_sources) })
      : rpc('ledger_dismiss_event', { p_event_id: args.event_id, p_reason: args.reason ?? null }),
  },

  log_meal: {
    description:
      'Record a meal: what was eaten, where and when. Use natural_language for a phrase like '
      + '"2 packets maggi with 3 cheese slices", "had 2 idlis and a vada at Veena Stores at 7:30am" or '
      + '"going to Ravi\'s place for dinner" — the last of which is a plan, and is stored as `scheduled` '
      + 'with no dishes until there are dishes to add. Dish names are snapped to the spellings already in '
      + 'the ledger, so "maggi" joins the Maggi you have eaten before instead of starting a second one. '
      + 'A meal carries no amount unless one is stated: eating is not buying, and the grocery order that '
      + 'paid for it is its own event.',
    parameters: {
      type: 'object',
      properties: {
        natural_language: { type: 'string', description: 'One sentence about the meal.' },
        occurred_at: { type: 'string', description: 'ISO 8601. Overrides whatever the sentence implied.' },
        place: { type: 'string', description: 'Restaurant, shop or "Ravi\'s place". Omit for home.' },
        items: {
          type: 'array',
          description: 'What was eaten. Overrides the dishes read from the sentence.',
          items: {
            type: 'object', required: ['name'],
            properties: {
              name: { type: 'string' },
              qty: { type: 'integer', default: 1 },
              amount: { type: 'number', description: 'Per-item price, when the receipt stated one.' },
            },
          },
        },
        amount: { type: 'number', description: 'What the meal cost, if it was paid for here.' },
        status: { type: 'string', enum: ['confirmed', 'scheduled'], description: 'Defaults to what the tense implies.' },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const parsed = args.natural_language
        ? parseMealEntry(args.natural_language, { timeZone: config.timeZone })
        : null;
      if (args.natural_language && !parsed) throw new Error('Could not read a meal out of that phrase.');

      const items = await snapDishes(args.items ?? parsed?.parsed.items ?? [], userId);
      const place = args.place ?? parsed?.parsed.place ?? null;
      const occurredAt = args.occurred_at ?? parsed?.parsed.occurred_at ?? new Date().toISOString();
      const amount = args.amount ?? parsed?.parsed.amount ?? null;

      if (!items.length && !place) {
        throw new Error('A meal needs at least one dish or a place. "going to Ravi\'s for dinner" is enough; "ate" is not.');
      }

      const data = stripUndefined({
        restaurant: place,
        items: items.length ? items : undefined,
        amount,
        currency: amount ? 'INR' : undefined,
        meal_type: parsed?.parsed.meal ?? undefined,
      });

      const result = await rpc('ledger_create_event', {
        p_event: {
          occurred_at: occurredAt,
          type: 'food',
          subtype: 'meal',
          title: place || summariseItems(items, 3) || 'Meal',
          description: args.natural_language ?? null,
          data,
          inference: parsed?.event.inference ?? {},
          status: args.status ?? parsed?.parsed.status ?? 'confirmed',
        },
        p_entities: parsed?.event.entities?.length ? parsed.event.entities : [],
        p_source_type: 'hermes',
        // Eating is not buying. A meal with no amount gives the fuzzy matcher
        // nothing but a timestamp, and it would fold "ate two things from the
        // fridge" into the grocery order that paid for them.
        p_allow_merge: false,
        p_user_id: userId,
      });

      return { ...result, understood: { place, items, occurred_at: occurredAt, status: args.status ?? parsed?.parsed.status ?? 'confirmed' } };
    },
  },

  add_meal_items: {
    description:
      'Add dishes to a meal already in the ledger — the "I will tell you what I ate later" half of log_meal. '
      + 'Pass event_id, or a date_range and the nearest food event in it is used. Quantities of a dish '
      + 'already listed are added together rather than duplicated, and a meal that was only planned becomes '
      + 'confirmed, since knowing what was on the plate is evidence it happened.',
    parameters: {
      type: 'object', required: ['items'],
      properties: {
        event_id: { type: 'string' },
        date_range: { description: 'Used when event_id is absent. Defaults to today.' },
        items: {
          type: 'array',
          items: {
            type: 'object', required: ['name'],
            properties: { name: { type: 'string' }, qty: { type: 'integer', default: 1 }, amount: { type: 'number' } },
          },
        },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      if (!args.items?.length) throw new Error('Nothing to add.');

      const event = args.event_id
        ? await rpc('ledger_get_event', { p_event_id: args.event_id })
        : await latestMeal(args.date_range ?? 'today', userId);
      if (!event) throw new Error('No meal found to add to. Search for it first, or pass event_id.');

      const merged = [...(event.data?.items ?? [])];
      for (const item of await snapDishes(args.items, userId)) {
        const existing = merged.find(i => sameName(i.name, item.name));
        if (existing) existing.qty = (existing.qty || 1) + (item.qty || 1);
        else merged.push(item);
      }

      const changes = { data: { items: merged } };
      // A plan with a plate on it is not a plan any more.
      if (event.status === 'scheduled') changes.status = 'confirmed';

      const updated = await rpc('ledger_update_event', {
        p_event_id: event.id, p_changes: changes, p_replace_data: false,
      });
      return { event_id: event.id, items: merged, status: updated?.status ?? changes.status ?? event.status };
    },
  },

  get_daily_summary: {
    description: 'The stored summary for one day, with a live event count so a stale summary is visible as stale.',
    parameters: { type: 'object', required: ['date'], properties: { date: { type: 'string', description: 'YYYY-MM-DD' } } },
    handler: async args => rpc('ledger_get_daily_summary', { p_date: args.date, p_user_id: await resolveUserId() }),
  },

  get_period_summary: {
    description: 'A week or month: the stored retrospective if one exists, plus live aggregates and the daily summaries inside it.',
    parameters: {
      type: 'object', required: ['start_date', 'end_date'],
      properties: {
        start_date: { type: 'string' }, end_date: { type: 'string' },
        period_type: { type: 'string', enum: ['week', 'month', 'quarter', 'year'], default: 'week' },
      },
    },
    handler: async args => rpc('ledger_get_period_summary', {
      p_start: args.start_date, p_end: args.end_date,
      p_period_type: args.period_type || 'week', p_user_id: await resolveUserId(),
    }),
  },

  get_entity: {
    description: 'One merchant, person, place or project: how often it appears, when it was first and last seen, and the total spent with it.',
    parameters: { type: 'object', required: ['entity_id'], properties: { entity_id: { type: 'string' } } },
    handler: args => rpc('ledger_get_entity', { p_entity_id: args.entity_id }),
  },

  search_entity_events: {
    description: 'Every event linked to an entity. "What have I bought from Amazon", "when was I last in Hyderabad", "meetings with this person".',
    parameters: {
      type: 'object', required: ['entity_id'],
      properties: { entity_id: { type: 'string' }, date_range: {}, limit: { type: 'integer', default: 100 } },
    },
    handler: async (args) => {
      const { from, to } = resolveRange(args.date_range);
      return rpc('ledger_search_entity_events', {
        p_entity_id: args.entity_id, p_from: from, p_to: to, p_limit: args.limit ?? 100,
      });
    },
  },

  // ── Beyond the nine, because these answer real questions ──

  search_entities: {
    description: 'Find entities by name. Use this to turn "Amazon" into an entity_id before calling search_entity_events.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, type: { type: 'string' }, limit: { type: 'integer', default: 25 } },
    },
    handler: async args => rpc('ledger_search_entities', {
      p_query: args.query ?? null, p_type: args.type ?? null,
      p_limit: args.limit ?? 25, p_user_id: await resolveUserId(),
    }),
  },

  get_stats: {
    description: 'Aggregates over a period: counts by type, spend by category, top entities, how much needs review. Computed from events at call time, never stored.',
    parameters: { type: 'object', properties: { date_range: {} } },
    handler: async (args) => {
      const { from, to } = resolveRange(args.date_range);
      return rpc('ledger_stats', { p_from: from, p_to: to, p_user_id: await resolveUserId() });
    },
  },

  get_review_queue: {
    description: 'Events the system is unsure about, for confirming, correcting, merging or dismissing.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', default: 50 } } },
    handler: async args => rpc('ledger_review_queue', { p_limit: args.limit ?? 50, p_user_id: await resolveUserId() }),
  },

  merge_events: {
    description: 'Fold a duplicate into a target event. All evidence moves across; the target keeps its facts.',
    parameters: {
      type: 'object', required: ['target_event_id', 'duplicate_event_id'],
      properties: { target_event_id: { type: 'string' }, duplicate_event_id: { type: 'string' } },
    },
    handler: args => rpc('ledger_merge_events', {
      p_target: args.target_event_id, p_duplicate: args.duplicate_event_id,
    }),
  },

  export_ledger: {
    description: 'Everything, as JSON: events with their sources, entities and summaries. The data is yours and portable.',
    parameters: { type: 'object', properties: { date_range: {} } },
    handler: async (args) => {
      const { from, to } = resolveRange(args.date_range);
      return rpc('ledger_export', { p_from: from, p_to: to, p_user_id: await resolveUserId() });
    },
  },
};

/** Function-calling schema for every tool, ready to hand to a model. */
export const TOOL_SPECS = Object.entries(TOOLS).map(([name, spec]) => ({
  type: 'function',
  function: { name, description: spec.description, parameters: spec.parameters },
}));

export async function runTool(name, args = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`);
  return tool.handler(args);
}

const sameName = (a, b) =>
  String(a).toLowerCase().replace(/\s+/g, ' ').trim() === String(b).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Snap dish names to the spellings the ledger already holds.
 *
 * Without this, "maggi", "Maggi" and "MAGGI" are three dishes in the ranking of
 * what you eat most, and the one you actually eat weekly looks like three
 * things you tried once.
 */
async function snapDishes(items, userId) {
  const list = (items || [])
    .filter(item => item?.name && String(item.name).trim())
    .map(item => ({
      name: dishName(item.name),
      qty: Number.isFinite(Number(item.qty)) && Number(item.qty) > 0 ? Math.round(Number(item.qty)) : 1,
      ...(Number.isFinite(Number(item.amount)) ? { amount: Number(item.amount) } : {}),
    }));
  if (!list.length) return [];

  let known = new Map();
  try {
    const result = await rpc('ledger_search_events', {
      p_query: null, p_types: ['food'], p_subtypes: null, p_statuses: null, p_source_types: null,
      p_entity_id: null, p_entity_name: null, p_from: null, p_to: null, p_min_confidence: null,
      p_limit: 300, p_offset: 0, p_ascending: false, p_user_id: userId,
    });
    for (const event of result?.events || []) {
      for (const item of event.data?.items || []) {
        if (item?.name) known.set(String(item.name).toLowerCase().replace(/\s+/g, ' ').trim(), item.name);
      }
    }
  } catch {
    // A catalogue we could not read is a spelling we do not correct, not a
    // meal we refuse to record.
    known = new Map();
  }

  return list.map(item => ({ ...item, name: known.get(item.name.toLowerCase().replace(/\s+/g, ' ').trim()) || item.name }));
}

/** The food event nearest to now inside a range — "the dinner I mentioned". */
async function latestMeal(range, userId) {
  const { from, to } = resolveRange(range);
  const result = await rpc('ledger_search_events', {
    p_query: null, p_types: ['food'], p_subtypes: null, p_statuses: null, p_source_types: null,
    p_entity_id: null, p_entity_name: null, p_from: from, p_to: to, p_min_confidence: null,
    p_limit: 50, p_offset: 0, p_ascending: false, p_user_id: userId,
  });
  const events = result?.events || [];
  if (!events.length) return null;

  const now = Date.now();
  const nearest = events.reduce((best, event) =>
    Math.abs(new Date(event.occurred_at) - now) < Math.abs(new Date(best.occurred_at) - now) ? event : best);
  return rpc('ledger_get_event', { p_event_id: nearest.id });
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}
