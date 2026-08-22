import { Chart, Grid, gridHtml } from '../vendor.js';
import { supabase, getCurrentUserId } from '../supabase.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, formatDate, todayISO,
  destroyChart, makeCopyable, downloadCSV, escapeHTML, cssVar,
  openModal, closeModal, showToast, parseNum, ASSET_COLORS, CHART_COLORS,
  computeNet, computeAssets, computeLiquid, computeEmergencyFund, renderKpiCards,
  numCell, rowActions,
} from '../utils.js';

// Applied to both the header and the body cells of a column, so a numeric
// column is right-aligned end to end.
// A data attribute, not a class: Grid.js writes `class` straight onto the
// cell, replacing the gridjs-th / gridjs-td classes it needs to stay styled.
const NUMERIC_COL = () => ({ 'data-align': 'end' });
const ACTIONS_COL = () => ({ 'data-align': 'end' });

let entries = [];
let netWorthChartRef = null;
let allocationChartRef = null;
let tableGrid = null;
let editingId = null;
let chartType = 'line';
let searchTerm = '';
let filterYear = '';

export async function renderNetWorth(container) {
  editingId = null;
  chartType = 'line';
  searchTerm = '';
  filterYear = '';

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Net Worth</h2>
        <p>Track your assets, liabilities, and financial independence progress</p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button type="button" class="btn-sm btn-ghost" id="nw-export-btn">
          <i class="fas fa-download"></i> Export CSV
        </button>
      </div>
    </div>

    <div class="page-body">
      <!-- KPI Cards -->
      <div class="kpi-grid kpi-grid--3col" id="nw-kpi-grid">
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
              <div class="chart-title">Wealth Accumulation</div>
              <div class="chart-subtitle">Net worth over time</div>
            </div>
            <div class="chart-toggle">
              <button type="button" class="chart-toggle-btn active" id="nw-line-btn">Line</button>
              <button type="button" class="chart-toggle-btn" id="nw-bar-btn">Bar</button>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="nw-accumulation-chart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <div>
              <div class="chart-title">Asset Distribution</div>
              <div class="chart-subtitle">Latest snapshot breakdown</div>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="nw-allocation-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- History Table -->
      <div class="table-section">
        <div class="table-toolbar">
          <div style="font-weight:700;font-size:0.9rem;color:var(--text-primary)">
            <i class="fas fa-clock-rotate-left" style="color:var(--accent);margin-right:0.4rem"></i>
            Historical Snapshots
          </div>
          <div class="table-actions" style="display:flex;gap:0.5rem;align-items:center">
            <select id="nw-year-filter" class="form-input" style="padding:0.35rem 0.5rem;font-size:0.8rem;height:36px;width:120px;border-radius:var(--radius-sm)">
              <option value="">All Years</option>
            </select>
            <div class="search-input-wrap">
              <i class="fas fa-search"></i>
              <input type="text" class="search-input" id="nw-search" placeholder="Search entries…" />
            </div>
            <button type="button" class="btn-icon" id="nw-refresh-btn" title="Refresh" aria-label="Refresh">
              <i class="fas fa-rotate-right"></i>
            </button>
          </div>
        </div>
        <div class="table-inner">
          <div id="nw-table-container"></div>
        </div>
      </div>
    </div>

    <!-- FAB -->
    <button type="button" class="fab" id="nw-fab" title="Add snapshot" aria-label="Add snapshot">
      <i class="fas fa-plus"></i>
    </button>
  `;

  // Chart toggles
  document.getElementById('nw-line-btn').addEventListener('click', () => {
    chartType = 'line';
    document.getElementById('nw-line-btn').classList.add('active');
    document.getElementById('nw-bar-btn').classList.remove('active');
    buildAccumulationChart(entries, 'line');
  });
  document.getElementById('nw-bar-btn').addEventListener('click', () => {
    chartType = 'bar';
    document.getElementById('nw-bar-btn').classList.add('active');
    document.getElementById('nw-line-btn').classList.remove('active');
    buildAccumulationChart(entries, 'bar');
  });

  // FAB
  document.getElementById('nw-fab').addEventListener('click', () => openEntryForm());

  // Export
  document.getElementById('nw-export-btn').addEventListener('click', exportCSV);

  // Refresh
  document.getElementById('nw-refresh-btn').addEventListener('click', loadData);

  // Search
  document.getElementById('nw-search').addEventListener('input', e => {
    searchTerm = e.target.value.toLowerCase();
    renderTable();
  });

  // Year filter
  document.getElementById('nw-year-filter')?.addEventListener('change', e => {
    filterYear = e.target.value;
    renderTable();
  });

  await loadData();
}

async function loadData() {
  const { data, error } = await supabase
    .from('net_worth_entries')
    .select('*')
    .order('date', { ascending: true });

  if (error) {
    showToast('Failed to load data: ' + error.message, 'error');
    return;
  }

  entries = data || [];
  renderKPIs();
  buildAccumulationChart(entries, chartType);
  buildAllocationChart(entries[entries.length - 1]);
  renderYearFilter();
  renderTable();
}

// ── KPI Cards ──────────────────────────────────────────
function renderKPIs() {
  const latest = entries[entries.length - 1];
  const prev = entries[entries.length - 2];

  const cur = {
    assets:      computeAssets(latest),
    liabilities: latest?.credit_cards || 0,
    net:         computeNet(latest),
    liquid:      computeLiquid(latest),
  };
  const prv = {
    assets:      computeAssets(prev),
    liabilities: prev?.credit_cards || 0,
    net:         computeNet(prev),
    liquid:      computeLiquid(prev),
  };

  const nwChange = prv.net !== 0 ? ((cur.net - prv.net) / Math.abs(prv.net)) * 100 : 0;
  const nwChangeLabel = prev
    ? `${nwChange >= 0 ? '↑' : '↓'} ${Math.abs(nwChange).toFixed(1)}% from last`
    : 'First snapshot';

  const monthlyExpenses = settings.get('monthly_expenses');
  const runwayTarget    = settings.get('emergency_runway_target');
  const solvencyTarget  = settings.get('solvency_target');
  const fiMultiplier    = settings.get('fi_multiplier');
  const fiTarget        = settings.fiTarget();
  const passiveYield    = settings.get('passive_income_yield') / 100;
  const emergencyFund   = computeEmergencyFund(latest, settings.get('emergency_fund_basis'));

  const solvency = cur.liabilities > 0 ? (cur.assets / cur.liabilities) : null;
  const passiveIncome = ((latest?.stocks || 0) + (latest?.mutual_funds || 0) + (latest?.fds || 0)) * passiveYield / 12;
  const runway = monthlyExpenses > 0 ? emergencyFund / monthlyExpenses : 0;
  const fiPct = fiTarget > 0 ? (cur.net / fiTarget) * 100 : 0;

  const expectedWealth = (settings.get('age') * settings.get('monthly_net_income') * 12) / settings.get('wealth_score_divisor');
  const wealthScore = expectedWealth > 0 ? (cur.net / expectedWealth).toFixed(2) : '—';
  // "PAW" and "UAW" are the book's terms, not the reader's. Say what they mean.
  const wealthLabel = parseFloat(wealthScore) >= 1 ? 'ahead for your age' : 'behind for your age';

  const kpis = [
    {
      id: 'kpi-nw', label: 'Net worth', icon: 'fa-chart-column', tone: 'accent', value: formatINRFull(cur.net), raw: cur.net,
      badge: { text: nwChange >= 0 ? `+${nwChange.toFixed(1)}%` : `${nwChange.toFixed(1)}%`, type: nwChange >= 0 ? 'positive' : 'negative' },
      sub: nwChangeLabel,
      tooltip: 'Total assets minus total liabilities at latest snapshot date.',
    },
    {
      id: 'kpi-assets', label: 'Total assets', icon: 'fa-building-columns', tone: 'success', value: formatINRFull(cur.assets), raw: cur.assets,
      sub: `Liquid: ${formatINR(cur.liquid)}`,
      tooltip: 'Sum of all asset classes in latest snapshot.',
    },
    {
      id: 'kpi-solvency', label: 'Solvency ratio', icon: 'fa-scale-balanced', tone: 'warning', value: solvency !== null ? solvency.toFixed(2) : 'No debt',
      unit: solvency !== null ? '×' : '',
      raw: solvency?.toFixed(2) ?? 0,
      sub: cur.liabilities > 0 ? `Liabilities: ${formatINR(cur.liabilities)}` : 'No liabilities recorded',
      badge: solvency !== null ? { text: solvency > solvencyTarget ? 'Strong' : 'Watch it', type: solvency > solvencyTarget ? 'positive' : 'neutral' } : { text: 'Debt-free', type: 'positive' },
      tooltip: `Assets ÷ Liabilities. Higher is better. > ${solvencyTarget}× is considered healthy.`,
    },
    {
      id: 'kpi-passive', label: 'Est. passive income', icon: 'fa-money-bill-wave', tone: 'purple', value: formatINR(passiveIncome), unit: '/mo', raw: passiveIncome.toFixed(0),
      sub: `At ${(passiveYield * 100).toFixed(0)}% annual yield on investables`,
      tooltip: `(Stocks + MFs + FDs) × ${(passiveYield * 100).toFixed(0)}% ÷ 12. Blended estimated monthly passive income.`,
    },
    {
      id: 'kpi-runway', label: 'Emergency runway', icon: 'fa-shield-halved', tone: runway >= runwayTarget ? 'success' : 'warning',
      value: runway.toFixed(1), unit: 'months', raw: runway.toFixed(1),
      badge: { text: runway >= runwayTarget ? 'Healthy' : 'Build up', type: runway >= runwayTarget ? 'positive' : 'neutral' },
      sub: `${settings.get('emergency_fund_basis') === 'cash_like' ? 'Cash + FDs' : 'Liquid'} ÷ ₹${(monthlyExpenses/1000).toFixed(0)}k/mo baseline`,
      tooltip: `Emergency fund ÷ monthly baseline expenses. Target: ≥ ${runwayTarget} months.`,
    },
    {
      id: 'kpi-fi', label: 'FI progress', icon: 'fa-bullseye', tone: 'pink', value: formatPercent(Math.min(fiPct, 100)), raw: fiPct.toFixed(1),
      sub: `Wealth score ${wealthScore} — ${wealthLabel}`,
      progress: Math.min(Math.max(fiPct, 0), 100),
      tooltip: `${fiMultiplier}× rule: target ₹${(fiTarget/1e7).toFixed(2)}Cr. Wealth Score from "The Millionaire Next Door".`,
    },
  ];

  const grid = document.getElementById('nw-kpi-grid');
  if (!grid) return;

  renderKpiCards(grid, kpis);
}

// ── Charts ──────────────────────────────────────────────
function buildAccumulationChart(data, type) {
  netWorthChartRef = destroyChart(netWorthChartRef);
  const ctx = document.getElementById('nw-accumulation-chart');
  if (!ctx || !data.length) return;

  const labels = data.map(e => e.date);
  const nwData = data.map(e => computeNet(e));
  const assetsData = data.map(e => computeAssets(e));

  const gradient = ctx.getContext('2d').createLinearGradient(0,0,0,220);
  gradient.addColorStop(0, 'rgba(56,189,248,0.2)');
  gradient.addColorStop(1, 'rgba(56,189,248,0)');

  netWorthChartRef = new Chart(ctx, {
    type: type === 'bar' ? 'bar' : 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Net worth',
          data: nwData,
          borderColor: CHART_COLORS.accent,
          backgroundColor: type === 'line' ? gradient : 'rgba(56,189,248,0.35)',
          borderWidth: 2.5, fill: type === 'line', tension: 0.4,
          pointBackgroundColor: CHART_COLORS.accent, pointRadius: 3, pointHoverRadius: 6,
        },
        {
          label: 'Total assets',
          data: assetsData,
          borderColor: CHART_COLORS.success,
          backgroundColor: 'rgba(16,185,129,0.08)',
          borderWidth: 1.5, fill: false, tension: 0.4,
          pointRadius: 0, pointHoverRadius: 4,
          borderDash: [4, 4],
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top', labels: { usePointStyle: true, pointStyleWidth: 8, padding: 16, font: { size: 11 } }
        },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatINRFull(ctx.parsed.y)}` }
        }
      },
      scales: {
        x: { type: 'time', time: { unit: 'month', displayFormats: { month: 'MMM yy' } }, grid: { display: false }, ticks: { maxRotation: 0 } },
        y: {
          grid: { color: 'rgba(148,163,184,0.06)' },
          ticks: {
            callback: v => {
              if (v >= 1e7) return '₹' + (v/1e7).toFixed(1) + 'Cr';
              if (v >= 1e5) return '₹' + (v/1e5).toFixed(1) + 'L';
              return '₹' + (v/1000).toFixed(0) + 'k';
            }
          }
        }
      }
    }
  });
}

function buildAllocationChart(latest) {
  allocationChartRef = destroyChart(allocationChartRef);
  const ctx = document.getElementById('nw-allocation-chart');
  if (!ctx || !latest) return;

  const fields = [
    { key: 'stocks',       label: 'Stocks',       color: ASSET_COLORS.stocks },
    { key: 'mutual_funds', label: 'Mutual Funds',  color: ASSET_COLORS.mutual_funds },
    { key: 'cash',         label: 'Cash',          color: ASSET_COLORS.cash },
    { key: 'epf',          label: 'EPF',           color: ASSET_COLORS.epf },
    { key: 'gold',         label: 'Gold',          color: ASSET_COLORS.gold },
    { key: 'fds',          label: 'FDs',           color: ASSET_COLORS.fds },
  ].filter(f => (latest[f.key] || 0) > 0);

  allocationChartRef = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: fields.map(f => f.label),
      datasets: [{
        data: fields.map(f => latest[f.key] || 0),
        backgroundColor: fields.map(f => f.color),
        borderColor: cssVar('--bg-card', '#1e293b'), borderWidth: 3, hoverOffset: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '72%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true, pointStyleWidth: 8, font: { size: 10.5 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatINR(ctx.parsed)}` } }
      }
    }
  });
}

function renderYearFilter() {
  const select = document.getElementById('nw-year-filter');
  if (!select) return;

  const years = [...new Set(entries.map(e => e.date?.slice(0, 4)))].filter(Boolean).sort().reverse();
  const currentVal = select.value;
  select.innerHTML = '<option value="">All Years</option>' + 
    years.map(y => `<option value="${escapeHTML(y)}">${escapeHTML(y)}</option>`).join('');
  if (years.includes(currentVal)) {
    select.value = currentVal;
  } else {
    filterYear = '';
  }
}

// ── Table ───────────────────────────────────────────────
function renderTable() {
  const container = document.getElementById('nw-table-container');
  if (!container) return;
  if (tableGrid) { try { tableGrid.destroy(); } catch(_) {} }

  let filtered = entries;
  if (filterYear) {
    filtered = filtered.filter(e => e.date?.startsWith(filterYear));
  }
  if (searchTerm) {
    filtered = filtered.filter(e =>
      e.date?.includes(searchTerm) ||
      formatINRFull(computeNet(e)).includes(searchTerm)
    );
  }

  const rows = [...filtered].reverse().map(e => {
    const net    = computeNet(e);
    const assets = computeAssets(e);

    // Find previous entry for change
    const idx = entries.indexOf(e);
    const prev = idx > 0 ? entries[idx - 1] : null;
    const prevNet = prev ? computeNet(prev) : null;
    const chgPct = prevNet ? ((net - prevNet) / Math.abs(prevNet)) * 100 : null;

    return [
      formatDate(e.date),
      gridHtml(numCell(formatINR(e.stocks))),
      gridHtml(numCell(formatINR(e.mutual_funds))),
      gridHtml(numCell(formatINR(e.cash))),
      gridHtml(numCell(formatINR(assets))),
      gridHtml(numCell(formatINR(e.credit_cards), { tone: 'danger' })),
      gridHtml(numCell(formatINR(net), { tone: 'accent', bold: true })),
      chgPct !== null
        ? gridHtml(numCell(`${chgPct >= 0 ? '↑' : '↓'} ${Math.abs(chgPct).toFixed(1)}%`,
                           { tone: chgPct >= 0 ? 'success' : 'danger' }))
        : gridHtml(numCell('—')),
      gridHtml(rowActions(`window.__nwEdit('${e.id}')`, `window.__nwDelete('${e.id}')`, 'snapshot')),
    ];
  });

  tableGrid = new Grid({
    columns: [
      // Column names are the words the rest of the app uses. This one read
      // "MFs" next to a Settings screen and an allocation chart that both
      // say "Mutual Funds".
      { name: 'Date' },
      { name: 'Stocks',       attributes: NUMERIC_COL },
      { name: 'Mutual Funds', attributes: NUMERIC_COL },
      { name: 'Cash',         attributes: NUMERIC_COL },
      { name: 'Total Assets', attributes: NUMERIC_COL },
      { name: 'Liabilities',  attributes: NUMERIC_COL },
      { name: 'Net Worth',    attributes: NUMERIC_COL },
      { name: 'Change',       attributes: NUMERIC_COL },
      { name: 'Actions', sort: false, attributes: ACTIONS_COL },
    ],
    data: rows,
    pagination: { limit: 10 },
    sort: true,
    language: { noRecordsFound: 'No snapshots found. Add your first one!' },
  }).render(container);

  window.__nwEdit = (id) => {
    const entry = entries.find(e => e.id === id);
    if (entry) openEntryForm(entry);
  };

  window.__nwDelete = async (id) => {
    if (!confirm('Delete this snapshot?')) return;
    const { error } = await supabase.from('net_worth_entries').delete().eq('id', id);
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
    showToast('Snapshot deleted.');
    await loadData();
  };
}

// Removed — use computeNet() from utils.js instead.

// ── Form Modal ───────────────────────────────────────────
function openEntryForm(entry = null) {
  editingId = entry?.id || null;
  const title = entry ? 'Edit snapshot' : 'Add a snapshot';

  openModal(`
    <div class="modal-header">
      <div class="modal-title">${escapeHTML(title)}</div>
      <button class="modal-close" id="nw-modal-close"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Date</label>
        <input type="date" class="form-input" id="nw-f-date" value="${escapeHTML(entry?.date || todayISO())}" />
      </div>

      <div style="font-size:0.72rem;font-weight:700;color:var(--success);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.6rem;margin-top:0.4rem">
        <i class="fas fa-arrow-up" style="margin-right:0.25rem"></i>Assets
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Stocks (₹)</label>
          <input type="number" class="form-input" id="nw-f-stocks" placeholder="0" min="0" value="${entry?.stocks ?? ''}" />
        </div>
        <div class="form-group">
          <label class="form-label">Mutual Funds (₹)</label>
          <input type="number" class="form-input" id="nw-f-mf" placeholder="0" min="0" value="${entry?.mutual_funds ?? ''}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Cash & Bank (₹)</label>
          <input type="number" class="form-input" id="nw-f-cash" placeholder="0" min="0" value="${entry?.cash ?? ''}" />
        </div>
        <div class="form-group">
          <label class="form-label">EPF (₹)</label>
          <input type="number" class="form-input" id="nw-f-epf" placeholder="0" min="0" value="${entry?.epf ?? ''}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Gold (₹)</label>
          <input type="number" class="form-input" id="nw-f-gold" placeholder="0" min="0" value="${entry?.gold ?? ''}" />
        </div>
        <div class="form-group">
          <label class="form-label">Fixed Deposits (₹)</label>
          <input type="number" class="form-input" id="nw-f-fds" placeholder="0" min="0" value="${entry?.fds ?? ''}" />
        </div>
      </div>

      <div style="font-size:0.72rem;font-weight:700;color:var(--danger);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.6rem;margin-top:0.4rem">
        <i class="fas fa-arrow-down" style="margin-right:0.25rem"></i>Liabilities
      </div>
      <div class="form-group">
        <label class="form-label">Credit Cards Outstanding (₹)</label>
        <input type="number" class="form-input" id="nw-f-cc" placeholder="0" min="0" value="${entry?.credit_cards ?? ''}" />
      </div>

      <!-- Live preview -->
      <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:1rem;margin-top:0.5rem;border:1px solid var(--border)">
        <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:0.5rem;font-weight:700">Live Preview</div>
        <div style="display:flex;justify-content:space-between;font-size:0.85rem">
          <span style="color:var(--text-secondary)">Total Assets</span>
          <span id="nw-preview-assets" style="font-weight:700;color:var(--success)">₹0</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-top:0.25rem">
          <span style="color:var(--text-secondary)">Net Worth</span>
          <span id="nw-preview-net" style="font-weight:800;color:var(--accent);font-size:1rem">₹0</span>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" id="nw-form-cancel">Cancel</button>
      <button class="btn-submit" id="nw-form-submit">${entry ? 'Save changes' : 'Add snapshot'}</button>
    </div>
  `);

  // Close handlers
  document.getElementById('nw-modal-close').addEventListener('click', closeModal);
  document.getElementById('nw-form-cancel').addEventListener('click', closeModal);

  // Live preview
  const fields = ['nw-f-stocks','nw-f-mf','nw-f-cash','nw-f-epf','nw-f-gold','nw-f-fds','nw-f-cc'];
  fields.forEach(id => {
    document.getElementById(id)?.addEventListener('input', updatePreview);
  });
  updatePreview();

  // Submit
  document.getElementById('nw-form-submit').addEventListener('click', submitForm);
}

function updatePreview() {
  const stocks = parseNum(document.getElementById('nw-f-stocks')?.value);
  const mf     = parseNum(document.getElementById('nw-f-mf')?.value);
  const cash   = parseNum(document.getElementById('nw-f-cash')?.value);
  const epf    = parseNum(document.getElementById('nw-f-epf')?.value);
  const gold   = parseNum(document.getElementById('nw-f-gold')?.value);
  const fds    = parseNum(document.getElementById('nw-f-fds')?.value);
  const cc     = parseNum(document.getElementById('nw-f-cc')?.value);

  const assets = stocks + mf + cash + epf + gold + fds;
  const net = assets - cc;

  const pa = document.getElementById('nw-preview-assets');
  const pn = document.getElementById('nw-preview-net');
  if (pa) pa.textContent = formatINRFull(assets);
  if (pn) {
    pn.textContent = formatINRFull(net);
    pn.style.color = net >= 0 ? 'var(--accent)' : 'var(--danger)';
  }
}

async function submitForm() {
  const btn = document.getElementById('nw-form-submit');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const payload = {
    date:         document.getElementById('nw-f-date')?.value,
    stocks:       parseNum(document.getElementById('nw-f-stocks')?.value),
    mutual_funds: parseNum(document.getElementById('nw-f-mf')?.value),
    cash:         parseNum(document.getElementById('nw-f-cash')?.value),
    epf:          parseNum(document.getElementById('nw-f-epf')?.value),
    gold:         parseNum(document.getElementById('nw-f-gold')?.value),
    fds:          parseNum(document.getElementById('nw-f-fds')?.value),
    credit_cards: parseNum(document.getElementById('nw-f-cc')?.value),
    user_id:      await getCurrentUserId(),
  };

  if (!payload.date) {
    showToast('Please select a date.', 'error');
    btn.disabled = false;
    btn.textContent = editingId ? 'Save changes' : 'Add snapshot';
    return;
  }

  if (editingId) payload.id = editingId;

  const { error } = await supabase.from('net_worth_entries').upsert([payload]);
  if (error) {
    showToast('Save failed: ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = editingId ? 'Save changes' : 'Add snapshot';
    return;
  }

  closeModal();
  showToast(editingId ? 'Snapshot updated!' : 'Snapshot added!');
  await loadData();
}

// ── Export ───────────────────────────────────────────────
function exportCSV() {
  const headers = ['Date','Stocks','Mutual Funds','Cash','EPF','Gold','FDs','Credit Cards','Total Assets','Net Worth'];
  const rows = entries.map(e => {
    const assets = computeAssets(e);
    const net    = computeNet(e);
    return [e.date, e.stocks||0, e.mutual_funds||0, e.cash||0, e.epf||0, e.gold||0, e.fds||0, e.credit_cards||0, assets, net];
  });
  downloadCSV(headers, rows, `net_worth_export_${todayISO()}.csv`);
  showToast('CSV exported!');
}
