// ======================================================
// Local cost ledger.
//
// Every billable call the jobs make is appended here as one JSON line, before
// anything else happens with the result. Deliberately a local file, not a
// Supabase table: it is operational data about this machine's jobs, not part
// of your life record, and it should stay readable when the database is
// unreachable — which is exactly when you want to know what a retry loop cost.
//
// Tokens are recorded as facts, because the API reports them. Money is derived
// at read time from ledger/pricing.json, so correcting a price re-values the
// whole history instead of leaving old rows wrong. A model with no price shows
// its tokens and a blank cost rather than an invented number.
// ======================================================

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COST_FILE = process.env.LEDGER_COST_FILE || resolve(HERE, 'costs.jsonl');
const PRICING_FILE = process.env.LEDGER_PRICING_FILE || resolve(HERE, 'pricing.json');

let pricing = null;

function prices() {
  if (pricing) return pricing;
  try {
    pricing = JSON.parse(readFileSync(PRICING_FILE, 'utf8')).models || {};
  } catch {
    pricing = {};
  }
  return pricing;
}

/**
 * Cost of one call, or null when the model has no price configured.
 *
 * Cached input tokens are billed differently and are already counted inside
 * prompt_tokens, so they are subtracted out before the full-price multiply —
 * otherwise a well-cached run reads as more expensive than it was.
 */
export function costOf(model, usage) {
  const configured = prices()[model];
  if (!configured || configured.input == null || configured.output == null) return null;

  const prompt = usage?.prompt_tokens || 0;
  // Long-context pricing kicks in above a threshold. This pipeline's calls run
  // one to five thousand tokens, so it never gets there — but the rate table
  // should still be right rather than merely adequate.
  const price = (configured.long_context && prompt > (configured.long_context_threshold ?? Infinity))
    ? { ...configured, ...configured.long_context }
    : configured;

  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const written = usage?.prompt_tokens_details?.cache_write_tokens || 0;
  // Cached and freshly-written tokens are both counted inside prompt_tokens,
  // so they come out before the full-price multiply — otherwise a well-cached
  // run reads as more expensive than it was.
  const fresh = Math.max(prompt - cached - written, 0);
  const output = usage?.completion_tokens || 0;

  return (fresh * price.input
        + cached * (price.cached_input ?? price.input)
        + written * (price.cache_write ?? price.input)
        + output * price.output) / 1_000_000;
}

/**
 * Append one call. Never throws: a cost ledger that can break an ingestion run
 * is worse than one with a gap in it.
 */
export function recordUsage({ job, model, usage, meta = {}, ok = true, error = null }) {
  try {
    const row = {
      at: new Date().toISOString(),
      job,
      model,
      ok,
      error: error || undefined,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cache_write_tokens: usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
      // A snapshot of what it cost under the rates in force at the time. Kept
      // for the record, but never what a total is built from — see below.
      cost_usd: costOf(model, usage),
      ...meta,
    };
    mkdirSync(dirname(COST_FILE), { recursive: true });
    appendFileSync(COST_FILE, JSON.stringify(row) + '\n');
    return row;
  } catch {
    return null;
  }
}

/** Every recorded call, newest last. */
export function readUsage() {
  if (!existsSync(COST_FILE)) return [];
  return readFileSync(COST_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Recompute a row's cost from its tokens under today's price table.
 *
 * Reading the stored cost_usd instead would freeze every row at the rates that
 * happened to be configured when it was written — which, for calls recorded
 * before the rates were known at all, means a permanent blank. Tokens are the
 * fact; money is a view of them.
 */
function rowCost(row) {
  return costOf(row.model, {
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    prompt_tokens_details: {
      cached_tokens: row.cached_tokens || 0,
      cache_write_tokens: row.cache_write_tokens || 0,
    },
  });
}

/** Totals for a window, broken down by day, job and model. */
export function summarizeCosts({ days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const rows = readUsage().filter(r => new Date(r.at).getTime() >= since);

  const totals = { calls: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, cost: 0, unpriced: 0, failures: 0 };
  const byDay = {}, byJob = {}, byModel = {};

  for (const row of rows) {
    totals.calls++;
    totals.prompt += row.prompt_tokens || 0;
    totals.completion += row.completion_tokens || 0;
    totals.cached += row.cached_tokens || 0;
    totals.reasoning += row.reasoning_tokens || 0;
    if (!row.ok) totals.failures++;
    const cost = rowCost(row);
    if (cost == null) totals.unpriced++;
    else totals.cost += cost;

    const day = row.at.slice(0, 10);
    for (const [bucket, key] of [[byDay, day], [byJob, row.job || 'unknown'], [byModel, row.model || 'unknown']]) {
      bucket[key] ||= { calls: 0, tokens: 0, cost: 0, unpriced: 0 };
      bucket[key].calls++;
      bucket[key].tokens += row.total_tokens || 0;
      if (cost == null) bucket[key].unpriced++;
      else bucket[key].cost += cost;
    }
  }

  return { days, since: new Date(since).toISOString(), totals, byDay, byJob, byModel, file: COST_FILE };
}

export const COST_LEDGER_FILE = COST_FILE;
