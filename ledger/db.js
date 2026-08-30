// ======================================================
// Supabase access for the jobs.
//
// The jobs connect with the service role, which bypasses RLS — so every call
// passes an explicit user id, and the SQL functions check ledger_can_act_as()
// rather than trusting it. Writes go exclusively through ledger_ingest_event:
// the jobs never INSERT into events directly, because deduplication and merge
// rules live in the database and must apply to every writer.
// ======================================================

import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { normalizeName } from '../src/ledger/normalize.js';

let client = null;

export function db() {
  if (!client) {
    client = createClient(config.supabase.url(), config.supabase.serviceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-ledger-client': 'jobs' } },
    });
  }
  return client;
}

// ── Whose ledger ───────────────────────────────────────

let cachedUserId = null;

/**
 * The user the jobs act for.
 *
 * An explicit LEDGER_USER_ID always wins. Otherwise, if the project has
 * exactly one user, that is unambiguously the answer and there is no reason to
 * make you copy a uuid into a file. More than one, and it has to be stated —
 * guessing which person's life to record would be the wrong kind of clever.
 */
export async function resolveUserId() {
  if (cachedUserId) return cachedUserId;

  const explicit = config.userId();
  if (explicit) {
    cachedUserId = explicit;
    return cachedUserId;
  }

  const { data, error } = await db().auth.admin.listUsers();
  if (error) throw new Error(`Could not list users to resolve LEDGER_USER_ID: ${error.message}`);

  const users = data?.users || [];
  if (users.length === 1) {
    cachedUserId = users[0].id;
    return cachedUserId;
  }
  if (!users.length) {
    throw new Error('This Supabase project has no users yet. Sign in to the app once, then re-run.');
  }

  throw new Error(
    'This project has more than one user, so LEDGER_USER_ID has to be set in .env.ledger.\n' +
    users.map(u => `  ${u.id}  ${u.email}`).join('\n'));
}

async function rpc(fn, args) {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}${error.hint ? ` (${error.hint})` : ''}`);
  return data;
}

/** The one write path. Returns { action, event_id, source_id, matched_by }. */
export function ingestEvent(userId, payload) {
  return rpc('ledger_ingest_event', { p_user_id: userId, p_payload: payload });
}

export function searchEvents(userId, filters = {}) {
  return rpc('ledger_search_events', { ...filters, p_user_id: userId });
}

export function stats(userId, from, to) {
  return rpc('ledger_stats', { p_from: from, p_to: to, p_user_id: userId });
}

export function getDailySummary(userId, date) {
  return rpc('ledger_get_daily_summary', { p_date: date, p_user_id: userId });
}

export function upsertDailySummary(userId, date, summary, sections, generatedBy, metadata) {
  return rpc('ledger_upsert_daily_summary', {
    p_date: date, p_summary: summary, p_sections: sections,
    p_generated_by: generatedBy, p_metadata: metadata, p_user_id: userId,
  });
}

export function upsertPeriodSummary(userId, periodType, start, end, summary, sections, generatedBy, metadata) {
  return rpc('ledger_upsert_period_summary', {
    p_period_type: periodType, p_start: start, p_end: end, p_summary: summary,
    p_sections: sections, p_generated_by: generatedBy, p_metadata: metadata, p_user_id: userId,
  });
}

/**
 * How often a sender/subject shape has been seen and how often it produced an
 * event. A fingerprint seen repeatedly that has never yielded one is not worth
 * another model call — this is the cheap half of the cost control.
 */
export function fingerprintStats(userId, days = 90) {
  return rpc('ledger_fingerprint_stats', { p_days: days, p_user_id: userId });
}

/**
 * The merchants you have already eaten at.
 *
 * A card alert names a merchant and nothing else, so whether "BRAMBLE" was
 * dinner or a hardware shop is not in the mail. It is in the ledger: if that
 * name already carries a food event — because a receipt said so, or because
 * you corrected one by hand — the next alert from it is a meal too. This is
 * what makes a correction stick without a rule being written for it.
 */
export async function foodMerchants(userId, limit = 500) {
  const result = await rpc('ledger_search_events', {
    p_query: null, p_types: ['food'], p_subtypes: null, p_statuses: null, p_source_types: null,
    p_entity_id: null, p_entity_name: null, p_from: null, p_to: null, p_min_confidence: null,
    p_limit: limit, p_offset: 0, p_ascending: false, p_user_id: userId,
  });

  const names = new Set();
  for (const event of result?.events || []) {
    for (const name of [event.data?.restaurant, event.data?.merchant]) {
      const normalized = normalizeName(name);
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

/** One user setting, with the same defaults the SQL layer uses. */
export async function setting(userId, key, fallback) {
  const { data, error } = await db()
    .from('user_settings').select('value').eq('user_id', userId).eq('key', key).maybeSingle();
  if (error || !data) return fallback;
  return data.value ?? fallback;
}

// ── Checkpoints ────────────────────────────────────────

export async function getCheckpoint(userId, sourceType, accountKey) {
  const { data, error } = await db()
    .from('ingestion_checkpoints')
    .select('cursor, last_success_at')
    .eq('user_id', userId).eq('source_type', sourceType).eq('account_key', accountKey)
    .maybeSingle();
  if (error) throw new Error(`getCheckpoint: ${error.message}`);
  return data?.cursor ?? {};
}

/**
 * Only ever called after the events from that cursor position are committed.
 * Moving it first would mean a crash silently skipped mail forever; moving it
 * after means a crash re-reads a few messages, which ingestion is designed to
 * make free.
 */
export async function setCheckpoint(userId, sourceType, accountKey, cursor, succeeded = true) {
  const row = {
    user_id: userId, source_type: sourceType, account_key: accountKey,
    cursor, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (succeeded) row.last_success_at = row.last_run_at;

  const { error } = await db()
    .from('ingestion_checkpoints')
    .upsert(row, { onConflict: 'user_id,source_type,account_key' });
  if (error) throw new Error(`setCheckpoint: ${error.message}`);
}

// ── Run records ────────────────────────────────────────

export async function startRun(userId, sourceType, accountKey, metadata = {}) {
  const { data, error } = await db()
    .from('ingestion_runs')
    .insert({ user_id: userId, source_type: sourceType, account_key: accountKey, metadata })
    .select('id').single();
  if (error) throw new Error(`startRun: ${error.message}`);
  return data.id;
}

export async function finishRun(runId, counters) {
  const { error } = await db()
    .from('ingestion_runs')
    .update({
      completed_at: new Date().toISOString(),
      status: counters.status,
      items_seen: counters.itemsSeen ?? 0,
      events_created: counters.eventsCreated ?? 0,
      events_updated: counters.eventsUpdated ?? 0,
      events_skipped: counters.eventsSkipped ?? 0,
      errors: counters.errors ?? [],
      metadata: counters.metadata ?? {},
    })
    .eq('id', runId);
  if (error) throw new Error(`finishRun: ${error.message}`);
}
