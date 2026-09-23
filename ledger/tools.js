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
import { db, rpc, resolveUserId, searchEvents } from './db.js';
import { parseQuickEntry, parseMealEntry } from '../src/ledger/nlparse.js';
import { dishName, summariseItems } from '../src/ledger/items.js';
import { normalizeName, entityRef, prune } from '../src/ledger/normalize.js';
import { dayStartISO, localDateISO, shiftISO, startOfWeek } from '../src/ledger/dates.js';
import { summarise, bucketDays } from '../src/ledger/nutrition.js';
import { findReference } from './nutrition/reference.js';
import { resolvePending, setManual, pendingItems, coverage } from './nutrition/resolve.js';
import { lookupBarcode } from './nutrition/databases.js';
import { resolveSettings } from '../src/settings-schema.js';

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
  const named = {
    today:      [today, today],
    yesterday:  [shiftISO(today, -1), shiftISO(today, -1)],
    'this week':  [startOfWeek(today), today],
    'last week':  [shiftISO(startOfWeek(today), -7), shiftISO(startOfWeek(today), -1)],
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
    return { from: toInstant(shiftISO(today, -parseInt(lastN[1], 10)), timeZone, false),
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
  return dayStartISO(endOfDay ? shiftISO(date, 1) : date, timeZone);
}

function lastMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1));
  const end = new Date(Date.UTC(y, m - 1, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

/**
 * A date expression → inclusive local calendar dates.
 *
 * The health functions take dates, not instants: a "day" of steps is a local
 * day, and the database buckets by the zone the phone was in when it synced.
 */
export function resolveDays(range, fallback = 'last 7 days', timeZone = config.timeZone) {
  const { from, to } = resolveRange(range || fallback, timeZone);
  // `to` is the exclusive midnight after the last day; step back inside it.
  return {
    from: localDateISO(new Date(from), timeZone),
    to: localDateISO(new Date(new Date(to).getTime() - 1), timeZone),
  };
}

// ── The tools ──────────────────────────────────────────

/**
 * A handler that is nothing but "resolve the range, call the function".
 * Most read tools are exactly that, and writing each one out by hand is how
 * one of them ends up passing a date where the SQL wanted an instant.
 *
 *   days   — the function takes local dates (the health ones), not instants
 *   user   — false for the few functions that take no p_user_id
 *   args   — extra SQL arguments derived from the tool's own arguments
 */
function rangedRpc(fn, { days = false, fallback = 'last 7 days', user = true, args: extra = () => ({}) } = {}) {
  return async (args) => {
    const { from, to } = days ? resolveDays(args.date_range, fallback) : resolveRange(args.date_range);
    return rpc(fn, {
      ...extra(args), p_from: from, p_to: to,
      ...(user ? { p_user_id: await resolveUserId() } : {}),
    });
  };
}

/** A read tool over a range of local days: one row per day comes back. */
function dayRangedTool(fn, { description, fallback = 'last 7 days', properties = {}, required, args }) {
  return {
    description,
    readOnly: true,
    parameters: prune({ type: 'object', required, properties: { ...properties, date_range: { ...DATE_RANGE, default: fallback } } }),
    handler: rangedRpc(fn, { days: true, fallback, args }),
  };
}

const DATE_RANGE = {
  type: 'string',
  description: 'today, yesterday, this week, last week, this month, last month, this year, "last N days", '
    + 'a single YYYY-MM-DD, or an explicit span "YYYY-MM-DD..YYYY-MM-DD".',
};

export const TOOLS = {
  search_events: {
    readOnly: true,
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
      return searchEvents(await resolveUserId(), prune({
        p_query: args.query, p_types: args.types, p_subtypes: args.subtypes,
        p_statuses: args.statuses, p_source_types: args.source_types,
        p_entity_id: args.entity_id, p_entity_name: args.entity_name,
        p_from: from, p_to: to,
        p_min_confidence: args.min_confidence,
        p_limit: args.limit ?? 50, p_offset: args.offset ?? 0, p_ascending: args.ascending,
      }));
    },
  },

  get_event: {
    readOnly: true,
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
        event = { ...parsed.event, ...prune(args) };
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
          status: event.status === 'scheduled' ? 'scheduled' : 'confirmed',
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

      const data = prune({
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

      const eventId = result?.event_id;
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

      return { ...result, logged: true, event_id: logged?.event_id, qty };
    },
  },

  get_nutrition: {
    readOnly: true,
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

      // The SQL twin already priced each meal; the rollup only reads its
      // verdict. Same summarise() the Food screen uses, so the two agree.
      const s = summarise(rows, null, {
        dateOf: iso => localDateISO(iso, config.timeZone),
        nutritionOf: r => (r.kcal === null || r.kcal === undefined
          ? { basis: 'none' }
          : { kcal: Math.round(Number(r.kcal)), protein: Math.round(Number(r.protein_g || 0)),
              basis: r.basis === 'partial' ? 'partial' : 'itemized' }),
      });

      const summary = {
        range: { from, to },
        kcal: s.kcal, protein_g: s.protein,
        meals_priced: s.priced,
        meals_unpriced: s.unknown,
        meals_partial: s.partial,
        eating_days: s.activeDays,
        kcal_per_eating_day: s.kcalPerDay,
        protein_per_eating_day: s.proteinPerDay,
        coverage: Math.round(s.coverage * 100) / 100,
        // Said explicitly so it survives into whatever Hermes tells the user.
        caveat: s.unknown
          ? `${s.unknown} of ${rows.length} meals in this period have no nutrition yet, so the totals are a floor.`
          : 'Every meal in this period is priced, but only meals with a receipt are in the ledger at all.',
      };

      const by = args.by ?? 'total';
      if (by === 'total') return summary;
      if (by === 'day') {
        return { ...summary, days: bucketDays(s.days, 'day').map(b =>
          ({ date: b.key, kcal: b.kcal, protein_g: b.protein, meals: b.meals })) };
      }
      // Per eating day within the bucket, so switching `by` changes the
      // resolution and not the units.
      const buckets = bucketDays(s.days, by).map(b => ({
        start: b.key, eating_days: b.days, meals: b.meals,
        kcal_per_eating_day: b.kcal, protein_per_eating_day: b.protein,
      }));
      return { ...summary, [by === 'week' ? 'weeks' : 'months']: buckets };
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

      const result = await setManual(userId, args.name, {
        kcal: args.kcal, protein_g: args.protein_g, carbs_g: args.carbs_g,
        fat_g: args.fat_g, portion_g: args.portion_g, category: args.category,
      });

      return {
        ...result, dish: args.name, verified: true,
        per_serving: { kcal: args.kcal, protein_g: args.protein_g ?? null, portion_g: args.portion_g ?? null },
        note: `Applied to every past and future meal containing "${args.name}" (${normalizeName(args.name)}).`,
      };
    },
  },

  list_unresolved_foods: {
    readOnly: true,
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
      const pending = await pendingItems(userId, Math.min(Math.max(Number(args.limit) || 20, 1), 200));
      return {
        coverage: await coverage(userId),
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

  merge_dishes: {
    description:
      'Fold one dish spelling into another, retroactively: "cheese slice and cheese slices are the same thing". '
      + 'Every past meal that named the duplicate is rewritten to name the kept dish, so counts and calories stop '
      + 'being split in two. Pass the name to keep and the name to remove; both must already be in the dictionary. '
      + 'Irreversible — use only when the user says two names are one dish.',
    parameters: {
      type: 'object', required: ['keep', 'remove'],
      properties: {
        keep: { type: 'string', description: 'The dish name that stays.' },
        remove: { type: 'string', description: 'The duplicate spelling that is folded in and deleted.' },
      },
    },
    handler: async (args) => {
      const userId = await resolveUserId();
      const find = async (name) => {
        const key = normalizeName(name);
        const { data, error } = await db().from('food_items').select('id, display_name')
          .eq('user_id', userId).eq('normalized_name', key).maybeSingle();
        if (error) throw new Error(`food_items: ${error.message}`);
        if (data) return data;
        const near = await rpc('food_match_item', { p_name: name, p_threshold: 0.3, p_limit: 5, p_user_id: userId }) || [];
        throw new Error(`No dish named "${name}" in the dictionary. Closest: ${near.map(r => r.display_name).join(', ') || 'nothing'}.`);
      };
      const keep = await find(args.keep);
      const remove = await find(args.remove);
      if (keep.id === remove.id) throw new Error('Those are already the same dish.');
      return rpc('food_merge_items', { p_user_id: userId, p_target_id: keep.id, p_duplicate_id: remove.id });
    },
  },

  log_measurement: {
    description:
      'Record a body measurement — weight, waist, body fat. Use when the user states a reading: '
      + '"88.4 this morning", "waist is 96cm". One reading per metric per day: telling it again the '
      + 'same day corrects the earlier value instead of duplicating it, so the user can re-weigh '
      + 'freely. Weight is the one that matters most here — it is the feedback loop for the daily '
      + 'calorie target — so when the user mentions weight in passing, offer to log it. This is THE place weight '
      + 'is written; get_day and get_health_overview read it back alongside any reading from Apple Health.',
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
      + 'what it burned. His Apple Watch records walks, runs and gym sessions by itself and they arrive when his '
      + 'phone syncs — so this is for what the Watch did NOT capture: a sport played without it, a session he '
      + 'forgot to start, a comment worth keeping ("knee hurt after 2 km"). If unsure whether the Watch has it, '
      + 'log it anyway: a telling that matches a Watch workout is folded into it, never counted twice.',
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
          data: prune({
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
    readOnly: true,
    description: 'The stored summary for one day, with a live event count so a stale summary is visible as stale.',
    parameters: { type: 'object', required: ['date'], properties: { date: { type: 'string', description: 'YYYY-MM-DD' } } },
    handler: async args => rpc('ledger_get_daily_summary', { p_date: args.date, p_user_id: await resolveUserId() }),
  },

  get_period_summary: {
    readOnly: true,
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
    readOnly: true,
    description: 'One merchant, person, place or project: how often it appears, when it was first and last seen, and the total spent with it.',
    parameters: { type: 'object', required: ['entity_id'], properties: { entity_id: { type: 'string' } } },
    handler: args => rpc('ledger_get_entity', { p_entity_id: args.entity_id }),
  },

  search_entity_events: {
    readOnly: true,
    description: 'Every event linked to an entity. "What have I bought from Amazon", "when was I last in Hyderabad", "meetings with this person".',
    parameters: {
      type: 'object', required: ['entity_id'],
      properties: { entity_id: { type: 'string' }, date_range: DATE_RANGE, limit: { type: 'integer', default: 100 } },
    },
    handler: rangedRpc('ledger_search_entity_events', {
      user: false, args: a => ({ p_entity_id: a.entity_id, p_limit: a.limit ?? 100 }),
    }),
  },

  // ── Beyond the nine, because these answer real questions ──

  search_entities: {
    readOnly: true,
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
    readOnly: true,
    description: 'Aggregates over a period: counts by type, spend by category, top entities, how much needs review. Computed from events at call time, never stored.',
    parameters: { type: 'object', properties: { date_range: DATE_RANGE } },
    handler: rangedRpc('ledger_stats'),
  },

  // ── The whole day ────────────────────────────────────
  //
  // Money, food, body and activity used to be three stores with three sets of
  // tools, and a question like "how was my week" meant calling all of them and
  // hoping they agreed. life_days() joins them in SQL; this is the front door.

  get_day: {
    readOnly: true,
    description: 'Everything about a day, or each day in a range, in one object: money spent and received, calories and protein '
      + 'eaten, steps, sleep, heart, weight, calories burned, the energy balance against the calorie target, and workouts. '
      + 'START HERE for "how was my day", "how was my week", "am I in a deficit", or anything that crosses money, food and body. '
      + 'money.spend is everything; when part of it was work (card spends he has marked as work, reimbursable) the day '
      + 'also carries money.work_spend and money.personal_spend — judge his spending on personal_spend, and mention work separately. '
      + 'energy.balance_kcal is eaten minus burned (negative is a deficit). Eaten comes from receipts and what he told you, so '
      + 'it is a floor: when energy.complete is false say the balance is provisional. That happens for today, when '
      + 'food.meals_unpriced > 0, and when energy.eaten_looks_partial is set (under 60% of target — almost always a meal '
      + 'he did not log, so ask what he ate rather than congratulating him on the deficit). '
      + 'Up to 120 days; for longer body-only trends use get_health_overview.',
    parameters: { type: 'object', properties: { date_range: { ...DATE_RANGE, default: 'today' } } },
    handler: rangedRpc('life_days', { days: true, fallback: 'today' }),
  },

  // ── Finance ──────────────────────────────────────────

  get_net_worth: {
    readOnly: true,
    description: 'Net worth from the snapshots he records: the latest figure with its asset breakdown (stocks, mutual funds, cash, '
      + 'EPF, gold, FDs) and liabilities, the change since the previous snapshot, and recent history. In INR. Snapshots are '
      + 'entered by hand every week or two, so always say the date of the latest one.',
    parameters: { type: 'object', properties: { history: { type: 'integer', default: 12, description: 'How many recent snapshots to include.' } } },
    handler: async args => rpc('finance_net_worth', { p_limit: args.history ?? 12, p_user_id: await resolveUserId() }),
  },

  get_card_points: {
    readOnly: true,
    description: 'Credit card reward points (HSBC TravelOne): current balance, lifetime accrued and redeemed, and for a period the '
      + 'spend, points earned, points per ₹100, a month-by-month split, top merchants and past redemptions. The balance is always '
      + 'lifetime; date_range only scopes the period figures. For what was bought, use search_events — this is the points view. '
      + 'Rows are now created automatically from card alerts: `assumed` counts rows whose label and multiplier were inferred from '
      + 'earlier spends at the same merchant and that he has not confirmed yet, so say the balance includes that many assumed points. '
      + 'range.work_spend is the part of the period spend he has marked as work. top_merchants are real merchants now, work or not.',
    parameters: { type: 'object', properties: { date_range: DATE_RANGE } },
    handler: async (args) => {
      const range = args.date_range ? resolveDays(args.date_range) : { from: null, to: null };
      return rpc('finance_card_points', { p_from: range.from, p_to: range.to, p_user_id: await resolveUserId() });
    },
  },

  get_targets: {
    readOnly: true,
    description: 'His own targets and assumptions: daily calorie target, monthly income and baseline expenses, FI multiplier and the '
      + 'FI target it implies, expected return, retirement age, emergency runway, card reward targets. Each value says whether HE set '
      + 'it (set_by: user) or it is the app default (set_by: default) — treat a default as a placeholder, not as his goal. '
      + 'Call this before judging any number against "his target".',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const stored = await rpc('finance_settings', { p_user_id: await resolveUserId() }) || {};
      const all = resolveSettings(stored);
      // The matching thresholds are the pipeline's business, and the identifiers are his name.
      const targets = Object.fromEntries(Object.entries(all)
        .filter(([key, s]) => s.group !== 'Event ledger' && s.group !== 'Profile' || ['age', 'retirement_age'].includes(key)));
      const annualExpenses = Number(all.monthly_expenses.value) * 12;
      return {
        targets,
        derived: {
          annual_expenses: annualExpenses,
          fi_target: Math.round(annualExpenses * Number(all.fi_multiplier.value)),
          fi_target_rests_on_defaults: [all.monthly_expenses, all.fi_multiplier].some(s => s.set_by === 'default'),
        },
      };
    },
  },

  // ── Apple Health ─────────────────────────────────────
  //
  // The phone syncs raw HealthKit samples — a row every minute or two, per
  // device, ~1,300 a day. None of these tools return samples. They return days
  // (or hours, or nights), already deduplicated across iPhone and Watch in SQL.

  get_health_overview: dayRangedTool('health_overview', {
    description: 'Apple Health, one row per day: steps, active and resting calories burned, distance, exercise minutes, '
      + 'sleep hours with bed and wake times, resting heart rate, heart rate min/avg/max, HRV, weight, workouts. '
      + 'START HERE for any question about activity, sleep, fitness, heart or weight. Days with no data still appear, as just a date.',
  }),

  get_health_metric: dayRangedTool('health_series', {
    description: 'One Apple Health metric across days, for anything the overview does not carry or when only one number is wanted. '
      + 'Totals per day for cumulative types (step_count, active_energy, water, dietary_*); min/avg/max/latest per day for readings '
      + '(heart_rate, hrv_sdnn, body_mass, oxygen_saturation). Call list_health_metrics for the exact type names that have data.',
    required: ['type'],
    properties: { type: { type: 'string', description: 'HealthKit type in snake_case, e.g. step_count, heart_rate, body_mass.' } },
    args: a => ({ p_type: a.type }),
  }),

  get_health_day_detail: {
    readOnly: true,
    description: 'One Apple Health metric across the hours of a single day — when were the steps walked, what did heart rate do overnight. '
      + 'Buckets for a cumulative type add up to that day\'s total.',
    parameters: {
      type: 'object', required: ['type'],
      properties: {
        type: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD, today or yesterday. Defaults to today.' },
        bucket_minutes: { type: 'integer', default: 60, description: '5 to 360.' },
      },
    },
    handler: async (args) => {
      const { from } = resolveDays(args.date, 'today');
      return rpc('health_intraday', {
        p_type: args.type, p_day: from, p_bucket_minutes: args.bucket_minutes ?? 60, p_user_id: await resolveUserId(),
      });
    },
  },

  get_sleep: dayRangedTool('health_sleep', {
    description: 'Sleep per night with stages: hours asleep, fell-asleep and wake times, minutes of core, deep, REM and awake, time in bed. '
      + 'A night is dated by the morning it ended. Overlapping records are merged, and time in bed is not counted as sleep.',
  }),

  get_workouts: dayRangedTool('life_activity', {
    description: 'Workouts and physical activity: everything the Apple Watch recorded, plus anything he told you that the Watch did '
      + 'not. Each item says its source (watch or ledger). When he described a workout the Watch also recorded, it appears ONCE, as '
      + 'the Watch measured it, with his words in `note`. Check here before log_activity.',
    fallback: 'last 30 days',
  }),

  list_health_metrics: {
    readOnly: true,
    description: 'Which Apple Health types have been synced, with row counts, date span, and when the phone last synced. '
      + 'Use it to tell "no data that day" from "that metric is not being synced", and to find exact type names.',
    parameters: { type: 'object', properties: {} },
    handler: async () => rpc('health_catalog', { p_user_id: await resolveUserId() }),
  },

  get_review_queue: {
    readOnly: true,
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
    readOnly: true,
    description: 'Everything, as JSON: events with their sources, entities and summaries. The data is yours and portable.',
    parameters: { type: 'object', properties: { date_range: DATE_RANGE } },
    handler: rangedRpc('ledger_export'),
  },
};

/**
 * Function-calling schema for every tool, ready to hand to a model. `npm run
 * ledger:tools-manifest` prints it; docs/hermes-tools.json is that output.
 */
export const TOOL_SPECS = Object.entries(TOOLS).map(([name, spec]) => ({
  type: 'function',
  function: { name, description: spec.description, parameters: spec.parameters },
}));

/** The tools that only read. Derived from the specs, so it cannot go stale. */
export const READ_ONLY_TOOLS = new Set(Object.entries(TOOLS).filter(([, spec]) => spec.readOnly).map(([name]) => name));

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
    const result = await searchEvents(userId, { p_types: ['food'], p_limit: 300 });
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
    return prune({
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
  const result = await searchEvents(userId, { p_types: ['food'], p_from: from, p_to: to, p_limit: 50 });
  const events = result?.events || [];
  if (!events.length) return null;

  const now = Date.now();
  const nearest = events.reduce((best, event) =>
    Math.abs(new Date(event.occurred_at) - now) < Math.abs(new Date(best.occurred_at) - now) ? event : best);
  return rpc('ledger_get_event', { p_event_id: nearest.id });
}

