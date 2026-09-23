// ======================================================
// The one way a browser module talks to Postgres.
//
// supabase-js reports failure as `{ data, error }` rather than throwing, so
// every caller used to carry its own `if (error) …` block — twenty of them,
// each deciding afresh whether to toast, log or swallow. Both helpers here
// throw instead, so a call site has one shape: `await`, and catch if it
// cares. The API modules (ledger, health, networth, points) build on these;
// views never touch `supabase.rpc` or `.from()` directly.
// ======================================================

import { supabase } from './supabase.js';

/** Call a SQL function with the user's JWT. Throws on error, resolves to `data`. */
export async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Run a PostgREST query builder (`supabase.from(...).select(...)` etc.) and
 * unwrap it the same way. Resolves to `data`, which for a select is an array
 * and for a write is whatever `.select()` was chained (usually null).
 */
export async function unwrap(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}
