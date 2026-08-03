import { supabase, getCurrentUserId } from '../supabase.js';
import { POINTS_PER_EUR, EUR_INR_FALLBACK, MULTIPLIER_OPTIONS, REDEMPTION_PARTNERS, CC_MILESTONE_TARGET, CC_REWARD_TARGET_RATE } from '../constants.js';
import {
  formatINR, formatINRFull, formatPercent, formatDate, todayISO,
  applyChartDefaults, destroyChart, makeCopyable, downloadCSV,
  openModal, closeModal, showToast, parseNum, fetchEURtoINR, CHART_COLORS
} from '../utils.js';

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
        <button class="btn-sm btn-ghost" id="pt-export-btn">
          <i class="fas fa-download"></i> Export CSV
        </button>
      </div>
    </div>

    <div class="page-body">
      <!-- KPI Cards -->
      <div class="kpi-grid kpi-grid--3col" id="pt-kpi-grid">
        ${Array(6).fill(0).map(() => `
          <div class="kpi-card">
            <div class="skeleton" style="height:90px;border-radius:var(--radius-md)"></div>
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
              <button class="chart-toggle-btn" id="pt-line-btn">Line</button>
              <button class="chart-toggle-btn active" id="pt-bar-btn">Bar</button>
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
          <div class="chart-canvas-wrap" style="height:220px">
            <canvas id="pt-merchant-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Table section -->
      <div class="table-section">
        <div class="table-toolbar">
          <div class="table-tabs">
            <button class="table-tab active" id="tab-transactions">
              <i class="fas fa-receipt" style="margin-right:0.3rem"></i>Transactions
            </button>
            <button class="table-tab" id="tab-redemptions">
              <i class="fas fa-plane-departure" style="margin-right:0.3rem"></i>Redemptions
            </button>
          </div>
          <div class="table-actions" style="display:flex;gap:0.5rem;align-items:center">
            <div id="pt-dynamic-filter-container"></div>
            <div class="search-input-wrap">
              <i class="fas fa-search"></i>
              <input type="text" class="search-input" id="pt-search" placeholder="Search…" />
            </div>
            <button class="btn-icon" id="pt-refresh-btn" title="Refresh">
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
    <button class="fab" id="pt-fab" title="Add transaction / redemption">
      <i class="fas fa-plus"></i>
    </button>
  `;

  applyChartDefaults();

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
  const calcPoints = (t) => {
    if (t.points !== null && t.points !== undefined) return parseFloat(t.points);
    return parseFloat(t.amount) * parseFloat(t.multiplier) / 100;
  };

  const totalAccrued  = transactions.reduce((s, t) => s + calcPoints(t), 0);
  const totalRedeemed = redemptions.reduce((s, r) => s + parseFloat(r.points_redeemed || 0), 0);
  const balance = totalAccrued - totalRedeemed;
  const balanceEUR = balance / POINTS_PER_EUR;
  const balanceINR = balanceEUR * eurRate;

  const totalSpent = transactions.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
  const totalRdValue = redemptions.reduce((s, r) => s + parseFloat(r.value_amount || 0), 0);
  const rewardRate = totalSpent > 0 ? ((totalRdValue + balanceINR) / totalSpent) * 100 : 0;
  const avgVPP = totalRedeemed > 0 ? totalRdValue / totalRedeemed : 0;

  // Month accrual
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthPts = transactions
    .filter(t => t.date?.slice(0,7) === thisMonth)
    .reduce((s, t) => s + calcPoints(t), 0);

  // Top merchant
  const merchantSpend = {};
  transactions.forEach(t => {
    merchantSpend[t.merchant] = (merchantSpend[t.merchant] || 0) + parseFloat(t.amount || 0);
  });
  const topMerchant = Object.entries(merchantSpend).sort((a,b) => b[1]-a[1])[0];

  const milestone = CC_MILESTONE_TARGET;
  const progressPct = (totalSpent / milestone) * 100;
  const remaining = Math.max(milestone - totalSpent, 0);

  const kpis = [
    {
      id: 'pt-kpi-spent', label: 'Total Spent', icon: '🛒', color: 'var(--accent-glow)', iconBg: 'rgba(56,189,248,0.1)',
      value: formatINRFull(totalSpent), raw: totalSpent,
      progress: Math.min(progressPct, 100),
      sub: progressPct >= 100 ? 'Milestone achieved! 🎉' : `₹${Math.round(remaining).toLocaleString('en-IN')} to ₹${(CC_MILESTONE_TARGET/100000).toFixed(0)}L milestone`,
      tooltip: 'Lifetime total INR spend on the HSBC TravelOne card.',
    },
    {
      id: 'pt-kpi-balance', label: 'Points Balance', icon: '⭐', color: 'var(--warning-glow)', iconBg: 'rgba(245,158,11,0.1)',
      value: Math.round(balance).toLocaleString('en-IN') + ' pts', raw: Math.round(balance),
      sub: `Est. value: ${formatINRFull(balanceINR)}`,
      badge: { text: `${(balance / POINTS_PER_EUR).toFixed(0)} EUR`, type: 'neutral' },
      tooltip: `Accrued minus redeemed. Value = balance ÷ ${POINTS_PER_EUR} EUR × ₹${eurRate.toFixed(0)}/EUR`,
    },
    {
      id: 'pt-kpi-accrued', label: 'Total Accrued', icon: '⬆️', color: 'var(--success-glow)', iconBg: 'rgba(16,185,129,0.1)',
      value: Math.round(totalAccrued).toLocaleString('en-IN') + ' pts', raw: Math.round(totalAccrued),
      sub: `This month: ${Math.round(monthPts).toLocaleString('en-IN')} pts`,
      tooltip: 'All points ever earned on this card, including multiplier bonuses.',
    },
    {
      id: 'pt-kpi-redeemed', label: 'Total Redeemed', icon: '✈️', color: 'var(--purple-glow)', iconBg: 'rgba(167,139,250,0.1)',
      value: Math.round(totalRedeemed).toLocaleString('en-IN') + ' pts', raw: Math.round(totalRedeemed),
      sub: `Value realized: ${formatINRFull(totalRdValue)}`,
      tooltip: 'Total points burned across all redemptions. Sub-label = INR value you got back.',
    },
    {
      id: 'pt-kpi-balval', label: 'Balance Value', icon: '💶', color: 'var(--teal-glow)', iconBg: 'rgba(45,212,191,0.1)',
      value: formatINRFull(balanceINR), raw: balanceINR.toFixed(0),
      sub: `${balanceEUR.toFixed(1)} EUR @ ₹${eurRate.toFixed(0)}`,
      badge: { text: 'Live FX', type: 'neutral' },
      tooltip: `Balance ÷ ${POINTS_PER_EUR} EUR converted to INR at live EUR/INR rate.`,
    },
    {
      id: 'pt-kpi-rate', label: 'Reward Rate', icon: '📈', color: 'var(--pink-glow)', iconBg: 'rgba(244,114,182,0.1)',
      value: formatPercent(rewardRate), raw: rewardRate.toFixed(2),
      sub: `Avg value per point: ₹${avgVPP.toFixed(2)}`,
      badge: rewardRate > 0 ? { text: rewardRate >= CC_REWARD_TARGET_RATE ? `✓ >${CC_REWARD_TARGET_RATE}% target` : `Target: ${CC_REWARD_TARGET_RATE}%`, type: rewardRate >= CC_REWARD_TARGET_RATE ? 'positive' : 'neutral' } : null,
      tooltip: `(Redemption value + Balance INR) ÷ Total Spend × 100. Target > ${CC_REWARD_TARGET_RATE}%.`,
    },
  ];

  const grid = document.getElementById('pt-kpi-grid');
  if (!grid) return;

  grid.innerHTML = kpis.map(k => `
    <div class="kpi-card" id="${k.id}" style="--kpi-glow:${k.color}" title="${k.tooltip}">
      <div class="kpi-header">
        <span class="kpi-label">${k.label}</span>
        <div class="kpi-icon" style="background:${k.iconBg}">${k.icon}</div>
      </div>
      <div class="kpi-value mono">${k.value}</div>
      ${k.progress !== undefined ? `
        <div class="progress-wrap" style="margin:0.4rem 0">
          <div class="progress-bar" style="width:${k.progress}%"></div>
        </div>
      ` : ''}
      <div class="kpi-sub">
        ${k.badge ? `<span class="kpi-badge ${k.badge.type}">${k.badge.text}</span> ` : ''}
        ${k.sub}
      </div>
    </div>
  `).join('');

  kpis.forEach(k => {
    const el = document.getElementById(k.id);
    if (el) makeCopyable(el, k.raw);
  });
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
    const pts = t.points !== null && t.points !== undefined
      ? parseFloat(t.points)
      : parseFloat(t.amount) * parseFloat(t.multiplier) / 100;
    monthly[month] = (monthly[month] || 0) + pts;
  });

  const sortedMonths = Object.keys(monthly).sort();
  const labels = sortedMonths.map(m => m + '-01');
  const data   = sortedMonths.map(m => monthly[m]);

  pointsChartRef = new Chart(ctx, {
    type: type === 'line' ? 'line' : 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Points Earned',
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
    spend[t.merchant] = (spend[t.merchant] || 0) + parseFloat(t.amount || 0);
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
        borderColor: 'var(--bg-card)', borderWidth: 3, hoverOffset: 8,
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
      <select id="pt-multiplier-filter" class="form-input" style="padding:0.35rem 0.5rem;font-size:0.8rem;height:36px;width:130px;border-radius:var(--radius-sm)">
        <option value="">All Multipliers</option>
        ${multipliers.map(m => `<option value="${m}" ${filterMultiplier === String(m) ? 'selected' : ''}>${m}×</option>`).join('')}
      </select>
      <select id="pt-merchant-filter" class="form-input" style="padding:0.35rem 0.5rem;font-size:0.8rem;height:36px;width:140px;border-radius:var(--radius-sm);max-width:180px">
        <option value="">All Merchants</option>
        ${merchants.map(mer => `<option value="${mer}" ${filterMerchant === mer ? 'selected' : ''}>${mer}</option>`).join('')}
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
      <select id="pt-partner-filter" class="form-input" style="padding:0.35rem 0.5rem;font-size:0.8rem;height:36px;width:140px;border-radius:var(--radius-sm)">
        <option value="">All Partners</option>
        ${partners.map(p => `<option value="${p}" ${filterPartner === p ? 'selected' : ''}>${p}</option>`).join('')}
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

  const calcPoints = (t) => t.points !== null && t.points !== undefined
    ? parseFloat(t.points)
    : parseFloat(t.amount) * parseFloat(t.multiplier) / 100;

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
      gridjs.html(`<span style="font-weight:600">₹${parseFloat(t.amount||0).toLocaleString('en-IN')}</span>`),
      gridjs.html(`<span class="badge ${getMultiplierBadgeClass(t.multiplier)}">${t.multiplier}×</span>`),
      gridjs.html(`<span style="color:var(--success);font-weight:600">${Math.round(pts).toLocaleString('en-IN')} pts</span>`),
      gridjs.html(`
        <div style="display:flex;gap:0.35rem">
          <button class="btn-sm btn-accent" onclick="window.__ptTxEdit('${t.id}')">
            <i class="fas fa-pencil"></i>
          </button>
          <button class="btn-sm btn-danger" onclick="window.__ptTxDelete('${t.id}')">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      `),
    ];
  });

  txTableGrid = new gridjs.Grid({
    columns: ['Date','Merchant','Description','Amount','Multiplier','Points','Actions'],
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
    const vpp = parseFloat(r.points_redeemed || 1) > 0
      ? parseFloat(r.value_amount || 0) / parseFloat(r.points_redeemed)
      : 0;
    return [
      formatDate(r.date),
      r.partner,
      r.description || '—',
      gridjs.html(`<span style="color:var(--danger);font-weight:600">${parseFloat(r.points_redeemed||0).toLocaleString('en-IN')} pts</span>`),
      gridjs.html(`<span style="font-weight:600">₹${parseFloat(r.value_amount||0).toLocaleString('en-IN')}</span>`),
      gridjs.html(`<span style="color:var(--success)">₹${vpp.toFixed(3)}/pt</span>`),
      gridjs.html(`
        <div style="display:flex;gap:0.35rem">
          <button class="btn-sm btn-accent" onclick="window.__ptRdEdit('${r.id}')">
            <i class="fas fa-pencil"></i>
          </button>
          <button class="btn-sm btn-danger" onclick="window.__ptRdDelete('${r.id}')">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      `),
    ];
  });

  rdTableGrid = new gridjs.Grid({
    columns: ['Date','Partner','Description','Points','Value','Value/pt','Actions'],
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
  const title = data
    ? `Edit ${isTransaction ? 'Transaction' : 'Redemption'}`
    : `Add ${isTransaction ? 'Transaction' : 'Redemption'}`;

  const transactionForm = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Date</label>
        <input type="date" class="form-input" id="pt-f-date" value="${data?.date || todayISO()}" />
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
      <label class="form-label">Merchant</label>
      <input type="text" class="form-input" id="pt-f-merchant" placeholder="e.g. Swiggy, Amazon, Zara" value="${data?.merchant || ''}" />
    </div>
    <div class="form-group">
      <label class="form-label">Description (optional)</label>
      <input type="text" class="form-input" id="pt-f-desc" placeholder="Brief note" value="${data?.description || ''}" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Amount (₹)</label>
        <input type="number" class="form-input" id="pt-f-amount" placeholder="0" min="0" step="0.01" value="${data?.amount || ''}" />
      </div>
      <div class="form-group">
        <label class="form-label">Points Override</label>
        <input type="number" class="form-input" id="pt-f-points" placeholder="Auto-calculated" min="0" value="${data?.points ?? ''}" />
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
        <input type="date" class="form-input" id="pt-f-date" value="${data?.date || todayISO()}" />
      </div>
      <div class="form-group">
        <label class="form-label">Partner</label>
        <select class="form-select" id="pt-f-partner">
          ${REDEMPTION_PARTNERS.map(p => `
            <option value="${p}" ${data?.partner === p ? 'selected' : ''}>${p}</option>
          `).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description (optional)</label>
      <input type="text" class="form-input" id="pt-f-desc" placeholder="e.g. Flight to NYC, Hotel in Bali" value="${data?.description || ''}" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Points Redeemed</label>
        <input type="number" class="form-input" id="pt-f-pts-rd" placeholder="0" min="0" value="${data?.points_redeemed || ''}" />
      </div>
      <div class="form-group">
        <label class="form-label">Value Received (₹)</label>
        <input type="number" class="form-input" id="pt-f-val" placeholder="0" min="0" step="0.01" value="${data?.value_amount || ''}" />
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
      <div class="modal-title">${title}</div>
      <button class="modal-close" id="pt-modal-close"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-tabs">
      <div class="modal-tab ${isTransaction ? 'active' : ''}" id="modal-tab-tx" style="cursor:pointer">
        <i class="fas fa-receipt" style="margin-right:0.3rem"></i>Transaction
      </div>
      <div class="modal-tab ${!isTransaction ? 'active' : ''}" id="modal-tab-rd" style="cursor:pointer">
        <i class="fas fa-plane" style="margin-right:0.3rem"></i>Redemption
      </div>
    </div>
    <div class="modal-body" id="pt-form-body">
      ${isTransaction ? transactionForm : redemptionForm}
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" id="pt-form-cancel">Cancel</button>
      <button class="btn-submit" id="pt-form-submit">${data ? 'Save Changes' : `Add ${isTransaction ? 'Transaction' : 'Redemption'}`}</button>
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
      document.getElementById('pt-form-submit').textContent = 'Add Transaction';
      attachTxPreview();
    });
    document.getElementById('modal-tab-rd').addEventListener('click', () => {
      editingType = 'redemption';
      document.getElementById('modal-tab-rd').classList.add('active');
      document.getElementById('modal-tab-tx').classList.remove('active');
      document.getElementById('pt-form-body').innerHTML = redemptionForm;
      document.getElementById('pt-form-submit').textContent = 'Add Redemption';
      attachRdPreview();
    });
  }

  // Live previews
  if (isTransaction) attachTxPreview();
  else attachRdPreview();

  document.getElementById('pt-form-submit').addEventListener('click', submitForm);
}

function attachTxPreview() {
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
      btn.disabled = false; btn.textContent = 'Add Transaction'; return;
    }
    if (editingId) payload.id = editingId;

    ({ error } = await supabase.from('cc_transactions').upsert([payload]));
  } else {
    const payload = {
      date:            document.getElementById('pt-f-date')?.value,
      partner:         document.getElementById('pt-f-partner')?.value,
      description:     document.getElementById('pt-f-desc')?.value.trim() || null,
      points_redeemed: parseNum(document.getElementById('pt-f-pts-rd')?.value),
      value_amount:    parseNum(document.getElementById('pt-f-val')?.value),
      currency:        'INR',
      user_id:         await getCurrentUserId(),
    };

    if (!payload.date || !payload.points_redeemed) {
      showToast('Please fill in Date and Points Redeemed.', 'error');
      btn.disabled = false; btn.textContent = 'Add Redemption'; return;
    }
    if (editingId) payload.id = editingId;

    ({ error } = await supabase.from('cc_redemptions').upsert([payload]));
  }

  if (error) {
    showToast('Save failed: ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = editingId ? 'Save Changes' : `Add ${editingType}`;
    return;
  }

  closeModal();
  showToast(editingId ? 'Saved!' : `${editingType === 'transaction' ? 'Transaction' : 'Redemption'} added!`);
  await loadData();
}

// ── Export ───────────────────────────────────────────────
function exportCSV() {
  if (activeTab === 'transactions') {
    const calcPoints = (t) => t.points !== null && t.points !== undefined
      ? parseFloat(t.points)
      : parseFloat(t.amount) * parseFloat(t.multiplier) / 100;
    const headers = ['Date','Merchant','Description','Amount (₹)','Multiplier','Points'];
    const rows = transactions.map(t => [t.date, t.merchant, t.description||'', t.amount, t.multiplier+'x', calcPoints(t).toFixed(0)]);
    downloadCSV(headers, rows, `cc_transactions_${todayISO()}.csv`);
  } else {
    const headers = ['Date','Partner','Description','Points Redeemed','Value (₹)','Value/pt (₹)'];
    const rows = redemptions.map(r => {
      const vpp = parseFloat(r.points_redeemed||1) > 0 ? (parseFloat(r.value_amount||0)/parseFloat(r.points_redeemed)).toFixed(3) : '0';
      return [r.date, r.partner, r.description||'', r.points_redeemed, r.value_amount, vpp];
    });
    downloadCSV(headers, rows, `cc_redemptions_${todayISO()}.csv`);
  }
  showToast('CSV exported!');
}
