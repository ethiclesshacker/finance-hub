// ======================================================
// The pipeline: messages in, ledger rows out.
//
//   connector → extraction → normalization → dedupe → storage → entities
//
// Only the first stage knows what a mailbox is, and only the last knows what
// Postgres is. Everything between is the same for any source: hand this
// function a list of messages in the normalized shape and it fills the ledger.
//
// Two rules it enforces regardless of which extraction rung fired:
//
//   - Every message that was read produces a source row, even when it produces
//     no event. That is what makes a "we looked at this and there was nothing
//     here" verdict durable, and what the fingerprint cache learns from.
//   - Nothing is written except through ledger_ingest_event, so deduplication
//     and merge rules are applied identically to every writer.
// ======================================================

import { config } from './config.js';
import { ingestEvent, fingerprintStats, foodMerchants, setting } from './db.js';
import { extractDeterministic, buildIngestPayload } from '../src/ledger/email.js';
import { extractWithLLM } from './extract/llm.js';

// A sender/subject shape seen this many times that has never yielded an event
// is not worth another model call. The cheap half of the cost control: it only
// ever suppresses negatives, so it cannot cause a missed event that the rules
// would have caught.
const FINGERPRINT_MIN_SIGHTINGS = 3;

export async function runPipeline({ userId, accountKey, selfAddresses = [], messages, dryRun = false }) {
  const counters = {
    itemsSeen: messages.length,
    eventsCreated: 0,
    eventsUpdated: 0,
    eventsSkipped: 0,
    sourcesOnly: 0,
    llmCalls: 0,
    llmUsage: { prompt_tokens: 0, completion_tokens: 0 },
    byExtractor: {},
    errors: [],
  };

  // Who counts as "me" for the purpose of spotting self-transfers. Read once
  // per run rather than per message.
  const selfIdentifiers = String(await setting(userId, 'ledger_self_identifiers', ''))
    .split(',').map(v => v.trim()).filter(Boolean);

  // Which merchants are places you eat. Read once per run and handed to the
  // rules, so a card alert from a restaurant lands as a meal rather than as a
  // purchase the Food screen never sees. A failure here costs classification,
  // never the run.
  let knownFood = new Set();
  try {
    knownFood = await foodMerchants(userId);
  } catch (err) {
    counters.errors.push({ stage: 'food_merchants', error: err.message });
  }

  // ── Stage 1: deterministic extraction ────────────────
  const deterministic = [];
  const llmCandidates = [];
  const noEvent = [];

  for (const message of messages) {
    let result;
    try {
      result = extractDeterministic(message, {
        timeZone: config.timeZone, selfAddresses, selfIdentifiers, foodMerchants: knownFood,
      });
    } catch (err) {
      counters.errors.push({ stage: 'extract', message: message.messageId, error: err.message });
      continue;
    }

    // A rule that throws is a bug in the rule, not an odd email — it would
    // otherwise silently stop extracting from every message it matches.
    if (result.ruleErrors?.length) {
      for (const failure of result.ruleErrors) counters.errors.push({ stage: 'rule', ...failure });
    }

    if (result.decision === 'extracted') deterministic.push({ message, result });
    else if (result.decision === 'llm')  llmCandidates.push({ message, result });
    else                                 noEvent.push({ message, result });
  }

  // ── Stage 2: fingerprint cache ───────────────────────
  let suppressed = 0;
  if (llmCandidates.length) {
    let known = {};
    try {
      known = (await fingerprintStats(userId, 90)) || {};
    } catch (err) {
      counters.errors.push({ stage: 'fingerprints', error: err.message });
    }

    for (let i = llmCandidates.length - 1; i >= 0; i--) {
      const stat = known[llmCandidates[i].result.fingerprint];
      if (stat && stat.seen >= FINGERPRINT_MIN_SIGHTINGS && stat.events === 0) {
        const [item] = llmCandidates.splice(i, 1);
        item.result = { ...item.result, reason: `fingerprint seen ${stat.seen}×, never an event` };
        noEvent.push(item);
        suppressed++;
      }
    }
  }
  counters.fingerprintSuppressed = suppressed;

  // ── Stage 3: the model, for what is left ─────────────
  const llmExtractions = new Map();   // message index in llmCandidates → extractions

  if (llmCandidates.length && config.llm.enabled) {
    const batchSize = Math.max(1, config.limits.llmBatchSize);
    const maxCalls = config.limits.maxLlmCalls;

    for (let offset = 0; offset < llmCandidates.length; offset += batchSize) {
      if (counters.llmCalls >= maxCalls) {
        counters.errors.push({
          stage: 'llm',
          error: `call ceiling of ${maxCalls} reached; ${llmCandidates.length - offset} messages left for the next run`,
        });
        break;
      }

      const batch = llmCandidates.slice(offset, offset + batchSize);
      const { results, calls, error, usage } = await extractWithLLM(batch.map(b => b.message), { selfIdentifiers, timeZone: config.timeZone });
      counters.llmCalls += calls;
      if (usage) {
        counters.llmUsage.prompt_tokens += usage.prompt_tokens || 0;
        counters.llmUsage.completion_tokens += usage.completion_tokens || 0;
      }
      if (error) {
        counters.errors.push({ stage: 'llm', error });
        continue;
      }

      for (const [batchIndex, result] of results) {
        llmExtractions.set(offset + batchIndex, result);
      }
    }
  }

  // ── Stage 4: storage ─────────────────────────────────
  // Chronological, so an order is in the ledger before the delivery mail that
  // wants to relate to it.
  const writes = [];

  for (const { message, result } of deterministic) {
    for (const extraction of result.extractions) {
      writes.push({ message, extraction });
      counters.byExtractor[extraction.extracted_by] = (counters.byExtractor[extraction.extracted_by] || 0) + 1;
    }
  }

  llmCandidates.forEach((candidate, index) => {
    const result = llmExtractions.get(index);
    if (result?.isEvent && result.extractions.length) {
      for (const extraction of result.extractions) {
        writes.push({ message: candidate.message, extraction });
        counters.byExtractor[extraction.extracted_by] = (counters.byExtractor[extraction.extracted_by] || 0) + 1;
      }
    } else {
      // Asked and answered: record the source so the next run has the verdict.
      writes.push({ message: candidate.message, extraction: null,
                    verdict: result?.reason || 'model returned no event' });
    }
  });

  for (const { message, result } of noEvent) {
    writes.push({ message, extraction: null, verdict: result.reason });
  }

  writes.sort((a, b) => new Date(a.message.date) - new Date(b.message.date));

  for (const write of writes) {
    const payload = buildIngestPayload({
      extraction: write.extraction,
      message: write.message,
      accountKey,
      storeSnippet: config.storeSnippets,
    });

    if (write.verdict) {
      payload.source.metadata = { ...payload.source.metadata, verdict: write.verdict };
    }

    if (dryRun) {
      counters.eventsSkipped++;
      continue;
    }

    try {
      const outcome = await ingestEvent(userId, payload);
      switch (outcome?.action) {
        case 'created':     counters.eventsCreated++; break;
        case 'updated':     counters.eventsUpdated++; break;
        case 'skipped':     counters.eventsSkipped++; break;
        case 'source_only': counters.sourcesOnly++;  break;
        default: break;
      }
      if (outcome?.conflicts?.length) {
        counters.errors.push({ stage: 'merge', event: outcome.event_id, conflicts: outcome.conflicts });
      }
    } catch (err) {
      counters.errors.push({ stage: 'ingest', message: write.message.messageId, error: err.message });
    }
  }

  return counters;
}
