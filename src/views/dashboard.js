// ======================================================
// Dashboard — the one screen that reads everything.
//
// It composes rather than computes: net worth rows come from the same
// fetcher the Net Worth screen uses, points arithmetic from points-math.js,
// the day from life_days (the join Hermes reads), money direction from the
// one rule in 0017, and the two charts from charts.js — so the figure here is
// always the figure on the screen it summarises.
//
// Top to bottom it runs from what changes by the hour to what changes by the
// month: what needs you, today's body, this month's spending, then net worth
// and points. Every section past the header is optional; a source that has
// not been set up removes its card rather than showing zeros.
// ======================================================

import * as ledger from '../ledger/api.js';
import * as health from '../health/api.js';
import { listEntries } from '../networth/api.js';
import { listTransactions, listRedemptions } from '../points/api.js';
import { EUR_INR_FALLBACK } from '../constants.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, destroyChart, fetchEURtoINR, escapeHTML,
  computeNet, computeAssets, computeLiquid, computeEmergencyFund,
  renderKpiCards, bannerHTML, todayISO,
} from '../utils.js';
import { netWorthSeriesChart, allocationDoughnut, wireChartToggle } from '../charts.js';
import { pointsSummary } from '../points-math.js';
import { impliedSavingsRate, monthsBetween } from '../finance.js';
import { shiftISO, formatHours, meanOf, latestOf } from '../health/summary.js';
import { navigateTo } from '../router.js';

let netWorthChart = null;
let allocationChart = null;
let netWorthData = [];
let clockTimer = null;
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;

// A snapshot older than this is worth a nudge: the KPIs below all read it.
const STALE_SNAPSHOT_DAYS = 45;

export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="page-body card-stack">

      <!-- The greeting is this screen's page header; the figure it exists to
           report sits on the same line. -->
      <div class="dash-header">
        <div class="dash-left">
          <div class="dash-greeting" id="dash-greeting"></div>
          <div class="dash-date" id="dash-date"></div>
        </div>
        <div class="dash-nw-stat">
          <div class="dash-nw-label">Net Worth</div>
          <div class="dash-nw-value mono" id="hero-net-worth">—</div>
          <div class="dash-nw-change" id="hero-nw-change">—</div>
        </div>
      </div>

      <div id="dash-alert"></div>

      <!-- Filled only with what applies; the card removes itself when nothing does. -->
      <div class="chart-card dash-todo-card" id="dash-todo" hidden>
        <div class="chart-title">Worth a look</div>
        <ul class="dash-todo" id="dash-todo-list"></ul>
      </div>

      <!-- KPIs -->
      <div class="kpi-grid" id="dashboard-kpis">
        ${Array(4).fill(0).map(() => `
          <div class="kpi-card">
            <div class="skeleton skeleton--kpi"></div>
          </div>
        `).join('')}
      </div>

      <!-- Today -->
      <div class="chart-card" id="dash-today-card">
        <div class="chart-header">
          <div>
            <div class="chart-title">Today</div>
            <div class="chart-subtitle">Sleep, movement and food, from Apple Health and the ledger</div>
          </div>
          <button type="button" class="btn-sm btn-accent" data-goto="health">
            Open Health <i class="fas fa-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
        <div class="points-strip" id="dash-today">
          ${Array(4).fill(0).map(() => `
            <div class="points-strip-item">
              <div class="skeleton skeleton--stat"></div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- This month -->
      <div class="chart-card" id="dash-life-card">
        <div class="chart-header">
          <div>
            <div class="chart-title">This month, actually</div>
            <div class="chart-subtitle">Recorded personal spending, against what you budgeted</div>
          </div>
          <button type="button" class="btn-sm btn-accent" data-goto="ledger">
            Open Life <i class="fas fa-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
        <div id="dash-life-strip">
          <div class="skeleton skeleton--strip"></div>
        </div>
      </div>

      <!-- Charts -->
      <div class="charts-grid">
        <div class="chart-card">
          <div class="chart-header">
            <div>
              <div class="chart-title">Wealth Accumulation</div>
              <div class="chart-subtitle">Net worth over time</div>
            </div>
            <div class="chart-toggle">
              <button type="button" class="chart-toggle-btn active" id="nw-chart-line">Line</button>
              <button type="button" class="chart-toggle-btn" id="nw-chart-bar">Bar</button>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="dash-nw-chart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <div>
              <div class="chart-title">Asset Allocation</div>
              <div class="chart-subtitle" id="dash-alloc-sub">Latest snapshot</div>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="dash-alloc-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Points strip -->
      <div class="chart-card">
        <div class="chart-header">
          <div>
            <div class="chart-title">Points &amp; Rewards</div>
            <div class="chart-subtitle">HSBC TravelOne <span id="fx-badge"></span></div>
          </div>
          <button type="button" class="btn-sm btn-accent" data-goto="points">
            View details <i class="fas fa-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
        <div class="points-strip" id="points-strip">
          ${Array(4).fill(0).map(() => `
            <div class="points-strip-item">
              <div class="skeleton skeleton--stat"></div>
            </div>
          `).join('')}
        </div>
      </div>

    </div>
  `;

  // The greeting and date used to be baked in at render time, so a tab left
  // open overnight kept saying "Good evening" and showing yesterday's date.
  updateClock();
  clearInterval(clockTimer);
  clockTimer = setInterval(updateClock, 60_000);

  wireChartToggle('nw-chart-line', 'nw-chart-bar', type => buildNetWorthChart(netWorthData, type));

  // One delegated handler for every "go to that screen" button, including the
  // ones the to-do list draws later.
  container.querySelector('.page-body').addEventListener('click', e => {
    const target = e.target.closest('[data-goto]');
    if (target) navigateTo(target.dataset.goto);
  });

  await loadDashboardData();
}

export { renderDashboard as render };

/** Release everything the screen holds before the router replaces its DOM. */
export function unmount() {
  loadToken++;
  clearInterval(clockTimer);
  clockTimer = null;
  netWorthChart = destroyChart(netWorthChart);
  allocationChart = destroyChart(allocationChart);
  netWorthData = [];
}

function updateClock() {
  const now = new Date();
  const h = now.getHours();
  const greeting = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';

  const greetEl = document.getElementById('dash-greeting');
  const dateEl  = document.getElementById('dash-date');
  if (!greetEl || !dateEl) { clearInterval(clockTimer); return; }

  const name = settings.get('display_name');
  greetEl.textContent = name ? `Good ${greeting}, ${name} 👋` : `Good ${greeting} 👋`;
  dateEl.textContent  = now.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function showAlert(message) {
  const el = document.getElementById('dash-alert');
  if (!el) return;
  el.innerHTML = bannerHTML({
    tone: 'error', title: "Couldn't load your data.", sub: message,
    action: { id: 'dash-retry', label: 'Retry', ghost: true },
  });
  document.getElementById('dash-retry')?.addEventListener('click', () => loadDashboardData());
}

function showEmptyState() {
  const el = document.getElementById('dash-alert');
  if (!el) return;
  el.innerHTML = bannerHTML({
    tone: 'empty', title: 'No snapshots yet.',
    sub: 'Add your first net worth snapshot and the dashboard fills in.',
    action: { id: 'dash-goto-nw', label: 'Add snapshot' },
  });
  document.getElementById('dash-goto-nw')?.addEventListener('click', () => navigateTo('networth'));
}

function removeCard(id) {
  document.getElementById(id)?.remove();
}

async function loadDashboardData() {
  const token = ++loadToken;
  const todo = new TodoList(token);

  // The ledger and Apple Health are optional: the dashboard predates both and
  // has to keep working when their migrations have not been run or nothing
  // has arrived yet. Each removes its own card on failure.
  renderDayAndMonth(token)
    .catch(err => {
      console.warn('[dashboard] life_days:', err?.message || err);
      if (token === loadToken) { removeCard('dash-today-card'); removeCard('dash-life-card'); }
    });
  ledger.reviewQueue(50)
    .then(rows => {
      const n = Array.isArray(rows) ? rows.length : 0;
      if (n) todo.add('review', {
        icon: 'fa-inbox', goto: 'ledger', action: 'Review',
        text: `${n}${n >= 50 ? '+' : ''} ledger event${n === 1 ? '' : 's'} waiting for review`,
      });
    })
    .catch(() => {});

  for (const [key, label, readers] of [
    ['monthly_expenses', 'monthly budget', 'runway, FI target and this month’s pace read it'],
    ['monthly_net_income', 'monthly income', 'the savings rate reads it'],
  ]) {
    if (!settings.isSet(key)) todo.add(key, {
      icon: 'fa-sliders', goto: 'settings', action: 'Set it',
      text: `Your ${label} is still the ${formatINRFull(settings.get(key))} placeholder, and ${readers}`,
    });
  }

  let entries, transactions, redemptions, eurRate;
  try {
    [entries, transactions, redemptions, eurRate] = await Promise.all([
      listEntries(), listTransactions(), listRedemptions(), fetchEURtoINR(EUR_INR_FALLBACK),
    ]);
  } catch (err) {
    // A failed query used to be swallowed by `?.data || []`, so a network drop
    // or a denied RLS policy rendered a confident, well-formatted net worth of ₹0.
    if (token === loadToken) showAlert(err.message);
    return;
  }
  if (token !== loadToken || !document.getElementById('dashboard-kpis')) return;

  entries      = entries || [];
  transactions = transactions || [];
  redemptions  = redemptions || [];
  netWorthData = entries;

  const alertEl = document.getElementById('dash-alert');
  if (alertEl) alertEl.innerHTML = '';
  if (!entries.length) showEmptyState();

  // ── Net Worth ─────────────────────────────────────────
  const latest = entries[entries.length - 1];
  const prev   = entries[entries.length - 2];

  const netWorth    = computeNet(latest);
  const prevNW      = computeNet(prev);
  const nwChange    = prevNW !== 0 ? ((netWorth - prevNW) / Math.abs(prevNW)) * 100 : 0;
  const totalAssets = computeAssets(latest);

  const heroEl   = document.getElementById('hero-net-worth');
  const changeEl = document.getElementById('hero-nw-change');
  if (heroEl) heroEl.textContent = entries.length ? formatINRFull(netWorth) : '—';
  if (changeEl && prev) {
    const isPos = nwChange >= 0;
    changeEl.innerHTML = `<span class="${isPos ? 'is-up' : 'is-down'}">${isPos ? '↑' : '↓'} ${Math.abs(nwChange).toFixed(1)}%</span> from last snapshot`;
  } else if (changeEl) {
    changeEl.textContent = entries.length ? 'First snapshot' : 'No data yet';
  }

  // Everything below the hero reads the latest snapshot, so say how old it is.
  if (latest?.date) {
    const ageDays = Math.round(monthsBetween(String(latest.date).slice(0, 10), todayISO()) * 30.4375);
    const allocSub = document.getElementById('dash-alloc-sub');
    if (allocSub) allocSub.textContent = `Snapshot of ${formatDay(latest.date)}`;
    if (ageDays > STALE_SNAPSHOT_DAYS) todo.add('snapshot', {
      icon: 'fa-camera', goto: 'networth', action: 'Update',
      text: `Last net worth snapshot was ${formatAge(ageDays)} ago (${formatDay(latest.date)})`,
    });
  }

  // ── Points ────────────────────────────────────────────
  const pointsPerEur = settings.get('points_per_eur');
  const pts = pointsSummary(transactions, redemptions, { pointsPerEur, eurRate });
  const rewardTarget = settings.get('cc_reward_target_rate');
  // Rows made from card alerts arrive as a guess until you look at them.
  const assumed = transactions.filter(t => t.basis === 'assumed').length;
  if (assumed) todo.add('points', {
    icon: 'fa-credit-card', goto: 'points', action: 'Confirm',
    text: `${assumed} card spend${assumed === 1 ? '' : 's'} labelled from a rule, not yet confirmed`,
  });

  const fxBadge = document.getElementById('fx-badge');
  if (fxBadge) fxBadge.textContent = `· 1 EUR = ₹${eurRate.toFixed(0)}`;

  // ── KPIs ──────────────────────────────────────────────
  const fiTarget      = settings.fiTarget();
  const monthlyExp    = settings.get('monthly_expenses');
  const runwayTarget  = settings.get('emergency_runway_target');
  const basis         = settings.get('emergency_fund_basis');
  const fiPct         = fiTarget > 0 ? Math.min((netWorth / fiTarget) * 100, 100) : 0;
  const emergencyFund = computeEmergencyFund(latest, basis);
  const runway        = monthlyExp > 0 ? emergencyFund / monthlyExp : 0;
  const runwayOK      = runway >= runwayTarget;

  const savings = impliedSavingsRate(entries, settings.get('monthly_net_income'), 12);
  const budgetRate = settings.budgetedSavingsRate();

  renderKpiCards(document.getElementById('dashboard-kpis'), [
    {
      id: 'dk-assets', label: 'Total assets', icon: 'fa-building-columns',
      value: formatINRFull(totalAssets), raw: totalAssets,
      sub: `Liquid: ${formatINR(computeLiquid(latest))}`,
      tooltip: 'Sum of all asset classes in your latest snapshot.',
    },
    {
      id: 'dk-savings', label: 'Savings rate', icon: 'fa-arrow-trend-up',
      value: savings ? formatPercent(savings.rate) : '—',
      raw: savings ? savings.rate.toFixed(1) : 0,
      progress: savings ? Math.max(0, Math.min(savings.rate, 100)) : undefined,
      badge: savings
        ? { text: savings.rate >= budgetRate ? 'On track' : 'Below budget',
            type: savings.rate >= budgetRate ? 'positive' : 'neutral' }
        : null,
      sub: savings
        ? `${formatINR(savings.perMonth)}/mo over ${savings.months.toFixed(0)} months`
        : 'Needs two snapshots',
      tooltip: `Net worth growth ÷ income over the last 12 months. Includes investment returns, so it moves with the market. Budgeted rate: ${budgetRate.toFixed(0)}%.`,
    },
    {
      id: 'dk-fi', label: 'FI progress', icon: 'fa-bullseye',
      value: formatPercent(fiPct), raw: fiPct.toFixed(1),
      sub: `Target ${formatINR(fiTarget)}`,
      progress: fiPct,
      tooltip: `${settings.get('fi_multiplier')}× rule FIRE target. Target = ${settings.get('fi_multiplier')} × annual expenses.`,
    },
    {
      id: 'dk-runway', label: 'Emergency runway', icon: 'fa-shield-halved',
      tone: runwayOK ? 'success' : 'warning',
      value: runway.toFixed(1), unit: 'months', raw: runway.toFixed(1),
      badge: { text: runwayOK ? 'Healthy' : 'Build up', type: runwayOK ? 'positive' : 'neutral' },
      sub: `${basis === 'cash_like' ? 'Cash + FDs' : 'Liquid'} ÷ ₹${(monthlyExp / 1000).toFixed(0)}k/mo`,
      tooltip: `${basis === 'cash_like' ? 'Cash and fixed deposits' : 'Cash, stocks and mutual funds'} ÷ monthly baseline expenses. Target ≥ ${runwayTarget} months.`,
    },
  ]);

  // ── Points Strip ──────────────────────────────────────
  renderStrip(document.getElementById('points-strip'), [
    {
      label: 'Accrued',
      value: Math.round(pts.totalAccrued).toLocaleString('en-IN') + ' pts',
      sub: `${transactions.length} transactions`,
      tone: 'success',
    },
    {
      label: 'Redeemed',
      value: Math.round(pts.totalRedeemed).toLocaleString('en-IN') + ' pts',
      sub: `Value: ${formatINRFull(pts.totalRdValue)}`,
      tone: 'danger',
    },
    {
      label: 'Balance value',
      value: formatINRFull(pts.balanceINR),
      sub: `${pts.balanceEUR.toFixed(0)} EUR`,
      tone: 'accent',
    },
    {
      label: 'Reward rate',
      value: formatPercent(pts.rewardRate),
      sub: pts.rewardRate >= rewardTarget ? `Above the ${rewardTarget}% target` : `Target: above ${rewardTarget}%`,
      tone: pts.rewardRate >= rewardTarget ? 'success' : 'warning',
    },
  ]);

  buildNetWorthChart(entries, 'line');
  allocationChart = destroyChart(allocationChart);
  allocationChart = allocationDoughnut(document.getElementById('dash-alloc-chart'), latest);
}

function buildNetWorthChart(entries, type = 'line') {
  netWorthChart = destroyChart(netWorthChart);
  netWorthChart = netWorthSeriesChart(document.getElementById('dash-nw-chart'), entries, type);
}

/** Four label / figure / note cells, shared by the Today and Points cards. */
function renderStrip(el, items) {
  if (!el) return;
  el.innerHTML = items.map((item, i) => `
    <div class="points-strip-item ${i < items.length - 1 ? 'has-divider' : ''}">
      <div class="psi-label">${escapeHTML(item.label)}</div>
      <div class="psi-value mono ${item.tone ? `is-${item.tone}` : ''}">${escapeHTML(item.value)}</div>
      <div class="psi-sub">${escapeHTML(item.sub)}</div>
    </div>
  `).join('');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Sep 2026" from an ISO date. */
function formatDay(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function formatAge(days) {
  if (days < 60) return `${days} days`;
  return `${Math.round(days / 30.44)} months`;
}

// ======================================================
// Worth a look
//
// The things only you can close: events the ledger could not read with
// confidence, card spends labelled by a rule, a stale snapshot, a setting
// still on its placeholder. Items arrive from several loads at different
// times, so the list is keyed and redrawn on each arrival.
// ======================================================

class TodoList {
  constructor(token) {
    this.token = token;
    this.items = new Map();
    this.draw();
  }

  add(key, item) {
    if (this.token !== loadToken) return;
    this.items.set(key, item);
    this.draw();
  }

  draw() {
    const card = document.getElementById('dash-todo');
    const list = document.getElementById('dash-todo-list');
    if (!card || !list) return;
    card.hidden = this.items.size === 0;
    list.innerHTML = [...this.items.values()].map(item => `
      <li class="dash-todo-item">
        <i class="fas ${item.icon}" aria-hidden="true"></i>
        <span class="dash-todo-text">${escapeHTML(item.text)}</span>
        <button type="button" class="btn-sm btn-ghost" data-goto="${escapeHTML(item.goto)}">${escapeHTML(item.action)}</button>
      </li>
    `).join('');
  }
}

// ======================================================
// Today and this month — both from life_days
//
// One call covers the month so far and the week before today, whichever
// starts earlier: the day strip needs a week for its averages, the month
// strip needs every day since the 1st.
// ======================================================

async function renderDayAndMonth(token) {
  const today = todayISO();
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStart = shiftISO(today, -7);
  const from = weekStart < monthStart ? weekStart : monthStart;

  const [days, stats] = await Promise.all([
    health.days(from, today),
    ledger.stats(new Date(`${monthStart}T00:00:00`).toISOString(), null).catch(() => null),
  ]);
  if (token !== loadToken) return;

  const list = Array.isArray(days) ? days : [];
  renderToday(list.filter(d => d.day >= weekStart), today);
  renderMonth(list.filter(d => d.day >= monthStart), stats, today);
}

// ── Today ────────────────────────────────────────────────

function renderToday(days, today) {
  const el = document.getElementById('dash-today');
  if (!el) return;

  // life_days nests body fields; the Health helpers read them flat.
  const flat = days.map(d => ({ day: d.day, ...(d.body || {}) }));
  const earlier = flat.filter(d => d.day !== today);
  const todayRow = days.find(d => d.day === today) || {};
  const yesterday = days.find(d => d.day === shiftISO(today, -1)) || {};

  const hasBody = flat.some(d => Object.keys(d).length > 1);
  const hasFood = days.some(d => d.food);
  if (!hasBody && !hasFood) { removeCard('dash-today-card'); return; }

  // A night is dated by the morning it ended, so last night is today's row
  // once the Watch has synced it — and yesterday's until then.
  const lastNight = latestOf(flat.filter(d => d.day >= shiftISO(today, -1)), 'sleep_hours');
  const sleepAvg = meanOf(earlier, 'sleep_hours');

  const steps = todayRow.body?.steps ?? null;
  const stepsAvg = meanOf(earlier, 'steps');

  const food = todayRow.food;
  const target = Number(todayRow.energy?.target_kcal ?? settings.get('food_kcal_target')) || 0;
  // Only a complete day has an honest balance; see 0011 on partial logs.
  const balance = yesterday.energy?.complete ? yesterday.energy.balance_kcal : null;

  const weight = latestOf(flat, 'weight_kg');
  const weekAgo = flat.find(d => d.weight_kg != null && d.day < (weight?.day || ''));
  const weightDelta = weight && weekAgo ? weight.value - Number(weekAgo.weight_kg) : null;

  const num = n => Math.round(n).toLocaleString('en-IN');

  renderStrip(el, [
    {
      label: 'Sleep',
      value: lastNight ? formatHours(lastNight.value) : '—',
      sub: lastNight
        ? `${lastNight.day === today ? 'Last night' : 'Night before'}${sleepAvg != null ? ` · 7-day avg ${formatHours(sleepAvg)}` : ''}`
        : 'No night synced yet',
    },
    {
      label: 'Steps',
      value: steps != null ? num(steps) : '—',
      sub: stepsAvg != null ? `So far · 7-day avg ${num(stepsAvg)}` : 'So far today',
    },
    {
      label: 'Eaten',
      value: food?.eaten_kcal != null ? `${num(food.eaten_kcal)} kcal` : '—',
      sub: [
        target ? `of ${num(target)}` : null,
        food?.protein_g != null ? `${food.protein_g} g protein` : null,
        balance != null ? `yesterday ${balance > 0 ? '+' : '−'}${num(Math.abs(balance))} net` : null,
      ].filter(Boolean).join(' · ') || 'Nothing logged yet',
    },
    {
      label: 'Weight',
      value: weight ? `${weight.value.toFixed(1)} kg` : '—',
      sub: weight
        ? `${weight.day === today ? 'Today' : formatDay(weight.day).slice(0, -5)}${weightDelta != null ? ` · ${weightDelta > 0 ? '+' : weightDelta < 0 ? '−' : '±'}${Math.abs(weightDelta).toFixed(1)} this week` : ''}`
        : 'Not measured this week',
    },
  ]);
}

// ── This month, actually ─────────────────────────────────
//
// Every other number on this dashboard — savings rate, runway, time to FI —
// is derived from `monthly_expenses`, a figure typed into Settings once. The
// ledger knows what was actually spent. Putting the two side by side is the
// only place in the app where the plan meets the record, which makes it worth
// the strip it occupies.
//
// Work spend (a points row ticked as work) is reimbursed, so it is shown but
// not measured against a personal budget. Money moved between your own
// accounts is neither spend nor income (0017) and is not here at all.

function renderMonth(days, stats, today) {
  const strip = document.getElementById('dash-life-strip');
  if (!strip) return;

  let spend = 0, work = 0, events = 0;
  for (const d of days) {
    events += Number(d.events) || 0;
    spend += Number(d.money?.spend) || 0;
    work += Number(d.money?.work_spend) || 0;
  }
  if (!events) { removeCard('dash-life-card'); return; }
  const personal = Math.max(spend - work, 0);

  const budget = settings.get('monthly_expenses');
  const budgetIsReal = settings.isSet('monthly_expenses');

  // Pace, not just position: a third of the way through the month, half the
  // budget gone is the thing worth knowing.
  const [y, m, dayOfMonth] = today.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const expected = budget * (dayOfMonth / daysInMonth);
  const overPace = expected > 0 && personal > expected * 1.1;
  const pct = budget > 0 ? Math.min((personal / budget) * 100, 100) : 0;

  const categories = Object.entries(stats?.spend?.by_category || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5);

  const note = !budgetIsReal
    ? `The budget is a placeholder, not yours — set it in Settings and this line means something.`
    : overPace
      ? `Ahead of pace — ${formatINRFull(personal - expected)} above where day ${dayOfMonth} would put you.`
      : `On pace. Day ${dayOfMonth} of ${daysInMonth}.`;

  strip.innerHTML = `
    <div class="life-strip">
      <div class="life-spend">
        <div class="life-spend-value mono">${escapeHTML(formatINRFull(personal))}</div>
        <div class="life-spend-sub">
          personal, across ${events} event${events === 1 ? '' : 's'}
          ${work ? ` · plus ${escapeHTML(formatINRFull(work))} work` : ''}
          · budget ${escapeHTML(formatINRFull(budget))}${budgetIsReal ? '' : ' (default)'}
        </div>
        <div class="progress-wrap life-bar">
          <div class="progress-bar ${overPace && budgetIsReal ? 'is-over' : ''}" style="width:${pct.toFixed(1)}%"></div>
          <span class="life-pace" style="left:${Math.min((dayOfMonth / daysInMonth) * 100, 100).toFixed(1)}%"
                title="Where the month is: day ${dayOfMonth} of ${daysInMonth}"></span>
        </div>
        <div class="life-spend-note ${overPace && budgetIsReal ? 'is-over' : ''}">${escapeHTML(note)}</div>
      </div>
      <div class="life-cats">
        ${categories.length ? categories.map(([key, value]) => `
          <div class="life-cat">
            <span class="life-cat-label">${escapeHTML(key.replace(/_/g, ' '))}</span>
            <span class="life-cat-value mono">${escapeHTML(formatINRFull(value))}</span>
          </div>
        `).join('') : '<div class="life-cat"><span class="life-cat-label">No categorised spending yet</span></div>'}
      </div>
    </div>
    <p class="life-caveat">
      Only what reached your inbox or was told to Hermes. Cash and anything unrecorded is not here;
      categories include work spend.
    </p>
  `;
}
