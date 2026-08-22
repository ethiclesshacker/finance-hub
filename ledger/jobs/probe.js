// ======================================================
// `probe` — a dry run against real mail.
//
// Connects, reads, extracts, prints. Touches no database, spends no model
// calls, marks nothing as read. This is the command to run first: it shows
// exactly what the deterministic layers would make of your actual inbox, which
// is the only honest way to tune them.
//
// The last line is the number that matters — what fraction of mail would ever
// reach a model.
// ======================================================

import { config, loadAccounts } from '../config.js';
import { getConnector } from '../connectors/index.js';
import { extractDeterministic, buildIngestPayload } from '../../src/ledger/email.js';

const BOLD = s => `\x1b[1m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;
const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const GREY = s => `\x1b[90m${s}\x1b[0m`;

export async function probe(options = {}) {
  const accounts = loadAccounts().filter(a => !options.account || a.key === options.account);
  if (!accounts.length) throw new Error('No enabled accounts matched.');

  const totals = { seen: 0, bodies: 0, extracted: 0, llm: 0, rejected: 0, events: 0 };
  const byExtractor = {};
  const byReason = {};
  const llmSamples = [];

  for (const account of accounts) {
    const connector = getConnector(account.protocol);
    console.log(`\n${BOLD(account.key)} ${DIM(`${account.host} · ${account.folders.join(', ')}`)}`);

    if (options.days) account.lookbackDays = options.days;

    // No stored cursor: a probe always looks at the recent window, so it can
    // be run repeatedly over the same mail while tuning rules.
    const { messages, stats } = await connector.fetchNew(account, {}, {
      maxMessages: options.limit ?? 50,
      maxMessageBytes: config.limits.maxMessageBytes,
    });

    totals.seen += stats.seen;
    totals.bodies += stats.fetchedBodies;
    console.log(DIM(`  ${stats.seen} in window · ${stats.fetchedBodies} bodies read · ` +
                    `${stats.skippedBySubject} skipped on subject · ${stats.skippedTooLarge} too large`));

    for (const message of messages) {
      const result = extractDeterministic(message, {
        timeZone: config.timeZone,
        selfAddresses: [account.user],
        selfIdentifiers: options.self ? String(options.self).split(',').map(v => v.trim()) : [],
      });

      if (result.ruleErrors?.length) {
        console.log(`  ${YELLOW('!')} rule error: ${JSON.stringify(result.ruleErrors)}`);
      }
      const when = new Date(message.date).toISOString().slice(0, 16).replace('T', ' ');
      const who = (message.from?.address || '?').slice(0, 32).padEnd(32);
      const subject = (message.subject || '(no subject)').slice(0, 46);

      if (result.decision === 'extracted') {
        totals.extracted++;
        for (const extraction of result.extractions) {
          totals.events++;
          byExtractor[extraction.extracted_by] = (byExtractor[extraction.extracted_by] || 0) + 1;
          const amount = extraction.data?.amount ? `₹${extraction.data.amount}` : '';
          console.log(`  ${GREEN('✓')} ${DIM(when)} ${GREY(who)} ${subject}`);
          console.log(`      → ${BOLD(`${extraction.type}/${extraction.subtype || '—'}`)} ` +
                      `${extraction.title} ${amount} ${DIM(`[${extraction.extracted_by}` +
                      `${extraction.dedupe_key ? ` · ${extraction.dedupe_key}` : ' · no key'}]`)}`);
          if (options.json) {
            console.log(DIM(JSON.stringify(buildIngestPayload({
              extraction, message, accountKey: account.key, storeSnippet: config.storeSnippets,
            }), null, 2).split('\n').map(l => '      ' + l).join('\n')));
          }
        }
      } else if (result.decision === 'llm') {
        totals.llm++;
        llmSamples.push({ when, from: message.from?.address, subject: message.subject });
        console.log(`  ${YELLOW('?')} ${DIM(when)} ${GREY(who)} ${subject} ${DIM('→ would ask the model')}`);
      } else {
        totals.rejected++;
        byReason[result.reason] = (byReason[result.reason] || 0) + 1;
        if (options.verbose) {
          console.log(`  ${GREY('·')} ${DIM(when)} ${GREY(who)} ${GREY(subject)} ${DIM(`→ ${result.reason}`)}`);
        }
      }
    }
  }

  console.log(`\n${BOLD('Summary')}`);
  console.log(`  messages in window     ${totals.seen}`);
  console.log(`  bodies downloaded      ${totals.bodies}`);
  console.log(`  ${GREEN('extracted for free')}     ${totals.extracted} messages → ${totals.events} events`);
  console.log(`  ${YELLOW('would call the model')}   ${totals.llm}`);
  console.log(`  ${GREY('no event')}               ${totals.rejected}`);

  if (Object.keys(byReason).length) {
    console.log(`\n${BOLD('Why mail was dropped')}`);
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${reason}`);
    }
  }

  if (Object.keys(byExtractor).length) {
    console.log(`\n${BOLD('Which layer did the work')}`);
    for (const [name, count] of Object.entries(byExtractor).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${name}`);
    }
  }

  const decided = totals.extracted + totals.llm + totals.rejected;
  if (decided) {
    const pct = ((totals.llm / decided) * 100).toFixed(1);
    console.log(`\n  ${BOLD(`${pct}%`)} of read mail would reach the model.`);
  }

  if (llmSamples.length && !options.verbose) {
    console.log(`\n${BOLD('Candidates for a new rule')} ${DIM('(most common senders the rules missed)')}`);
    const bySender = {};
    for (const s of llmSamples) bySender[s.from || '?'] = (bySender[s.from || '?'] || 0) + 1;
    for (const [sender, count] of Object.entries(bySender).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${String(count).padStart(4)}  ${sender}`);
    }
  }

  return totals;
}
