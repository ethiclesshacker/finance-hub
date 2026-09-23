import { gridHtml } from '../vendor.js';
import { getCurrentUserId } from '../supabase.js';
import { listEntries, saveEntry, deleteEntry } from '../networth/api.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, formatDate, todayISO,
  destroyChart, downloadCSV, escapeHTML,
  openModal, closeModal, showToast, parseNum, withBusy, buildGrid,
  computeNet, computeAssets, computeLiquid, computeEmergencyFund, renderKpiCards,
  numCell, rowActions,
} from '../utils.js';
import { netWorthSeriesChart, allocationDoughnut, wireChartToggle } from '../charts.js';

let entries = [];
let netWorthChartRef = null;
let allocationChartRef = null;
let tableGrid = null;
let editingId = null;
let chartType = 'line';
let filterYear = '';
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;

export async function renderNetWorth(container) {
  editingId = null;
  chartType = 'line';
  filterYear = '';

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Net Worth</h2>
        <p>Track your assets, liabilities, and financial independence progress</p>
      </div>
      <div class="page-actions">
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
          <div class="table-title">
            <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
            Historical Snapshots
          </div>
          <div class="table-actions">
            <select id="nw-year-filter" class="form-select toolbar-select" aria-label="Filter by year">
              <option value="">All Years</option>
            </select>
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

  wireChartToggle('nw-line-btn', 'nw-bar-btn', type => {
    chartType = type;
    buildAccumulationChart(entries, type);
  });

  document.getElementById('nw-fab').addEventListener('click', () => openEntryForm());
  document.getElementById('nw-export-btn').addEventListener('click', exportCSV);
  document.getElementById('nw-refresh-btn').addEventListener('click', loadData);

  document.getElementById('nw-year-filter')?.addEventListener('change', e => {
    filterYear = e.target.value;
    renderTable();
  });

  await loadData();
}

export { renderNetWorth as render };

/** Release the charts and the grid before the router replaces the DOM. */
export function unmount() {
  loadToken++;
  netWorthChartRef = destroyChart(netWorthChartRef);
  allocationChartRef = destroyChart(allocationChartRef);
  if (tableGrid) { try { tableGrid.destroy(); } catch (_) {} }
  tableGrid = null;
}

async function loadData() {
  const token = ++loadToken;
  let data;
  try {
    data = await listEntries();
  } catch (err) {
    if (token === loadToken) showToast('Failed to load data: ' + err.message, 'error');
    return;
  }
  if (token !== loadToken || !document.getElementById('nw-kpi-grid')) return;

  entries = data || [];
  renderKPIs();
  buildAccumulationChart(entries, chartType);
  allocationChartRef = destroyChart(allocationChartRef);
  allocationChartRef = allocationDoughnut(document.getElementById('nw-allocation-chart'), entries[entries.length - 1]);
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
  const prv = { net: computeNet(prev) };

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

  renderKpiCards(document.getElementById('nw-kpi-grid'), kpis);
}

// ── Charts ──────────────────────────────────────────────
function buildAccumulationChart(data, type) {
  netWorthChartRef = destroyChart(netWorthChartRef);
  netWorthChartRef = netWorthSeriesChart(document.getElementById('nw-accumulation-chart'), data, type, { withAssets: true });
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

  const filtered = filterYear ? entries.filter(e => e.date?.startsWith(filterYear)) : entries;

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

  tableGrid = buildGrid(container, tableGrid, [
    // Column names are the words the rest of the app uses. This one read
    // "MFs" next to a Settings screen and an allocation chart that both
    // say "Mutual Funds".
    { name: 'Date' },
    { name: 'Stocks',       numeric: true },
    { name: 'Mutual Funds', numeric: true },
    { name: 'Cash',         numeric: true },
    { name: 'Total Assets', numeric: true },
    { name: 'Liabilities',  numeric: true },
    { name: 'Net Worth',    numeric: true },
    { name: 'Change',       numeric: true },
    { name: 'Actions',      actions: true },
  ], rows, { limit: 10, empty: 'No snapshots found. Add your first one!' });

  window.__nwEdit = (id) => {
    const entry = entries.find(e => e.id === id);
    if (entry) openEntryForm(entry);
  };

  window.__nwDelete = async (id) => {
    if (!confirm('Delete this snapshot?')) return;
    try {
      await deleteEntry(id);
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
      return;
    }
    showToast('Snapshot deleted.');
    await loadData();
  };
}

// ── Form Modal ───────────────────────────────────────────
function openEntryForm(entry = null) {
  editingId = entry?.id || null;

  const money = (id, label, value) => `
    <div class="form-group">
      <label class="form-label" for="${id}">${label}</label>
      <input type="number" class="form-input" id="${id}" placeholder="0" min="0" value="${value ?? ''}" />
    </div>`;

  openModal({
    title: entry ? 'Edit snapshot' : 'Add a snapshot',
    body: `
      <div class="form-group">
        <label class="form-label" for="nw-f-date">Date</label>
        <input type="date" class="form-input" id="nw-f-date" value="${escapeHTML(entry?.date || todayISO())}" />
      </div>

      <div class="form-section is-success">
        <i class="fas fa-arrow-up" aria-hidden="true"></i>Assets
      </div>
      <div class="form-row">
        ${money('nw-f-stocks', 'Stocks (₹)', entry?.stocks)}
        ${money('nw-f-mf', 'Mutual Funds (₹)', entry?.mutual_funds)}
      </div>
      <div class="form-row">
        ${money('nw-f-cash', 'Cash & Bank (₹)', entry?.cash)}
        ${money('nw-f-epf', 'EPF (₹)', entry?.epf)}
      </div>
      <div class="form-row">
        ${money('nw-f-gold', 'Gold (₹)', entry?.gold)}
        ${money('nw-f-fds', 'Fixed Deposits (₹)', entry?.fds)}
      </div>

      <div class="form-section is-danger">
        <i class="fas fa-arrow-down" aria-hidden="true"></i>Liabilities
      </div>
      ${money('nw-f-cc', 'Credit Cards Outstanding (₹)', entry?.credit_cards)}

      <!-- Live preview -->
      <div class="form-preview">
        <div class="form-preview-label">Live Preview</div>
        <div class="form-preview-row">
          <span>Total Assets</span>
          <span class="form-preview-value" id="nw-preview-assets">₹0</span>
        </div>
        <div class="form-preview-row">
          <span>Net Worth</span>
          <span class="form-preview-value is-accent" id="nw-preview-net">₹0</span>
        </div>
      </div>`,
    footer: `
      <button type="button" class="btn-cancel" data-close>Cancel</button>
      <button type="button" class="btn-submit" id="nw-form-submit">${entry ? 'Save changes' : 'Add snapshot'}</button>`,
  });

  // Live preview
  const fields = ['nw-f-stocks','nw-f-mf','nw-f-cash','nw-f-epf','nw-f-gold','nw-f-fds','nw-f-cc'];
  fields.forEach(id => {
    document.getElementById(id)?.addEventListener('input', updatePreview);
  });
  updatePreview();

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
    pn.classList.toggle('is-accent', net >= 0);
    pn.classList.toggle('is-danger', net < 0);
  }
}

async function submitForm() {
  const btn = document.getElementById('nw-form-submit');
  await withBusy(btn, 'Saving…', async () => {
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

    if (!payload.date) { showToast('Please select a date.', 'error'); return; }
    if (editingId) payload.id = editingId;

    try {
      await saveEntry(payload);
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
      return;
    }

    closeModal();
    showToast(editingId ? 'Snapshot updated!' : 'Snapshot added!');
    await loadData();
  });
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
