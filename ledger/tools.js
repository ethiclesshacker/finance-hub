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
import { localDateISO, normalizeName, entityRef } from '../src/ledger/normalize.js';
import { findReference } from './nutrition/reference.js';
import { resolvePending } from './nutrition/resolve.js';

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

  // "2026-08-01..2026-08-31" — one string, so a model with a single-typed
  // schema can still ask for an explicit span.
  const span = phrase.match(/^(\S+)\s*(?:\.\.|\s+to\s+)\s*(\S+)$/);
  if (span) {
    return { from: toInstant(span[1], timeZone, false), to: toInstant(span[2], timeZone, true) };
  }
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

const DATE_RANGE = {
  type: 'string',
  description: 'today, yesterday, this week, last week, this month, last month, this year, "last N days", '
    + 'a single YYYY-MM-DD, or an explicit span "YYYY-MM-DD..YYYY-MM-DD".',
};

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
        date_range: DATE_RANGE,
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
    description:
      'Record something that happened — a purchase, a booking, a milestone, a note. Use '
      + 'natural_language for a phrase like "petrol 1600 yesterday", or pass structured fields directly. '
      + 'NOT for meals, body measurements or workouts: use log_meal, log_measurement and log_activity '
      + 'for those — they store the shapes the Food screen and the charts read.',
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
      + 'paid for it is its own event. When the user states calories ("the Mac is 833"), pass them as '
      + 'kcal on the item — they are used verbatim, and remembered so that dish never needs estimating again.',
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
              kcal: { type: 'number', description: 'Calories for ONE of this item, when the user or the menu stated them. Used verbatim, never re-estimated.' },
              kcal_estimated: { type: 'boolean', description: 'Set true when the kcal is YOUR estimate rather than something the user or a menu stated. An estimate is remembered at model rank, not as the user\'s word.' },
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

      const snapped = await snapDishes(args.items ?? parsed?.parsed.items ?? [], userId);

      // Split BEFORE the event is built. An assistant estimate must not ride
      // the event: item-level kcal outranks the dictionary at rollup, and a
      // guess frozen onto the meal would keep beating a real label acquired
      // later. Stated kcal stays on the item; an estimate goes only to the
      // dictionary (below), where better sources can replace it — the rollup
      // then prices this meal from there.
      const dictionaryWrites = snapped
        .filter(item => Number.isFinite(item.kcal))
        .map(({ name, kcal, kcal_estimated }) => ({ name, kcal, estimated: Boolean(kcal_estimated) }));
      const items = snapped.map(({ kcal_estimated, ...item }) =>
        kcal_estimated ? (({ kcal, ...rest }) => rest)(item) : item);

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

      // Every count lands in the dictionary, but provenance follows who said
      // it. A figure the person (or the menu) stated is source 'manual' —
      // outranks every automatic rung, so the resolver never revisits the
      // dish, yet NOT verified, so a later correction still lands. A figure
      // the assistant estimated is source 'llm': the same class as the
      // resolver's own guesses, replaceable by anything better. Mislabeling an
      // assistant guess as the user's word would let it outrank a real label
      // forever, which is the one provenance lie this schema forbids.
      const remembered = [];
      for (const write of dictionaryWrites) {
        try {
          await rpc('food_upsert_item', {
            p_user_id: userId,
            p_payload: write.estimated
              ? { display_name: write.name, kcal: write.kcal, source: 'llm', confidence: 0.65,
                  source_ref: { stated_via: 'log_meal', estimated_by: 'hermes', at: new Date().toISOString() } }
              : { display_name: write.name, kcal: write.kcal, source: 'manual', confidence: 0.9,
                  source_ref: { stated_via: 'log_meal', at: new Date().toISOString() } },
          });
          remembered.push(write.name);
        } catch {
          // The dictionary write is a bonus, not the meal. A failure here must
          // not lose what was eaten.
        }
      }


      const eventId = result?.event?.id ?? result?.id;
      const nutrition = eventId ? await priceMeal(userId, eventId, occurredAt, items.map(i => i.name)) : null;

      return { ...result,
               understood: { place, items, occurred_at: occurredAt, status: args.status ?? parsed?.parsed.status ?? 'confirmed' },
               ...(nutrition ? { nutrition } : {}),
               ...(remembered.length ? { remembered_calories_for: remembered } : {}) };
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
        date_range: { ...DATE_RANGE, description: 'Used when event_id is absent. Defaults to today. ' + DATE_RANGE.description },
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
      const nutrition = await priceMeal(userId, event.id, event.occurred_at, merged.map(i => i.name));
      return { event_id: event.id, items: merged, status: updated?.status ?? changes.status ?? event.status,
               ...(nutrition ? { nutrition } : {}) };
    },
  },

  // ── Nutrition ────────────────────────────────────────
  //
  // The ledger records what was ordered; the dish dictionary records what is in
  // it. These four tools are the whole surface: scan a package, ask what a
  // period added up to, correct a number, and see what still has none.

  lookup_barcode: {
    description:
      'Resolve a packaged food from its barcode and remember it, so every future receipt naming that '
      + 'product is priced automatically. Use this when the user photographs or reads out a barcode. '
      + 'A barcode is an exact identifier, not a search, so the result comes from the product\'s printed '
      + 'label and is trusted accordingly — unlike a nutrition lookup by name, which is a guess. '
      + 'Set eaten true to also log it as a meal right now; otherwise the product is only added to the '
      + 'dictionary and nothing is recorded as consumed.',
    parameters: {
      type: 'object', required: ['barcode'],
      properties: {
        barcode: { type: 'string', description: 'EAN or UPC, 8 to 14 digits. Spaces and dashes are ignored.' },
        eaten: { type: 'boolean', description: 'Also log this as eaten now. Default false — scanning a pack is not eating it.' },
        qty: { type: 'integer', description: 'How many packs, when eaten is true. Default 1.' },
        occurred_at: { type: 'string', description: 'ISO 8601. Defaults to now, when eaten is true.' },
        name: { type: 'string', description: 'Override the product name from the label.' },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const { lookupBarcode } = await import('./nutrition/databases.js');

      const found = await lookupBarcode(args.barcode);
      if (!found.ok) {
        // A miss is a normal outcome with a next step, not an error to swallow.
        // Hermes should offer to take the numbers off the packet by hand.
        return {
          ok: false, barcode: String(args.barcode).replace(/\D/g, ''),
          reason: found.error, not_found: Boolean(found.notFound),
          next: found.notFound
            ? 'Not in the database. Ask for the name and the per-100g panel on the packet, then call set_food_nutrition.'
            : 'Lookup failed. Try again, or ask for the label values and call set_food_nutrition.',
        };
      }

      const displayName = args.name || found.display_name;
      const stored = await rpc('food_upsert_item', {
        p_user_id: userId,
        p_payload: { display_name: displayName, ...found.row },
      });

      const result = {
        ok: true, product: displayName, action: stored?.action,
        per_serving: {
          kcal: found.row.kcal, protein_g: found.row.protein_g,
          carbs_g: found.row.carbs_g, fat_g: found.row.fat_g,
          portion_g: found.row.portion_g,
        },
        // What "one serving" was taken to mean. The user is the only one who
        // knows whether they ate the pack or a portion of it, so say which was
        // assumed rather than presenting the number as settled.
        portion_basis: found.row.source_ref.portion_basis,
        barcode: found.row.source_ref.barcode,
      };

      if (!args.eaten) return { ...result, logged: false };

      const qty = Math.max(1, Number(args.qty) || 1);
      const logged = await rpc('ledger_create_event', {
        p_event: {
          occurred_at: args.occurred_at || new Date().toISOString(),
          type: 'food', subtype: 'meal',
          title: displayName,
          data: { items: [{ name: displayName, qty }] },
          status: 'confirmed',
        },
        p_entities: [], p_source_type: 'hermes',
        p_allow_merge: false, p_user_id: userId,
      });

      return { ...result, logged: true, event_id: logged?.id, qty };
    },
  },

  get_nutrition: {
    description:
      'What the user actually ate over a period, in calories and protein. Use for "how many calories did '
      + 'I have today", "am I eating enough protein this week", "how did last month compare". '
      + 'ALWAYS report the coverage alongside the number: this is built from receipts, so anything cooked '
      + 'at home or paid in cash is invisible, and a total over 60% of meals means something different '
      + 'from one over 95%. Averages are per day the user actually ate something priced, never per calendar '
      + 'day, because dividing by days with no receipt would invent a diet nobody has.',
    parameters: {
      type: 'object',
      properties: {
        date_range: { ...DATE_RANGE, description: 'Defaults to today. ' + DATE_RANGE.description },
        by: { type: 'string', enum: ['total', 'day', 'week', 'month'], description: 'Break the period down. Default total.' },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const { from, to } = resolveRange(args.date_range ?? 'today');

      const rows = await rpc('food_event_nutrition', {
        p_from: from, p_to: to, p_limit: 2000, p_user_id: userId,
      }) || [];

      const priced = rows.filter(r => r.kcal !== null);
      const unknown = rows.length - priced.length;
      const partial = priced.filter(r => r.basis === 'partial');

      const byDay = new Map();
      for (const r of priced) {
        const day = localDateISO(r.occurred_at, config.timeZone);
        const b = byDay.get(day) || { date: day, kcal: 0, protein_g: 0, meals: 0 };
        b.kcal += Number(r.kcal); b.protein_g += Number(r.protein_g || 0); b.meals++;
        byDay.set(day, b);
      }
      const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
        .map(d => ({ ...d, kcal: Math.round(d.kcal), protein_g: Math.round(d.protein_g) }));

      const kcal = Math.round(priced.reduce((n, r) => n + Number(r.kcal), 0));
      const protein = Math.round(priced.reduce((n, r) => n + Number(r.protein_g || 0), 0));

      const summary = {
        range: { from, to },
        kcal, protein_g: protein,
        meals_priced: priced.length,
        meals_unpriced: unknown,
        meals_partial: partial.length,
        eating_days: days.length,
        kcal_per_eating_day: days.length ? Math.round(kcal / days.length) : null,
        protein_per_eating_day: days.length ? Math.round(protein / days.length) : null,
        coverage: rows.length ? Math.round((priced.length / rows.length) * 100) / 100 : 0,
        // Said explicitly so it survives into whatever Hermes tells the user.
        caveat: unknown
          ? `${unknown} of ${rows.length} meals in this period have no nutrition yet, so the totals are a floor.`
          : 'Every meal in this period is priced, but only meals with a receipt are in the ledger at all.',
      };

      if ((args.by ?? 'total') === 'total') return summary;
      if (args.by === 'day') return { ...summary, days };

      const bucket = (iso) => args.by === 'month'
        ? `${iso.slice(0, 7)}-01`
        : (() => { const d = new Date(`${iso}T00:00:00Z`);
                   d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
                   return d.toISOString().slice(0, 10); })();

      const groups = new Map();
      for (const d of days) {
        const key = bucket(d.date);
        const g = groups.get(key) || { start: key, kcal: 0, protein_g: 0, meals: 0, eating_days: 0 };
        g.kcal += d.kcal; g.protein_g += d.protein_g; g.meals += d.meals; g.eating_days++;
        groups.set(key, g);
      }
      // Per eating day within the bucket, so switching `by` changes the
      // resolution and not the units.
      const buckets = [...groups.values()].sort((a, b) => (a.start < b.start ? -1 : 1)).map(g => ({
        ...g,
        kcal_per_eating_day: Math.round(g.kcal / g.eating_days),
        protein_per_eating_day: Math.round(g.protein_g / g.eating_days),
      }));
      return { ...summary, [args.by === 'week' ? 'weeks' : 'months']: buckets };
    },
  },

  set_food_nutrition: {
    description:
      'Record or correct the nutrition of one dish, from a label the user read out or a number they know. '
      + 'Values are per ONE SERVING AS SOLD — one thali, one packet, one whole pizza — not per 100g; '
      + 'convert before calling, using portion_g to say what mass that serving is. '
      + 'This marks the dish verified, which outranks every automatic estimate permanently and applies '
      + 'retroactively to every meal that ever contained it. Use it when the user disputes a number.',
    parameters: {
      type: 'object', required: ['name', 'kcal'],
      properties: {
        name: { type: 'string', description: 'The dish, spelled as it appears on receipts.' },
        kcal: { type: 'number', description: 'Per serving as sold.' },
        protein_g: { type: 'number' },
        carbs_g: { type: 'number' },
        fat_g: { type: 'number' },
        portion_g: { type: 'number', description: 'Mass of one serving in grams. Strongly preferred — it is what makes the number checkable.' },
        category: { type: 'string', description: 'thali, pizza, packaged_snack, south_indian, …' },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const { setManual } = await import('./nutrition/resolve.js');

      const result = await setManual(userId, args.name, {
        kcal: args.kcal, protein_g: args.protein_g, carbs_g: args.carbs_g,
        fat_g: args.fat_g, portion_g: args.portion_g, category: args.category,
      });

      // How much of the past this just changed — the reason a correction here
      // is worth more than editing one meal.
      const affected = await rpc('food_event_nutrition', {
        p_from: null, p_to: null, p_limit: 2000, p_user_id: userId,
      }) || [];
      const norm = normalizeName(args.name);
      const meals = affected.filter(r => r.items_total > 0 && r.kcal !== null).length;

      return {
        ...result, dish: args.name, verified: true,
        per_serving: { kcal: args.kcal, protein_g: args.protein_g ?? null, portion_g: args.portion_g ?? null },
        note: `Applied to every past and future meal containing "${args.name}" (${norm}). `
            + `${meals} meals in the ledger currently carry a nutrition total.`,
      };
    },
  },

  list_unresolved_foods: {
    description:
      'Dishes the ledger has seen but has no nutrition for, most-eaten first. Use this to find out what '
      + 'is dragging coverage down, or to ask the user about the handful of dishes that would improve the '
      + 'numbers most. Resolving these is what makes get_nutrition trustworthy.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Default 20.' } },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const pending = await rpc('food_pending_items', {
        p_limit: Math.min(Math.max(Number(args.limit) || 20, 1), 200), p_user_id: userId,
      }) || [];
      const coverage = await rpc('food_coverage', { p_user_id: userId });
      return {
        coverage,
        unresolved: pending.map(p => ({ name: p.display_name, times_eaten: p.occurrences })),
        next: pending.length
          ? 'Ask the user about the top few, then call set_food_nutrition — or run `npm run ledger:nutrition` to resolve them automatically.'
          : 'Everything the ledger has seen is resolved.',
      };
    },
  },

  // ── The body ─────────────────────────────────────────
  //
  // The receipts capture calories in; nothing captures the other side. These
  // two tools are for what only the user can report: what they weigh, and what
  // they did. They exist as dedicated tools rather than create_event calls
  // because the shape matters — a weight the Food screen can later plot against
  // the calorie curve has to land as {metric, value, unit} every time, not as
  // whatever free text the day produced.

  log_measurement: {
    description:
      'Record a body measurement — weight, waist, body fat. Use when the user states a reading: '
      + '"88.4 this morning", "waist is 96cm". One reading per metric per day: telling it again the '
      + 'same day corrects the earlier value instead of duplicating it, so the user can re-weigh '
      + 'freely. Weight is the one that matters most here — it is the feedback loop for the daily '
      + 'calorie target — so when the user mentions weight in passing, offer to log it.',
    parameters: {
      type: 'object', required: ['metric', 'value'],
      properties: {
        metric: { type: 'string', enum: ['weight', 'waist', 'body_fat', 'chest', 'resting_hr'],
                  description: 'What was measured.' },
        value: { type: 'number', description: 'The reading, in the unit below.' },
        unit: { type: 'string', description: 'Defaults: weight kg, waist/chest cm, body_fat %, resting_hr bpm.' },
        occurred_at: { type: 'string', description: 'ISO 8601. Defaults to now. The reading belongs to its local day.' },
        note: { type: 'string', description: 'Context worth keeping: "after workout", "new scale".' },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const value = Number(args.value);
      if (!Number.isFinite(value) || value <= 0) throw new Error('A measurement needs a positive number.');

      // Sanity bounds per metric — a slip of the tongue ("884") must not
      // become a fact in a health record.
      const BOUNDS = { weight: [25, 400], waist: [40, 250], body_fat: [2, 70], chest: [50, 250], resting_hr: [25, 220] };
      const UNITS  = { weight: 'kg', waist: 'cm', body_fat: '%', chest: 'cm', resting_hr: 'bpm' };
      const [lo, hi] = BOUNDS[args.metric];
      if (value < lo || value > hi) {
        throw new Error(`${value} is outside the plausible range for ${args.metric} (${lo}–${hi} ${UNITS[args.metric]}). Not recorded — check the number.`);
      }

      const unit = args.unit || UNITS[args.metric];
      const occurredAt = args.occurred_at || new Date().toISOString();
      const day = localDateISO(occurredAt, config.timeZone);

      const title = `${args.metric === 'body_fat' ? 'Body fat' : args.metric === 'resting_hr' ? 'Resting HR'
                   : args.metric[0].toUpperCase() + args.metric.slice(1)} ${value} ${unit}`;

      const result = await rpc('ledger_create_event', {
        p_event: {
          occurred_at: occurredAt,
          type: 'health', subtype: 'measurement',
          title,
          description: args.note || null,
          data: { metric: args.metric, value, unit },
          // One reading per metric per day: the dedupe key routes a second
          // reading to the same row instead of creating a sibling.
          dedupe_key: `measurement:${args.metric}:${day}`,
          status: 'confirmed',
        },
        p_entities: [], p_source_type: 'hermes',
        p_allow_merge: true, p_user_id: userId,
      });

      // Ingestion never overwrites a fact a source already stated — the right
      // rule for two emails, the wrong one for a person re-reading their scale.
      // So when the day already has a reading, this is a *correction*, and it
      // goes through ledger_update_event: the path that is allowed to
      // overwrite, with the previous value kept in the audit trail.
      let action = result?.action;
      if (action !== 'created') {
        await rpc('ledger_update_event', {
          p_event_id: result.event_id,
          p_changes: { title, occurred_at: occurredAt, data: { metric: args.metric, value, unit } },
          p_replace_data: false,
        });
        action = 'corrected';
      }

      return {
        event_id: result?.event_id, action,
        recorded: { metric: args.metric, value, unit, day },
        note: action === 'corrected'
          ? `Replaced today's earlier ${args.metric} reading — the old value stays in the audit trail.`
          : `Logged. One ${args.metric} reading is kept per day; saying it again today corrects it.`,
      };
    },
  },

  log_activity: {
    description:
      'Record exercise or physical activity: a workout, a run, a walk, a sport. Use when the user '
      + 'says they did something physical — "went to the gym", "ran 5k", "played badminton for an '
      + 'hour". Facts the user stated (what, how long, how far) land as facts; any estimated calorie '
      + 'burn is stored as inference, clearly separated, because the user said what they did, not '
      + 'what it burned.',
    parameters: {
      type: 'object', required: ['activity'],
      properties: {
        activity: { type: 'string', description: 'What they did: gym, run, walk, cycling, swimming, badminton, yoga…' },
        duration_min: { type: 'number', description: 'How long, in minutes.' },
        distance_km: { type: 'number', description: 'For runs, walks, rides.' },
        intensity: { type: 'string', enum: ['light', 'moderate', 'hard'], description: 'Only if the user characterised it.' },
        est_kcal_burned: { type: 'number', description: 'Your estimate, if the user asks for one. Stored as inference, never as fact.' },
        occurred_at: { type: 'string', description: 'ISO 8601. Defaults to now.' },
        place: { type: 'string', description: 'Gym name, park, court.' },
        note: { type: 'string' },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const name = String(args.activity || '').trim();
      if (!name) throw new Error('What was the activity?');

      const bits = [
        args.duration_min ? `${args.duration_min} min` : null,
        args.distance_km ? `${args.distance_km} km` : null,
      ].filter(Boolean).join(', ');

      const result = await rpc('ledger_create_event', {
        p_event: {
          occurred_at: args.occurred_at || new Date().toISOString(),
          type: 'activity', subtype: 'workout',
          title: bits ? `${name[0].toUpperCase() + name.slice(1)} — ${bits}` : name[0].toUpperCase() + name.slice(1),
          description: args.note || null,
          data: stripUndefined({
            activity: name.toLowerCase(),
            duration_min: args.duration_min,
            distance_km: args.distance_km,
            intensity: args.intensity,
            place: args.place,
          }),
          // Rule 2 of the schema, applied here: the burn is interpretation.
          inference: args.est_kcal_burned ? { est_kcal_burned: Number(args.est_kcal_burned) } : {},
          status: 'confirmed',
        },
        p_entities: args.place ? [entityRef('place', args.place)].filter(Boolean) : [],
        p_source_type: 'hermes',
        // Two walks in a day are two walks; nothing here should merge.
        p_allow_merge: false, p_user_id: userId,
      });

      return { event_id: result?.event_id, action: result?.action,
               recorded: { activity: name, duration_min: args.duration_min ?? null,
                           distance_km: args.distance_km ?? null } };
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
      properties: { entity_id: { type: 'string' }, date_range: DATE_RANGE, limit: { type: 'integer', default: 100 } },
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
    parameters: { type: 'object', properties: { date_range: DATE_RANGE } },
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
    parameters: { type: 'object', properties: { date_range: DATE_RANGE } },
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
      // A stated calorie count rides along under one name. Zero is a statement
      // (a Coke Zero), so the test is "is a number", never truthiness.
      ...(Number.isFinite(Number(item.kcal ?? item.calories)) ? { kcal: Number(item.kcal ?? item.calories) } : {}),
      ...(item.kcal_estimated ? { kcal_estimated: true } : {}),
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

  // Two catalogues, in order. Past meals give the exact spelling the person
  // has used before. The dictionary gives the spelling a *priced* row has,
  // through the same trigram-plus-token rule the resolver uses, so "Cheese
  // Slice" joins "Cheese Slices" and inherits its 70 kcal instead of starting
  // a second, unpriced dish. A miss on both is a genuinely new dish.
  const out = [];
  for (const item of list) {
    const key = item.name.toLowerCase().replace(/\s+/g, ' ').trim();
    let name = known.get(key);
    if (!name) {
      try {
        const match = await findReference(userId, item.name, {});
        if (match?.row?.display_name) name = match.row.display_name;
      } catch {
        // Same stance as above: an unreachable dictionary is not a reason to
        // refuse the meal.
      }
    }
    out.push({ ...item, name: name || item.name });
  }
  return out;
}

/**
 * Price the dishes that are new to the dictionary, right now, and read the
 * meal back with its calories.
 *
 * Without this a dish Hermes logs sits unpriced until someone remembers to run
 * `npm run ledger:nutrition` — which nobody does at dinner. The resolver is
 * asked only about the names just written, with a one-call budget, so the
 * cost is bounded and the receipt can say "~640 kcal" in the same breath as
 * "logged". Every step is best-effort: the meal is already saved.
 */
async function priceMeal(userId, eventId, occurredAt, names) {
  const wanted = (names || []).filter(Boolean);
  try {
    if (wanted.length) {
      await resolvePending({ userId, names: wanted, maxLlmCalls: 1, log: () => {} });
    }
  } catch {
    // Pricing failed; the rollup will say "unpriced" and the nightly run retries.
  }
  try {
    const at = new Date(occurredAt).getTime();
    if (!Number.isFinite(at)) return null;
    const rows = await rpc('food_event_nutrition', {
      p_from: new Date(at - 60_000).toISOString(),
      p_to: new Date(at + 60_000).toISOString(),
      p_limit: 20, p_user_id: userId,
    }) || [];
    const row = rows.find(r => (r.event_id ?? r.id) === eventId) || (rows.length === 1 ? rows[0] : null);
    if (!row) return null;
    const total = Number(row.items_total ?? 0), resolved = Number(row.items_resolved ?? 0);
    return stripUndefined({
      kcal: row.kcal === null || row.kcal === undefined ? null : Math.round(Number(row.kcal)),
      protein_g: row.protein_g === null || row.protein_g === undefined ? undefined : Math.round(Number(row.protein_g)),
      // "full" means every dish is priced; "partial" means the total is a
      // floor; "none" means say "logged, calories pending" rather than a number.
      basis: row.basis ?? undefined,
      dishes_priced: total ? `${resolved}/${total}` : undefined,
    });
  } catch {
    return null;
  }
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
