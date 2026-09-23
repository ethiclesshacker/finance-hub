// ======================================================
// Browser client for card points (HSBC TravelOne).
//
// Reads come from the `cc_points` view rather than the table: a row linked
// to a card alert takes its amount and date from the alert, not from a typed
// copy. Writes go to `cc_transactions` directly or through the SQL functions
// from 0012_card_points.sql / 0013_card_reconcile.sql, which is where the
// "any edit confirms" rule and the reconcile bookkeeping live.
// ======================================================

import { supabase } from '../supabase.js';
import { rpc, unwrap } from '../rpc.js';

// ── Reads ──────────────────────────────────────────────

export const listTransactions = () =>
  unwrap(supabase.from('cc_points').select('*').order('date', { ascending: false }));

export const listRedemptions = () =>
  unwrap(supabase.from('cc_redemptions').select('*').order('date', { ascending: false }));

export const listRules = () =>
  unwrap(supabase.from('cc_merchant_rules').select('*').order('uses', { ascending: false }));

/** What never paired: typed rows without an alert, alerts without a row. */
export const reconcile = () => rpc('cc_reconcile');

/** Pick up card spend the ledger has seen since the last visit. Idempotent. */
export const syncFromEvents = () => rpc('cc_sync_from_events');

// ── Transactions ───────────────────────────────────────

export const upsertTransaction = payload => unwrap(supabase.from('cc_transactions').upsert([payload]));
export const deleteTransaction = id => unwrap(supabase.from('cc_transactions').delete().eq('id', id));

/** One update across many rows — never a loop of single-row updates. */
export const updateTransactions = (ids, patch) =>
  unwrap(supabase.from('cc_transactions').update(patch).in('id', ids));

/**
 * Confirm a row that arrived from a card alert, optionally correcting it.
 * With no fields it only flips `basis` to confirmed; with fields it is the
 * edit path for a linked row (date and amount stay the bank's).
 */
export const confirmTransaction = (id, fields = {}) => rpc('cc_confirm', { p_id: id, ...fields });

// ── Redemptions ────────────────────────────────────────

export const upsertRedemption = payload => unwrap(supabase.from('cc_redemptions').upsert([payload]));
export const deleteRedemption = id => unwrap(supabase.from('cc_redemptions').delete().eq('id', id));

// ── Merchant rules ─────────────────────────────────────

export const updateRule = (merchantKey, patch) =>
  unwrap(supabase.from('cc_merchant_rules').update(patch).eq('merchant_key', merchantKey));

export const deleteRule = merchantKey =>
  unwrap(supabase.from('cc_merchant_rules').delete().eq('merchant_key', merchantKey));

// ── Reconcile actions ──────────────────────────────────

export const linkToEvent     = (id, eventId) => rpc('cc_link', { p_id: id, p_event_id: eventId });
export const markNoAlert     = ids           => rpc('cc_mark_no_alert', { p_ids: ids });
export const createFromEvent = eventId       => rpc('cc_create_from_event', { p_event_id: eventId });
export const ignoreEvents    = eventIds      => rpc('cc_ignore_events', { p_event_ids: eventIds });
