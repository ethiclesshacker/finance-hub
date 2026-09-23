// ======================================================
// Browser client for net worth snapshots.
//
// Three screens read the same table — Dashboard, Net Worth and the FI
// Planner — and each used to write its own `.from('net_worth_entries')` call
// with its own error handling. One fetcher, so they cannot disagree about
// the ordering, and one place to change if the table ever does.
// ======================================================

import { supabase } from '../supabase.js';
import { unwrap } from '../rpc.js';

const TABLE = 'net_worth_entries';

/** Every snapshot, oldest first — the order every chart and projection wants. */
export const listEntries = () =>
  unwrap(supabase.from(TABLE).select('*').order('date', { ascending: true }));

/** Insert or update one snapshot. `payload.id` set means update. */
export const saveEntry = payload => unwrap(supabase.from(TABLE).upsert([payload]));

export const deleteEntry = id => unwrap(supabase.from(TABLE).delete().eq('id', id));
