// ======================================================
// Summaries, derived from events and nothing else.
//
// A summary is a view of the ledger, never a source of truth: delete every row
// in daily_summaries and the next run reproduces them exactly. That is why the
// digest is built here, deterministically, and the model — when it is used at
// all — only turns an already-complete digest into prose. It never sees the
// raw mail, so it has nothing to invent from.
//
// `openQuestions` and `possiblyMissing` are the honest half. A day with no
// food events is far more likely to mean the ledger missed a meal than that
// you did not eat, and saying so is more useful than a tidy summary that
// quietly implies full coverage.
// ======================================================

import { localDateISO } from './normalize.js';
import { typeMeta } from './taxonomy.js';

/**
 * Money coming in — a refund, a salary credit, a card bill payment. It has an
 * amount, but adding it to spending would make every total wrong in the
 * flattering direction.
 */
export function isInflow(event) {
  return event?.type === 'transfer' || event?.data?.direction === 'credit';
}

/**
 * Group events into the sections a daily or period summary reports on.
 * Pure: same events in, same digest out.
 */
export function buildDigest(events, { timeZone = 'Asia/Kolkata', from = null, to = null } = {}) {
  const live = (events || []).filter(e => e.status !== 'dismissed');
  const byType = {};
  for (const event of live) (byType[event.type] ||= []).push(event);

  const spend = {};
  let spendTotal = 0;
  let inflowTotal = 0;
  for (const event of live) {
    const amount = Number(event.data?.amount);
    if (!Number.isFinite(amount)) continue;
    if (isInflow(event)) { inflowTotal += amount; continue; }
    const bucket = event.data?.category || event.subtype || event.type;
    spend[bucket] = (spend[bucket] || 0) + amount;
    spendTotal += amount;
  }

  const people = new Map();
  const places = new Map();
  for (const event of live) {
    for (const entity of event.entities || []) {
      const target = entity.type === 'person' ? people : (entity.type === 'place' ? places : null);
      if (!target) continue;
      const seen = target.get(entity.name) || { name: entity.name, count: 0, events: [] };
      seen.count++;
      seen.events.push(event.id);
      target.set(entity.name, seen);
    }
  }

  const needsReview = live.filter(e => e.status === 'needs_review' || e.status === 'inferred');
  const scheduled = live.filter(e => e.status === 'scheduled');

  return {
    range: { from, to },
    event_count: live.length,
    days: [...new Set(live.map(e => localDateISO(e.occurred_at, timeZone)))].sort(),

    major_activities: pickMajor(live).map(describe),
    purchases: (byType.purchase || []).map(describe),
    food:      (byType.food || []).map(describe),
    travel:    (byType.travel || []).map(describe),
    work:      [...(byType.work || []), ...(byType.meeting || [])].map(describe),
    health:    (byType.health || []).map(describe),
    notable:   live.filter(e => e.type === 'milestone' || Number(e.data?.amount) >= 10_000).map(describe),

    people: [...people.values()].sort((a, b) => b.count - a.count),
    places: [...places.values()].sort((a, b) => b.count - a.count),

    spend: { total: Math.round(spendTotal), by_bucket: roundValues(spend) },
    inflow: { total: Math.round(inflowTotal) },
    counts_by_type: Object.fromEntries(Object.entries(byType).map(([type, list]) => [type, list.length])),

    open_questions: openQuestions(live, needsReview, scheduled),
    possibly_missing: possiblyMissing(live, { timeZone, from, to }),
  };
}

/** The handful of events a person would actually mention about a day. */
function pickMajor(events) {
  const score = event => {
    let value = 0;
    if (['travel', 'milestone', 'meeting', 'work', 'health'].includes(event.type)) value += 3;
    if (event.type === 'food' && event.subtype === 'restaurant') value += 2;
    if (Number(event.data?.amount) >= 5000) value += 2;
    if (event.occurred_at_end) value += 1;                    // it took time
    if ((event.entities || []).some(e => e.type === 'person')) value += 1;
    if (event.status === 'confirmed') value += 1;
    return value;
  };
  return [...events].sort((a, b) => score(b) - score(a) || new Date(a.occurred_at) - new Date(b.occurred_at))
                    .filter(e => score(e) >= 3)
                    .slice(0, 8);
}

function describe(event) {
  return {
    id: event.id,
    at: event.occurred_at,
    type: event.type,
    subtype: event.subtype,
    title: event.title,
    amount: Number.isFinite(Number(event.data?.amount)) ? Number(event.data.amount) : null,
    currency: event.data?.currency || null,
    status: event.status,
    confidence: event.confidence,
    where: event.data?.place || event.data?.restaurant || event.data?.merchant || null,
  };
}

function roundValues(obj) {
  return Object.fromEntries(Object.entries(obj)
    .map(([k, v]) => [k, Math.round(v)])
    .sort((a, b) => b[1] - a[1]));
}

/** Things the ledger itself is unsure about. Never invented — always countable. */
function openQuestions(events, needsReview, scheduled) {
  const questions = [];

  for (const event of needsReview.slice(0, 10)) {
    questions.push({
      event_id: event.id,
      question: `Did this happen: ${event.title}?`,
      why: event.status === 'needs_review'
        ? `extracted with ${fmtConfidence(event.confidence)} confidence`
        : 'inferred, not confirmed',
    });
  }

  for (const event of scheduled) {
    if (new Date(event.occurred_at) < new Date()) {
      questions.push({
        event_id: event.id,
        question: `Did "${event.title}" actually take place?`,
        why: 'it was on the calendar and nothing has confirmed it since',
      });
    }
  }

  // A purchase whose only evidence is a card alert has an amount but no idea
  // what was bought.
  for (const event of events) {
    if (event.type === 'purchase' && event.subtype === 'card_transaction'
        && event.source_count === 1 && !event.data?.order_id) {
      questions.push({
        event_id: event.id,
        question: `What was the ${fmtMoney(event.data?.amount, event.data?.currency)} charge at ${event.data?.merchant || 'an unknown merchant'} for?`,
        why: 'only a card alert; no order or receipt matched it',
      });
    }
  }

  return questions.slice(0, 15);
}

/**
 * Gaps worth naming. Stated as absences in the record, not as claims about
 * the day — "no food events recorded" rather than "you did not eat".
 */
function possiblyMissing(events, { timeZone, from, to }) {
  const gaps = [];
  const types = new Set(events.map(e => e.type));

  if (events.length && !types.has('food')) {
    gaps.push('No food events recorded. Meals paid in cash or not emailed will not appear.');
  }
  if (!events.length) {
    gaps.push('No events at all in this period — either a quiet stretch or ingestion has not run.');
  }

  const sources = new Set(events.map(e => e.source_type));
  if (events.length && sources.size === 1 && sources.has('email')) {
    gaps.push('Everything here came from email. Anything not emailed to you is invisible to the ledger.');
  }

  if (from && to) {
    const covered = new Set(events.map(e => localDateISO(e.occurred_at, timeZone)));
    const blanks = [];
    for (let d = new Date(from); d < new Date(to); d.setUTCDate(d.getUTCDate() + 1)) {
      const day = localDateISO(d, timeZone);
      if (!covered.has(day)) blanks.push(day);
    }
    if (blanks.length && blanks.length < 15) {
      gaps.push(`No events recorded on: ${blanks.join(', ')}.`);
    }
  }

  return gaps;
}

/**
 * A readable summary with no model involved. This is what gets stored when the
 * LLM is disabled or unreachable, and it is the input the model is given when
 * it is enabled — so the prose can be rewritten but the facts cannot drift.
 */
export function renderDigestText(digest, { label = 'Day' } = {}) {
  const lines = [];
  const section = (title, items, render) => {
    if (!items?.length) return;
    lines.push(`${title}:`);
    for (const item of items.slice(0, 12)) lines.push(`  - ${render(item)}`);
  };

  lines.push(`${label}: ${digest.event_count} event${digest.event_count === 1 ? '' : 's'} recorded.`);

  section('Major activities', digest.major_activities, e => `${time(e.at)} ${e.title}`);
  section('Purchases', digest.purchases, e => `${e.title}${e.amount ? '' : ' (amount unknown)'}`);
  section('Food', digest.food, e => `${time(e.at)} ${e.title}`);
  section('Travel', digest.travel, e => `${time(e.at)} ${e.title}`);
  section('Work', digest.work, e => `${time(e.at)} ${e.title}`);

  if (digest.people?.length) {
    lines.push(`People: ${digest.people.map(p => p.name).slice(0, 10).join(', ')}`);
  }
  if (digest.inflow?.total) {
    lines.push(`Money in: ${fmtMoney(digest.inflow.total, 'INR')}`);
  }
  if (digest.spend?.total) {
    const buckets = Object.entries(digest.spend.by_bucket).slice(0, 5)
      .map(([k, v]) => `${k} ${fmtMoney(v, 'INR')}`).join(', ');
    lines.push(`Spend: ${fmtMoney(digest.spend.total, 'INR')}${buckets ? ` (${buckets})` : ''}`);
  }

  section('Open questions', digest.open_questions, q => q.question);
  section('Possibly missing', digest.possibly_missing.map(text => ({ text })), q => q.text);

  return lines.join('\n');
}

function time(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtMoney(amount, currency) {
  if (!Number.isFinite(Number(amount))) return 'an unknown amount';
  const symbol = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }[currency || 'INR'] || '';
  return `${symbol}${Math.round(Number(amount)).toLocaleString('en-IN')}`;
}
function fmtConfidence(value) {
  return value === null || value === undefined ? 'unknown' : `${Math.round(Number(value) * 100)}%`;
}

export { typeMeta };
