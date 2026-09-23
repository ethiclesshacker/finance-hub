// Run with: npm test
// The local cost ledger. Runs in its own process (node --test isolates files),
// so the file and price table can be pointed at a scratch directory before
// the module reads them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ledger-costs-'));
process.env.LEDGER_COST_FILE = join(dir, 'costs.jsonl');
process.env.LEDGER_PRICING_FILE = join(dir, 'pricing.json');
writeFileSync(process.env.LEDGER_PRICING_FILE, JSON.stringify({
  models: {
    // USD per million tokens. Round numbers, so the arithmetic is checkable by eye.
    priced: { input: 1, cached_input: 0.1, cache_write: 2, output: 10 },
    'no-output-rate': { input: 1 },
  },
}));

const { recordUsage, summarizeCosts, COST_LEDGER_FILE } = await import('../ledger/costs.js');

test('the ledger file is the one the environment named', () => {
  assert.equal(COST_LEDGER_FILE, process.env.LEDGER_COST_FILE);
});

test('a call is recorded as tokens, never as money', () => {
  const row = recordUsage({
    job: 'ingest:extract', model: 'priced',
    usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
             prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
             completion_tokens_details: { reasoning_tokens: 50 } },
    meta: { ms: 812 },
  });
  assert.equal(row.prompt_tokens, 1000);
  assert.equal(row.cached_tokens, 300);
  assert.equal(row.cache_write_tokens, 100);
  assert.equal(row.reasoning_tokens, 50);
  assert.equal(row.ms, 812);
  assert.equal(row.ok, true);
  // Money is a view of the tokens under today's rates, not a fact of the row.
  assert.equal('cost_usd' in row, false);

  const written = JSON.parse(readFileSync(COST_LEDGER_FILE, 'utf8').trim().split('\n').at(-1));
  assert.equal(written.cost_usd, undefined);
  assert.equal(written.prompt_tokens, 1000);
});

test('a failed call is recorded too, with no tokens and its error', () => {
  const row = recordUsage({ job: 'nutrition', model: 'priced', usage: null, ok: false, error: 'timed out after 60000ms' });
  assert.equal(row.ok, false);
  assert.equal(row.error, 'timed out after 60000ms');
  assert.equal(row.prompt_tokens, 0);
});

test('summarizeCosts prices cached and written tokens at their own rates', () => {
  recordUsage({ job: 'summarize:prose', model: 'no-output-rate', usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 } });

  const s = summarizeCosts({ days: 1 });
  assert.equal(s.totals.calls, 3);
  assert.equal(s.totals.failures, 1);
  assert.equal(s.totals.prompt, 1500);
  assert.equal(s.totals.completion, 250);
  assert.equal(s.totals.cached, 300);
  assert.equal(s.totals.reasoning, 50);

  // The priced call: 600 fresh at 1, 300 cached at 0.1, 100 written at 2, 200 out at 10.
  const expected = (600 * 1 + 300 * 0.1 + 100 * 2 + 200 * 10) / 1_000_000;
  // The failed call has no tokens and costs nothing; the model with no output
  // rate is unpriced rather than guessed at.
  assert.equal(s.totals.unpriced, 1);
  assert.ok(Math.abs(s.totals.cost - expected) < 1e-12, `${s.totals.cost} vs ${expected}`);

  assert.equal(s.byJob['ingest:extract'].calls, 1);
  assert.equal(s.byJob['ingest:extract'].tokens, 1200);
  assert.equal(s.byModel['no-output-rate'].unpriced, 1);
  assert.equal(Object.keys(s.byDay).length, 1);
});
