import { Chart } from '../vendor.js';
import { supabase } from '../supabase.js';
import * as ledger from '../ledger/api.js';
import { EUR_INR_FALLBACK } from '../constants.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, destroyChart, makeCopyable, fetchEURtoINR,
  parseNum, escapeHTML, cssVar, CHART_COLORS, ASSET_COLORS,
  computeNet, computeAssets, computeLiquid, computeEmergencyFund,
  renderKpiCards,
} from '../utils.js';
import { impliedSavingsRate } from '../finance.js';
import { navigateTo } from '../router.js';

let netWorthChart = null;
let allocationChart = null;
let netWorthData = [];
let clockTimer = null;

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

  document.getElementById('nw-chart-line')?.addEventListener('click', () => {
    document.getElementById('nw-chart-line').classList.add('active');
    document.getElementById('nw-chart-bar').classList.remove('active');
    buildNetWorthChart(netWorthData, 'line');
  });
  document.getElementById('nw-chart-bar')?.addEventListener('click', () => {
    document.getElementById('nw-chart-bar').classList.add('active');
    document.getElementById('nw-chart-line').classList.remove('active');
    buildNetWorthChart(netWorthData, 'bar');
  });

  document.getElementById('dash-goto-points')?.addEventListener('click', () => navigateTo('points'));
  document.getElementById('dash-goto-ledger')?.addEventListener('click', () => navigateTo('ledger'));

  await loadDashboardData();
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

/** Points on a transaction, guarding every field. */
function calcPoints(t) {
  if (t.points !== null && t.points !== undefined) return parseNum(t.points);
  return parseNum(t.amount) * parseNum(t.multiplier) / 100;
}

function showAlert(message) {
  const el = document.getElementById('dash-alert');
  if (!el) return;
  el.innerHTML = `
    <div class="dash-banner dash-banner--error" role="alert">
      <i class="fas fa-triangle-exclamation"></i>
      <div>
        <strong>Couldn't load your data.</strong>
        <div class="dash-banner-sub">${escapeHTML(message)}</div>
      </div>
      <button type="button" class="btn-sm btn-ghost" id="dash-retry">Retry</button>
    </div>
  `;
  document.getElementById('dash-retry')?.addEventListener('click', () => loadDashboardData());
}

function showEmptyState() {
  const el = document.getElementById('dash-alert');
  if (!el) return;
  el.innerHTML = `
    <div class="dash-banner dash-banner--empty">
      <i class="fas fa-seedling"></i>
      <div>
        <strong>No snapshots yet.</strong>
        <div class="dash-banner-sub">Add your first net worth snapshot and the dashboard fills in.</div>
      </div>
      <button type="button" class="btn-sm btn-accent" id="dash-goto-nw">Add snapshot</button>
    </div>
  `;
  document.getElementById('dash-goto-nw')?.addEventListener('click', () => navigateTo('networth'));
}

async function loadDashboardData() {
  // The ledger is optional: the dashboard predates it and has to keep working
  // when the migrations have not been run or nothing has been ingested yet.
  renderLifeStrip().catch(() => hideLifeStrip());

  const [nwRes, txRes, rdRes, eurRate] = await Promise.all([
    supabase.from('net_worth_entries').select('*').order('date', { ascending: true }),
    supabase.from('cc_transactions').select('*'),
    supabase.from('cc_redemptions').select('*'),
    fetchEURtoINR(EUR_INR_FALLBACK),
  ]);

  // A failed query used to be swallowed by `?.data || []`, so a network drop or
  // a denied RLS policy rendered a confident, well-formatted net worth of ₹0.
  const failure = nwRes.error || txRes.error || rdRes.error;
  if (failure) {
    showAlert(failure.message);
    return;
  }

  const entries      = nwRes.data || [];
  const transactions = txRes.data || [];
  const redemptions  = rdRes.data || [];
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
    changeEl.innerHTML = `<span style="color:${isPos ? 'var(--success)' : 'var(--danger)'}">${isPos ? '↑' : '↓'} ${Math.abs(nwChange).toFixed(1)}%</span> from last snapshot`;
  } else if (changeEl) {
    changeEl.textContent = entries.length ? 'First snapshot' : 'No data yet';
  }

  // ── Points ────────────────────────────────────────────
  const pointsPerEur  = settings.get('points_per_eur');
  const totalAccrued  = transactions.reduce((s, t) => s + calcPoints(t), 0);
  const totalRedeemed = redemptions.reduce((s, r) => s + parseNum(r.points_redeemed), 0);
  const balance       = totalAccrued - totalRedeemed;
  const balanceINR    = pointsPerEur > 0 ? (balance / pointsPerEur) * eurRate : 0;
  const totalSpent    = transactions.reduce((s, t) => s + parseNum(t.amount), 0);
  const rdValue       = redemptions.reduce((s, r) => s + parseNum(r.value_amount), 0);
  const rewardRate    = totalSpent > 0 ? ((rdValue + balanceINR) / totalSpent) * 100 : 0;
  const rewardTarget  = settings.get('cc_reward_target_rate');

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

  const kpis = [
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
      glow: runwayOK ? 'var(--success-glow)' : 'var(--warning-glow)',
      value: runway.toFixed(1), unit: 'months', raw: runway.toFixed(1),
      badge: { text: runwayOK ? 'Healthy' : 'Build up', type: runwayOK ? 'positive' : 'neutral' },
      sub: `${basis === 'cash_like' ? 'Cash + FDs' : 'Liquid'} ÷ ₹${(monthlyExp / 1000).toFixed(0)}k/mo`,
      tooltip: `${basis === 'cash_like' ? 'Cash and fixed deposits' : 'Cash, stocks and mutual funds'} ÷ monthly baseline expenses. Target ≥ ${runwayTarget} months.`,
    },
  ];

  renderKpiCards(document.getElementById('dashboard-kpis'), kpis);

  // ── Points Strip ──────────────────────────────────────
  const strip = document.getElementById('points-strip');
  if (strip) {
    const items = [
      {
        label: 'Accrued',
        value: Math.round(totalAccrued).toLocaleString('en-IN') + ' pts',
        sub: `${transactions.length} transactions`,
        color: 'var(--success)',
      },
      {
        label: 'Redeemed',
        value: Math.round(totalRedeemed).toLocaleString('en-IN') + ' pts',
        sub: `Value: ${formatINRFull(rdValue)}`,
        color: 'var(--danger)',
      },
      {
        label: 'Balance value',
        value: formatINRFull(balanceINR),
        sub: `${pointsPerEur > 0 ? (balance / pointsPerEur).toFixed(0) : 0} EUR`,
        color: 'var(--accent)',
      },
      {
        label: 'Reward rate',
        value: formatPercent(rewardRate),
        sub: rewardRate >= rewardTarget ? `Above the ${rewardTarget}% target` : `Target: above ${rewardTarget}%`,
        color: rewardRate >= rewardTarget ? 'var(--success)' : 'var(--warning)',
      },
    ];

    strip.innerHTML = items.map((item, i) => `
      <div class="points-strip-item ${i < items.length - 1 ? 'has-divider' : ''}">
        <div class="psi-label">${escapeHTML(item.label)}</div>
        <div class="psi-value mono" style="color:${item.color}">${escapeHTML(item.value)}</div>
        <div class="psi-sub">${escapeHTML(item.sub)}</div>
      </div>
    `).join('');
  }

  buildNetWorthChart(entries, 'line');
  buildAllocationChart(latest);
}

function buildNetWorthChart(entries, type = 'line') {
  netWorthChart = destroyChart(netWorthChart);
  const ctx = document.getElementById('dash-nw-chart');
  if (!ctx || !entries.length) return;

  const labels = entries.map(e => e.date);
  const data   = entries.map(e => computeNet(e));

  const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, 'rgba(56,189,248,0.22)');
  gradient.addColorStop(1, 'rgba(56,189,248,0)');

  netWorthChart = new Chart(ctx, {
    type: type === 'bar' ? 'bar' : 'line',
    data: {
      labels,
      datasets: [{
        label: 'Net worth',
        data,
        borderColor: CHART_COLORS.accent,
        backgroundColor: type === 'line' ? gradient : 'rgba(56,189,248,0.3)',
        borderWidth: 2, fill: true, tension: 0.4,
        pointBackgroundColor: CHART_COLORS.accent,
        pointRadius: 3, pointHoverRadius: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ' ' + formatINRFull(ctx.parsed.y) } }
      },
      scales: {
        x: { type: 'time', time: { unit: 'month', displayFormats: { month: 'MMM yy' } }, grid: { display: false }, ticks: { maxRotation: 0 } },
        y: {
          grid: { color: 'rgba(148,163,184,0.06)' },
          ticks: {
            callback: v => {
              if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
              if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
              return '₹' + (v / 1000).toFixed(0) + 'k';
            }
          }
        }
      }
    }
  });
}

function buildAllocationChart(latest) {
  allocationChart = destroyChart(allocationChart);
  const ctx = document.getElementById('dash-alloc-chart');
  if (!ctx || !latest) return;

  const fields = [
    { key: 'stocks',       label: 'Stocks',       color: ASSET_COLORS.stocks },
    { key: 'mutual_funds', label: 'Mutual Funds', color: ASSET_COLORS.mutual_funds },
    { key: 'cash',         label: 'Cash',         color: ASSET_COLORS.cash },
    { key: 'epf',          label: 'EPF',          color: ASSET_COLORS.epf },
    { key: 'gold',         label: 'Gold',         color: ASSET_COLORS.gold },
    { key: 'fds',          label: 'FDs',          color: ASSET_COLORS.fds },
  ].filter(f => (latest[f.key] || 0) > 0);

  allocationChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: fields.map(f => f.label),
      datasets: [{
        data: fields.map(f => latest[f.key] || 0),
        backgroundColor: fields.map(f => f.color),
        // Resolved off the document — `var(--bg-card)` never resolves on a canvas.
        borderColor: cssVar('--bg-card', '#1e293b'),
        borderWidth: 3, hoverOffset: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '72%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, pointStyleWidth: 8, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatINR(ctx.parsed)}` } }
      }
    }
  });
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

async function renderLifeStrip() {
  const strip = document.getElementById('dash-life-strip');
  if (!strip) return;

  const zone = settings.get('ledger_timezone') || 'Asia/Kolkata';
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const from = new Date(`${monthStart}T00:00:00`).toISOString();

  const stats = await ledger.stats(from, null);
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
