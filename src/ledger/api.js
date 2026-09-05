// ======================================================
// Browser client for the ledger.
//
// Every call goes through the same SQL functions the ingestion jobs and Hermes
// use — with the user's JWT, so RLS is what enforces ownership rather than
// anything in this file. There is deliberately no direct table access here: an
// event created from the UI has to go down the same deduplication path as one
// extracted from an email, or the "one real-world event, one row" promise only
// holds for some writers.
// ======================================================

import { supabase } from '../supabase.js';

async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export function searchEvents({
  query = null, types = null, subtypes = null, statuses = null, sourceTypes = null,
  entityId = null, entityName = null, from = null, to = null,
  minConfidence = null, limit = 100, offset = 0, ascending = false,
} = {}) {
  return rpc('ledger_search_events', {
    p_query: query || null,
    p_types: types?.length ? types : null,
    p_subtypes: subtypes?.length ? subtypes : null,
    p_statuses: statuses?.length ? statuses : null,
    p_source_types: sourceTypes?.length ? sourceTypes : null,
    p_entity_id: entityId, p_entity_name: entityName,
    p_from: from, p_to: to,
    p_min_confidence: minConfidence,
    p_limit: limit, p_offset: offset, p_ascending: ascending,
  });
}

export const getEvent            = id            => rpc('ledger_get_event', { p_event_id: id });
export const dismissEvent        = (id, reason)  => rpc('ledger_dismiss_event', { p_event_id: id, p_reason: reason ?? null });
export const deleteEvent         = (id, purge)   => rpc('ledger_delete_event', { p_event_id: id, p_purge_sources: Boolean(purge) });
export const mergeEvents         = (target, dup) => rpc('ledger_merge_events', { p_target: target, p_duplicate: dup });
export const duplicateCandidates = (id, limit=5) => rpc('ledger_duplicate_candidates', { p_event_id: id, p_limit: limit });
export const reviewQueue         = (limit = 50)  => rpc('ledger_review_queue', { p_limit: limit });
export const getDailySummary     = date          => rpc('ledger_get_daily_summary', { p_date: date });
export const stats               = (from, to)    => rpc('ledger_stats', { p_from: from, p_to: to });
export const exportLedger        = (from, to)    => rpc('ledger_export', { p_from: from, p_to: to });
export const searchEntities      = (q, type)     => rpc('ledger_search_entities', { p_query: q || null, p_type: type || null, p_limit: 25 });

export function createEvent(event, entities = [], { allowMerge = true, sourceType = 'manual' } = {}) {
  return rpc('ledger_create_event', {
    p_event: event, p_entities: entities,
    p_source_type: sourceType, p_allow_merge: allowMerge,
  });
}

export function updateEvent(id, changes, { replaceData = false } = {}) {
  return rpc('ledger_update_event', { p_event_id: id, p_changes: changes, p_replace_data: replaceData });
}

/** Types the ledger has actually seen, for the filter dropdown. */
export async function listEventTypes() {
  const { data, error } = await supabase
    .from('ledger_event_types').select('type, label, icon').order('label');
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Generated summaries across a date range.
 *
 * A per-day RPC would mean one round trip per row of the timeline; the table
 * is RLS-scoped, so a range read is both cheaper and simpler.
 */
export async function dailySummaries(fromDate, toDate) {
  let query = supabase
    .from('daily_summaries')
    .select('date, summary, event_count, generated_by, generated_at')
    .order('date', { ascending: false });
  if (fromDate) query = query.gte('date', fromDate);
  if (toDate) query = query.lte('date', toDate);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return Object.fromEntries((data || []).map(row => [row.date, row]));
}

// ── Nutrition ──────────────────────────────────────────
//
// The dish dictionary is small (one row per distinct thing eaten, not per meal)
// and the Food screen needs all of it to roll anything up, so it is read whole
// and cached by the caller. Direct table access is fine here where it is not
// elsewhere: nothing is being written, and there is no deduplication path to
// bypass — the RLS policy is the whole of the access rule.

/** Every resolved dish, for the client-side rollup in src/ledger/nutrition.js. */
export async function foodDictionary() {
  const { data, error } = await supabase
    .from('food_items')
    .select('normalized_name, display_name, kcal, protein_g, carbs_g, fat_g, portion_g, category, source, confidence, verified')
    .not('kcal', 'is', null);
  if (error) throw new Error(error.message);
  return data || [];
}

/** How much of the ledger the dictionary can answer. Shown beside any total. */
export const foodCoverage = () => rpc('food_coverage', {});

/** Correct one dish by hand. Writes source 'manual', which outranks the resolver. */
export const setFoodItem = payload => rpc('food_upsert_item', { p_user_id: null, p_payload: payload });

// The Dishes page edits the dictionary directly. The upsert function is the
// resolver's door — it is rank-guarded and refuses to touch a verified row —
// and a person correcting a number is exactly who should be allowed past
// both. RLS still scopes every row to its owner.

const DICT_COLUMNS = 'id, normalized_name, display_name, kcal, protein_g, carbs_g, fat_g, portion_g, category, source, confidence, verified, source_ref, updated_at';

/** Every dish, priced or not, for the Dishes page. */
export async function foodDictionaryAll() {
  const { data, error } = await supabase.from('food_items').select(DICT_COLUMNS).order('display_name');
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * A person's numbers for one dish. Marked manual + verified, so no resolver
 * run will ever revisit it, and it re-values every meal that ever had it.
 */
export async function updateFoodItem(id, fields) {
  const patch = {
    ...fields, source: 'manual', confidence: 1, verified: true,
    source_ref: { entered_by: 'human', via: 'dishes page', at: new Date().toISOString() },
  };
  const { data, error } = await supabase.from('food_items').update(patch).eq('id', id).select(DICT_COLUMNS).single();
  if (error) throw new Error(error.message);
  return data;
}

/** Forget the numbers and let the resolver estimate the dish again. */
export async function resetFoodItem(id) {
  const patch = {
    kcal: null, protein_g: null, carbs_g: null, fat_g: null, portion_g: null,
    source: 'llm', confidence: null, verified: false,
    source_ref: { reset_by: 'human', via: 'dishes page', at: new Date().toISOString() },
  };
  const { data, error } = await supabase.from('food_items').update(patch).eq('id', id).select(DICT_COLUMNS).single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Fold one dish into another. Every past meal that named the duplicate is
 * rewritten to name the target, so counts and calories agree retroactively.
 */
export const mergeFoodItems = (targetId, duplicateId) =>
  rpc('food_merge_items', { p_user_id: null, p_target_id: targetId, p_duplicate_id: duplicateId });

/** A dish typed in by hand. Created through the upsert (it owns normalisation), then verified. */
export async function createFoodItem(fields) {
  const res = await setFoodItem({
    ...fields, source: 'manual', confidence: 1,
    source_ref: { entered_by: 'human', via: 'dishes page', at: new Date().toISOString() },
  });
  if (!res?.id) throw new Error('The dish was not created.');
  if (res.action === 'kept_verified' || res.action === 'kept_stronger') {
    throw new Error('That dish already exists — edit it in the list instead.');
  }
  const { data, error } = await supabase.from('food_items').update({ verified: true }).eq('id', res.id).select(DICT_COLUMNS).single();
  if (error) throw new Error(error.message);
  return data;
}

/** The last few ingestion runs — the "is this thing on?" indicator. */
export async function recentRuns(limit = 5) {
  const { data, error } = await supabase
    .from('ingestion_runs')
    .select('source_type, account_key, started_at, completed_at, status, items_seen, events_created, events_updated, errors')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}
