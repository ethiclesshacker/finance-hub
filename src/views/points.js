import { Chart, Grid, gridHtml } from '../vendor.js';
import { supabase, getCurrentUserId } from '../supabase.js';
import { EUR_INR_FALLBACK, MULTIPLIER_OPTIONS, REDEMPTION_PARTNERS } from '../constants.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, formatDate, todayISO,
  destroyChart, makeCopyable, downloadCSV, escapeHTML, cssVar,
  openModal, closeModal, showToast, parseNum, fetchEURtoINR, CHART_COLORS, renderKpiCards,
  numCell, rowActions, callAttrs, comboboxHTML, wireCombobox,
} from '../utils.js';

// Grid.js applies these to both the header cell and every body cell in the
// column, which is how a numeric column stays right-aligned end to end.
// A data attribute, not a class: Grid.js writes `class` straight onto the
// cell, replacing the gridjs-th / gridjs-td classes it needs to stay styled.
const NUMERIC_COL = () => ({ 'data-align': 'end' });
const ACTIONS_COL = () => ({ 'data-align': 'end' });

/**
 * Points on a transaction. Every field goes through parseNum — a single null
 * amount or multiplier used to turn the entire KPI row into NaN.
 */
function calcPoints(t) {
  if (t.points !== null && t.points !== undefined) return parseNum(t.points);
  return parseNum(t.amount) * parseNum(t.multiplier) / 100;
}

let transactions = [];
let redemptions = [];
let eurRate = EUR_INR_FALLBACK;
let pointsChartRef = null;
let merchantChartRef = null;
let txTableGrid = null;
let rdTableGrid = null;
let activeTab = 'transactions';
// Rows now arrive from the ledger as well as from this form (0012_card_points.sql):
// `rules` maps the bank's merchant names to your labels, and `reconcile` is what
// never paired — typed rows with no bank alert, and alerts with no row.
let rules = [];
let reconcile = { rows_without_event: [], events_without_row: [] };
let filterBasis = '';
let rulesGrid = null;
let reconRowsGrid = null;
let reconEventsGrid = null;
let activeChartType = 'bar';
let editingId = null;
let editingType = null;
let searchTerm = '';
let filterMultiplier = '';
let filterPartner = '';
let filterMerchant = '';

function getMultiplierBadgeClass(multiplier) {
  const val = parseFloat(multiplier);
  if (val === 0) return 'badge-gray';
  if (val === 2) return 'badge-blue';
  if (val === 4) return 'badge-yellow';
  if (val === 16) return 'badge-purple';
  if (val === 24) return 'badge-green';
  return 'badge-blue';
}

export async function renderPoints(container) {
  activeTab = 'transactions';
  activeChartType = 'bar';
  editingId = null;
  editingType = null;
  searchTerm = '';
  filterMultiplier = '';
  filterPartner = '';
  filterMerchant = '';

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Points & Rewards</h2>
        <p>HSBC TravelOne — spend tracking, points accrual & redemption management</p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <span id="fx-rate-badge" class="badge badge-blue">
          <i class="fas fa-circle-notch fa-spin" style="font-size:0.6rem"></i>
          Loading FX…
        </span>
        <button type="button" class="btn-sm btn-ghost" id="pt-export-btn">
          <i class="fas fa-download"></i> Export CSV
        </button>
      </div>
    </div>

    <div class="page-body">
      <!-- KPI Cards -->
      <div class="kpi-grid kpi-grid--3col" id="pt-kpi-grid">
        ${Array(6).fill(0).map(() => `
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
              <div class="chart-title">Points Accumulation</div>
              <div class="chart-subtitle">Monthly points earned</div>
            </div>
            <div class="chart-toggle">
              <button type="button" class="chart-toggle-btn" id="pt-line-btn">Line</button>
              <button type="button" class="chart-toggle-btn active" id="pt-bar-btn">Bar</button>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="pt-accumulation-chart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <div>
              <div class="chart-title">Spend by Merchant</div>
              <div class="chart-subtitle">Top merchants by INR spend</div>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="pt-merchant-chart"></canvas>
          </div>
        </div>
      </div>

      <div id="pt-sync-banner"></div>

      <!-- Table section -->
      <div class="table-section">
        <div class="table-toolbar">
          <div class="table-tabs">
            <button type="button" class="table-tab active" id="tab-transactions">
              <i class="fas fa-receipt" style="margin-right:0.3rem"></i>Transactions
            </button>
            <button type="button" class="table-tab" id="tab-redemptions">
              <i class="fas fa-plane-departure" style="margin-right:0.3rem"></i>Redemptions
            </button>
            <button type="button" class="table-tab" id="tab-rules">
              <i class="fas fa-tags" style="margin-right:0.3rem"></i>Rules
            </button>
            <button type="button" class="table-tab" id="tab-reconcile">
              <i class="fas fa-code-compare" style="margin-right:0.3rem"></i>Reconcile
            </button>
          </div>
          <div class="table-actions" style="display:flex;gap:0.5rem;align-items:center">
            <div id="pt-dynamic-filter-container"></div>
            <div class="search-input-wrap">
              <i class="fas fa-search"></i>
              <input type="text" class="search-input" id="pt-search" placeholder="Search…" />
            </div>
            <button type="button" class="btn-icon" id="pt-refresh-btn" title="Refresh" aria-label="Refresh">
              <i class="fas fa-rotate-right"></i>
            </button>
          </div>
        </div>
        <div class="table-inner">
          <div id="pt-transactions-table"></div>
          <div id="pt-redemptions-table" style="display:none"></div>
          <div id="pt-rules-table" style="display:none"></div>
          <div id="pt-reconcile-table" style="display:none"></div>
        </div>
      </div>
    </div>

    <!-- FAB -->
    <button type="button" class="fab" id="pt-fab" title="Add transaction / redemption" aria-label="Add transaction or redemption">
      <i class="fas fa-plus"></i>
    </button>
  `;

  // Chart toggles
  document.getElementById('pt-line-btn').addEventListener('click', () => {
    activeChartType = 'line';
    document.getElementById('pt-line-btn').classList.add('active');
    document.getElementById('pt-bar-btn').classList.remove('active');
    buildAccumulationChart(transactions, 'line');
  });
  document.getElementById('pt-bar-btn').addEventListener('click', () => {
    activeChartType = 'bar';
    document.getElementById('pt-bar-btn').classList.add('active');
    document.getElementById('pt-line-btn').classList.remove('active');
    buildAccumulationChart(transactions, 'bar');
  });

  // Tab switching
  document.getElementById('tab-transactions').addEventListener('click', () => switchTab('transactions'));
  document.getElementById('tab-redemptions').addEventListener('click', () => switchTab('redemptions'));
  document.getElementById('tab-rules').addEventListener('click', () => switchTab('rules'));
  document.getElementById('tab-reconcile').addEventListener('click', () => switchTab('reconcile'));

  // FAB
  document.getElementById('pt-fab').addEventListener('click', () => openForm(null, activeTab === 'redemptions' ? 'redemption' : 'transaction'));

  // Export
  document.getElementById('pt-export-btn').addEventListener('click', exportCSV);

  // Refresh
  document.getElementById('pt-refresh-btn').addEventListener('click', loadData);

  // Search
  document.getElementById('pt-search').addEventListener('input', e => {
    searchTerm = e.target.value.toLowerCase();
    if (activeTab === 'transactions') renderTxTable();
    else if (activeTab === 'redemptions') renderRdTable();
    else if (activeTab === 'rules') renderRulesTable();
  });

  await loadData();
}

async function loadData() {
  // Pick up any spend on the card the ledger has seen since the last visit.
  // Idempotent and cheap; a failure here must not stop the page loading.
  await supabase.rpc('cc_sync_from_events').then(() => {}, () => {});

  // cc_points is cc_transactions as it should be read: for a row linked to a
  // ledger event, the date and amount are the bank's, not a typed copy.
  const [txRes, rdRes, rate, rulesRes, reconRes] = await Promise.all([
    supabase.from('cc_points').select('*').order('date', { ascending: false }),
    supabase.from('cc_redemptions').select('*').order('date', { ascending: false }),
    fetchEURtoINR(EUR_INR_FALLBACK),
    supabase.from('cc_merchant_rules').select('*').order('uses', { ascending: false }),
    supabase.rpc('cc_reconcile'),
  ]);

  const failure = txRes.error || rdRes.error;
  if (failure) {
    showToast('Failed to load data: ' + failure.message, 'error');
    return;
  }

  transactions = txRes.data || [];
  redemptions  = rdRes.data || [];
  eurRate = rate;
  rules = rulesRes.data || [];
  reconcile = reconRes.data || { rows_without_event: [], events_without_row: [] };

  // Update FX badge
  const badge = document.getElementById('fx-rate-badge');
  if (badge) badge.innerHTML = `<i class="fas fa-euro-sign" style="font-size:0.6rem"></i> 1 EUR = ₹${rate.toFixed(2)}`;

  renderKPIs();
  buildAccumulationChart(transactions, activeChartType);
  buildMerchantChart(transactions);
  renderTableFilters();
  renderTxTable();
  renderRdTable();
  renderRulesTable();
  renderReconcile();
  renderSyncBanner();
}

// ── What the ledger added, and what never paired ───────

function renderSyncBanner() {
  const el = document.getElementById('pt-sync-banner');
  if (!el) return;
  const assumed = transactions.filter(t => t.basis === 'assumed').length;
  const loose = reconcile.rows_without_event.length + reconcile.events_without_row.length;
  if (!assumed && !loose) { el.innerHTML = ''; return; }

  const parts = [];
  if (assumed) {
    parts.push(`<span><strong>${assumed}</strong> ${assumed === 1 ? 'row was' : 'rows were'} added from your card alerts with an assumed label and multiplier.</span>
      <button type="button" class="btn-sm btn-accent" id="pt-show-assumed">${filterBasis === 'assumed' ? 'Show all' : 'Review'}</button>`);
  }
  if (loose) {
    parts.push(`<span><strong>${reconcile.rows_without_event.length}</strong> typed ${reconcile.rows_without_event.length === 1 ? 'row has' : 'rows have'} no card alert, and
      <strong>${reconcile.events_without_row.length}</strong> ${reconcile.events_without_row.length === 1 ? 'alert has' : 'alerts have'} no row.</span>
      <button type="button" class="btn-sm btn-ghost" id="pt-go-reconcile">Reconcile</button>`);
  }
  el.innerHTML = `<div class="pt-banner">${parts.map(p => `<div class="pt-banner-item">${p}</div>`).join('')}</div>`;

  document.getElementById('pt-show-assumed')?.addEventListener('click', () => {
    filterBasis = filterBasis === 'assumed' ? '' : 'assumed';
    switchTab('transactions');
    renderTxTable();
    renderSyncBanner();
  });
  document.getElementById('pt-go-reconcile')?.addEventListener('click', () => switchTab('reconcile'));
}

// ── KPI Cards ──────────────────────────────────────────
function renderKPIs() {
  const POINTS_PER_EUR        = settings.get('points_per_eur');
  const CC_MILESTONE_TARGET   = settings.get('cc_milestone_target');
  const CC_REWARD_TARGET_RATE = settings.get('cc_reward_target_rate');

  const totalAccrued  = transactions.reduce((s, t) => s + calcPoints(t), 0);
  const totalRedeemed = redemptions.reduce((s, r) => s + parseNum(r.points_redeemed), 0);
  const balance = totalAccrued - totalRedeemed;
  const balanceEUR = POINTS_PER_EUR > 0 ? balance / POINTS_PER_EUR : 0;
  const balanceINR = balanceEUR * eurRate;

  const totalSpent = transactions.reduce((s, t) => s + parseNum(t.amount), 0);
  const totalRdValue = redemptions.reduce((s, r) => s + parseNum(r.value_amount), 0);
  const rewardRate = totalSpent > 0 ? ((totalRdValue + balanceINR) / totalSpent) * 100 : 0;
  const avgVPP = totalRedeemed > 0 ? totalRdValue / totalRedeemed : 0;

  // Month accrual
  const thisMonth = todayISO().slice(0, 7);  // local month, not UTC
  const monthPts = transactions
    .filter(t => t.date?.slice(0,7) === thisMonth)
    .reduce((s, t) => s + calcPoints(t), 0);

  // Top merchant
  const merchantSpend = {};
  transactions.forEach(t => {
    merchantSpend[t.merchant] = (merchantSpend[t.merchant] || 0) + parseNum(t.amount);
  });

  const milestone = CC_MILESTONE_TARGET;
  const progressPct = milestone > 0 ? (totalSpent / milestone) * 100 : 0;
  const remaining = Math.max(milestone - totalSpent, 0);

  const kpis = [
    {
      id: 'pt-kpi-spent', label: 'Total spent', icon: 'fa-cart-shopping', tone: 'accent', value: formatINRFull(totalSpent), raw: totalSpent,
      progress: Math.min(progressPct, 100),
      sub: progressPct >= 100 ? 'Milestone reached' : `₹${Math.round(remaining).toLocaleString('en-IN')} to ₹${(CC_MILESTONE_TARGET/100000).toFixed(0)}L milestone`,
      tooltip: 'Lifetime total INR spend on the HSBC TravelOne card.',
    },
    {
      id: 'pt-kpi-balance', label: 'Points balance', icon: 'fa-star', tone: 'warning', value: Math.round(balance).toLocaleString('en-IN'), unit: 'pts', raw: Math.round(balance),
      sub: `Est. value: ${formatINRFull(balanceINR)}`,
      badge: { text: `${(balance / POINTS_PER_EUR).toFixed(0)} EUR`, type: 'neutral' },
      tooltip: `Accrued minus redeemed. Value = balance ÷ ${POINTS_PER_EUR} EUR × ₹${eurRate.toFixed(0)}/EUR`,
    },
    {
      id: 'pt-kpi-accrued', label: 'Total accrued', icon: 'fa-arrow-up-right-dots', tone: 'success', value: Math.round(totalAccrued).toLocaleString('en-IN'), unit: 'pts', raw: Math.round(totalAccrued),
      sub: `This month: ${Math.round(monthPts).toLocaleString('en-IN')} pts`,
      tooltip: 'All points ever earned on this card, including multiplier bonuses.',
    },
    {
      id: 'pt-kpi-redeemed', label: 'Total redeemed', icon: 'fa-plane-departure', tone: 'purple', value: Math.round(totalRedeemed).toLocaleString('en-IN'), unit: 'pts', raw: Math.round(totalRedeemed),
      sub: `Value realized: ${formatINRFull(totalRdValue)}`,
      tooltip: 'Total points burned across all redemptions. Sub-label = INR value you got back.',
    },
    {
      id: 'pt-kpi-balval', label: 'Balance value', icon: 'fa-euro-sign', tone: 'teal', value: formatINRFull(balanceINR), raw: balanceINR.toFixed(0),
      sub: `${balanceEUR.toFixed(1)} EUR @ ₹${eurRate.toFixed(0)}`,
      badge: { text: 'Live FX', type: 'neutral' },
      tooltip: `Balance ÷ ${POINTS_PER_EUR} EUR converted to INR at live EUR/INR rate.`,
    },
    {
      id: 'pt-kpi-rate', label: 'Reward rate', icon: 'fa-arrow-trend-up', tone: 'pink', value: formatPercent(rewardRate), raw: rewardRate.toFixed(2),
      sub: `Avg value per point: ₹${avgVPP.toFixed(2)}`,
      badge: rewardRate > 0 ? { text: rewardRate >= CC_REWARD_TARGET_RATE ? `Above ${CC_REWARD_TARGET_RATE}% target` : `Target ${CC_REWARD_TARGET_RATE}%`, type: rewardRate >= CC_REWARD_TARGET_RATE ? 'positive' : 'neutral' } : null,
      tooltip: `(Redemption value + Balance INR) ÷ Total Spend × 100. Target > ${CC_REWARD_TARGET_RATE}%.`,
    },
  ];

  const grid = document.getElementById('pt-kpi-grid');
  if (!grid) return;

  renderKpiCards(grid, kpis);
}

// ── Charts ──────────────────────────────────────────────
function buildAccumulationChart(txns, type) {
  pointsChartRef = destroyChart(pointsChartRef);
  const ctx = document.getElementById('pt-accumulation-chart');
  if (!ctx || !txns.length) return;

  // Group by month
  const monthly = {};
  txns.forEach(t => {
    const month = t.date?.slice(0, 7);
    if (!month) return;
    monthly[month] = (monthly[month] || 0) + calcPoints(t);
  });

  const sortedMonths = Object.keys(monthly).sort();
  const labels = sortedMonths.map(m => m + '-01');
  const data   = sortedMonths.map(m => monthly[m]);

  pointsChartRef = new Chart(ctx, {
    type: type === 'line' ? 'line' : 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Points earned',
        data,
        backgroundColor: type === 'bar' ? 'rgba(167,139,250,0.5)' : 'rgba(167,139,250,0.15)',
        borderColor: CHART_COLORS.purple,
        borderWidth: 2,
        borderRadius: type === 'bar' ? 6 : 0,
        fill: type === 'line',
        tension: 0.4,
        pointBackgroundColor: CHART_COLORS.purple,
        pointRadius: 3, pointHoverRadius: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${Math.round(ctx.parsed.y).toLocaleString('en-IN')} pts` } }
      },
      scales: {
        x: { type: 'time', time: { unit: 'month', displayFormats: { month: 'MMM yy' } }, grid: { display: false }, ticks: { maxRotation: 0 } },
        y: {
          grid: { color: 'rgba(148,163,184,0.06)' },
          ticks: { callback: v => Math.round(v).toLocaleString('en-IN') }
        }
      }
    }
  });
}

function buildMerchantChart(txns) {
  merchantChartRef = destroyChart(merchantChartRef);
  const ctx = document.getElementById('pt-merchant-chart');
  if (!ctx || !txns.length) return;

  const spend = {};
  txns.forEach(t => {
    spend[t.merchant] = (spend[t.merchant] || 0) + parseNum(t.amount);
  });

  const sorted = Object.entries(spend).sort((a,b) => b[1]-a[1]);
  const top6 = sorted.slice(0, 6);
  const otherSum = sorted.slice(6).reduce((s,[,v]) => s+v, 0);
  if (otherSum > 0) top6.push(['Others', otherSum]);

  const palette = [
    CHART_COLORS.accent, CHART_COLORS.purple, CHART_COLORS.success,
    CHART_COLORS.warning, CHART_COLORS.pink, CHART_COLORS.teal, '#94a3b8'
  ];

  merchantChartRef = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: top6.map(([k]) => k),
      datasets: [{
        data: top6.map(([,v]) => v),
        backgroundColor: palette,
        borderColor: cssVar('--bg-card', '#1e293b'), borderWidth: 3, hoverOffset: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '70%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 10, usePointStyle: true, pointStyleWidth: 8, font: { size: 10.5 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatINR(ctx.parsed)}` } }
      }
    }
  });
}

function renderTableFilters() {
  const container = document.getElementById('pt-dynamic-filter-container');
  if (!container) return;

  if (activeTab === 'transactions') {
    const multipliers = [...new Set(transactions.map(t => t.multiplier))].filter(v => v !== null && v !== undefined).sort((a, b) => a - b);
    const merchants = [...new Set(transactions.map(t => t.merchant))].filter(Boolean).sort();
    
    container.innerHTML = `
      <select id="pt-multiplier-filter" class="form-input" style="padding:0.35rem 0.5rem;font-size:0.8rem;height:36px;width:130px;border-radius:var(--radius-sm)" aria-label="Filter by multiplier">
        <option value="">All Multipliers</option>
        ${multipliers.map(m => `<option value="${escapeHTML(m)}" ${filterMultiplier === String(m) ? 'selected' : ''}>${escapeHTML(m)}×</option>`).join('')}
      </select>
      <select id="pt-merchant-filter" class="form-input" style="padding:0.35rem 0.5rem;font-size:0.8rem;height:36px;width:140px;border-radius:var(--radius-sm);max-width:180px" aria-label="Filter by merchant">
        <option value="">All Merchants</option>
        ${merchants.map(mer => `<option value="${escapeHTML(mer)}" ${filterMerchant === mer ? 'selected' : ''}>${escapeHTML(mer)}</option>`).join('')}
      </select>
    `;
    
    document.getElementById('pt-multiplier-filter')?.addEventListener('change', e => {
      filterMultiplier = e.target.value;
      renderTxTable();
    });
    
    document.getElementById('pt-merchant-filter')?.addEventListener('change', e => {
      filterMerchant = e.target.value;
      renderTxTable();
    });
  } else if (activeTab !== 'redemptions') {
    container.innerHTML = '';
  } else {
    const partners = [...new Set(redemptions.map(r => r.partner))].filter(Boolean).sort();
    container.innerHTML = `
      <select id="pt-partner-filter" class="form-input" style="padding:0.35rem 0.5rem;font-size:0.8rem;height:36px;width:140px;border-radius:var(--radius-sm)" aria-label="Filter by transfer partner">
        <option value="">All Partners</option>
        ${partners.map(p => `<option value="${escapeHTML(p)}" ${filterPartner === p ? 'selected' : ''}>${escapeHTML(p)}</option>`).join('')}
      </select>
    `;
    document.getElementById('pt-partner-filter')?.addEventListener('change', e => {
      filterPartner = e.target.value;
      renderRdTable();
    });
  }
}

// ── Tables ───────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  for (const name of ['transactions', 'redemptions', 'rules', 'reconcile']) {
    document.getElementById(`tab-${name}`).classList.toggle('active', tab === name);
    document.getElementById(`pt-${name}-table`).style.display = tab === name ? '' : 'none';
  }
  renderTableFilters();
}

function renderTxTable() {
  const container = document.getElementById('pt-transactions-table');
  if (!container) return;
  if (txTableGrid) { try { txTableGrid.destroy(); } catch(_) {} }

  let filtered = transactions;
  if (filterBasis) {
    filtered = filtered.filter(t => t.basis === filterBasis);
  }
  if (filterMultiplier) {
    filtered = filtered.filter(t => String(t.multiplier) === filterMultiplier);
  }
  if (filterMerchant) {
    filtered = filtered.filter(t => t.merchant === filterMerchant);
  }
  if (searchTerm) {
    filtered = filtered.filter(t =>
      t.merchant?.toLowerCase().includes(searchTerm) ||
      t.description?.toLowerCase().includes(searchTerm) ||
      t.date?.includes(searchTerm)
    );
  }

  const rows = filtered.map(t => {
    const pts = calcPoints(t);
    return [
      formatDate(t.date),
      gridHtml(merchantCell(t)),
      t.description || '—',
      gridHtml(amountCell(t)),
      gridHtml(`<span class="badge ${getMultiplierBadgeClass(t.multiplier)}">${escapeHTML(t.multiplier)}×</span>`),
      gridHtml(numCell(Math.round(pts).toLocaleString('en-IN'), { tone: 'success', bold: true })),
      gridHtml((t.basis === 'assumed'
        ? `<button type="button" class="btn-sm btn-accent pt-confirm" ${callAttrs(`window.__ptTxConfirm('${t.id}')`)} title="The label and multiplier are right">Confirm</button>`
        : '') + rowActions(`window.__ptTxEdit('${t.id}')`, `window.__ptTxDelete('${t.id}')`, 'transaction')),
    ];
  });

  txTableGrid = new Grid({
    columns: [
      { name: 'Date' },
      { name: 'Merchant' },
      { name: 'Description' },
      { name: 'Amount', attributes: NUMERIC_COL },
      { name: 'Multiplier' },
      { name: 'Points', attributes: NUMERIC_COL },
      { name: 'Actions', sort: false, attributes: ACTIONS_COL },
    ],
    data: rows,
    pagination: { limit: 10 },
    sort: true,
    language: { noRecordsFound: 'No transactions yet. Add one with the + button!' },
  }).render(container);

  window.__ptTxEdit = (id) => {
    const t = transactions.find(t => t.id === id);
    if (t) openForm(t, 'transaction');
  };
  window.__ptTxConfirm = async (id) => {
    const { error } = await supabase.rpc('cc_confirm', { p_id: id });
    if (error) { showToast('Could not confirm: ' + error.message, 'error'); return; }
    showToast('Confirmed.');
    await loadData();
  };
  window.__ptTxDelete = async (id) => {
    if (!confirm('Delete this transaction?')) return;
    const { error } = await supabase.from('cc_transactions').delete().eq('id', id);
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
    showToast('Transaction deleted.');
    await loadData();
  };
}

/** The label, with where the row came from and whether anyone has looked at it. */
function merchantCell(t) {
  const bits = [escapeHTML(t.merchant || '—')];
  if (t.basis === 'assumed') bits.push('<span class="badge badge-yellow" title="Added from a card alert. The label and multiplier are assumed from earlier spends at this merchant.">Assumed</span>');
  if (t.merchant && t.merchant === settings.get('cc_work_label')) bits.push('<span class="badge badge-blue" title="Counted as work spend">Work</span>');
  const bank = t.raw_merchant && t.raw_merchant !== t.merchant
    ? `<div class="pt-bank-name" title="The merchant name on the card alert">${escapeHTML(t.raw_merchant)}</div>` : '';
  return `<div class="pt-merchant">${bits.join(' ')}</div>${bank}`;
}

/** The bank's amount when there is one; what you typed stays visible if it differed. */
function amountCell(t) {
  const main = numCell(formatINRFull(parseNum(t.amount)), { bold: true });
  if (t.amount_typed === null || t.amount_typed === undefined) return main;
  return `${main}<div class="pt-typed" title="The card alert said ${escapeHTML(formatINRFull(parseNum(t.amount)))}; the bank's figure is used">typed ${escapeHTML(formatINRFull(parseNum(t.amount_typed)))}</div>`;
}

// ── Rules ──────────────────────────────────────────────
//
// This is the table to curate. A rule says: when the card alert names THIS
// merchant, file it under THAT label at THIS multiplier. They were learned from
// the rows typed by hand; editing one makes it yours and stops it being relearned.

function renderRulesTable() {
  const container = document.getElementById('pt-rules-table');
  if (!container) return;
  if (rulesGrid) { try { rulesGrid.destroy(); } catch (_) {} }

  const workLabel = settings.get('cc_work_label');
  const shown = searchTerm
    ? rules.filter(r => r.ledger_merchant?.toLowerCase().includes(searchTerm) || r.label?.toLowerCase().includes(searchTerm))
    : rules;

  rulesGrid = new Grid({
    columns: [
      { name: 'On the card alert' },
      { name: 'Your label' },
      { name: 'Multiplier' },
      { name: 'Seen', attributes: NUMERIC_COL },
      { name: 'Rule' },
      { name: 'Actions', sort: false, attributes: ACTIONS_COL },
    ],
    data: shown.map(r => [
      r.ledger_merchant,
      gridHtml(`${escapeHTML(r.label)}${r.label === workLabel ? ' <span class="badge badge-blue">Work</span>' : ''}`),
      gridHtml(`<span class="badge ${getMultiplierBadgeClass(r.multiplier)}">${escapeHTML(r.multiplier)}×</span>`),
      gridHtml(numCell(String(r.uses))),
      gridHtml(r.source === 'manual'
        ? '<span class="badge badge-green">Yours</span>'
        : r.ambiguous
          ? '<span class="badge badge-yellow" title="You have filed this merchant under more than one label. The rule uses the most common one.">Learned · mixed</span>'
          : '<span class="badge">Learned</span>'),
      gridHtml(rowActions(`window.__ptRuleEdit('${encodeURIComponent(r.merchant_key)}')`, `window.__ptRuleDelete('${encodeURIComponent(r.merchant_key)}')`, 'rule')),
    ]),
    pagination: { limit: 12 },
    sort: true,
    language: { noRecordsFound: 'No rules yet. They are learned from rows linked to a card alert.' },
  }).render(container);

  window.__ptRuleEdit = (key) => {
    const rule = rules.find(r => r.merchant_key === decodeURIComponent(key));
    if (rule) openRuleForm(rule);
  };
  window.__ptRuleDelete = async (key) => {
    if (!confirm('Delete this rule? New spends at this merchant will arrive under the bank\'s own name at 2×.')) return;
    const { error } = await supabase.from('cc_merchant_rules').delete().eq('merchant_key', decodeURIComponent(key));
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
    showToast('Rule deleted.');
    await loadData();
  };
}

function openRuleForm(rule) {
  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Rule for ${escapeHTML(rule.ledger_merchant)}</h3>
      <button class="modal-close" id="pt-modal-close" aria-label="Close"><i class="fas fa-xmark"></i></button>
    </div>
    <div id="pt-form-body">
      <div class="form-group">
        <label class="form-label" for="pt-r-label">File it under</label>
        ${comboboxHTML({ id: 'pt-r-label', value: rule.label, placeholder: 'Search or type a new one', options: usedBefore(t => t.merchant) })}
        <div class="form-hint">Use “${escapeHTML(settings.get('cc_work_label'))}” to count spends here as work.</div>
      </div>
      <div class="form-group">
        <label class="form-label" for="pt-r-multiplier">Multiplier</label>
        <select class="form-select" id="pt-r-multiplier">
          ${MULTIPLIER_OPTIONS.map(m => `<option value="${m.value}" ${rule.multiplier == m.value ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <label class="pt-check"><input type="checkbox" id="pt-r-apply" checked />
        <span>Also apply to rows at this merchant that are still assumed</span></label>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" id="pt-form-cancel">Cancel</button>
      <button class="btn-submit" id="pt-rule-submit">Save rule</button>
    </div>
  `);
  wireCombobox('pt-r-label');
  document.getElementById('pt-modal-close').addEventListener('click', closeModal);
  document.getElementById('pt-form-cancel').addEventListener('click', closeModal);
  document.getElementById('pt-rule-submit').addEventListener('click', async () => {
    const label = document.getElementById('pt-r-label').value.trim();
    const multiplier = parseNum(document.getElementById('pt-r-multiplier').value);
    if (!label) { showToast('A rule needs a label.', 'error'); return; }

    const { error } = await supabase.from('cc_merchant_rules')
      .update({ label, multiplier, source: 'manual', ambiguous: false, updated_at: new Date().toISOString() })
      .eq('merchant_key', rule.merchant_key);
    if (error) { showToast('Save failed: ' + error.message, 'error'); return; }

    if (document.getElementById('pt-r-apply').checked) {
      const waiting = transactions.filter(t => t.basis === 'assumed' && t.raw_merchant
        && t.raw_merchant.toLowerCase() === rule.ledger_merchant.toLowerCase());
      for (const t of waiting) {
        await supabase.from('cc_transactions').update({ merchant: label, multiplier }).eq('id', t.id);
      }
    }
    closeModal();
    showToast('Rule saved.');
    await loadData();
  });
}

// ── Reconcile ──────────────────────────────────────────
//
// Two lists that should both be short. A typed row with no card alert is fine
// when the alert never came; it is a problem when the alert is sitting in the
// other list under a different amount. Linking keeps your label, multiplier and
// points, and takes the amount and date from the bank.

function renderReconcile() {
  const container = document.getElementById('pt-reconcile-table');
  if (!container) return;
  for (const g of [reconRowsGrid, reconEventsGrid]) { if (g) { try { g.destroy(); } catch (_) {} } }

  container.innerHTML = `
    <div class="pt-recon-head">Typed rows with no card alert <span class="pt-recon-count">${reconcile.rows_without_event.length}</span></div>
    <p class="pt-recon-note">If a likely alert exists it is suggested. Link it and the bank's amount and date take over; your label, multiplier and points stay. With no suggestion, the alert probably never arrived and the row is fine as it is.</p>
    <div id="pt-recon-rows"></div>
    <div class="pt-recon-head">Card alerts with no row <span class="pt-recon-count">${reconcile.events_without_row.length}</span></div>
    <p class="pt-recon-note">Spends the ledger saw on this card before automatic rows began. Add a row for any that earned points and was never entered.</p>
    <div id="pt-recon-events"></div>`;

  reconRowsGrid = new Grid({
    columns: [{ name: 'Date' }, { name: 'Label' }, { name: 'Amount', attributes: NUMERIC_COL }, { name: 'Likely card alert' }, { id: 'act', name: '', sort: false, attributes: ACTIONS_COL }],
    data: reconcile.rows_without_event.map(r => [
      formatDate(r.date), r.label, gridHtml(numCell(formatINRFull(parseNum(r.amount)), { bold: true })),
      r.suggestion
        ? gridHtml(`${escapeHTML(formatDate(r.suggestion.date))} · ${escapeHTML(r.suggestion.merchant || 'unnamed')} · <strong>${escapeHTML(formatINRFull(parseNum(r.suggestion.amount)))}</strong>
            <div class="pt-bank-name">${escapeHTML(r.suggestion.why)}</div>`)
        : gridHtml('<span class="pt-bank-name">None found</span>'),
      r.suggestion
        ? gridHtml(`<button type="button" class="btn-sm btn-accent" ${callAttrs(`window.__ptLink('${r.id}','${r.suggestion.event_id}')`)}>Link</button>`)
        : '',
    ]),
    pagination: { limit: 8 }, sort: true,
    language: { noRecordsFound: 'Every typed row is linked to a card alert.' },
  }).render(document.getElementById('pt-recon-rows'));

  reconEventsGrid = new Grid({
    columns: [{ name: 'Date' }, { name: 'On the card alert' }, { name: 'Amount', attributes: NUMERIC_COL }, { name: 'Would be filed under' }, { id: 'act', name: '', sort: false, attributes: ACTIONS_COL }],
    data: reconcile.events_without_row.map(e => [
      formatDate(e.date), e.merchant || e.title || 'unnamed',
      gridHtml(numCell(formatINRFull(parseNum(e.amount)), { bold: true })),
      e.would_be_label || '—',
      gridHtml(`<button type="button" class="btn-sm btn-ghost" ${callAttrs(`window.__ptCreate('${e.event_id}')`)}>Add row</button>`),
    ]),
    pagination: { limit: 8 }, sort: true,
    language: { noRecordsFound: 'Every spend on the card has a row.' },
  }).render(document.getElementById('pt-recon-events'));

  window.__ptLink = async (id, eventId) => {
    const { error } = await supabase.rpc('cc_link', { p_id: id, p_event_id: eventId });
    if (error) { showToast('Could not link: ' + error.message, 'error'); return; }
    showToast('Linked. The bank\'s amount and date now apply.');
    await loadData();
  };
  window.__ptCreate = async (eventId) => {
    const { error } = await supabase.rpc('cc_create_from_event', { p_event_id: eventId });
    if (error) { showToast('Could not add: ' + error.message, 'error'); return; }
    showToast('Row added as assumed. Confirm it in Transactions.');
    await loadData();
  };
}

function renderRdTable() {
  const container = document.getElementById('pt-redemptions-table');
  if (!container) return;
  if (rdTableGrid) { try { rdTableGrid.destroy(); } catch(_) {} }

  let filtered = redemptions;
  if (filterPartner) {
    filtered = filtered.filter(r => r.partner === filterPartner);
  }
  if (searchTerm) {
    filtered = filtered.filter(r =>
      r.partner?.toLowerCase().includes(searchTerm) ||
      r.description?.toLowerCase().includes(searchTerm) ||
      r.date?.includes(searchTerm)
    );
  }

  const rows = filtered.map(r => {
    const ptsRedeemed = parseNum(r.points_redeemed);
    const vpp = ptsRedeemed > 0 ? parseNum(r.value_amount) / ptsRedeemed : 0;
    return [
      formatDate(r.date),
      r.partner,
      r.description || '—',
      gridHtml(numCell(parseNum(r.points_redeemed).toLocaleString('en-IN'), { tone: 'danger', bold: true })),
      gridHtml(numCell(formatINRFull(parseNum(r.value_amount)), { bold: true })),
      gridHtml(numCell('₹' + vpp.toFixed(3), { tone: 'success' })),
      gridHtml(rowActions(`window.__ptRdEdit('${r.id}')`, `window.__ptRdDelete('${r.id}')`, 'redemption')),
    ];
  });

  rdTableGrid = new Grid({
    columns: [
      { name: 'Date' },
      { name: 'Partner' },
      { name: 'Description' },
      { name: 'Points', attributes: NUMERIC_COL },
      { name: 'Value', attributes: NUMERIC_COL },
      { name: 'Value per point', attributes: NUMERIC_COL },
      { name: 'Actions', sort: false, attributes: ACTIONS_COL },
    ],
    data: rows,
    pagination: { limit: 10 },
    sort: true,
    language: { noRecordsFound: 'No redemptions yet. Log your first one!' },
  }).render(container);

  window.__ptRdEdit = (id) => {
    const r = redemptions.find(r => r.id === id);
    if (r) openForm(r, 'redemption');
  };
  window.__ptRdDelete = async (id) => {
    if (!confirm('Delete this redemption?')) return;
    const { error } = await supabase.from('cc_redemptions').delete().eq('id', id);
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
    showToast('Redemption deleted.');
    await loadData();
  };
}

// ── Form Modal ───────────────────────────────────────────
function openForm(data, type) {
  editingId = data?.id || null;
  editingType = type;

  const isTransaction = type === 'transaction';
  // Sentence case, and the same noun the submit button uses — the dialog said
  // "Add Transaction" over a button that said "Add transaction".
  const noun = isTransaction ? 'transaction' : 'redemption';
  const title = data ? `Edit ${noun}` : `Add ${noun}`;

  const transactionForm = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Date</label>
        <input type="date" class="form-input" id="pt-f-date" value="${escapeHTML(data?.date || todayISO())}" ${data?.event_id ? 'disabled' : ''} />
        ${data?.event_id ? '<div class="form-hint">From the card alert</div>' : ''}
      </div>
      <div class="form-group">
        <label class="form-label">Multiplier</label>
        <select class="form-select" id="pt-f-multiplier">
          ${MULTIPLIER_OPTIONS.map(m => `
            <option value="${m.value}" ${(data?.multiplier || 2) == m.value ? 'selected' : ''}>
              ${m.label}
            </option>
          `).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="pt-f-merchant">Merchant</label>
      ${comboboxHTML({
        id: 'pt-f-merchant',
        value: data?.merchant || '',
        placeholder: 'Search or type a new one',
        options: usedBefore(t => t.merchant),
      })}
    </div>
    <div class="form-group">
      <label class="form-label" for="pt-f-desc">Description (optional)</label>
      ${data?.event_id ? '<div class="form-hint">Saved on the ledger event, so it shows in Life, search and summaries too.</div>' : ''}
      ${comboboxHTML({
        id: 'pt-f-desc',
        value: data?.description || '',
        placeholder: 'Search or type a new one',
        options: usedBefore(t => t.description),
      })}
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Amount (₹)</label>
        <input type="number" class="form-input" id="pt-f-amount" placeholder="0" min="0" step="0.01" value="${escapeHTML(data?.amount ?? '')}" ${data?.event_id ? 'disabled' : ''} />
        ${data?.event_id ? '<div class="form-hint">From the card alert</div>' : ''}
      </div>
      <div class="form-group">
        <label class="form-label">Points Override</label>
        <input type="number" class="form-input" id="pt-f-points" placeholder="Auto-calculated" min="0" value="${escapeHTML(data?.points ?? '')}" />
        <div class="form-hint">Leave blank to auto-calculate</div>
      </div>
    </div>
    ${data?.event_id && data?.raw_merchant ? `
      <label class="pt-check"><input type="checkbox" id="pt-f-remember" ${data.basis === 'assumed' ? 'checked' : ''} />
        <span>Remember this label and multiplier for <strong>${escapeHTML(data.raw_merchant)}</strong></span></label>` : ''}
    <!-- Preview -->
    <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:0.85rem 1rem;border:1px solid var(--border);font-size:0.85rem">
      <span style="color:var(--text-muted)">Auto-calculated points: </span>
      <span id="pt-preview-pts" style="color:var(--success);font-weight:700">0 pts</span>
    </div>
  `;

  const redemptionForm = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Date</label>
        <input type="date" class="form-input" id="pt-f-date" value="${escapeHTML(data?.date || todayISO())}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="pt-f-partner">Partner</label>
        ${comboboxHTML({
          id: 'pt-f-partner',
          value: data?.partner || '',
          placeholder: 'Search or type a new one',
          // Partners you have actually transferred to first, then the rest of
          // the card's list. The old select carried an "Other" option purely
          // because it could not hold a name it had not been given; a field
          // that takes any name has no use for it.
          options: [...new Set([
            ...usedBefore(r => r.partner, redemptions),
            ...REDEMPTION_PARTNERS,
          ])],
        })}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description (optional)</label>
      <input type="text" class="form-input" id="pt-f-desc" placeholder="e.g. Flight to NYC, Hotel in Bali" value="${escapeHTML(data?.description || '')}" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Points Redeemed</label>
        <input type="number" class="form-input" id="pt-f-pts-rd" placeholder="0" min="0" value="${escapeHTML(data?.points_redeemed ?? '')}" />
      </div>
      <div class="form-group">
        <label class="form-label">Value Received (₹)</label>
        <input type="number" class="form-input" id="pt-f-val" placeholder="0" min="0" step="0.01" value="${escapeHTML(data?.value_amount ?? '')}" />
      </div>
    </div>
    <!-- VPP Preview -->
    <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:0.85rem 1rem;border:1px solid var(--border);font-size:0.85rem">
      <span style="color:var(--text-muted)">Value per point: </span>
      <span id="pt-preview-vpp" style="color:var(--success);font-weight:700">₹0.000</span>
    </div>
  `;

  openModal(`
    <div class="modal-header">
      <div class="modal-title">${escapeHTML(title)}</div>
      <button type="button" class="modal-close" id="pt-modal-close" aria-label="Close"><i class="fas fa-times" aria-hidden="true"></i></button>
    </div>
    <div class="modal-tabs">
      <button type="button" class="modal-tab ${isTransaction ? 'active' : ''}" id="modal-tab-tx" aria-pressed="${isTransaction}">
        <i class="fas fa-receipt" aria-hidden="true"></i>Transaction
      </button>
      <button type="button" class="modal-tab ${!isTransaction ? 'active' : ''}" id="modal-tab-rd" aria-pressed="${!isTransaction}">
        <i class="fas fa-plane" aria-hidden="true"></i>Redemption
      </button>
    </div>
    <div class="modal-body" id="pt-form-body">
      ${isTransaction ? transactionForm : redemptionForm}
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" id="pt-form-cancel">Cancel</button>
      <button class="btn-submit" id="pt-form-submit">${data ? 'Save changes' : `Add ${isTransaction ? 'transaction' : 'redemption'}`}</button>
    </div>
  `);

  // Close handlers
  document.getElementById('pt-modal-close').addEventListener('click', closeModal);
  document.getElementById('pt-form-cancel').addEventListener('click', closeModal);

  // Tab switching inside modal (only for new entries)
  if (!data) {
    document.getElementById('modal-tab-tx').addEventListener('click', () => {
      editingType = 'transaction';
      document.getElementById('modal-tab-tx').classList.add('active');
      document.getElementById('modal-tab-rd').classList.remove('active');
      document.getElementById('pt-form-body').innerHTML = transactionForm;
      document.getElementById('pt-form-submit').textContent = 'Add transaction';
      attachTxPreview();
    });
    document.getElementById('modal-tab-rd').addEventListener('click', () => {
      editingType = 'redemption';
      document.getElementById('modal-tab-rd').classList.add('active');
      document.getElementById('modal-tab-tx').classList.remove('active');
      document.getElementById('pt-form-body').innerHTML = redemptionForm;
      document.getElementById('pt-form-submit').textContent = 'Add redemption';
      attachRdPreview();
    });
  }

  // Live previews
  if (isTransaction) attachTxPreview();
  else attachRdPreview();

  document.getElementById('pt-form-submit').addEventListener('click', submitForm);
}

/**
 * What you have put in this field before, most-used first.
 *
 * Frequency rather than alphabetical: this is a field you fill in daily, and
 * the answer is usually one of the three you gave last week. Alphabetical puts
 * Zomato last on a list you scroll.
 */
function usedBefore(pick, rows = transactions) {
  const counts = new Map();
  for (const transaction of rows) {
    const value = String(pick(transaction) ?? '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}

function attachTxPreview() {
  // Both the first render and a tab switch land here, which is what makes this
  // the right place to wire the comboboxes: the tab switch replaces the form's
  // markup wholesale, so the old listeners go with it.
  wireCombobox('pt-f-merchant');
  wireCombobox('pt-f-desc');

  const updatePreview = () => {
    const amount = parseNum(document.getElementById('pt-f-amount')?.value);
    const multiplier = parseNum(document.getElementById('pt-f-multiplier')?.value);
    const pts = amount * multiplier / 100;
    const el = document.getElementById('pt-preview-pts');
    if (el) el.textContent = Math.round(pts).toLocaleString('en-IN') + ' pts';
  };
  document.getElementById('pt-f-amount')?.addEventListener('input', updatePreview);
  document.getElementById('pt-f-multiplier')?.addEventListener('change', updatePreview);
  updatePreview();
}

function attachRdPreview() {
  wireCombobox('pt-f-partner');

  const updateVPP = () => {
    const pts = parseNum(document.getElementById('pt-f-pts-rd')?.value);
    const val = parseNum(document.getElementById('pt-f-val')?.value);
    const vpp = pts > 0 ? val / pts : 0;
    const el = document.getElementById('pt-preview-vpp');
    if (el) el.textContent = '₹' + vpp.toFixed(3) + '/pt';
  };
  document.getElementById('pt-f-pts-rd')?.addEventListener('input', updateVPP);
  document.getElementById('pt-f-val')?.addEventListener('input', updateVPP);
  updateVPP();
}

async function submitForm() {
  const btn = document.getElementById('pt-form-submit');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  let error;

  if (editingType === 'transaction') {
    const ptsOverride = document.getElementById('pt-f-points')?.value;
    const payload = {
      date:        document.getElementById('pt-f-date')?.value,
      merchant:    document.getElementById('pt-f-merchant')?.value.trim(),
      description: document.getElementById('pt-f-desc')?.value.trim() || null,
      amount:      parseNum(document.getElementById('pt-f-amount')?.value),
      multiplier:  parseNum(document.getElementById('pt-f-multiplier')?.value),
      points:      ptsOverride !== '' && ptsOverride !== undefined ? parseNum(ptsOverride) : null,
      user_id:     await getCurrentUserId(),
    };

    if (!payload.date || !payload.merchant) {
      showToast('Please fill in Date and Merchant.', 'error');
      btn.disabled = false; btn.textContent = 'Add transaction'; return;
    }
    if (editingId) payload.id = editingId;

    const current = editingId ? transactions.find(t => t.id === editingId) : null;
    if (current?.event_id) {
      // Linked to a card alert: the date and amount are the bank's and are not
      // written, and the note is written through to the event, which is where
      // it lives. Any save confirms an assumed row — editing it is looking at it.
      ({ error } = await supabase.rpc('cc_confirm', {
        p_id: editingId, p_label: payload.merchant, p_multiplier: payload.multiplier,
        p_points: payload.points, p_remember: Boolean(document.getElementById('pt-f-remember')?.checked),
        p_description: payload.description ?? '',
      }));
      // cc_confirm keeps an existing points override when given null, so
      // clearing the override has to be said separately.
      if (!error && payload.points === null && current.points !== null) {
        ({ error } = await supabase.from('cc_transactions').update({ points: null }).eq('id', editingId));
      }
    } else {
      ({ error } = await supabase.from('cc_transactions').upsert([payload]));
    }
  } else {
    const payload = {
      date:            document.getElementById('pt-f-date')?.value,
      partner:         document.getElementById('pt-f-partner')?.value.trim(),
      description:     document.getElementById('pt-f-desc')?.value.trim() || null,
      points_redeemed: parseNum(document.getElementById('pt-f-pts-rd')?.value),
      value_amount:    parseNum(document.getElementById('pt-f-val')?.value),
      currency:        'INR',
      user_id:         await getCurrentUserId(),
    };

    // The partner used to be a dropdown, which always had a value. A field you
    // can type into can also be left empty.
    if (!payload.date || !payload.partner || !payload.points_redeemed) {
      showToast('Please fill in Date, Partner and Points Redeemed.', 'error');
      btn.disabled = false; btn.textContent = 'Add redemption'; return;
    }
    if (editingId) payload.id = editingId;

    ({ error } = await supabase.from('cc_redemptions').upsert([payload]));
  }

  if (error) {
    showToast('Save failed: ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = editingId ? 'Save changes' : `Add ${editingType}`;
    return;
  }

  closeModal();
  showToast(editingId ? 'Saved!' : `${editingType === 'transaction' ? 'Transaction' : 'Redemption'} added!`);
  await loadData();
}

// ── Export ───────────────────────────────────────────────
function exportCSV() {
  if (activeTab === 'transactions') {
    const headers = ['Date','Merchant','Description','Amount (₹)','Multiplier','Points'];
    const rows = transactions.map(t => [t.date, t.merchant, t.description||'', t.amount, t.multiplier+'x', calcPoints(t).toFixed(0)]);
    downloadCSV(headers, rows, `cc_transactions_${todayISO()}.csv`);
  } else {
    const headers = ['Date','Partner','Description','Points Redeemed','Value (₹)','Value/pt (₹)'];
    const rows = redemptions.map(r => {
      const ptsRedeemed = parseNum(r.points_redeemed);
      const vpp = ptsRedeemed > 0 ? (parseNum(r.value_amount) / ptsRedeemed).toFixed(3) : '0';
      return [r.date, r.partner, r.description||'', r.points_redeemed, r.value_amount, vpp];
    });
    downloadCSV(headers, rows, `cc_redemptions_${todayISO()}.csv`);
  }
  showToast('CSV exported!');
}
