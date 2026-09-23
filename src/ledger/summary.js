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

import { DEFAULT_TIME_ZONE, formatTime, localDateISO } from './dates.js';
import { formatMoney, prune } from './normalize.js';

// Moving money between your own pockets: it left one account and arrived in
// another, or it paid off a card whose spends were already counted one by one.
const OWN_POCKETS = new Set(['self_transfer', 'credit_card_bill_repayment', 'card_bill_payment', 'scheduled_bill_payment']);
// A transfer that is money arriving, even when the bank's email gave no direction.
const ARRIVALS = new Set(['credit', 'refund', 'interest_credit', 'dividend', 'cashback', 'reward']);
// A transfer that is money leaving for good.
const DEPARTURES = new Set(['payment', 'insurance_premium']);

/**
 * Which way an event's amount counts: 'spend', 'inflow', or null for neither.
 *
 * There used to be three versions of this rule — here, in ledger_stats() and
 * in life_days() — and all three were wrong in a different direction. The two
 * older ones called every transfer an inflow, so ₹15,000 moved between your own
 * accounts and every card bill you paid were reported as money coming in: lakhs
 * of income that never existed. The newest counted no transfer as inflow at
 * all, so a salary credit vanished. This is the one rule; public.ledger_money_flow()
 * in 0017_money_flow.sql is its twin. Change one, change both.
 */
export function moneyFlow(event) {
  const direction = event?.data?.direction;
  if (event?.type === 'transfer') {
    const subtype = event?.subtype;
    if (OWN_POCKETS.has(subtype)) return null;
    if (DEPARTURES.has(subtype)) return direction === 'credit' ? 'inflow' : 'spend';
    if (direction === 'credit' || ARRIVALS.has(subtype)) return 'inflow';
    return null;
  }
  return direction === 'credit' ? 'inflow' : 'spend';
}

/**
 * "Does this stay out of spend?" — true for an inflow and for money that only
 * moved between your own pockets. Kept under its old name because that is the
 * question every caller was asking: they all use it to decide what NOT to add
 * to a spending total. For an actual inflow total, use moneyFlow().
 */
export function isInflow(event) {
  return moneyFlow(event) !== 'spend';
}

/**
 * Group events into the sections a daily or period summary reports on.
 * Pure: same events in, same digest out.
 */
export function buildDigest(events, { timeZone = DEFAULT_TIME_ZONE, from = null, to = null } = {}) {
  const live = (events || []).filter(e => e.status !== 'dismissed');
  const byType = {};
  for (const event of live) (byType[event.type] ||= []).push(event);

  const spend = {};
  let spendTotal = 0;
  let inflowTotal = 0;
  for (const event of live) {
    const amount = Number(event.data?.amount);
    if (!Number.isFinite(amount)) continue;
    const flow = moneyFlow(event);
    if (flow === 'inflow') { inflowTotal += amount; continue; }
    if (flow !== 'spend') continue;   // between your own pockets: neither
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
        question: `What was the ${formatMoney(event.data?.amount, event.data?.currency)} charge at ${event.data?.merchant || 'an unknown merchant'} for?`,
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

const present = v => v !== null && v !== undefined;
const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round1 = v => (present(v) ? Math.round(v * 10) / 10 : null);

/**
 * The body half of a digest, from life_days() rows: what the sensors and the
 * food log say, next to what the events say.
 *
 * One day comes back as that day's numbers. Several come back as averages —
 * each over the days that HAVE the number, because a night the Watch was on
 * the charger is a gap, not a night of zero sleep. The energy balance is
 * averaged over complete days only, and says how many that was: a mean that
 * quietly includes days with unpriced meals reads as a deficit nobody ran.
 *
 * Always returns an object, `{ recorded: false }` when there is nothing, so a
 * stored summary can tell "no body data" from "written before this existed".
 */
export function lifeSection(days = []) {
  const withData = days.filter(d => d.body || d.food || d.energy || d.activity);
  if (!withData.length) return { recorded: false };

  const activity = days.flatMap(d => (d.activity || []).map(a => ({ day: d.day, ...a })));

  if (days.length === 1) {
    const d = days[0];
    return prune({
      recorded: true,
      steps: d.body?.steps, sleep_hours: d.body?.sleep_hours,
      fell_asleep: d.body?.fell_asleep, woke: d.body?.woke,
      resting_hr: d.body?.resting_hr, hrv_ms: d.body?.hrv_ms, weight_kg: d.body?.weight_kg,
      eaten_kcal: d.energy?.eaten_kcal, burned_kcal: d.energy?.burned_kcal,
      balance_kcal: d.energy?.balance_kcal, target_kcal: d.energy?.target_kcal,
      energy_complete: d.energy ? Boolean(d.energy.complete) : undefined,
      meals_unpriced: d.food?.meals_unpriced || undefined,
      activity,
    });
  }

  const pick = (group, key) => days.map(d => d[group]?.[key]).filter(present).map(Number);
  const weights = days.filter(d => present(d.body?.weight_kg)).map(d => ({ day: d.day, kg: Number(d.body.weight_kg) }));
  const complete = days.filter(d => d.energy?.complete);
  return prune({
    recorded: true,
    days: days.length,
    steps_avg: present(mean(pick('body', 'steps'))) ? Math.round(mean(pick('body', 'steps'))) : null,
    sleep_hours_avg: round1(mean(pick('body', 'sleep_hours'))),
    nights_recorded: pick('body', 'sleep_hours').length,
    resting_hr_avg: present(mean(pick('body', 'resting_hr'))) ? Math.round(mean(pick('body', 'resting_hr'))) : null,
    weight_first: weights[0], weight_last: weights.length > 1 ? weights[weights.length - 1] : undefined,
    weight_change_kg: weights.length > 1 ? round1(weights[weights.length - 1].kg - weights[0].kg) : undefined,
    eaten_kcal_avg: present(mean(pick('energy', 'eaten_kcal'))) ? Math.round(mean(pick('energy', 'eaten_kcal'))) : null,
    burned_kcal_avg: present(mean(pick('energy', 'burned_kcal'))) ? Math.round(mean(pick('energy', 'burned_kcal'))) : null,
    balance_kcal_avg: complete.length ? Math.round(mean(complete.map(d => Number(d.energy.balance_kcal)))) : null,
    balance_over_days: complete.length || undefined,
    target_kcal: days.find(d => d.energy?.target_kcal)?.energy.target_kcal,
    workouts: activity.length || undefined,
    active_minutes: activity.reduce((sum, a) => sum + (Number(a.minutes) || 0), 0) || undefined,
  });
}

/** The body section as lines of text. Empty when nothing was recorded. */
export function renderLifeLines(body) {
  if (!body?.recorded) return [];
  const n = v => Math.round(Number(v)).toLocaleString('en-IN');
  const hm = h => `${Math.floor(Math.round(h * 60) / 60)}h ${String(Math.round(h * 60) % 60).padStart(2, '0')}m`;
  const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n(Math.abs(v))}`;
  const lines = [];

  if (body.days) {
    const bits = [];
    if (present(body.steps_avg)) bits.push(`${n(body.steps_avg)} steps a day`);
    if (present(body.sleep_hours_avg)) bits.push(`${hm(body.sleep_hours_avg)} sleep a night over ${body.nights_recorded} nights`);
    if (present(body.resting_hr_avg)) bits.push(`resting HR ${body.resting_hr_avg}`);
    if (bits.length) lines.push(`Body: ${bits.join(', ')}.`);
    if (body.weight_last) lines.push(`Weight: ${body.weight_first.kg} → ${body.weight_last.kg} kg (${body.weight_change_kg > 0 ? '+' : body.weight_change_kg < 0 ? '−' : ''}${Math.abs(body.weight_change_kg).toFixed(1)} kg).`);
    else if (body.weight_first) lines.push(`Weight: ${body.weight_first.kg} kg on ${body.weight_first.day}.`);
    if (present(body.eaten_kcal_avg) && present(body.burned_kcal_avg)) {
      lines.push(`Energy: about ${n(body.eaten_kcal_avg)} kcal eaten and ${n(body.burned_kcal_avg)} burned a day`
        + (present(body.balance_kcal_avg) ? `; balance ${signed(body.balance_kcal_avg)} a day over the ${body.balance_over_days} fully logged day${body.balance_over_days === 1 ? '' : 's'}.` : '; no day was fully logged, so no balance.'));
    }
    if (body.workouts) lines.push(`Activity: ${body.workouts} workout${body.workouts === 1 ? '' : 's'}, ${n(body.active_minutes || 0)} minutes.`);
    return lines;
  }

  const bits = [];
  if (present(body.steps)) bits.push(`${n(body.steps)} steps`);
  if (present(body.sleep_hours)) bits.push(`slept ${hm(body.sleep_hours)}${body.fell_asleep ? ` (${body.fell_asleep}–${body.woke})` : ''}`);
  if (present(body.resting_hr)) bits.push(`resting HR ${body.resting_hr}`);
  if (present(body.weight_kg)) bits.push(`weight ${body.weight_kg} kg`);
  if (bits.length) lines.push(`Body: ${bits.join(', ')}.`);
  if (present(body.eaten_kcal) && present(body.burned_kcal)) {
    lines.push(`Energy: ate ${n(body.eaten_kcal)} kcal, burned ${n(body.burned_kcal)}, balance ${signed(body.balance_kcal)} against a ${n(body.target_kcal)} target`
      + (body.energy_complete ? '.' : ` — provisional${body.meals_unpriced ? `, ${body.meals_unpriced} meal${body.meals_unpriced === 1 ? '' : 's'} unpriced` : ''}.`));
  } else if (present(body.burned_kcal)) {
    lines.push(`Energy: burned ${n(body.burned_kcal)} kcal; nothing eaten is on record.`);
  }
  for (const a of body.activity || []) {
    lines.push(`Activity: ${a.activity}${a.minutes ? ` ${a.minutes} min` : ''}${a.distance_km ? `, ${a.distance_km} km` : ''} (${a.source})${a.note && a.source === 'ledger' ? ` — ${a.note}` : ''}`);
  }
  return lines;
}

/**
 * A readable summary with no model involved. This is what gets stored when the
 * LLM is disabled or unreachable, and it is the input the model is given when
 * it is enabled — so the prose can be rewritten but the facts cannot drift.
 */
export function renderDigestText(digest, { label = 'Day', timeZone = DEFAULT_TIME_ZONE } = {}) {
  const lines = [];
  const time = iso => formatTime(iso, timeZone);
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
    lines.push(`Money in: ${formatMoney(digest.inflow.total, 'INR')}`);
  }
  if (digest.spend?.total) {
    const buckets = Object.entries(digest.spend.by_bucket).slice(0, 5)
      .map(([k, v]) => `${k} ${formatMoney(v, 'INR')}`).join(', ');
    lines.push(`Spend: ${formatMoney(digest.spend.total, 'INR')}${buckets ? ` (${buckets})` : ''}`);
  }

  lines.push(...renderLifeLines(digest.body));

  section('Open questions', digest.open_questions, q => q.question);
  section('Possibly missing', digest.possibly_missing.map(text => ({ text })), q => q.text);

  return lines.join('\n');
}

function fmtConfidence(value) {
  return value === null || value === undefined ? 'unknown' : `${Math.round(Number(value) * 100)}%`;
}

