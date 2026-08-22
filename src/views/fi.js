import { Chart } from '../vendor.js';
import { supabase } from '../supabase.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, destroyChart, makeCopyable,
  escapeHTML, showToast, parseNum, CHART_COLORS, computeNet,
  renderKpiCards,
} from '../utils.js';
import {
  impliedSavingsRate, monthsToTarget, projectSeries,
  coastFINumber, addMonthsISO, formatDuration,
} from '../finance.js';
import { navigateTo } from '../router.js';

let entries = [];
let projectionChart = null;

// Scenario state, module-level so it survives navigating away and back.
// Sliding only changes the projection; "Save as my assumptions" writes it.
let scenario = null;

/**
 * Fingerprint of the settings the scenario is derived from. When these change
 * — because you edited them on the Settings screen — an unsaved scenario is
 * stale and gets re-derived. Otherwise it is left alone.
 */
function settingsSignature() {
  return [
    settings.get('monthly_contribution'),
    settings.get('monthly_net_income'),
    settings.get('monthly_expenses'),
    settings.get('expected_return'),
    settings.get('fi_multiplier'),
  ].join('|');
}

export async function renderFI(container) {
  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>FI Planner</h2>
        <p>Savings rate, projections, and the date the maths says you're done</p>
      </div>
      <button type="button" class="btn-sm btn-ghost" id="fi-settings-btn">
        <i class="fas fa-sliders"></i> Edit assumptions
      </button>
    </div>

    <div class="page-body">
      <div id="fi-alert"></div>

      <div class="kpi-grid kpi-grid--3col" id="fi-kpi-grid">
        ${Array(6).fill(0).map(() => `
          <div class="kpi-card"><div class="skeleton skeleton--kpi"></div></div>
        `).join('')}
      </div>

      <div class="chart-card" style="margin-top:1rem">
        <div class="chart-header">
          <div>
            <div class="chart-title">Path to Financial Independence</div>
            <div class="chart-subtitle" id="fi-chart-sub">Actual net worth, then projected</div>
          </div>
          <label class="fi-toggle">
            <input type="checkbox" id="fi-real-terms" />
            <span>Today's rupees</span>
          </label>
        </div>
        <div class="chart-canvas-wrap chart-card--tall">
          <canvas id="fi-projection-chart"></canvas>
        </div>
      </div>

      <div class="fi-grid">
        <div class="chart-card">
          <div class="chart-header" style="margin-bottom:0.75rem">
            <div>
              <div class="chart-title">Scenario</div>
              <div class="chart-subtitle">Drag to see what changes. Nothing is saved until you save it.</div>
            </div>
          </div>
          <div class="fi-sliders" id="fi-sliders"></div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;margin-top:1rem">
            <button type="button" class="btn-sm btn-accent" id="fi-save-scenario">Save as my assumptions</button>
            <button type="button" class="btn-sm btn-ghost" id="fi-reset-scenario">Reset to saved</button>
            <span class="fi-dirty" id="fi-dirty" role="status"></span>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-header" style="margin-bottom:0.75rem">
            <div>
              <div class="chart-title">Milestones</div>
              <div class="chart-subtitle">At the current scenario</div>
            </div>
          </div>
          <div id="fi-milestones"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('fi-settings-btn')?.addEventListener('click', () => navigateTo('settings'));
  document.getElementById('fi-real-terms')?.addEventListener('change', e => {
    scenario.realTerms = e.target.checked;
    recompute();
  });
  document.getElementById('fi-save-scenario')?.addEventListener('click', saveScenario);
  document.getElementById('fi-reset-scenario')?.addEventListener('click', () => {
    resetScenario();
    renderSliders();
    recompute();
  });

  await loadData();
}

function showAlert(message, kind = 'error') {
  const el = document.getElementById('fi-alert');
  if (!el) return;
  el.innerHTML = `
    <div class="dash-banner dash-banner--${kind === 'error' ? 'error' : 'empty'}" role="${kind === 'error' ? 'alert' : 'status'}">
      <i class="fas fa-${kind === 'error' ? 'triangle-exclamation' : 'seedling'}"></i>
      <div><strong>${escapeHTML(message)}</strong></div>
      ${kind === 'empty' ? '<button type="button" class="btn-sm btn-accent" id="fi-goto-nw">Add snapshot</button>' : ''}
    </div>
  `;
  document.getElementById('fi-goto-nw')?.addEventListener('click', () => navigateTo('networth'));
}

/** Re-derive the scenario from saved settings, discarding unsaved slider moves. */
function resetScenario() {
  scenario = {
    // A saved monthly_contribution wins; otherwise fall back to the budgeted
    // surplus. Not the observed savings rate — that is inflated by market
    // returns and would compound them twice in the projection.
    monthly: Math.round(settings.plannedContribution()),
    returnPct: settings.get('expected_return'),
    multiplier: settings.get('fi_multiplier'),
    realTerms: scenario?.realTerms ?? false,
    _signature: settingsSignature(),
    _observed: impliedSavingsRate(entries, settings.get('monthly_net_income'), 12),
  };
}

/** Keep an in-progress scenario across navigation; re-derive only when stale. */
function syncScenario() {
  if (!scenario || scenario._signature !== settingsSignature()) {
    resetScenario();
  } else {
    // Snapshots may have changed even when settings did not.
    scenario._observed = impliedSavingsRate(entries, settings.get('monthly_net_income'), 12);
  }
}

async function loadData() {
  const { data, error } = await supabase
    .from('net_worth_entries').select('*').order('date', { ascending: true });

  if (error) { showAlert(`Couldn't load snapshots: ${error.message}`); return; }

  entries = data || [];
  if (!entries.length) {
    showAlert('No snapshots yet — a projection needs at least one.', 'empty');
    return;
  }

  syncScenario();
  renderSliders();
  recompute();
}

const SLIDERS = [
  {
    key: 'monthly', label: 'Monthly contribution', min: 0, max: 200000, step: 1000,
    format: v => formatINRFull(v),
  },
  {
    key: 'returnPct', label: 'Expected annual return', min: 0, max: 20, step: 0.25,
    format: v => v.toFixed(2) + '%',
  },
  {
    key: 'multiplier', label: 'FI multiplier', min: 10, max: 40, step: 0.5,
    format: v => v + '× annual expenses',
  },
];

function renderSliders() {
  const wrap = document.getElementById('fi-sliders');
  if (!wrap) return;

  wrap.innerHTML = SLIDERS.map(s => `
    <div class="fi-slider">
      <div class="fi-slider-head">
        <label for="fi-s-${s.key}">${escapeHTML(s.label)}</label>
        <span class="mono" id="fi-v-${s.key}">${escapeHTML(s.format(scenario[s.key]))}</span>
      </div>
      <input type="range" id="fi-s-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"
             value="${scenario[s.key]}" aria-label="${escapeHTML(s.label)}" />
    </div>
  `).join('');

  SLIDERS.forEach(s => {
    document.getElementById(`fi-s-${s.key}`)?.addEventListener('input', e => {
      scenario[s.key] = parseNum(e.target.value);
      const label = document.getElementById(`fi-v-${s.key}`);
      if (label) label.textContent = s.format(scenario[s.key]);
      recompute();
    });
  });

  const realToggle = document.getElementById('fi-real-terms');
  if (realToggle) realToggle.checked = scenario.realTerms;
}

/** The numbers the whole screen derives from, under the current scenario. */
function model() {
  const latest      = entries[entries.length - 1];
  const currentNet  = computeNet(latest);
  const annualExp   = settings.get('monthly_expenses') * 12;
  const target      = annualExp * scenario.multiplier;

  // In "today's rupees" the target stays put and the return is discounted by
  // inflation (Fisher, not a subtraction). In nominal terms both grow.
  const inflation = settings.get('inflation_rate') / 100;
  const ratePct = scenario.realTerms
    ? ((1 + scenario.returnPct / 100) / (1 + inflation) - 1) * 100
    : scenario.returnPct;

  const months = monthsToTarget({
    principal: currentNet, monthly: scenario.monthly,
    annualRatePct: ratePct, target,
  });

  const yearsToRetirement = Math.max(0, settings.get('retirement_age') - settings.get('age'));
  const coast = coastFINumber({ target, annualRatePct: ratePct, yearsToRetirement });

  return { latest, currentNet, annualExp, target, ratePct, months, coast, yearsToRetirement };
}

function recompute() {
  if (!entries.length) return;
  const m = model();
  renderKPIs(m);
  renderMilestones(m);
  buildProjectionChart(m);

  const sub = document.getElementById('fi-chart-sub');
  if (sub) {
    sub.textContent = scenario.realTerms
      ? `Actual, then projected at ${m.ratePct.toFixed(2)}% real (inflation-adjusted)`
      : `Actual, then projected at ${m.ratePct.toFixed(2)}% nominal`;
  }

  // Say plainly whether what's on screen is stored or just being tried out.
  const dirty = document.getElementById('fi-dirty');
  if (dirty) {
    const unsaved =
      scenario.monthly    !== Math.round(settings.plannedContribution()) ||
      scenario.returnPct  !== settings.get('expected_return') ||
      scenario.multiplier !== settings.get('fi_multiplier');
    dirty.textContent = unsaved ? 'Unsaved — projection only' : 'Saved';
    dirty.classList.toggle('is-unsaved', unsaved);
  }
}

function renderKPIs(m) {
  const observed   = scenario._observed;
  const budgetRate = settings.budgetedSavingsRate();
  const fiPct      = m.target > 0 ? (m.currentNet / m.target) * 100 : 0;
  const coastPct   = m.coast > 0 ? (m.currentNet / m.coast) * 100 : 0;
  const passive    = m.currentNet * (settings.get('passive_income_yield') / 100) / 12;

  const kpis = [
    {
      id: 'fi-k-rate', label: 'Actual savings rate', icon: 'fa-arrow-trend-up',
      tone: 'accent', value: observed ? formatPercent(observed.rate) : '—',
      raw: observed ? observed.rate.toFixed(1) : 0,
      progress: observed ? Math.max(0, Math.min(observed.rate, 100)) : undefined,
      sub: observed
        ? `${formatINR(observed.perMonth)}/mo over ${observed.months.toFixed(0)} months`
        : 'Needs two snapshots',
      tooltip: 'Net worth growth ÷ income over the last 12 months. Includes market returns, so it is not a pure contribution rate.',
    },
    {
      id: 'fi-k-budget', label: 'Budgeted savings rate', icon: 'fa-receipt',
      tone: 'success', value: formatPercent(budgetRate), raw: budgetRate.toFixed(1),
      badge: observed
        ? { text: observed.rate >= budgetRate ? 'Beating budget' : 'Behind budget',
            type: observed.rate >= budgetRate ? 'positive' : 'neutral' }
        : null,
      sub: `${formatINR(settings.budgetedSurplus())}/mo surplus on paper`,
      tooltip: '(Income − expenses) ÷ income, straight from your settings. The rate you would hit with zero investment return.',
    },
    {
      id: 'fi-k-time', label: 'Time to FI', icon: 'fa-hourglass-half',
      tone: 'purple', value: formatDuration(m.months),
      raw: m.months != null ? Math.round(m.months) : 0,
      sub: m.months != null
        ? `Around ${new Date(addMonthsISO(m.latest.date, m.months) + 'T00:00:00')
             .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`
        : 'Unreachable at this contribution and return',
      tooltip: 'Months until the projected balance crosses your FI target, compounding monthly.',
    },
    {
      id: 'fi-k-target', label: 'FI target', icon: 'fa-bullseye',
      tone: 'pink', value: formatINRFull(m.target), raw: Math.round(m.target),
      progress: Math.min(fiPct, 100),
      sub: `${formatPercent(fiPct)} there · ${scenario.multiplier}× ${formatINR(m.annualExp)}/yr`,
      tooltip: 'Annual expenses × the FI multiplier. At 25× that is the 4% safe-withdrawal rule.',
    },
    {
      id: 'fi-k-coast', label: 'Coast FI number', icon: 'fa-parachute-box',
      tone: coastPct >= 100 ? 'success' : 'warning',
      value: formatINRFull(m.coast), raw: Math.round(m.coast),
      progress: Math.min(coastPct, 100),
      badge: { text: coastPct >= 100 ? 'Coasting' : `${formatPercent(coastPct)}`, type: coastPct >= 100 ? 'positive' : 'neutral' },
      sub: coastPct >= 100
        ? `You could stop contributing today`
        : `${formatINR(Math.max(0, m.coast - m.currentNet))} to go`,
      tooltip: `What you'd need invested today to reach the FI target by age ${settings.get('retirement_age')} with no further contributions.`,
    },
    {
      id: 'fi-k-passive', label: 'Est. passive income', icon: 'fa-money-bill-wave',
      tone: 'teal', value: formatINR(passive), unit: '/mo', raw: Math.round(passive),
      badge: {
        text: passive >= settings.get('monthly_expenses') ? 'Covers expenses' : `${formatPercent(settings.get('monthly_expenses') > 0 ? (passive / settings.get('monthly_expenses')) * 100 : 0)} of expenses`,
        type: passive >= settings.get('monthly_expenses') ? 'positive' : 'neutral',
      },
      sub: `At ${settings.get('passive_income_yield')}% blended yield`,
      tooltip: 'Net worth × blended passive yield ÷ 12. What the portfolio would throw off monthly today.',
    },
  ];

  const grid = document.getElementById('fi-kpi-grid');
  if (!grid) return;

  renderKpiCards(grid, kpis);
}

function renderMilestones(m) {
  const wrap = document.getElementById('fi-milestones');
  if (!wrap) return;

  const stops = [
    { label: 'Coast FI', amount: m.coast },
    { label: '25% of target', amount: m.target * 0.25 },
    { label: '50% of target', amount: m.target * 0.50 },
    { label: '75% of target', amount: m.target * 0.75 },
    { label: 'Financially independent', amount: m.target },
  ].sort((a, b) => a.amount - b.amount);

  wrap.innerHTML = `
    <div class="fi-milestones">
      ${stops.map(s => {
        const reached = m.currentNet >= s.amount;
        const months = reached ? 0 : monthsToTarget({
          principal: m.currentNet, monthly: scenario.monthly,
          annualRatePct: m.ratePct, target: s.amount,
        });
        return `
          <div class="fi-milestone ${reached ? 'is-reached' : ''}">
            <div class="fi-milestone-mark" aria-hidden="true">
              <i class="fas fa-${reached ? 'circle-check' : 'circle'}"></i>
            </div>
            <div class="fi-milestone-body">
              <div class="fi-milestone-label">${escapeHTML(s.label)}</div>
              <div class="fi-milestone-amount mono">${escapeHTML(formatINRFull(s.amount))}</div>
            </div>
            <div class="fi-milestone-eta mono">
              ${reached ? '<span class="kpi-badge positive">Reached</span>'
                        : escapeHTML(formatDuration(months))}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function buildProjectionChart(m) {
  projectionChart = destroyChart(projectionChart);
  const ctx = document.getElementById('fi-projection-chart');
  if (!ctx) return;

  const actual = entries.map(e => ({ x: e.date, y: computeNet(e) }));

  // Cap the drawn projection so an unreachable target doesn't produce a
  // thousand-year x-axis.
  const projMonths = Math.min(m.months ?? 480, 480);
  const projected = projectSeries({
    principal: m.currentNet,
    monthly: scenario.monthly,
    annualRatePct: m.ratePct,
    months: projMonths,
    startISO: m.latest.date,
  }).map(p => ({ x: p.date, y: p.value }));

  const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(56,189,248,0.22)');
  gradient.addColorStop(1, 'rgba(56,189,248,0)');

  projectionChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Actual',
          data: actual,
          borderColor: CHART_COLORS.accent,
          backgroundColor: gradient,
          borderWidth: 2.5, fill: true, tension: 0.35,
          pointBackgroundColor: CHART_COLORS.accent, pointRadius: 3, pointHoverRadius: 6,
        },
        {
          label: 'Projected',
          data: projected,
          borderColor: CHART_COLORS.purple,
          borderWidth: 2, borderDash: [5, 4], fill: false, tension: 0,
          pointRadius: 0, pointHoverRadius: 4,
        },
        {
          label: 'FI target',
          data: [
            { x: entries[0].date, y: m.target },
            { x: projected[projected.length - 1]?.x ?? m.latest.date, y: m.target },
          ],
          borderColor: CHART_COLORS.success,
          borderWidth: 1.5, borderDash: [2, 4], fill: false,
          pointRadius: 0, pointHoverRadius: 0,
        },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, pointStyleWidth: 8, padding: 16, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${formatINRFull(c.parsed.y)}` } },
      },
      scales: {
        x: { type: 'time', time: { unit: 'year', displayFormats: { year: 'yyyy' } }, grid: { display: false }, ticks: { maxRotation: 0 } },
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

async function saveScenario() {
  const btn = document.getElementById('fi-save-scenario');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const { error } = await settings.saveSettings({
    monthly_contribution: scenario.monthly,
    expected_return: scenario.returnPct,
    fi_multiplier: scenario.multiplier,
  });

  if (btn) { btn.disabled = false; btn.textContent = 'Save as my assumptions'; }

  if (error) { showToast('Save failed: ' + error.message, 'error'); return; }

  // The scenario now matches what's stored, so it is no longer "unsaved".
  scenario._signature = settingsSignature();
  showToast('Assumptions saved.');
  recompute();
}
