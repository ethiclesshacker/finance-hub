import { supabase } from '../supabase.js';
import { USER_NAME, USER_MONTHLY_EXPENSES, FI_TARGET, POINTS_PER_EUR, EUR_INR_FALLBACK, EMERGENCY_RUNWAY_HEALTHY_TARGET, CC_REWARD_TARGET_RATE } from '../constants.js';
import { formatINR, formatINRFull, formatPercent, applyChartDefaults, destroyChart, makeCopyable, fetchEURtoINR, CHART_COLORS, ASSET_COLORS } from '../utils.js';
import { navigateTo } from '../router.js';

let netWorthChart = null;
let allocationChart = null;
let netWorthData = [];

export async function renderDashboard(container) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  container.innerHTML = `
    <div class="page-body" style="padding-top:1.5rem">

      <!-- Compact hero header: greeting left, net worth right -->
      <div class="dash-header">
        <div class="dash-left">
          <div class="dash-greeting">Good ${getGreeting()}, ${USER_NAME} 👋</div>
          <div class="dash-date">${dateStr}</div>
        </div>
        <div class="dash-nw-stat">
          <div class="dash-nw-label">Net Worth</div>
          <div class="dash-nw-value mono" id="hero-net-worth">—</div>
          <div class="dash-nw-change" id="hero-nw-change">—</div>
        </div>
      </div>

      <!-- 4 KPIs — all distinct, no net worth repeat -->
      <div class="kpi-grid" id="dashboard-kpis">
        ${Array(4).fill(0).map(() => `
          <div class="kpi-card">
            <div class="skeleton" style="height:88px;border-radius:var(--radius-md)"></div>
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
              <button class="chart-toggle-btn active" id="nw-chart-line">Line</button>
              <button class="chart-toggle-btn" id="nw-chart-bar">Bar</button>
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
          <div class="chart-canvas-wrap" style="height:220px">
            <canvas id="dash-alloc-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Points strip — inline stats, no nested cards -->
      <div class="chart-card" style="margin-top:1rem">
        <div class="chart-header" style="margin-bottom:0">
          <div>
            <div class="chart-title">Points & Rewards
              <span id="fx-badge" style="font-size:0.7rem;font-weight:500;color:var(--text-muted);margin-left:0.5rem">·</span>
            </div>
            <div class="chart-subtitle">HSBC TravelOne</div>
          </div>
          <button class="btn-sm btn-accent" id="dash-goto-points">
            View Details <i class="fas fa-arrow-right" style="font-size:0.7rem"></i>
          </button>
        </div>
        <div class="points-strip" id="points-strip">
          ${Array(4).fill(0).map(() => `
            <div class="points-strip-item">
              <div class="skeleton" style="height:52px;border-radius:var(--radius-sm)"></div>
            </div>
          `).join('')}
        </div>
      </div>

    </div>
  `;

  applyChartDefaults();

  // Chart toggles
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

  await loadDashboardData();
}

async function loadDashboardData() {
  const [nwRes, txRes, rdRes, eurRate] = await Promise.all([
    supabase.from('net_worth_entries').select('*').order('date', { ascending: true }),
    supabase.from('cc_transactions').select('*'),
    supabase.from('cc_redemptions').select('*'),
    fetchEURtoINR(EUR_INR_FALLBACK),
  ]);

  const entries     = nwRes.data || [];
  const transactions = txRes.data || [];
  const redemptions  = rdRes.data || [];
  netWorthData = entries;

  // ── Net Worth ─────────────────────────────────────────
  const latest = entries[entries.length - 1];
  const prev   = entries[entries.length - 2];

  const sum = (e) => e
    ? (e.stocks||0)+(e.mutual_funds||0)+(e.cash||0)+(e.epf||0)+(e.gold||0)+(e.fds||0)-(e.credit_cards||0)
    : 0;
  const assets = (e) => e
    ? (e.stocks||0)+(e.mutual_funds||0)+(e.cash||0)+(e.epf||0)+(e.gold||0)+(e.fds||0)
    : 0;
  const liquid = (e) => e ? (e.stocks||0)+(e.mutual_funds||0)+(e.cash||0) : 0;

  const netWorth  = sum(latest);
  const prevNW    = sum(prev);
  const nwChange  = prevNW ? ((netWorth - prevNW) / Math.abs(prevNW)) * 100 : 0;
  const totalAssets = assets(latest);

  // Hero net worth
  const heroEl  = document.getElementById('hero-net-worth');
  const changeEl = document.getElementById('hero-nw-change');
  if (heroEl) heroEl.textContent = formatINRFull(netWorth);
  if (changeEl && prev) {
    const isPos = nwChange >= 0;
    changeEl.innerHTML = `<span style="color:${isPos ? 'var(--success)' : 'var(--danger)'}">${isPos ? '↑' : '↓'} ${Math.abs(nwChange).toFixed(1)}%</span> from last snapshot`;
  } else if (changeEl) {
    changeEl.textContent = 'First snapshot';
  }

  // ── Points ────────────────────────────────────────────
  const calcPoints = (t) => t.points != null ? parseFloat(t.points) : parseFloat(t.amount) * parseFloat(t.multiplier) / 100;
  const totalAccrued  = transactions.reduce((s, t) => s + calcPoints(t), 0);
  const totalRedeemed = redemptions.reduce((s, r) => s + parseFloat(r.points_redeemed || 0), 0);
  const balance       = totalAccrued - totalRedeemed;
  const balanceINR    = (balance / POINTS_PER_EUR) * eurRate;
  const totalSpent    = transactions.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
  const rdValue       = redemptions.reduce((s, r) => s + parseFloat(r.value_amount || 0), 0);
  const rewardRate    = totalSpent > 0 ? ((rdValue + balanceINR) / totalSpent) * 100 : 0;

  // FX badge
  const fxBadge = document.getElementById('fx-badge');
  if (fxBadge) fxBadge.textContent = `· 1 EUR = ₹${eurRate.toFixed(0)}`;

  // ── 4 KPI Cards ───────────────────────────────────────
  const fiPct = Math.min((netWorth / FI_TARGET) * 100, 100);
  const runway = USER_MONTHLY_EXPENSES > 0 ? liquid(latest) / USER_MONTHLY_EXPENSES : 0;

  const kpis = [
    {
      id: 'dk-assets', label: 'Total Assets', icon: '🏦',
      iconBg: 'rgba(16,185,129,0.1)', glow: 'var(--success-glow)',
      value: formatINRFull(totalAssets), raw: totalAssets,
      sub: `Liquid: ${formatINR(liquid(latest))}`,
      tooltip: 'Sum of all asset classes in your latest snapshot.',
    },
    {
      id: 'dk-fi', label: 'FI Progress', icon: '🎯',
      iconBg: 'rgba(167,139,250,0.1)', glow: 'var(--purple-glow)',
      value: formatPercent(fiPct), raw: fiPct.toFixed(1),
      sub: `Target ${formatINR(FI_TARGET)}`,
      progress: fiPct,
      tooltip: '25× rule FIRE target. Target = 25 × annual expenses.',
    },
    {
      id: 'dk-points', label: 'Points Balance', icon: '✈️',
      iconBg: 'rgba(245,158,11,0.1)', glow: 'var(--warning-glow)',
      value: Math.round(balance).toLocaleString('en-IN') + ' pts', raw: Math.round(balance),
      sub: `≈ ${formatINRFull(balanceINR)}`,
      tooltip: 'HSBC TravelOne live balance valued in INR.',
    },
    {
      id: 'dk-runway', label: 'Emergency Runway', icon: '🛡️',
      iconBg: runway >= EMERGENCY_RUNWAY_HEALTHY_TARGET ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
      glow: runway >= EMERGENCY_RUNWAY_HEALTHY_TARGET ? 'var(--success-glow)' : 'var(--warning-glow)',
      value: runway.toFixed(1) + ' months', raw: runway.toFixed(1),
      badge: { text: runway >= EMERGENCY_RUNWAY_HEALTHY_TARGET ? 'Healthy' : 'Build up', type: runway >= EMERGENCY_RUNWAY_HEALTHY_TARGET ? 'positive' : 'neutral' },
      sub: `Liquid ÷ ₹${(USER_MONTHLY_EXPENSES/1000).toFixed(0)}k/mo`,
      tooltip: `Liquid assets ÷ monthly baseline expenses. Target ≥ ${EMERGENCY_RUNWAY_HEALTHY_TARGET} months.`,
    },
  ];

  const kpiContainer = document.getElementById('dashboard-kpis');
  if (kpiContainer) {
    kpiContainer.innerHTML = kpis.map(k => `
      <div class="kpi-card" id="${k.id}" style="--kpi-glow:${k.glow}" title="${k.tooltip}">
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

    kpis.forEach(k => makeCopyable(document.getElementById(k.id), k.raw));
  }

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
        label: 'Balance Value',
        value: formatINRFull(balanceINR),
        sub: `${(balance / POINTS_PER_EUR).toFixed(0)} EUR`,
        color: 'var(--accent)',
      },
      {
        label: 'Reward Rate',
        value: formatPercent(rewardRate),
        sub: rewardRate >= CC_REWARD_TARGET_RATE ? `✓ Above ${CC_REWARD_TARGET_RATE}% target` : `Target: > ${CC_REWARD_TARGET_RATE}%`,
        color: rewardRate >= CC_REWARD_TARGET_RATE ? 'var(--success)' : 'var(--warning)',
      },
    ];

    strip.innerHTML = items.map((item, i) => `
      <div class="points-strip-item ${i < items.length - 1 ? 'has-divider' : ''}">
        <div class="psi-label">${item.label}</div>
        <div class="psi-value mono" style="color:${item.color}">${item.value}</div>
        <div class="psi-sub">${item.sub}</div>
      </div>
    `).join('');
  }

  // Charts
  buildNetWorthChart(entries, 'line');
  buildAllocationChart(latest);
}

function buildNetWorthChart(entries, type = 'line') {
  netWorthChart = destroyChart(netWorthChart);
  const ctx = document.getElementById('dash-nw-chart');
  if (!ctx || !entries.length) return;

  const labels = entries.map(e => e.date);
  const data   = entries.map(e => {
    const a = (e.stocks||0)+(e.mutual_funds||0)+(e.cash||0)+(e.epf||0)+(e.gold||0)+(e.fds||0);
    return a - (e.credit_cards||0);
  });

  const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, 'rgba(56,189,248,0.22)');
  gradient.addColorStop(1, 'rgba(56,189,248,0)');

  netWorthChart = new Chart(ctx, {
    type: type === 'bar' ? 'bar' : 'line',
    data: {
      labels,
      datasets: [{
        label: 'Net Worth',
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
  allocationChart = destroyChart(allocationChart);
  const ctx = document.getElementById('dash-alloc-chart');
  if (!ctx || !latest) return;

  const fields = [
    { key: 'stocks',       label: 'Stocks',      color: ASSET_COLORS.stocks },
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
        borderColor: 'var(--bg-card)', borderWidth: 3, hoverOffset: 8,
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

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
