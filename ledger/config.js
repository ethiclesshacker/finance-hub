// ======================================================
// Configuration for the ingestion jobs.
//
// These run on your machine under launchd, not in the browser and not on
// Cloudflare. That is a deliberate trade: the Supabase service-role key and
// your mailbox passwords never leave the laptop, at the cost of only ingesting
// while it is awake. Nothing else in the system cares where the jobs run —
// they only speak to the same RPC layer the UI uses.
//
// Secrets are read from the environment, never from this repo. Run the jobs
// with `node --env-file-if-exists=.env.ledger`, which the npm scripts do.
// ======================================================

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.ledger.example to .env.ledger and fill it in, ` +
      `then run the job through the npm scripts (they pass --env-file-if-exists).`);
  }
  return value;
}

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
}

function int(name, fallback) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  root: ROOT,

  supabase: {
    // The project URL is the same one the browser build uses, so read it from
    // .env rather than making you keep two copies in step. Only the key
    // differs, and it differs for a reason.
    url: () => process.env.SUPABASE_URL || required('VITE_SUPABASE_URL'),

    // Not a duplicate of VITE_SUPABASE_ANON_KEY. The anon key is subject to
    // RLS and carries no session, so auth.uid() is null for a background job
    // and every write is refused. The jobs write on your behalf with nobody
    // signed in, which only the service role can do — and because it bypasses
    // RLS entirely, it stays in .env.ledger, which is gitignored and never
    // read by a build.
    serviceKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  /**
   * Whose ledger the jobs write to.
   *
   * Optional: with exactly one user in the project, resolveUserId() in db.js
   * finds it. Set it explicitly only if the project has several.
   */
  userId: () => process.env.LEDGER_USER_ID || null,

  timeZone: process.env.LEDGER_TIMEZONE || 'Asia/Kolkata',

  accountsFile: process.env.LEDGER_ACCOUNTS_FILE || resolve(ROOT, 'ledger/accounts.json'),

  limits: {
    // Ceiling per run, so a first run against a large mailbox cannot spiral.
    maxMessages: int('LEDGER_MAX_MESSAGES', 200),
    // Hard cap on model calls per run. The deterministic layers handle the
    // bulk; this is the bill's upper bound if a new sender floods in.
    maxLlmCalls: int('LEDGER_LLM_MAX_CALLS', 25),
    // Skip anything larger than this — big mail is attachments, not receipts.
    maxMessageBytes: int('LEDGER_MAX_MESSAGE_BYTES', 512 * 1024),
    llmBatchSize: int('LEDGER_LLM_BATCH_SIZE', 5),
  },

  llm: {
    enabled: flag('LEDGER_LLM_ENABLED', true),
    apiKey: process.env.OPENAI_API_KEY || null,
    // Set this to the exact model id you want. `node ledger/cli.js models`
    // lists what the key can actually reach, so a wrong value shows up as a
    // list of right ones rather than a silent fallback.
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    timeoutMs: int('LEDGER_LLM_TIMEOUT_MS', 60_000),
    // Extraction is mechanical: read the stated fields, put them in the right
    // slots. There is nothing to reason about, and reasoning tokens are billed
    // like any other. Set to 'low' / 'medium' / 'high' if a hard layout starts
    // being misread, or leave empty to let the model decide.
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? 'none',
  },

  // Keeping a 300-character snippet makes a bad extraction debuggable. It is
  // purged on a schedule by ledger_purge_snippets(); set to 0 to never store.
  storeSnippets: flag('LEDGER_STORE_SNIPPETS', true),
};

/**
 * Mail accounts, from accounts.json. Any number of them, any provider that
 * speaks IMAP — which is what makes "all my addresses across Google and Zoho"
 * one config file rather than two OAuth integrations.
 */
export function loadAccounts(file = config.accountsFile) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No mail accounts configured. Copy ledger/accounts.example.json to ${file} and edit it.`);
    }
    throw err;
  }

  const parsed = JSON.parse(raw);
  const accounts = (parsed.accounts || []).filter(a => a.enabled !== false);

  return accounts.map(account => ({
    key: account.key || `${account.protocol || 'imap'}:${account.user}`,
    protocol: account.protocol || 'imap',
    host: account.host,
    port: account.port || 993,
    secure: account.secure !== false,
    user: account.user,
    folders: account.folders?.length ? account.folders : ['INBOX'],
    lookbackDays: account.lookback_days ?? 7,
    password: resolvePassword(account),
  }));
}

/**
 * Password resolution, most secure first: an environment variable, the macOS
 * Keychain, or — last and least — a literal in the file. A literal is allowed
 * because refusing it entirely just pushes people to weirder workarounds, but
 * accounts.json is gitignored and should be chmod 600.
 */
function resolvePassword(account) {
  if (account.password_env) {
    const value = process.env[account.password_env];
    if (!value) throw new Error(`${account.password_env} is not set (needed for account ${account.user}).`);
    return value;
  }

  if (account.keychain_service) {
    try {
      return execFileSync('security', [
        'find-generic-password',
        '-s', account.keychain_service,
        '-a', account.keychain_account || account.user,
        '-w',
      ], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error(
        `Keychain lookup failed for ${account.user}. Add it with:\n` +
        `  security add-generic-password -s ${account.keychain_service} -a ${account.user} -w`);
    }
  }

  if (account.password) return account.password;

  throw new Error(`Account ${account.user} has no password_env, keychain_service or password.`);
}
