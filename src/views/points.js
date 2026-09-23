import { Chart, gridHtml } from '../vendor.js';
import { getCurrentUserId } from '../supabase.js';
import * as api from '../points/api.js';
import { EUR_INR_FALLBACK, MULTIPLIER_OPTIONS, REDEMPTION_PARTNERS } from '../constants.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, formatDate, todayISO,
  destroyChart, downloadCSV, escapeHTML, cssVar,
  openModal, closeModal, showToast, parseNum, fetchEURtoINR, CHART_COLORS, renderKpiCards,
  numCell, rowActions, callAttrs, comboboxHTML, wireCombobox, buildGrid, withBusy,
} from '../utils.js';
import { wireChartToggle, withAlpha, monthAxis, GRID_LINE } from '../charts.js';
import { calcPoints, pointsSummary } from '../points-math.js';

let transactions = [];
let redemptions = [];
let eurRate = EUR_INR_FALLBACK;
let pointsChartRef = null;
let merchantChartRef = null;
let txTableGrid = null;
let rdTableGrid = null;
let activeTab = 'transactions';

// One grammar for every note, shown in the box itself so it never has to be
// remembered. Notes live on ledger events now, so a consistent shape is what
// lets a question like "flights for one person this year" find all of them:
//   Type: detail | who | when
// `who` and `when` are optional, and only there when they add something.
const NOTE_PLACEHOLDER = 'Type: detail | who | when   e.g. Flight: BLR x CCU | Asha | Apr';
// Rows now arrive from the ledger as well as from this form (0012_card_points.sql):
// `rules` maps the bank's merchant names to your labels, and `reconcile` is what
// never paired — typed rows with no bank alert, and alerts with no row.
let rules = [];
let reconcile = { to_match: [], no_alert_found: [], events_without_row: [], settled: {} };
// Reconcile actions change the transactions underneath without redrawing them:
// redrawing is what threw you back to the top of the page after every click.
// The rest of the screen catches up when you leave the tab.
let pointsDirty = false;
let filterBasis = '';
let rulesGrid = null;
let activeChartType = 'bar';
let editingId = null;
let editingType = null;
let searchTerm = '';
let filterMultiplier = '';
let filterPartner = '';
let filterMerchant = '';
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;

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
      <div class="page-actions">
        <span id="fx-rate-badge" class="badge badge-blue">
          <i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>
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
              <i class="fas fa-receipt" aria-hidden="true"></i>Transactions
            </button>
            <button type="button" class="table-tab" id="tab-redemptions">
              <i class="fas fa-plane-departure" aria-hidden="true"></i>Redemptions
            </button>
            <button type="button" class="table-tab" id="tab-rules">
              <i class="fas fa-tags" aria-hidden="true"></i>Rules
            </button>
            <button type="button" class="table-tab" id="tab-reconcile">
              <i class="fas fa-code-compare" aria-hidden="true"></i>Reconcile
            </button>
          </div>
          <div class="table-actions">
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
          <div id="pt-redemptions-table" hidden></div>
          <div id="pt-rules-table" hidden></div>
          <div id="pt-reconcile-table" hidden></div>
        </div>
      </div>
    </div>

    <!-- FAB -->
    <button type="button" class="fab" id="pt-fab" title="Add transaction / redemption" aria-label="Add transaction or redemption">
      <i class="fas fa-plus"></i>
    </button>
  `;

  wireChartToggle('pt-line-btn', 'pt-bar-btn', type => {
    activeChartType = type;
    buildAccumulationChart(transactions, type);
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

export { renderPoints as render };

/** Release the grids and charts before the router replaces the DOM. */
export function unmount() {
  loadToken++;
  pointsChartRef = destroyChart(pointsChartRef);
  merchantChartRef = destroyChart(merchantChartRef);
  for (const grid of [txTableGrid, rdTableGrid, rulesGrid]) {
    if (grid) { try { grid.destroy(); } catch (_) {} }
  }
  txTableGrid = rdTableGrid = rulesGrid = null;
}

/** Where the page is scrolled to, so a redraw can put it back. */
function scrollState() {
  const main = document.getElementById('main-content');
  return { win: window.scrollY, main: main ? main.scrollTop : 0 };
}
function restoreScroll(state) {
  const main = document.getElementById('main-content');
  window.scrollTo(0, state.win);
  if (main) main.scrollTop = state.main;
}

async function loadData() {
  const token = ++loadToken;
  const place = scrollState();
  // Pick up any spend on the card the ledger has seen since the last visit.
  // Idempotent and cheap; a failure here must not stop the page loading.
  await api.syncFromEvents().catch(() => {});

  // cc_points is cc_transactions as it should be read: for a row linked to a
  // ledger event, the date and amount are the bank's, not a typed copy.
  // Rules and the reconcile lists are optional — the page stands without them.
  let tx, rd, rate, ruleRows, recon;
  try {
    [tx, rd, rate, ruleRows, recon] = await Promise.all([
      api.listTransactions(),
      api.listRedemptions(),
      fetchEURtoINR(EUR_INR_FALLBACK),
      api.listRules().catch(() => []),
      api.reconcile().catch(() => ({})),
    ]);
  } catch (err) {
    if (token === loadToken) showToast('Failed to load data: ' + err.message, 'error');
    return;
  }
  if (token !== loadToken || !document.getElementById('pt-kpi-grid')) return;

  transactions = tx || [];
  redemptions  = rd || [];
  eurRate = rate;
  rules = ruleRows || [];
  reconcile = { to_match: [], no_alert_found: [], events_without_row: [], settled: {}, ...(recon || {}) };
  pointsDirty = false;

  // Update FX badge
  const badge = document.getElementById('fx-rate-badge');
  if (badge) badge.innerHTML = `<i class="fas fa-euro-sign" aria-hidden="true"></i> 1 EUR = ₹${rate.toFixed(2)}`;

  renderKPIs();
  buildAccumulationChart(transactions, activeChartType);
  buildMerchantChart(transactions);
  renderTableFilters();
  renderTxTable();
  renderRdTable();
  renderRulesTable();
  renderReconcile();
  renderSyncBanner();
  // Grid.js renders on the next frame; put the page back after it has.
  requestAnimationFrame(() => restoreScroll(place));
}

// ── What the ledger added, and what never paired ───────

function renderSyncBanner() {
  const el = document.getElementById('pt-sync-banner');
  if (!el) return;
  const assumed = transactions.filter(t => t.basis === 'assumed').length;
  const loose = reconcile.to_match.length + reconcile.events_without_row.length;
  if (!assumed && !loose) { el.innerHTML = ''; return; }

  const parts = [];
  if (assumed) {
    parts.push(`<span><strong>${assumed}</strong> ${assumed === 1 ? 'row was' : 'rows were'} added from your card alerts with an assumed label and multiplier.</span>
      <button type="button" class="btn-sm btn-accent" id="pt-show-assumed">${filterBasis === 'assumed' ? 'Show all' : 'Review'}</button>`);
  }
  if (loose) {
    parts.push(`<span><strong>${reconcile.to_match.length}</strong> typed ${reconcile.to_match.length === 1 ? 'row looks' : 'rows look'} like a card alert that is waiting, and
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

  const {
    totalAccrued, totalRedeemed, balance, balanceEUR, balanceINR,
    totalSpent, totalRdValue, rewardRate, avgVPP,
  } = pointsSummary(transactions, redemptions, { pointsPerEur: POINTS_PER_EUR, eurRate });

  // Month accrual
  const thisMonth = todayISO().slice(0, 7);  // local month, not UTC
  const monthPts = transactions
    .filter(t => t.date?.slice(0,7) === thisMonth)
    .reduce((s, t) => s + calcPoints(t), 0);

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
        backgroundColor: withAlpha(CHART_COLORS.purple, type === 'bar' ? 0.5 : 0.15),
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
        x: monthAxis(),
        y: {
          grid: { color: GRID_LINE },
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
      <select id="pt-multiplier-filter" class="form-select toolbar-select" aria-label="Filter by multiplier">
        <option value="">All Multipliers</option>
        ${multipliers.map(m => `<option value="${escapeHTML(m)}" ${filterMultiplier === String(m) ? 'selected' : ''}>${escapeHTML(m)}×</option>`).join('')}
      </select>
      <select id="pt-merchant-filter" class="form-select toolbar-select" aria-label="Filter by merchant">
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
      <select id="pt-partner-filter" class="form-select toolbar-select" aria-label="Filter by transfer partner">
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
  const leavingReconcile = activeTab === 'reconcile' && tab !== 'reconcile';
  activeTab = tab;
  for (const name of ['transactions', 'redemptions', 'rules', 'reconcile']) {
    document.getElementById(`tab-${name}`).classList.toggle('active', tab === name);
    document.getElementById(`pt-${name}-table`).hidden = tab !== name;
  }
  // Rules and Reconcile have nothing to export; say so on the button rather
  // than silently handing over a different tab's rows.
  const exportBtn = document.getElementById('pt-export-btn');
  if (exportBtn) {
    const exportable = tab === 'transactions' || tab === 'redemptions';
    exportBtn.disabled = !exportable;
    exportBtn.title = exportable ? `Export the ${tab} shown, with the current filters` : 'Nothing to export on this tab';
  }
  renderTableFilters();
  if (leavingReconcile && pointsDirty) loadData();
}

/** The transactions the table shows, under every active filter. */
function filteredTransactions() {
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
  return filtered;
}

/** The redemptions the table shows, under every active filter. */
function filteredRedemptions() {
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
  return filtered;
}

function renderTxTable() {
  const container = document.getElementById('pt-transactions-table');
  if (!container) return;
  // Redrawing must not send you back to page one.
  const currentPage = Math.max(0, (parseInt(container.querySelector('.gridjs-pages .gridjs-currentPage')?.textContent, 10) || 1) - 1);

  const rows = filteredTransactions().map(t => {
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

  txTableGrid = buildGrid(container, txTableGrid, [
    { name: 'Date' },
    { name: 'Merchant' },
    { name: 'Description' },
    { name: 'Amount', numeric: true },
    { name: 'Multiplier' },
    { name: 'Points', numeric: true },
    { name: 'Actions', actions: true },
  ], rows, { limit: 10, page: currentPage, empty: 'No transactions yet. Add one with the + button!' });

  window.__ptTxEdit = (id) => {
    const t = transactions.find(t => t.id === id);
    if (t) openForm(t, 'transaction');
  };
  window.__ptTxConfirm = async (id) => {
    try {
      await api.confirmTransaction(id);
    } catch (err) {
      showToast('Could not confirm: ' + err.message, 'error');
      return;
    }
    // Nothing about the numbers changed, so nothing else needs redrawing.
    const row = transactions.find(t => t.id === id);
    if (row) row.basis = 'confirmed';
    const place = scrollState();
    renderTxTable();
    renderSyncBanner();
    requestAnimationFrame(() => restoreScroll(place));
    showToast('Confirmed.');
  };
  window.__ptTxDelete = async (id) => {
    if (!confirm('Delete this transaction?')) return;
    try {
      await api.deleteTransaction(id);
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
      return;
    }
    showToast('Transaction deleted.');
    await loadData();
  };
}

/** The label, with where the row came from and whether anyone has looked at it. */
function merchantCell(t) {
  const bits = [escapeHTML(t.merchant || '—')];
  if (t.basis === 'assumed') bits.push('<span class="badge badge-yellow" title="Added from a card alert. The label and multiplier are assumed from earlier spends at this merchant.">Assumed</span>');
  if (t.is_work) bits.push('<span class="badge badge-blue" title="Work spend: kept out of your personal spending">Work</span>');
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

  const shown = searchTerm
    ? rules.filter(r => r.ledger_merchant?.toLowerCase().includes(searchTerm) || r.label?.toLowerCase().includes(searchTerm))
    : rules;

  rulesGrid = buildGrid(container, rulesGrid, [
    { name: 'On the card alert' },
    { name: 'Your label' },
    { name: 'Multiplier' },
    { name: 'Seen', numeric: true },
    { name: 'Rule' },
    { name: 'Actions', actions: true },
  ], shown.map(r => [
      r.ledger_merchant,
      gridHtml(`${escapeHTML(r.label)}${r.is_work ? ' <span class="badge badge-blue">Work</span>' : ''}`),
      gridHtml(`<span class="badge ${getMultiplierBadgeClass(r.multiplier)}">${escapeHTML(r.multiplier)}×</span>`),
      gridHtml(numCell(String(r.uses))),
      gridHtml(r.source === 'manual'
        ? '<span class="badge badge-green">Yours</span>'
        : r.ambiguous
          ? '<span class="badge badge-yellow" title="You have filed this merchant under more than one label. The rule uses the most common one.">Learned · mixed</span>'
          : '<span class="badge">Learned</span>'),
      gridHtml(rowActions(`window.__ptRuleEdit('${encodeURIComponent(r.merchant_key)}')`, `window.__ptRuleDelete('${encodeURIComponent(r.merchant_key)}')`, 'rule')),
    ]), { limit: 12, empty: 'No rules yet. They are learned from rows linked to a card alert.' });

  window.__ptRuleEdit = (key) => {
    const rule = rules.find(r => r.merchant_key === decodeURIComponent(key));
    if (rule) openRuleForm(rule);
  };
  window.__ptRuleDelete = async (key) => {
    if (!confirm('Delete this rule? New spends at this merchant will arrive under the bank\'s own name at 2×.')) return;
    try {
      await api.deleteRule(decodeURIComponent(key));
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
      return;
    }
    showToast('Rule deleted.');
    await loadData();
  };
}

function openRuleForm(rule) {
  openModal({
    title: `Rule for ${rule.ledger_merchant}`,
    body: `
      <div class="form-group">
        <label class="form-label" for="pt-r-label">File it under</label>
        ${comboboxHTML({ id: 'pt-r-label', value: rule.label, placeholder: 'Search or type a new one', options: usedBefore(t => t.merchant) })}
      </div>
      <div class="form-group">
        <label class="form-label" for="pt-r-multiplier">Multiplier</label>
        <select class="form-select" id="pt-r-multiplier">
          ${MULTIPLIER_OPTIONS.map(m => `<option value="${m.value}" ${rule.multiplier == m.value ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <label class="pt-check"><input type="checkbox" id="pt-r-work" ${rule.is_work ? 'checked' : ''} />
        <span>Spends here are work <span class="pt-check-hint">tick only if nearly all of them are; you can always tick one row</span></span></label>
      <label class="pt-check"><input type="checkbox" id="pt-r-apply" checked />
        <span>Also apply to rows at this merchant that are still assumed</span></label>`,
    footer: `
      <button type="button" class="btn-cancel" data-close>Cancel</button>
      <button type="button" class="btn-submit" id="pt-rule-submit">Save rule</button>`,
  });
  wireCombobox('pt-r-label');
  document.getElementById('pt-rule-submit').addEventListener('click', async () => {
    const label = document.getElementById('pt-r-label').value.trim();
    const multiplier = parseNum(document.getElementById('pt-r-multiplier').value);
    const isWork = Boolean(document.getElementById('pt-r-work').checked);
    if (!label) { showToast('A rule needs a label.', 'error'); return; }

    await withBusy(document.getElementById('pt-rule-submit'), 'Saving…', async () => {
      try {
        await api.updateRule(rule.merchant_key, {
          label, multiplier, is_work: isWork, source: 'manual', ambiguous: false, updated_at: new Date().toISOString(),
        });

        if (document.getElementById('pt-r-apply').checked) {
          const waiting = transactions
            .filter(t => t.basis === 'assumed' && t.raw_merchant
              && t.raw_merchant.toLowerCase() === rule.ledger_merchant.toLowerCase())
            .map(t => t.id);
          // One update for every waiting row. Applying a rule you wrote is a
          // look at those rows, so they are confirmed — "any edit confirms".
          if (waiting.length) {
            await api.updateTransactions(waiting, { merchant: label, multiplier, is_work: isWork, basis: 'confirmed' });
          }
        }
      } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
        return;
      }
      closeModal();
      showToast('Rule saved.');
      await loadData();
    });
  });
}

// ── Reconcile ──────────────────────────────────────────
//
// Three short lists, each a different kind of decision, and every decision is
// remembered (0013_card_reconcile.sql) so a list can actually be emptied:
//
//   to match        a typed row that looks like a waiting card alert. Link it, or
//                   say it is not a match.
//   alerts, no row  a spend the ledger saw that was never entered. Add it, or
//                   ignore it (it earned nothing, or it is already inside a row
//                   that pools several spends).
//   nothing found   typed rows with no plausible alert. Nothing to do; collapsed,
//                   and acknowledged in one click.
//
// Plain DOM rather than Grid.js, on purpose: an action removes its own row and
// nothing else moves — no refetch, no redraw, no jump back to the top.

function renderReconcile() {
  const container = document.getElementById('pt-reconcile-table');
  if (!container) return;
  const money = v => escapeHTML(formatINRFull(parseNum(v)));

  const matchRows = reconcile.to_match.map(r => `
    <div class="pt-rc-row" data-row="${escapeHTML(r.id)}">
      <div class="pt-rc-what">
        <div class="pt-rc-title">${escapeHTML(r.label)} <span class="pt-rc-amount">${money(r.amount)}</span></div>
        <div class="pt-bank-name">${escapeHTML(formatDate(r.date))} · typed by you · ${escapeHTML(r.multiplier)}×</div>
      </div>
      <div class="pt-rc-arrow" aria-hidden="true"><i class="fas fa-arrow-right"></i></div>
      <div class="pt-rc-pick">
        <select class="form-select pt-rc-select" aria-label="Card alert to link to">
          ${r.candidates.map(c => `<option value="${escapeHTML(c.event_id)}">${escapeHTML(formatDate(c.date))} · ${escapeHTML(c.merchant || 'unnamed')} · ${money(c.amount)} · ${escapeHTML(c.why)}</option>`).join('')}
        </select>
      </div>
      <div class="pt-rc-actions">
        <button type="button" class="btn-sm btn-accent" ${callAttrs(`window.__ptLink('${r.id}')`)}>Link</button>
        <button type="button" class="btn-sm btn-ghost" ${callAttrs(`window.__ptNoMatch('${r.id}')`)} title="None of these is this row. Stop suggesting.">Not a match</button>
      </div>
    </div>`).join('');

  const eventRows = reconcile.events_without_row.map(e => `
    <div class="pt-rc-row" data-event="${escapeHTML(e.event_id)}">
      <div class="pt-rc-what">
        <div class="pt-rc-title">${escapeHTML(e.merchant || e.title || 'unnamed')} <span class="pt-rc-amount">${money(e.amount)}</span></div>
        <div class="pt-bank-name">${escapeHTML(formatDate(e.date))} · would be filed under ${escapeHTML(e.would_be_label || 'its own name')}</div>
      </div>
      <div class="pt-rc-actions">
        <button type="button" class="btn-sm btn-accent" ${callAttrs(`window.__ptCreate('${e.event_id}')`)}>Add row</button>
        <button type="button" class="btn-sm btn-ghost" ${callAttrs(`window.__ptIgnore('${e.event_id}')`)} title="Needs no row: it earned nothing, or it is already part of a row that pools several spends.">Ignore</button>
      </div>
    </div>`).join('');

  const fineRows = reconcile.no_alert_found.map(r => `
    <div class="pt-rc-row pt-rc-row--quiet" data-row="${escapeHTML(r.id)}">
      <div class="pt-rc-what">
        <div class="pt-rc-title">${escapeHTML(r.label)} <span class="pt-rc-amount">${money(r.amount)}</span></div>
        <div class="pt-bank-name">${escapeHTML(formatDate(r.date))}</div>
      </div>
    </div>`).join('');

  const settled = reconcile.settled || {};
  container.innerHTML = `
    <section class="pt-rc-section">
      <div class="pt-recon-head">Looks like a waiting card alert <span class="pt-recon-count" id="pt-rc-n-match">${reconcile.to_match.length}</span></div>
      <p class="pt-recon-note">You typed these, and a card alert nearby has the same label or a close amount. Linking keeps your label, multiplier and points and takes the amount and date from the bank. Pick a different alert from the list if the first guess is wrong.</p>
      <div class="pt-rc-list" id="pt-rc-match">${matchRows || '<p class="hl-empty">Nothing left to match.</p>'}</div>
    </section>

    <section class="pt-rc-section">
      <div class="pt-recon-head">Card alerts with no row <span class="pt-recon-count" id="pt-rc-n-events">${reconcile.events_without_row.length}</span></div>
      <p class="pt-recon-note">Spends on the card from before rows were created automatically. Add the ones you never entered. Ignore one that is already inside a row of yours that pools several spends, or it will be counted twice.</p>
      <div class="pt-rc-list" id="pt-rc-events">${eventRows || '<p class="hl-empty">Every spend on the card has a row.</p>'}</div>
    </section>

    <details class="pt-rc-section pt-rc-details" ${reconcile.no_alert_found.length ? '' : 'hidden'}>
      <summary class="pt-recon-head">No card alert found <span class="pt-recon-count" id="pt-rc-n-fine">${reconcile.no_alert_found.length}</span></summary>
      <p class="pt-recon-note">Rows you typed for which the ledger has no alert at all, usually because the email never came. They are fine as they are and need nothing from you.
        <button type="button" class="btn-sm btn-ghost" id="pt-rc-all-fine">Mark all as fine</button></p>
      <div class="pt-rc-list" id="pt-rc-fine">${fineRows}</div>
    </details>

    <p class="pt-recon-note pt-rc-settled">${(settled.rows_marked_fine || 0) + (settled.alerts_ignored || 0)
      ? `Already settled: ${settled.rows_marked_fine || 0} typed rows marked fine, ${settled.alerts_ignored || 0} alerts ignored.` : ''}</p>`;

  /** Take one row out of the page, and nothing else. */
  const removeRow = (selector, counterId, listKey, match) => {
    container.querySelector(selector)?.remove();
    reconcile[listKey] = reconcile[listKey].filter(item => !match(item));
    const counter = document.getElementById(counterId);
    if (counter) counter.textContent = String(reconcile[listKey].length);
    pointsDirty = true;
    renderSyncBanner();
  };
  /** An alert that has been used cannot be offered to another row. */
  const dropCandidate = (eventId) => {
    for (const row of [...reconcile.to_match]) {
      row.candidates = row.candidates.filter(c => c.event_id !== eventId);
      const el = container.querySelector(`[data-row="${CSS.escape(row.id)}"]`);
      el?.querySelector(`option[value="${CSS.escape(eventId)}"]`)?.remove();
      if (!row.candidates.length) removeRow(`[data-row="${CSS.escape(row.id)}"]`, 'pt-rc-n-match', 'to_match', r => r.id === row.id);
    }
  };
  const busy = (el, on) => el?.querySelectorAll('button, select').forEach(b => { b.disabled = on; });

  window.__ptLink = async (id) => {
    const el = container.querySelector(`[data-row="${CSS.escape(id)}"]`);
    const eventId = el?.querySelector('.pt-rc-select')?.value;
    if (!eventId) return;
    busy(el, true);
    try {
      await api.linkToEvent(id, eventId);
    } catch (err) {
      busy(el, false); showToast('Could not link: ' + err.message, 'error'); return;
    }
    removeRow(`[data-row="${CSS.escape(id)}"]`, 'pt-rc-n-match', 'to_match', r => r.id === id);
    removeRow(`[data-event="${CSS.escape(eventId)}"]`, 'pt-rc-n-events', 'events_without_row', e => e.event_id === eventId);
    dropCandidate(eventId);
    showToast('Linked. The bank\'s amount and date now apply.');
  };
  window.__ptNoMatch = async (id) => {
    const el = container.querySelector(`[data-row="${CSS.escape(id)}"]`);
    busy(el, true);
    try {
      await api.markNoAlert([id]);
    } catch (err) {
      busy(el, false); showToast('Could not save: ' + err.message, 'error'); return;
    }
    removeRow(`[data-row="${CSS.escape(id)}"]`, 'pt-rc-n-match', 'to_match', r => r.id === id);
  };
  window.__ptCreate = async (eventId) => {
    const el = container.querySelector(`[data-event="${CSS.escape(eventId)}"]`);
    busy(el, true);
    try {
      await api.createFromEvent(eventId);
    } catch (err) {
      busy(el, false); showToast('Could not add: ' + err.message, 'error'); return;
    }
    removeRow(`[data-event="${CSS.escape(eventId)}"]`, 'pt-rc-n-events', 'events_without_row', e => e.event_id === eventId);
    dropCandidate(eventId);
    showToast('Row added as assumed. Confirm it in Transactions.');
  };
  window.__ptIgnore = async (eventId) => {
    const el = container.querySelector(`[data-event="${CSS.escape(eventId)}"]`);
    busy(el, true);
    try {
      await api.ignoreEvents([eventId]);
    } catch (err) {
      busy(el, false); showToast('Could not save: ' + err.message, 'error'); return;
    }
    removeRow(`[data-event="${CSS.escape(eventId)}"]`, 'pt-rc-n-events', 'events_without_row', e => e.event_id === eventId);
    dropCandidate(eventId);
  };
  document.getElementById('pt-rc-all-fine')?.addEventListener('click', async (event) => {
    const ids = reconcile.no_alert_found.map(r => r.id);
    if (!ids.length) return;
    event.target.disabled = true;
    try {
      await api.markNoAlert(ids);
    } catch (err) {
      event.target.disabled = false; showToast('Could not save: ' + err.message, 'error'); return;
    }
    reconcile.no_alert_found = [];
    container.querySelector('.pt-rc-details')?.setAttribute('hidden', '');
    showToast(`${ids.length} rows marked as fine.`);
  });
}

function renderRdTable() {
  const container = document.getElementById('pt-redemptions-table');
  if (!container) return;

  const rows = filteredRedemptions().map(r => {
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

  rdTableGrid = buildGrid(container, rdTableGrid, [
    { name: 'Date' },
    { name: 'Partner' },
    { name: 'Description' },
    { name: 'Points', numeric: true },
    { name: 'Value', numeric: true },
    { name: 'Value per point', numeric: true },
    { name: 'Actions', actions: true },
  ], rows, { limit: 10, empty: 'No redemptions yet. Log your first one!' });

  window.__ptRdEdit = (id) => {
    const r = redemptions.find(r => r.id === id);
    if (r) openForm(r, 'redemption');
  };
  window.__ptRdDelete = async (id) => {
    if (!confirm('Delete this redemption?')) return;
    try {
      await api.deleteRedemption(id);
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
      return;
    }
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
        placeholder: NOTE_PLACEHOLDER,
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
    <label class="pt-check"><input type="checkbox" id="pt-f-work" ${data?.is_work ? 'checked' : ''} />
      <span>Work spend <span class="pt-check-hint">kept out of personal spending, whoever was paid</span></span></label>
    ${data?.event_id && data?.raw_merchant ? `
      <label class="pt-check"><input type="checkbox" id="pt-f-remember" ${data.basis === 'assumed' ? 'checked' : ''} />
        <span>Remember this label, multiplier and work setting for <strong>${escapeHTML(data.raw_merchant)}</strong></span></label>` : ''}
    <!-- Preview -->
    <div class="form-preview">
      <span class="form-preview-muted">Auto-calculated points: </span>
      <span id="pt-preview-pts" class="form-preview-value">0 pts</span>
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
    <div class="form-preview">
      <span class="form-preview-muted">Value per point: </span>
      <span id="pt-preview-vpp" class="form-preview-value">₹0.000</span>
    </div>
  `;

  openModal({
    title,
    tabs: `
      <div class="modal-tabs">
        <button type="button" class="modal-tab ${isTransaction ? 'active' : ''}" id="modal-tab-tx" aria-pressed="${isTransaction}">
          <i class="fas fa-receipt" aria-hidden="true"></i>Transaction
        </button>
        <button type="button" class="modal-tab ${!isTransaction ? 'active' : ''}" id="modal-tab-rd" aria-pressed="${!isTransaction}">
          <i class="fas fa-plane" aria-hidden="true"></i>Redemption
        </button>
      </div>`,
    body: isTransaction ? transactionForm : redemptionForm,
    footer: `
      <button type="button" class="btn-cancel" data-close>Cancel</button>
      <button type="button" class="btn-submit" id="pt-form-submit">${data ? 'Save changes' : `Add ${isTransaction ? 'transaction' : 'redemption'}`}</button>`,
  });

  // Tab switching inside modal (only for new entries)
  if (!data) {
    const body = document.querySelector('#modal-overlay .modal-body');
    document.getElementById('modal-tab-tx').addEventListener('click', () => {
      editingType = 'transaction';
      document.getElementById('modal-tab-tx').classList.add('active');
      document.getElementById('modal-tab-rd').classList.remove('active');
      body.innerHTML = transactionForm;
      document.getElementById('pt-form-submit').textContent = 'Add transaction';
      attachTxPreview();
    });
    document.getElementById('modal-tab-rd').addEventListener('click', () => {
      editingType = 'redemption';
      document.getElementById('modal-tab-rd').classList.add('active');
      document.getElementById('modal-tab-tx').classList.remove('active');
      body.innerHTML = redemptionForm;
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
  await withBusy(btn, 'Saving…', submitPayload);
}

/** Read the open form, validate it and write it. Runs inside withBusy. */
async function submitPayload() {
  if (editingType === 'transaction') {
    const ptsOverride = document.getElementById('pt-f-points')?.value;
    const payload = {
      date:        document.getElementById('pt-f-date')?.value,
      merchant:    document.getElementById('pt-f-merchant')?.value.trim(),
      description: document.getElementById('pt-f-desc')?.value.trim() || null,
      amount:      parseNum(document.getElementById('pt-f-amount')?.value),
      multiplier:  parseNum(document.getElementById('pt-f-multiplier')?.value),
      points:      ptsOverride !== '' && ptsOverride !== undefined ? parseNum(ptsOverride) : null,
      is_work:     Boolean(document.getElementById('pt-f-work')?.checked),
      user_id:     await getCurrentUserId(),
    };

    if (!payload.date || !payload.merchant) {
      showToast('Please fill in Date and Merchant.', 'error');
      return;
    }
    if (editingId) payload.id = editingId;

    const current = editingId ? transactions.find(t => t.id === editingId) : null;
    try {
      if (current?.event_id) {
        // Linked to a card alert: the date and amount are the bank's and are not
        // written, and the note is written through to the event, which is where
        // it lives. Any save confirms an assumed row — editing it is looking at it.
        await api.confirmTransaction(editingId, {
          p_label: payload.merchant, p_multiplier: payload.multiplier,
          p_points: payload.points, p_remember: Boolean(document.getElementById('pt-f-remember')?.checked),
          p_description: payload.description ?? '',
          p_is_work: payload.is_work,
        });
        // cc_confirm keeps an existing points override when given null, so
        // clearing the override has to be said separately.
        if (payload.points === null && current.points !== null) {
          await api.updateTransactions([editingId], { points: null });
        }
      } else {
        await api.upsertTransaction(payload);
      }
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
      return;
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
      return;
    }
    if (editingId) payload.id = editingId;

    try {
      await api.upsertRedemption(payload);
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
      return;
    }
  }

  closeModal();
  showToast(editingId ? 'Saved!' : `${editingType === 'transaction' ? 'Transaction' : 'Redemption'} added!`);
  await loadData();
}

// ── Export ───────────────────────────────────────────────
// What is on screen, under the filters that are on — not the whole table,
// and never a different tab's rows.
function exportCSV() {
  if (activeTab === 'transactions') {
    const rows = filteredTransactions();
    if (!rows.length) { showToast('No transactions to export.', 'error'); return; }
    downloadCSV(
      ['Date','Merchant','Description','Amount (₹)','Multiplier','Points','Basis','Work'],
      rows.map(t => [t.date, t.merchant, t.description||'', t.amount, t.multiplier+'x', calcPoints(t).toFixed(0), t.basis || '', t.is_work ? 'yes' : '']),
      `cc_transactions_${todayISO()}.csv`);
  } else if (activeTab === 'redemptions') {
    const rows = filteredRedemptions();
    if (!rows.length) { showToast('No redemptions to export.', 'error'); return; }
    downloadCSV(
      ['Date','Partner','Description','Points Redeemed','Value (₹)','Value/pt (₹)'],
      rows.map(r => {
        const ptsRedeemed = parseNum(r.points_redeemed);
        const vpp = ptsRedeemed > 0 ? (parseNum(r.value_amount) / ptsRedeemed).toFixed(3) : '0';
        return [r.date, r.partner, r.description||'', r.points_redeemed, r.value_amount, vpp];
      }),
      `cc_redemptions_${todayISO()}.csv`);
  } else {
    showToast('Nothing to export on this tab.', 'error');
    return;
  }
  showToast('CSV exported!');
}
