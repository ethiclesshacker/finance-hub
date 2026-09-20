// ======================================================
// Health — Apple Health, as days.
//
// The phone syncs a row per minute per device; this screen never sees one. It
// asks the database for days (health_overview), nights (health_sleep) and, for
// the one day you are looking at, hours (health_intraday). Deduplicating the
// Watch against the phone already happened in SQL.
//
// Chart rules this file keeps: one y-axis per chart (steps and heart rate do
// not share a plot — they get their own, side by side); sleep stages are an
// ordinal ramp in one hue, deep darkest, because they are an order, not three
// unrelated things; every chart has a hover tooltip and the whole range is
// also available as a table.
// ======================================================

import { Chart } from '../vendor.js';
import * as health from '../health/api.js';
import {
  shiftISO, shortDay, longDay, formatHours, summarise, fillHours,
} from '../health/summary.js';
import {
  destroyChart, escapeHTML, cssVar, renderKpiCards, todayISO, CHART_COLORS,
} from '../utils.js';

const RANGES = [7, 30, 90];
const RANGE_KEY = 'finance-hub-health-range';

// Validated as an ordinal ramp against --bg-card (single hue, monotone
// lightness, darkest step 3.98:1 on the surface). Built around --purple.
const SLEEP_RAMP = { deep: '#8468e8', core: '#a78bfa', rem: '#e0d9ff' };
// Sleep with no stage attached — a nap without the Watch, or an app that only
// reports "asleep". It is real sleep but has no place in the order, so it gets
// a neutral, not a fourth step of the ramp.
const SLEEP_UNSTAGED = '#64748b';

let charts = {};
let state = { range: 7, days: [], nights: [], workouts: [], selectedDay: null };
// A slow response for a range you have already left must not repaint the screen.
let loadToken = 0;

function savedRange() {
  try {
    const n = Number(localStorage.getItem(RANGE_KEY));
    return RANGES.includes(n) ? n : 7;
  } catch (_) { return 7; }
}

export async function renderHealth(container) {
  state = { range: savedRange(), days: [], nights: [], workouts: [], selectedDay: todayISO() };

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Health</h2>
        <p id="hl-sub">Apple Health, synced from your iPhone</p>
      </div>
      <div class="chart-toggle" role="group" aria-label="Date range">
        ${RANGES.map(n => `
          <button type="button" class="chart-toggle-btn ${n === state.range ? 'active' : ''}"
                  data-range="${n}" aria-pressed="${n === state.range}">${n} days</button>`).join('')}
      </div>
    </div>

    <div class="page-body card-stack">
      <div id="hl-alert"></div>

      <div class="kpi-grid kpi-grid--3col" id="hl-kpis">
        ${Array(6).fill(0).map(() => '<div class="kpi-card"><div class="skeleton skeleton--kpi"></div></div>').join('')}
      </div>

      <div class="hl-grid">
        ${chartCard('hl-steps', 'Steps', 'Per day, one source per day so the Watch and phone are never added together. Select a bar to see that day by the hour.')}
        ${chartCard('hl-sleep', 'Sleep', 'Time asleep per night, by stage. A night is dated by the morning it ended.', sleepLegend())}
      </div>

      <div class="hl-grid">
        ${chartCard('hl-rhr', 'Resting heart rate', 'Beats per minute, one reading per day')}
        ${chartCard('hl-hrv', 'Heart rate variability', 'Daily average, milliseconds')}
      </div>

      <div class="hl-grid">
        ${chartCard('hl-hours', 'Through the day', '<span id="hl-hours-sub">Steps by the hour</span>')}
        <div class="chart-card">
          <div class="chart-header">
            <div>
              <div class="chart-title">Workouts</div>
              <div class="chart-subtitle">Recorded by the Watch or a fitness app</div>
            </div>
          </div>
          <div id="hl-workouts" class="hl-list"></div>
        </div>
      </div>

      <details class="chart-card hl-table-card">
        <summary class="chart-title">Every day as a table</summary>
        <div class="hl-table-wrap" id="hl-table"></div>
      </details>
    </div>
  `;

  container.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.range = Number(btn.dataset.range);
      try { localStorage.setItem(RANGE_KEY, String(state.range)); } catch (_) {}
      container.querySelectorAll('[data-range]').forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      load();
    });
  });

  await load();
}

function chartCard(id, title, subtitle, extra = '') {
  return `
    <div class="chart-card">
      <div class="chart-header">
        <div>
          <div class="chart-title">${escapeHTML(title)}</div>
          <div class="chart-subtitle">${subtitle}</div>
        </div>
        ${extra}
      </div>
      <div class="chart-canvas-wrap"><canvas id="${id}" role="img" aria-label="${escapeHTML(title)} chart"></canvas></div>
    </div>`;
}

function sleepLegend() {
  const item = (key, label) => `<span class="hl-legend-item"><span class="hl-swatch" style="background:${SLEEP_RAMP[key]}"></span>${label}</span>`;
  return `<div class="hl-legend" aria-hidden="true">${item('deep', 'Deep')}${item('core', 'Core')}${item('rem', 'REM')}<span class="hl-legend-item"><span class="hl-swatch" style="background:${SLEEP_UNSTAGED}"></span>Unstaged</span></div>`;
}

async function load() {
  const token = ++loadToken;
  const to = todayISO();
  const from = shiftISO(to, -(state.range - 1));
  const alertEl = document.getElementById('hl-alert');

  try {
    const [days, nights, workouts, cat] = await Promise.all([
      health.overview(from, to), health.sleep(from, to), health.workouts(from, to), health.catalog(),
    ]);
    if (token !== loadToken || !document.getElementById('hl-kpis')) return;

    state.days = days || [];
    state.nights = nights || [];
    state.workouts = workouts || [];

    const sub = document.getElementById('hl-sub');
    if (sub) sub.textContent = cat?.last_sync_at
      ? `Apple Health · last synced ${relativeTime(cat.last_sync_at)}`
      : 'Apple Health, synced from your iPhone';

    if (!cat?.types?.length) {
      alertEl.innerHTML = emptyState();
    } else {
      alertEl.innerHTML = '';
    }

    renderKpis();
    renderSteps();
    renderSleep();
    renderLine('rhr', 'hl-rhr', 'resting_hr', 'bpm', CHART_COLORS.pink);
    renderLine('hrv', 'hl-hrv', 'hrv_ms', 'ms', CHART_COLORS.teal);
    renderWorkouts();
    renderTable();
    await loadHours(state.selectedDay);
  } catch (error) {
    if (token !== loadToken) return;
    alertEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
        <h4>Could not load health data</h4>
        <p>${escapeHTML(error.message)}</p>
      </div>`;
  }
}

function emptyState() {
  return `
    <div class="empty-state">
      <i class="fas fa-heart-pulse" aria-hidden="true"></i>
      <h4>Nothing synced yet</h4>
      <p>Open HealthSync on your iPhone and run a sync. See docs/health-sync.md for setup.</p>
    </div>`;
}

function relativeTime(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

// ── KPIs ────────────────────────────────────────────────

const int = v => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-IN'));

function renderKpis() {
  const s = summarise(state.days, todayISO());
  const span = `${state.range}-day`;
  renderKpiCards(document.getElementById('hl-kpis'), [
    {
      id: 'hk-steps', label: 'Steps', icon: 'fa-shoe-prints', tone: 'accent',
      value: int(s.stepsAvg), unit: s.stepsAvg !== null ? '/day' : '', raw: Math.round(s.stepsAvg ?? 0),
      sub: s.stepsToday !== null ? `Today so far ${int(s.stepsToday)}` : 'Nothing yet today',
      tooltip: `${span} average over completed days. Today is left out because it is not over.`,
    },
    {
      id: 'hk-sleep', label: 'Sleep', icon: 'fa-moon', tone: 'purple',
      value: formatHours(s.sleepAvg), raw: s.sleepAvg?.toFixed(2) ?? 0,
      sub: s.sleepLast ? `Last night ${formatHours(s.sleepLast.value)}` : 'No nights recorded',
      tooltip: `${span} average of time actually asleep. Time in bed and awake periods are not counted.`,
    },
    {
      id: 'hk-rhr', label: 'Resting heart rate', icon: 'fa-heart-pulse', tone: 'pink',
      value: s.restingLatest ? int(s.restingLatest.value) : '—', unit: s.restingLatest ? 'bpm' : '', raw: s.restingLatest?.value ?? 0,
      sub: s.restingAvg !== null ? `${span} average ${int(s.restingAvg)}` : '',
      tooltip: 'Latest daily resting heart rate from Apple Health.',
    },
    {
      id: 'hk-hrv', label: 'HRV', icon: 'fa-wave-square', tone: 'teal',
      value: int(s.hrvAvg), unit: s.hrvAvg !== null ? 'ms' : '', raw: Math.round(s.hrvAvg ?? 0),
      sub: s.hrvLatest ? `Latest ${int(s.hrvLatest.value)} ms · ${shortDay(s.hrvLatest.day)}` : '',
      tooltip: `${span} average of daily mean heart rate variability (SDNN).`,
    },
    {
      id: 'hk-burn', label: 'Energy burned', icon: 'fa-fire', tone: 'warning',
      value: int(s.burnedAvg), unit: s.burnedAvg !== null ? 'kcal/day' : '', raw: Math.round(s.burnedAvg ?? 0),
      sub: s.activeAvg !== null ? `${int(s.activeAvg)} of it active` : '',
      tooltip: `${span} average of active plus resting energy, completed days only.`,
    },
    {
      id: 'hk-weight', label: 'Weight', icon: 'fa-weight-scale', tone: 'success',
      value: s.weightLatest ? s.weightLatest.value.toFixed(1) : '—', unit: s.weightLatest ? 'kg' : '', raw: s.weightLatest?.value ?? 0,
      sub: s.weightLatest ? `Recorded ${shortDay(s.weightLatest.day)}` : `No reading in ${state.range} days`,
      tooltip: 'Latest body mass reading in Apple Health within this range.',
    },
  ]);
}

// ── Charts ──────────────────────────────────────────────

function baseOptions({ unit, onClick } = {}) {
  const grid = cssVar('--border', 'rgba(148,163,184,0.1)');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    onClick,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: items => longDay(state.days[items[0].dataIndex]?.day ?? items[0].label),
          label: item => ` ${item.dataset.label}: ${formatValue(item.parsed.y, unit)}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { maxTicksLimit: 5 } },
    },
  };
}

function formatValue(v, unit) {
  if (v === null || v === undefined) return '—';
  if (unit === 'hours') return formatHours(v);
  return `${Math.round(v).toLocaleString('en-IN')}${unit ? ' ' + unit : ''}`;
}

function draw(key, canvasId, config) {
  charts[key] = destroyChart(charts[key]);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  charts[key] = new Chart(canvas.getContext('2d'), config);
}

function renderSteps() {
  const labels = state.days.map(d => shortDay(d.day));
  const accent = cssVar('--accent', CHART_COLORS.accent);
  const dim = cssVar('--accent-dark', '#0284c7');
  const options = baseOptions({
    unit: 'steps',
    onClick: (_evt, elements) => {
      if (!elements.length) return;
      const day = state.days[elements[0].index]?.day;
      if (day) { state.selectedDay = day; renderSteps(); loadHours(day); }
    },
  });
  draw('steps', 'hl-steps', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Steps',
        data: state.days.map(d => d.steps ?? null),
        // The selected day is the one drawn at full strength.
        backgroundColor: state.days.map(d => (d.day === state.selectedDay ? accent : dim)),
        borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 22, categoryPercentage: 0.8, barPercentage: 0.9,
      }],
    },
    options,
  });
}

function renderSleep() {
  const byNight = new Map(state.nights.map(n => [n.night, n]));
  const hours = key => state.days.map(d => {
    const n = byNight.get(d.day);
    return n ? Number(n[key]) / 60 : null;
  });
  const surface = cssVar('--bg-card', '#162032');
  const stage = (label, key, color) => ({
    label, data: hours(key), backgroundColor: color, stack: 'sleep',
    // A 2px surface-coloured seam between stacked segments.
    borderColor: surface, borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
    borderRadius: 3, maxBarThickness: 22, categoryPercentage: 0.8, barPercentage: 0.9,
  });
  const options = baseOptions({ unit: 'hours' });
  options.scales.x.stacked = true;
  options.scales.y.stacked = true;
  options.scales.y.ticks.callback = v => `${v}h`;
  options.plugins.tooltip.callbacks.footer = items => {
    const night = byNight.get(state.days[items[0].dataIndex]?.day);
    // The merged total from SQL, not the sum of the segments: stages from two
    // sources can overlap, and the database has already resolved that.
    const total = night ? Number(night.hours_asleep) : 0;
    const clock = night ? `  ·  ${night.fell_asleep_local} → ${night.woke_local}` : '';
    return total ? `Asleep ${formatHours(total)}${clock}` : '';
  };
  draw('sleep', 'hl-sleep', {
    type: 'bar',
    data: {
      labels: state.days.map(d => shortDay(d.day)),
      datasets: [
        stage('Deep', 'deep_min', SLEEP_RAMP.deep),
        stage('Core', 'core_min', SLEEP_RAMP.core),
        stage('REM', 'rem_min', SLEEP_RAMP.rem),
        stage('Unstaged', 'unspecified_min', SLEEP_UNSTAGED),
      ],
    },
    options,
  });
}

function renderLine(key, canvasId, field, unit, color) {
  const options = baseOptions({ unit });
  // A heart rate never sits near zero; starting the axis there flattens every
  // change into a straight line.
  options.scales.y.beginAtZero = false;
  options.scales.y.grace = '15%';
  const sparse = state.days.length > 45;
  draw(key, canvasId, {
    type: 'line',
    data: {
      labels: state.days.map(d => shortDay(d.day)),
      datasets: [{
        label: unit === 'bpm' ? 'Resting HR' : 'HRV',
        data: state.days.map(d => d[field] ?? null),
        borderColor: color, backgroundColor: color, borderWidth: 2,
        // Monotone, so the curve never dips below a reading it did not take.
        cubicInterpolationMode: 'monotone',
        pointRadius: sparse ? 0 : 3, pointHoverRadius: 5, spanGaps: true,
      }],
    },
    options,
  });
}

async function loadHours(day) {
  const token = loadToken;
  const sub = document.getElementById('hl-hours-sub');
  try {
    const result = await health.intraday('step_count', day, 60);
    if (token !== loadToken || !document.getElementById('hl-hours')) return;
    const slots = fillHours(result?.buckets);
    const total = slots.reduce((sum, s) => sum + s.value, 0);
    if (sub) {
      sub.textContent = total
        ? `Steps by the hour · ${longDay(day)} · ${Math.round(total).toLocaleString('en-IN')} steps${result?.source ? ' · ' + result.source : ''}`
        : `No steps recorded on ${longDay(day)}`;
    }
    const options = baseOptions({ unit: 'steps' });
    options.plugins.tooltip.callbacks.title = items => `${slots[items[0].dataIndex].label} – ${String((slots[items[0].dataIndex].hour + 1) % 24).padStart(2, '0')}:00`;
    options.scales.x.ticks.maxTicksLimit = 8;
    draw('hours', 'hl-hours', {
      type: 'bar',
      data: {
        labels: slots.map(s => s.label),
        datasets: [{
          label: 'Steps', data: slots.map(s => s.value),
          backgroundColor: cssVar('--accent', CHART_COLORS.accent),
          borderRadius: 3, borderSkipped: 'bottom', maxBarThickness: 16, categoryPercentage: 0.85, barPercentage: 0.9,
        }],
      },
      options,
    });
  } catch (error) {
    if (sub) sub.textContent = `Could not load the hourly view: ${error.message}`;
  }
}

// ── Lists ───────────────────────────────────────────────

function renderWorkouts() {
  const el = document.getElementById('hl-workouts');
  if (!el) return;
  if (!state.workouts.length) {
    el.innerHTML = `<p class="hl-empty">No workouts in the last ${state.range} days.</p>`;
    return;
  }
  const title = s => escapeHTML(String(s || 'workout').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));
  el.innerHTML = [...state.workouts].reverse().slice(0, 12).map(w => `
    <div class="hl-row">
      <div class="hl-row-main">
        <div class="hl-row-title">${title(w.activity)}</div>
        <div class="hl-row-sub">${escapeHTML(longDay(w.day))}</div>
      </div>
      <div class="hl-row-stats mono">
        <span>${escapeHTML(String(w.minutes ?? '—'))} min</span>
        ${w.distance_km ? `<span>${escapeHTML(String(w.distance_km))} km</span>` : ''}
        ${w.active_kcal ? `<span>${escapeHTML(String(w.active_kcal))} kcal</span>` : ''}
      </div>
    </div>`).join('');
}

function renderTable() {
  const el = document.getElementById('hl-table');
  if (!el) return;
  const cell = v => (v === null || v === undefined ? '—' : escapeHTML(String(v)));
  const rows = [...state.days].reverse().map(d => `
    <tr>
      <th scope="row">${escapeHTML(longDay(d.day))}</th>
      <td>${d.steps !== undefined ? Number(d.steps).toLocaleString('en-IN') : '—'}</td>
      <td>${cell(d.active_kcal)}</td>
      <td>${cell(d.basal_kcal)}</td>
      <td>${d.sleep_hours !== undefined ? formatHours(d.sleep_hours) : '—'}</td>
      <td>${d.fell_asleep ? `${cell(d.fell_asleep)} → ${cell(d.woke)}` : '—'}</td>
      <td>${cell(d.resting_hr)}</td>
      <td>${cell(d.hrv_ms)}</td>
      <td>${cell(d.weight_kg)}</td>
    </tr>`).join('');
  el.innerHTML = `
    <table class="hl-table">
      <thead><tr>
        <th scope="col">Day</th><th scope="col">Steps</th><th scope="col">Active kcal</th>
        <th scope="col">Resting kcal</th><th scope="col">Asleep</th><th scope="col">Bed → wake</th>
        <th scope="col">Resting HR</th><th scope="col">HRV ms</th><th scope="col">Weight kg</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
