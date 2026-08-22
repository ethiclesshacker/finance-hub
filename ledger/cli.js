#!/usr/bin/env node
// ======================================================
// Personal Event Ledger — command line.
//
//   node ledger/cli.js probe      [--days 7] [--limit 50] [--account KEY] [-v] [--json]
//   node ledger/cli.js ingest     [--account KEY] [--dry-run] [--backfill-days 30] [--limit N]
//   node ledger/cli.js summarize  [--period day|week|month] [--date YYYY-MM-DD]
//   node ledger/cli.js tool NAME  '{"json":"args"}'
//   node ledger/cli.js users
//   node ledger/cli.js purge      [--days 90]
//   node ledger/cli.js reset      --yes   (deletes every event and source)
//   node ledger/cli.js costs      [--days 30]
//   node ledger/cli.js models     [--filter 5.6]
//
// Run these through the npm scripts (`npm run ledger:probe -- --days 3`) so the
// environment file is loaded.
// ======================================================

const [, , command, ...rest] = process.argv;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-v' || token === '--verbose') { args.verbose = true; continue; }
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      const name = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) { args[name] = inline; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[name] = true; continue; }
      args[name] = next; i++;
      continue;
    }
    args._.push(token);
  }
  if (args.limit) args.limit = parseInt(args.limit, 10);
  if (args.days) args.days = parseInt(args.days, 10);
  return args;
}

const args = parseArgs(rest);

const COMMANDS = {
  async probe() {
    const { probe } = await import('./jobs/probe.js');
    await probe(args);
  },

  async ingest() {
    const { ingestEmail } = await import('./jobs/ingest-email.js');
    const result = await ingestEmail(args);
    console.log(JSON.stringify(result, null, 2));
  },

  async summarize() {
    const { summarize } = await import('./jobs/summarize.js');
    const result = await summarize(args);
    console.log(JSON.stringify(result, null, 2));
  },

  async tool() {
    const { runTool, TOOLS } = await import('./tools.js');
    const name = args._[0];
    if (!name) {
      console.log('Available tools:\n');
      for (const [toolName, spec] of Object.entries(TOOLS)) {
        console.log(`  ${toolName.padEnd(24)} ${spec.description}`);
      }
      return;
    }
    const payload = args._[1] ? JSON.parse(args._[1]) : {};
    console.log(JSON.stringify(await runTool(name, payload), null, 2));
  },

  async reset() {
    // Destructive, and deliberately awkward. Everything here is reconstructible
    // from mail in about a minute, which is what makes a reset a reasonable
    // response to an extraction bug — but it is still your ledger, including
    // anything you or Hermes typed in by hand, which is not reconstructible.
    const { db, resolveUserId } = await import('./db.js');
    const userId = await resolveUserId();
    const client = db();

    const counts = {};
    for (const table of ['events', 'sources', 'entities', 'ingestion_checkpoints']) {
      const { count } = await client.from(table).select('*', { count: 'exact', head: true }).eq('user_id', userId);
      counts[table] = count ?? 0;
    }

    const manual = await client.from('events')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId).in('source_type', ['manual', 'hermes']);

    console.log('This will permanently delete, for user ' + userId + ':');
    for (const [table, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(6)}  ${table}`);
    if (manual.count) {
      console.log(`\n  ${manual.count} of those events were entered by hand and CANNOT be re-ingested.`);
    }

    if (!args.yes) {
      console.log('\nNothing was deleted. Re-run with --yes to go ahead.');
      return;
    }

    // Order matters only for readability; the foreign keys cascade.
    for (const table of ['events', 'sources', 'entities', 'ingestion_checkpoints', 'ingestion_runs']) {
      const { error } = await client.from(table).delete().eq('user_id', userId);
      if (error) throw new Error(`${table}: ${error.message}`);
      console.log(`cleared ${table}`);
    }
    console.log('\nDone. Re-populate with: npm run ledger:ingest -- --backfill-days 30');
  },

  async costs() {
    const { summarizeCosts, COST_LEDGER_FILE } = await import('./costs.js');
    const s = summarizeCosts({ days: args.days ?? 30 });
    const money = v => (v ? `$${v.toFixed(4)}` : '—');

    console.log(`Last ${s.days} days — ${COST_LEDGER_FILE}\n`);
    console.log(`  calls              ${s.totals.calls}${s.totals.failures ? ` (${s.totals.failures} failed)` : ''}`);
    console.log(`  prompt tokens      ${s.totals.prompt.toLocaleString()}${s.totals.cached ? ` (${s.totals.cached.toLocaleString()} cached)` : ''}`);
    console.log(`  completion tokens  ${s.totals.completion.toLocaleString()}${s.totals.reasoning ? ` (${s.totals.reasoning.toLocaleString()} reasoning)` : ''}`);
    console.log(`  cost               ${money(s.totals.cost)}`);

    if (s.totals.unpriced) {
      console.log(`\n  ${s.totals.unpriced} call(s) have no price configured.`);
      console.log('  Tokens are recorded either way — add rates to ledger/pricing.json to value them.');
    }

    const table = (title, bucket) => {
      const rows = Object.entries(bucket).sort((a, b) => b[1].tokens - a[1].tokens);
      if (!rows.length) return;
      console.log(`\n${title}`);
      for (const [key, v] of rows) {
        console.log(`  ${key.padEnd(24)} ${String(v.calls).padStart(4)} calls  ${String(v.tokens).padStart(9)} tok  ${money(v.cost).padStart(10)}`);
      }
    };
    table('By job', s.byJob);
    table('By model', s.byModel);
    table('By day', s.byDay);
  },

  async models() {
    const { config } = await import('./config.js');
    if (!config.llm.apiKey) throw new Error('OPENAI_API_KEY is not set.');
    const res = await fetch(`${config.llm.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.llm.apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const ids = ((await res.json()).data || []).map(m => m.id).sort();
    const filtered = args.filter ? ids.filter(id => id.includes(args.filter)) : ids;
    console.log(filtered.join('\n'));
    console.log(`\n${filtered.length} model(s). Current OPENAI_MODEL: ${config.llm.model}`);
  },

  async users() {
    const { db } = await import('./db.js');
    const { data, error } = await db().auth.admin.listUsers();
    if (error) throw error;
    for (const user of data.users) {
      console.log(`${user.id}  ${user.email}`);
    }
    console.log('\nSet LEDGER_USER_ID in .env.ledger to the id you want the jobs to write to.');
  },

  async purge() {
    const { db, resolveUserId } = await import('./db.js');
    const { data, error } = await db().rpc('ledger_purge_snippets', {
      p_days: args.days ?? null, p_user_id: await resolveUserId(),
    });
    if (error) throw error;
    console.log(`Purged cached body text from ${data} source rows.`);
  },
};

const run = COMMANDS[command];
if (!run) {
  console.error(`Unknown command "${command || ''}".\n`);
  console.error('Commands: ' + Object.keys(COMMANDS).join(', '));
  process.exit(1);
}

run().catch(err => {
  console.error(`\n${err.message}`);
  if (process.env.LEDGER_DEBUG) console.error(err.stack);
  process.exit(1);
});
