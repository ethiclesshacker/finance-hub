import { Chart, Grid, gridHtml } from '../vendor.js';
import { supabase, getCurrentUserId } from '../supabase.js';
import { EUR_INR_FALLBACK, MULTIPLIER_OPTIONS, REDEMPTION_PARTNERS } from '../constants.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, formatDate, todayISO,
  destroyChart, makeCopyable, downloadCSV, escapeHTML, cssVar,
  openModal, closeModal, showToast, parseNum, fetchEURtoINR, CHART_COLORS, renderKpiCards,
  numCell, rowActions, comboboxHTML, wireCombobox,
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

  // FAB
  document.getElementById('pt-fab').addEventListener('click', () => openForm(null, activeTab === 'transactions' ? 'transaction' : 'redemption'));

  // Export
  document.getElementById('pt-export-btn').addEventListener('click', exportCSV);

  // Refresh
  document.getElementById('pt-refresh-btn').addEventListener('click', loadData);

  // Search
  document.getElementById('pt-search').addEventListener('input', e => {
    searchTerm = e.target.value.toLowerCase();
    if (activeTab === 'transactions') renderTxTable();
    else renderRdTable();
  });

  await loadData();
}

async function loadData() {
  const [txRes, rdRes, rate] = await Promise.all([
    supabase.from('cc_transactions').select('*').order('date', { ascending: false }),
    supabase.from('cc_redemptions').select('*').order('date', { ascending: false }),
    fetchEURtoINR(EUR_INR_FALLBACK),
  ]);

  const failure = txRes.error || rdRes.error;
  if (failure) {
    showToast('Failed to load data: ' + failure.message, 'error');
    return;
  }

  transactions = txRes.data || [];
  redemptions  = rdRes.data || [];
  eurRate = rate;

  // Update FX badge
  const badge = document.getElementById('fx-rate-badge');
  if (badge) badge.innerHTML = `<i class="fas fa-euro-sign" style="font-size:0.6rem"></i> 1 EUR = ₹${rate.toFixed(2)}`;

  renderKPIs();
  buildAccumulationChart(transactions, activeChartType);
  buildMerchantChart(transactions);
  renderTableFilters();
  renderTxTable();
  renderRdTable();
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
  document.getElementById('tab-transactions').classList.toggle('active', tab === 'transactions');
  document.getElementById('tab-redemptions').classList.toggle('active', tab === 'redemptions');
  document.getElementById('pt-transactions-table').style.display = tab === 'transactions' ? '' : 'none';
  document.getElementById('pt-redemptions-table').style.display = tab === 'redemptions' ? '' : 'none';
  renderTableFilters();
}

function renderTxTable() {
  const container = document.getElementById('pt-transactions-table');
  if (!container) return;
  if (txTableGrid) { try { txTableGrid.destroy(); } catch(_) {} }

  let filtered = transactions;
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
      t.merchant,
      t.description || '—',
      gridHtml(numCell(formatINRFull(parseNum(t.amount)), { bold: true })),
      gridHtml(`<span class="badge ${getMultiplierBadgeClass(t.multiplier)}">${escapeHTML(t.multiplier)}×</span>`),
      gridHtml(numCell(Math.round(pts).toLocaleString('en-IN'), { tone: 'success', bold: true })),
      gridHtml(rowActions(`window.__ptTxEdit('${t.id}')`, `window.__ptTxDelete('${t.id}')`, 'transaction')),
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
  window.__ptTxDelete = async (id) => {
    if (!confirm('Delete this transaction?')) return;
    const { error } = await supabase.from('cc_transactions').delete().eq('id', id);
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
    showToast('Transaction deleted.');
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
        <input type="date" class="form-input" id="pt-f-date" value="${escapeHTML(data?.date || todayISO())}" />
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
        <input type="number" class="form-input" id="pt-f-amount" placeholder="0" min="0" step="0.01" value="${escapeHTML(data?.amount ?? '')}" />
      </div>
      <div class="form-group">
        <label class="form-label">Points Override</label>
        <input type="number" class="form-input" id="pt-f-points" placeholder="Auto-calculated" min="0" value="${escapeHTML(data?.points ?? '')}" />
        <div class="form-hint">Leave blank to auto-calculate</div>
      </div>
    </div>
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

    ({ error } = await supabase.from('cc_transactions').upsert([payload]));
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
