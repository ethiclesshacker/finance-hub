// ======================================================
// Dashboard — the one screen that reads everything.
//
// It composes rather than computes: net worth rows come from the same
// fetcher the Net Worth screen uses, points arithmetic from points-math.js,
// and the two charts from charts.js, so the figure here is always the figure
// on the screen it summarises.
// ======================================================

import * as ledger from '../ledger/api.js';
import { listEntries } from '../networth/api.js';
import { listTransactions, listRedemptions } from '../points/api.js';
import { EUR_INR_FALLBACK } from '../constants.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, destroyChart, fetchEURtoINR, escapeHTML,
  computeNet, computeAssets, computeLiquid, computeEmergencyFund,
  renderKpiCards, bannerHTML,
} from '../utils.js';
import { netWorthSeriesChart, allocationDoughnut, wireChartToggle } from '../charts.js';
import { pointsSummary } from '../points-math.js';
import { impliedSavingsRate } from '../finance.js';
import { navigateTo } from '../router.js';

let netWorthChart = null;
let allocationChart = null;
let netWorthData = [];
let clockTimer = null;
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;

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

      <!-- KPIs -->
      <div class="kpi-grid" id="dashboard-kpis">
        ${Array(4).fill(0).map(() => `
          <div class="kpi-card">
            <div class="skeleton skeleton--kpi"></div>
          </div>
        `).join('')}
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
              <div class="chart-subtitle">Latest snapshot</div>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="dash-alloc-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Life strip -->
      <div class="chart-card">
        <div class="chart-header">
          <div>
            <div class="chart-title">This month, actually</div>
            <div class="chart-subtitle">Recorded spending, against what you budgeted</div>
          </div>
          <button type="button" class="btn-sm btn-accent" id="dash-goto-ledger">
            Open Life <i class="fas fa-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
        <div id="dash-life-strip">
          <div class="skeleton skeleton--strip"></div>
        </div>
      </div>

      <!-- Points strip -->
      <div class="chart-card">
        <div class="chart-header">
          <div>
            <div class="chart-title">Points &amp; Rewards</div>
            <div class="chart-subtitle">HSBC TravelOne <span id="fx-badge"></span></div>
          </div>
          <button type="button" class="btn-sm btn-accent" id="dash-goto-points">
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

  document.getElementById('dash-goto-points')?.addEventListener('click', () => navigateTo('points'));
  document.getElementById('dash-goto-ledger')?.addEventListener('click', () => navigateTo('ledger'));

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

async function loadDashboardData() {
  const token = ++loadToken;

  // The ledger is optional: the dashboard predates it and has to keep working
  // when the migrations have not been run or nothing has been ingested yet.
  renderLifeStrip(token).catch(() => { if (token === loadToken) hideLifeStrip(); });

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

  // ── Points ────────────────────────────────────────────
  const pointsPerEur = settings.get('points_per_eur');
  const pts = pointsSummary(transactions, redemptions, { pointsPerEur, eurRate });
  const rewardTarget = settings.get('cc_reward_target_rate');

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
  const strip = document.getElementById('points-strip');
  if (strip) {
    const items = [
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
    ];

    strip.innerHTML = items.map((item, i) => `
      <div class="points-strip-item ${i < items.length - 1 ? 'has-divider' : ''}">
        <div class="psi-label">${escapeHTML(item.label)}</div>
        <div class="psi-value mono is-${item.tone}">${escapeHTML(item.value)}</div>
        <div class="psi-sub">${escapeHTML(item.sub)}</div>
      </div>
    `).join('');
  }

  buildNetWorthChart(entries, 'line');
  allocationChart = destroyChart(allocationChart);
  allocationChart = allocationDoughnut(document.getElementById('dash-alloc-chart'), latest);
}

function buildNetWorthChart(entries, type = 'line') {
  netWorthChart = destroyChart(netWorthChart);
  netWorthChart = netWorthSeriesChart(document.getElementById('dash-nw-chart'), entries, type);
}

// ======================================================
// This month, actually
//
// Every other number on this dashboard — savings rate, runway, time to FI —
// is derived from `monthly_expenses`, a figure typed into Settings once. The
// ledger knows what was actually spent. Putting the two side by side is the
// only place in the app where the plan meets the record, which makes it worth
// the strip it occupies.
// ======================================================

const LIFE_CATEGORY_LABELS = {
  food_delivery: 'Food delivery', card_transaction: 'Card', upi_payment: 'UPI',
  groceries: 'Groceries', utilities: 'Utilities', restaurant: 'Restaurants',
  transport: 'Transport', shopping: 'Shopping', uncategorised: 'Uncategorised',
};

function hideLifeStrip() {
  const strip = document.getElementById('dash-life-strip');
  strip?.closest('.chart-card')?.remove();
}

async function renderLifeStrip(token) {
  const strip = document.getElementById('dash-life-strip');
  if (!strip) return;

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const from = new Date(`${monthStart}T00:00:00`).toISOString();

  const stats = await ledger.stats(from, null);
  if (token !== loadToken || !strip.isConnected) return;

  const spent = Number(stats?.spend?.total) || 0;
  const budget = settings.get('monthly_expenses');
  const eventCount = Number(stats?.event_count) || 0;

  if (!eventCount) { hideLifeStrip(); return; }

  // Pace, not just position: a third of the way through the month, half the
  // budget gone is the thing worth knowing.
  const daysIn = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const expected = budget * (daysIn / daysInMonth);
  const overPace = expected > 0 && spent > expected * 1.1;
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;

  const categories = Object.entries(stats?.spend?.by_category || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 4);

  strip.innerHTML = `
    <div class="life-strip">
      <div class="life-spend">
        <div class="life-spend-value mono">${escapeHTML(formatINRFull(spent))}</div>
        <div class="life-spend-sub">
          recorded across ${eventCount} event${eventCount === 1 ? '' : 's'} ·
          budget ${escapeHTML(formatINRFull(budget))}
        </div>
        <div class="progress-wrap life-bar">
          <div class="progress-bar ${overPace ? 'is-over' : ''}" style="width:${pct.toFixed(1)}%"></div>
          <span class="life-pace" style="left:${Math.min((daysIn / daysInMonth) * 100, 100).toFixed(1)}%"
                title="Where the month is: day ${daysIn} of ${daysInMonth}"></span>
        </div>
        <div class="life-spend-note ${overPace ? 'is-over' : ''}">
          ${overPace
            ? `Ahead of pace — ${escapeHTML(formatINRFull(spent - expected))} above where day ${daysIn} would put you.`
            : `On pace. Day ${daysIn} of ${daysInMonth}.`}
        </div>
      </div>
      <div class="life-cats">
        ${categories.length ? categories.map(([key, value]) => `
          <div class="life-cat">
            <span class="life-cat-label">${escapeHTML(LIFE_CATEGORY_LABELS[key] || key.replace(/_/g, ' '))}</span>
            <span class="life-cat-value mono">${escapeHTML(formatINRFull(value))}</span>
          </div>
        `).join('') : '<div class="life-cat"><span class="life-cat-label">No categorised spending yet</span></div>'}
      </div>
    </div>
    <p class="life-caveat">
      Only what reached your inbox. Cash and anything unemailed is not here.
    </p>
  `;
}
