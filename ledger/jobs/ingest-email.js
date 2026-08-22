// ======================================================
// The every-15-minutes job.
//
// One run per mailbox: read the checkpoint, ask the connector what is new,
// push it through the pipeline, then move the checkpoint — in that order. A
// crash anywhere leaves the checkpoint where it was, so the next run re-reads
// a handful of messages, which idempotent ingestion makes free. The opposite
// order would turn a crash into a permanent hole in the ledger.
//
// One failing account never stops the others: each is wrapped, recorded in
// ingestion_runs and reported at the end.
// ======================================================

import { config, loadAccounts } from '../config.js';
import { getConnector } from '../connectors/index.js';
import { getCheckpoint, setCheckpoint, startRun, finishRun, resolveUserId } from '../db.js';
import { runPipeline } from '../pipeline.js';

export async function ingestEmail(options = {}) {
  const userId = await resolveUserId();
  const accounts = loadAccounts().filter(a => !options.account || a.key === options.account);

  if (!accounts.length) {
    throw new Error(options.account
      ? `No enabled account with key "${options.account}".`
      : 'No enabled mail accounts in accounts.json.');
  }

  const summary = { started_at: new Date().toISOString(), accounts: [] };

  for (const account of accounts) {
    const connector = getConnector(account.protocol);
    const runId = await startRun(userId, connector.sourceType, account.key, {
      host: account.host, folders: account.folders,
      dry_run: Boolean(options.dryRun),
      backfill_days: options.backfillDays ? parseInt(options.backfillDays, 10) : null,
    });

    const started = Date.now();
    try {
      const cursor = await getCheckpoint(userId, connector.sourceType, account.key);

      const backfillDays = options.backfillDays ? parseInt(options.backfillDays, 10) : null;

      const { messages, cursor: nextCursor, stats } = await connector.fetchNew(account, cursor, {
        // A backfill is allowed a bigger bite, since it is a one-off catch-up
        // rather than the every-15-minutes path.
        maxMessages: options.limit ? parseInt(options.limit, 10)
                   : backfillDays ? Math.max(config.limits.maxMessages, 1000)
                   : config.limits.maxMessages,
        maxMessageBytes: config.limits.maxMessageBytes,
        ignoreCursor: Boolean(backfillDays),
        lookbackDays: backfillDays || undefined,
      });

      const counters = await runPipeline({
        userId, accountKey: account.key, selfAddresses: [account.user],
        messages, dryRun: Boolean(options.dryRun),
      });

      // Only now, with every event committed.
      if (!options.dryRun) {
        await setCheckpoint(userId, connector.sourceType, account.key, nextCursor, true);
      }

      await finishRun(runId, {
        status: counters.errors.length ? 'partial' : 'succeeded',
        itemsSeen: counters.itemsSeen,
        eventsCreated: counters.eventsCreated,
        eventsUpdated: counters.eventsUpdated,
        eventsSkipped: counters.eventsSkipped,
        errors: counters.errors,
        metadata: {
          connector: stats,
          sources_only: counters.sourcesOnly,
          llm_calls: counters.llmCalls,
          llm_usage: counters.llmUsage,
          fingerprint_suppressed: counters.fingerprintSuppressed,
          by_extractor: counters.byExtractor,
          duration_ms: Date.now() - started,
        },
      });

      summary.accounts.push({ account: account.key, ok: true, ...counters, connector: stats });
    } catch (err) {
      await finishRun(runId, {
        status: 'failed',
        errors: [{ stage: 'run', error: err.message }],
        metadata: { duration_ms: Date.now() - started },
      });
      summary.accounts.push({ account: account.key, ok: false, error: err.message });
    }
  }

  summary.completed_at = new Date().toISOString();
  return summary;
}
