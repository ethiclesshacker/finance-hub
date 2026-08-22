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
import { parseQuickEntry } from '../src/ledger/nlparse.js';
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

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}
