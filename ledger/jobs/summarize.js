// ======================================================
// Daily, weekly and monthly summarisation.
//
// Every period is built from events, never from the summaries below it. A
// monthly retrospective that summarised four weekly summaries would be a copy
// of a copy — drift with extra steps — so the month re-reads the month.
//
// The digest is assembled deterministically in src/ledger/summary.js. The
// model, when enabled, is given that digest and asked only to write it up. It
// never sees an email, so there is nothing for it to invent, and when it is
// unavailable the deterministic rendering is stored instead. A summary is a
// derived artefact either way.
// ======================================================

import { config } from '../config.js';
import { chat } from '../extract/openai.js';
import { searchEvents, getDailySummary, upsertDailySummary, upsertPeriodSummary,
         setting, resolveUserId } from '../db.js';
import { buildDigest, renderDigestText } from '../../src/ledger/summary.js';
import { localDateISO } from '../../src/ledger/normalize.js';

const PROSE_PROMPT = `You write a short factual summary of one person's day or period from a structured digest.

Rules:
- Use ONLY what is in the digest. Never add an event, a place, a person or an amount that is not there.
- If the digest is thin, the summary is thin. Do not pad it.
- Repeat the open questions and gaps verbatim in meaning — they are the honest part.
- Second person, plain language, no motivational commentary. 120 words maximum.`;

export async function summarize(options = {}) {
  const userId = await resolveUserId();
  const timeZone = (await setting(userId, 'ledger_timezone', config.timeZone)) || config.timeZone;
  const period = options.period || 'day';

  // A laptop is not a server. The daily job fires at 23:40, and on any night
  // the lid is shut it fires late — at which point "today" is a different day
  // and the day it was meant to summarise never gets one.
  //
  // So the default daily run is not "summarise today", it is "make the last
  // few days correct": any day with events whose summary is missing or has
  // gone stale gets regenerated. Idempotent, and self-repairing after a gap.
  if (period === 'day' && !options.date) {
    return catchUpDays(userId, timeZone, parseInt(options.days ?? '7', 10));
  }

  const { start, end, label } = resolvePeriod(period, {
    date: options.date || null,
    today: localDateISO(new Date(), timeZone),
    current: Boolean(options.current),
  });
  return summarizePeriod(userId, timeZone, period, start, end, label);
}

async function summarizePeriod(userId, timeZone, period, start, end, label) {
  const from = dayStartISO(start, timeZone);
  const to = dayStartISO(addDays(end, 1), timeZone);

  const response = await searchEvents(userId, {
    p_from: from, p_to: to, p_limit: 1000, p_ascending: true,
  });
  const events = response?.events || [];

  const digest = buildDigest(events, { timeZone, from, to });
  const deterministic = renderDigestText(digest, { label });

  const { text, generatedBy } = await writeProse(deterministic, digest, label);

  const metadata = {
    generated_from: 'events',
    period, label, timezone: timeZone,
    deterministic_summary: deterministic,
  };

  if (period === 'day') {
    const result = await upsertDailySummary(userId, start, text, digest, generatedBy, metadata);
    return { period, date: start, generated_by: generatedBy, event_count: digest.event_count, summary: text, stored: Boolean(result) };
  }

  const result = await upsertPeriodSummary(userId, period === 'week' ? 'week' : 'month',
                                           start, end, text, digest, generatedBy, metadata);
  return { period, start, end, generated_by: generatedBy, event_count: digest.event_count, summary: text, stored: Boolean(result) };
}

/**
 * Turn the digest into prose. Falls back to the deterministic rendering on any
 * failure — a summary that reads a little flat is strictly better than a run
 * that produced none.
 */
async function writeProse(deterministic, digest, label) {
  if (!config.llm.enabled || !config.llm.apiKey) {
    return { text: deterministic, generatedBy: 'deterministic' };
  }
  if (!digest.event_count) {
    return { text: deterministic, generatedBy: 'deterministic' };
  }

  const { ok, content, error } = await chat({
    job: 'summarize:prose',
    messages: [
      { role: 'system', content: PROSE_PROMPT },
      { role: 'user', content: `${label}\n\nDigest (JSON):\n${JSON.stringify(digest)}\n\nPlain rendering:\n${deterministic}` },
    ],
  });

  if (!ok || !content?.trim()) {
    // A summary that reads a little flat is strictly better than a run that
    // produced none, so the deterministic rendering is what gets stored.
    return {
      text: `${deterministic}\n\n(Prose generation failed: ${error || 'empty completion'})`,
      generatedBy: 'deterministic',
    };
  }

  return { text: content.trim(), generatedBy: `llm:${config.llm.model}` };
}

/**
 * Regenerate every day in the window that needs it.
 *
 * A day with no events is left alone rather than given an empty summary —
 * silence is the honest record of a day the ledger knows nothing about, and
 * writing "nothing happened" would claim more than we know.
 */
async function catchUpDays(userId, timeZone, days) {
  const today = localDateISO(new Date(), timeZone);
  const done = [];
  const skipped = [];

  for (let i = 0; i < Math.max(days, 1); i++) {
    const date = addDays(today, -i);
    const existing = await getDailySummary(userId, date);

    if (!existing?.live_event_count) { skipped.push({ date, reason: 'no events' }); continue; }
    if (existing.summary && !existing.stale) { skipped.push({ date, reason: 'already current' }); continue; }

    done.push(await summarizeOneDay(userId, timeZone, date,
      existing.summary ? 'stale' : 'missing'));
  }

  return { period: 'day', mode: 'catch-up', window_days: days, generated: done, skipped };
}

async function summarizeOneDay(userId, timeZone, date, reason) {
  const { start, end, label } = resolvePeriod('day', { date, today: date });
  const result = await summarizePeriod(userId, timeZone, 'day', start, end, label);
  return { ...result, regenerated_because: reason };
}

// ── Period arithmetic, in the user's zone ──────────────

export function resolvePeriod(period, { date = null, today, current = false } = {}) {
  // `today` is the clock; `date` is an explicit target. Conflating them made
  // the function untestable and the intent ambiguous — passing a date has to
  // mean "the period containing this date", which is not what the scheduled
  // run wants.
  const anchor = today;

  if (period === 'day') {
    const start = date || anchor;
    return { start, end: start, label: formatDay(start) };
  }

  if (period === 'week') {
    // The week that *ended*, not the one that just began.
    //
    // The retrospective runs Monday at 00:10, and taking the week containing
    // "today" makes that the week which is ten minutes old — so the weekly
    // summary was always of an empty week, and the week that actually
    // happened was never summarised at all.
    const containing = startOfWeek(date || anchor);
    const start = (date || current) ? containing : addDays(containing, -7);
    return { start, end: addDays(start, 6), label: `Week of ${formatDay(start)}` };
  }

  // Same for months: run on the 1st and summarise the month that just
  // finished. The job used to run on the 28th, quietly dropping the last two
  // or three days of every month.
  const [y, m] = (date || anchor).split('-').map(Number);
  const target = (date || current) ? { y, m } : (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });
  const start = `${target.y}-${String(target.m).padStart(2, '0')}-01`;
  const end = toISODate(new Date(Date.UTC(target.y, target.m, 0)));
  return {
    start, end,
    label: new Date(Date.UTC(target.y, target.m - 1, 1))
      .toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

function startOfWeek(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const offset = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // ISO: Monday = 0
  return addDays(isoDate, -offset);
}

function toISODate(date) { return date.toISOString().slice(0, 10); }
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return toISODate(new Date(Date.UTC(y, m - 1, d + days)));
}
function formatDay(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Midnight of `isoDate` in `timeZone`, as an instant. */
function dayStartISO(isoDate, timeZone) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return new Date(guess - (asUTC - guess)).toISOString();
}
