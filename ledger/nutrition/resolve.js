// ======================================================
// The ladder.
//
//   food_pending_items()  →  what still needs an answer
//        ↓
//   rung 0  the dictionary itself — already answered, costs nothing
//   rung 0.5 the reference engine — the same dish under a different spelling
//   rung 1  curated table         — the traps a model reliably gets wrong
//   rung 1.7 Anuvaad INDB (local) — measured Indian recipes, judged
//   rung 2  OFF / USDA FDC        — packaged goods only, where a label exists
//   rung 3  the model             — composed dishes, batched, INDB-grounded
//        ↓
//   food_upsert_item()    →  written once, reused by every event
//
// The ordering is the opposite of the obvious one, and it is the point of the
// whole module. Structured databases go *after* the curated table and are asked
// only about branded packages, because probing this ledger's real dish names
// showed they answer a different question than the one being asked: they hold
// ingredients and packaged products, while a receipt line is a composed dish at
// an unknown portion. See the header of databases.js for the measurements.
//
// Nothing here writes to events. The dictionary is keyed by dish, the rollup
// happens at read time in SQL, and correcting one row re-values the whole year.
// ======================================================

import { db, resolveUserId } from '../db.js';
import { config } from '../config.js';
import { normalizeName } from '../../src/ledger/normalize.js';
import { curatedLookup, isNonFood, looksPackaged } from './curated.js';
import { findReference, rowFromReference } from './reference.js';
import { resolveFromDatabases } from './databases.js';
import { matchINDB } from './indb.js';
import { estimateBatch } from './llm.js';

/** Everything the resolver still has no answer for, heaviest first. */
export async function pendingItems(userId, limit = 500) {
  const { data, error } = await db().rpc('food_pending_items', {
    p_limit: limit, p_user_id: userId,
  });
  if (error) throw new Error(`food_pending_items failed: ${error.message}`);
  return data || [];
}

/** How much of the ledger the dictionary can currently answer. */
export async function coverage(userId) {
  const { data, error } = await db().rpc('food_coverage', { p_user_id: userId });
  if (error) throw new Error(`food_coverage failed: ${error.message}`);
  return data || {};
}

async function upsert(userId, displayName, row) {
  const { data, error } = await db().rpc('food_upsert_item', {
    p_user_id: userId,
    p_payload: { display_name: displayName, ...row },
  });
  if (error) throw new Error(`food_upsert_item(${displayName}) failed: ${error.message}`);
  return data;
}

/**
 * Run the ladder over everything unresolved.
 *
 * `dryRun` walks the same rungs and reports what each would have written
 * without touching the database or, for the model rung, spending anything.
 */
export async function resolvePending({
  userId,
  limit = 500,
  dryRun = false,
  useReferences = true,
  useDatabases = true,
  useLlm = true,
  verbose = false,
  batchSize = config.limits.llmBatchSize * 6,
  maxLlmCalls = config.limits.maxLlmCalls,
  log = console.log,
} = {}) {
  const uid = userId || await resolveUserId();
  const pending = await pendingItems(uid, limit);

  const counters = {
    pending: pending.length,
    nonFood: 0, referenced: 0, curated: 0, indb: 0, database: 0, llm: 0,
    unresolved: 0, llmCalls: 0, rejected: [],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };

  if (!pending.length) {
    log('Nothing pending — every dish in the ledger already has a row.');
    return counters;
  }

  log(`${pending.length} distinct dish names to resolve.\n`);

  // ── Rung 0.5 — not food at all ───────────────────────
  // Recorded rather than skipped. A row saying "this is a USB hub" stops the
  // resolver reconsidering it on every future run, and stops the rollup
  // treating an unresolved name as merely unknown.
  const remaining = [];
  for (const item of pending) {
    if (isNonFood(item.display_name)) {
      counters.nonFood++;
      if (!dryRun) {
        await upsert(uid, item.display_name, {
          kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
          category: 'non_food', source: 'curated', confidence: 1,
          source_ref: { rule: 'non-food item in a quick-commerce basket' },
        });
      }
      continue;
    }
    remaining.push(item);
  }
  if (counters.nonFood) log(`  ${counters.nonFood} not food (quick-commerce baskets) — recorded as zero.`);

  // ── Rung 1 — the curated table ───────────────────────
  const afterCurated = [];
  for (const item of remaining) {
    const hit = curatedLookup(item.display_name);
    if (!hit) { afterCurated.push(item); continue; }
    counters.curated++;
    if (!dryRun) {
      await upsert(uid, item.display_name, {
        ...hit, source: 'curated', confidence: 0.9,
        source_ref: { rule: 'curated table' },
      });
    }
  }
  if (counters.curated) log(`  ${counters.curated} from the curated table.`);

  // ── Rung 1.5 — the reference engine ──────────────────
  //
  // Deliberately after the curated table and before anything that costs money.
  // The dictionary grows as this loop runs, so a name resolved by the model in
  // an early batch is available to match against later in the same run — which
  // is why this is a sequential loop rather than a parallel map.
  const afterReference = [];
  if (useReferences) {
    for (const item of afterCurated) {
      const match = await findReference(uid, item.display_name, { log: verbose ? log : undefined });
      if (!match) { afterReference.push(item); continue; }
      counters.referenced++;
      log(`    "${item.display_name}" ← "${match.row.display_name}" (${match.reason})`);
      if (!dryRun) await upsert(uid, item.display_name, rowFromReference(match));
    }
    if (counters.referenced) log(`  ${counters.referenced} matched a dish already in the dictionary.`);
  } else {
    afterReference.push(...afterCurated);
  }

  // ── Rung 1.7 — Anuvaad INDB ──────────────────────────
  //
  // A local file of measured Indian recipes, so it costs nothing to consult
  // and cannot rate-limit. Judged with the same gates as the remote databases:
  // a generic name it truly contains resolves to measured data; everything
  // else falls through untouched.
  const afterIndb = [];
  for (const item of afterReference) {
    const hit = matchINDB(item.display_name);
    if (!hit.ok) { afterIndb.push(item); continue; }
    counters.indb++;
    log(`    "${item.display_name}" = INDB "${hit.row.source_ref.name}" (${hit.row.kcal} kcal / ${hit.row.portion_g} g)`);
    if (!dryRun) await upsert(uid, item.display_name, hit.row);
  }
  if (counters.indb) log(`  ${counters.indb} matched measured Indian recipes (INDB).`);

  // ── Rung 2 — structured databases, packaged goods only ──
  const afterDb = [];
  if (useDatabases) {
    const packaged = afterIndb.filter((i) => looksPackaged(i.display_name));
    const composed = afterIndb.filter((i) => !looksPackaged(i.display_name));

    if (packaged.length) {
      log(`  ${packaged.length} look packaged — asking Open Food Facts / FDC…`);
      for (const item of packaged) {
        const res = await resolveFromDatabases(item.display_name);
        if (res.ok) {
          counters.database++;
          if (!dryRun) await upsert(uid, item.display_name, { ...res.row, category: 'packaged_snack' });
        } else {
          // A rejection here is not a failure. It is the gate working: the
          // name goes to the model, which is better at it anyway.
          afterDb.push(item);
        }
      }
      log(`  ${counters.database} resolved from a real label; ${packaged.length - counters.database} rejected and passed on.`);
    }
    afterDb.push(...composed);
  } else {
    afterDb.push(...afterIndb);
  }

  // ── Rung 3 — the model ───────────────────────────────
  if (!useLlm || !afterDb.length) {
    counters.unresolved = afterDb.length;
    if (afterDb.length) log(`  ${afterDb.length} left unresolved (model rung off).`);
    return counters;
  }

  log(`  ${afterDb.length} composed dishes for the model, in batches of ${batchSize}.`);

  for (let i = 0; i < afterDb.length; i += batchSize) {
    if (counters.llmCalls >= maxLlmCalls) {
      log(`  Stopped at the ${maxLlmCalls}-call ceiling; ${afterDb.length - i} names left for the next run.`);
      counters.unresolved += afterDb.length - i;
      break;
    }

    const batch = afterDb.slice(i, i + batchSize);
    const names = batch.map((b) => b.display_name);

    if (dryRun) {
      log(`    [dry run] would ask for ${names.length}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`);
      counters.llmCalls++;
      continue;
    }

    const res = await estimateBatch(names);
    counters.llmCalls++;
    if (res.usage) {
      counters.usage.prompt_tokens += res.usage.prompt_tokens || 0;
      counters.usage.completion_tokens += res.usage.completion_tokens || 0;
    }

    if (!res.ok) {
      log(`    batch failed: ${res.error}`);
      counters.unresolved += names.length;
      continue;
    }

    for (const name of names) {
      const row = res.rows.get(name);
      if (!row) { counters.unresolved++; continue; }
      await upsert(uid, name, row);
      counters.llm++;
    }

    for (const r of res.rejected) {
      counters.rejected.push(r);
      log(`    rejected "${r.name}": ${r.reason}`);
    }

    log(`    batch ${Math.floor(i / batchSize) + 1}: ${res.rows.size}/${names.length} resolved.`);
  }

  return counters;
}

/**
 * Set or correct one dish by hand.
 *
 * Writes with source 'manual', which outranks every other rung, so a row you
 * have checked is never overwritten by a later resolver run.
 */
export async function setManual(userId, displayName, fields) {
  const uid = userId || await resolveUserId();
  const normalized = normalizeName(displayName);
  if (!normalized) throw new Error(`"${displayName}" normalizes to nothing`);

  const result = await upsert(uid, displayName, {
    ...fields, source: 'manual', confidence: 1,
    source_ref: { entered_by: 'human', at: new Date().toISOString() },
  });

  // The upsert keeps a verified row untouched, so verification is a separate
  // write — otherwise the first manual edit would lock out the second.
  const { error } = await db().from('food_items')
    .update({ verified: true }).eq('user_id', uid).eq('normalized_name', normalized);
  if (error) throw new Error(`could not mark verified: ${error.message}`);

  return result;
}

/**
 * Re-anchor the dictionary's model estimates against better sources.
 *
 * Two passes over rows whose source is 'llm':
 *
 *   1. INDB — a judged direct match upgrades the row to measured data
 *      (rank 38 over 20; the upsert guard permits it, and would refuse the
 *      reverse). "Masala Dosa" moves from a guess to a measurement.
 *   2. The model again, for what remains — but grounded now: every batch
 *      carries the closest measured INDB recipes, so even the dishes INDB
 *      does not contain are re-estimated against real Indian densities
 *      instead of from memory.
 *
 * Never touches manual, curated, off, fdc or verified rows: those are either
 * a person's word or a label, and a recalculation has no business with them.
 */
export async function reanchor({ userId, dryRun = false, log = console.log } = {}) {
  const uid = userId || await resolveUserId();

  const { data: rows, error } = await db().from('food_items')
    .select('display_name, kcal, portion_g, source, verified')
    .eq('user_id', uid).eq('source', 'llm').eq('verified', false)
    .not('kcal', 'is', null);
  if (error) throw new Error(`could not list llm rows: ${error.message}`);

  const counters = { candidates: rows.length, indb: 0, reestimated: 0, unchanged: 0, failed: 0, moves: [] };
  log(`${rows.length} model-estimated dishes to re-anchor.\n`);

  // ── Pass 1: measured upgrades ────────────────────────
  const { matchINDB } = await import('./indb.js');
  const remaining = [];
  for (const row of rows) {
    const hit = matchINDB(row.display_name);
    if (!hit.ok) { remaining.push(row); continue; }
    counters.indb++;
    counters.moves.push({ name: row.display_name, from: row.kcal, to: hit.row.kcal, via: 'indb' });
    log(`  INDB  ${row.display_name}: ${Math.round(row.kcal)} → ${Math.round(hit.row.kcal)} kcal (${hit.row.source_ref.name})`);
    if (!dryRun) await upsert(uid, row.display_name, hit.row);
  }

  // ── Pass 2: grounded re-estimation ───────────────────
  const { estimateBatch } = await import('./llm.js');
  const batchSize = config.limits.llmBatchSize * 6;
  for (let i = 0; i < remaining.length; i += batchSize) {
    const batch = remaining.slice(i, i + batchSize);
    if (dryRun) { log(`  [dry run] would re-estimate ${batch.length} dishes`); continue; }
    const res = await estimateBatch(batch.map(r => r.display_name));
    if (!res.ok) { log(`  batch failed: ${res.error}`); counters.failed += batch.length; continue; }
    for (const row of batch) {
      const v = res.rows.get(row.display_name);
      if (!v) { counters.failed++; continue; }
      // Only a material change is worth a write — rewriting 620 as 615 churns
      // the audit trail for nothing.
      if (Math.abs(v.kcal - row.kcal) / Math.max(row.kcal, 1) < 0.08) { counters.unchanged++; continue; }
      counters.reestimated++;
      counters.moves.push({ name: row.display_name, from: row.kcal, to: v.kcal, via: 'model' });
      log(`  model ${row.display_name}: ${Math.round(row.kcal)} → ${Math.round(v.kcal)} kcal`);
      await upsert(uid, row.display_name, v);
    }
  }

  return counters;
}
