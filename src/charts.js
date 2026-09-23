// ======================================================
// Chart.js pieces shared across screens.
//
// The Dashboard, Net Worth and FI Planner each carried their own copy of
// the ₹ axis formatter, the accent gradient fill and the line/bar toggle,
// and the Dashboard and Net Worth each built the same two charts from the
// same rows with slightly different numbers in them. One copy of each now.
// Nothing here reaches into a view's state: every function takes a canvas
// and the data to draw, and returns the Chart it made.
// ======================================================

import { Chart } from './vendor.js';
import {
  formatINR, formatINRFull, cssVar, destroyChart, CHART_COLORS, ASSET_COLORS,
  computeNet, computeAssets,
} from './utils.js';

/** '#38bdf8' + 0.2 → 'rgba(56,189,248,0.2)'. Chart.js paints to canvas, where a CSS token never resolves. */
export function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Axis tick callback: ₹1.2Cr / ₹4.5L / ₹80k. Sign-safe. */
export function inrTicks(v) {
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  return '₹' + (v / 1000).toFixed(0) + 'k';
}

/** A top-to-bottom fade from `colour` at `alpha` to transparent, for an area fill. */
export function verticalGradient(canvas, height, colour = CHART_COLORS.accent, alpha = 0.22) {
  const gradient = canvas.getContext('2d').createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, withAlpha(colour, alpha));
  gradient.addColorStop(1, withAlpha(colour, 0));
  return gradient;
}

/** The faint horizontal rules every y-axis uses. */
export const GRID_LINE = 'rgba(148,163,184,0.06)';

/** A monthly time axis, labels like "Sep 25". */
export function monthAxis() {
  return {
    type: 'time',
    time: { unit: 'month', displayFormats: { month: 'MMM yy' } },
    grid: { display: false },
    ticks: { maxRotation: 0 },
  };
}

/**
 * Wire a two-button line/bar toggle. `onChange(type)` runs after the active
 * class has moved, so the handler only has to redraw.
 */
export function wireChartToggle(lineId, barId, onChange) {
  const line = document.getElementById(lineId);
  const bar  = document.getElementById(barId);
  if (!line || !bar) return;
  const pick = type => {
    line.classList.toggle('active', type === 'line');
    bar.classList.toggle('active', type === 'bar');
    onChange(type);
  };
  line.addEventListener('click', () => pick('line'));
  bar.addEventListener('click',  () => pick('bar'));
}

/**
 * Net worth over time, as a line with an area fill or as bars.
 *
 * `withAssets` adds the total-assets series as a dashed line and shows the
 * legend; without it the chart is the single net worth series, unlabelled.
 * Returns the Chart, or null when there is nothing to draw. The caller keeps
 * the reference and destroys it through `destroyChart`.
 */
export function netWorthSeriesChart(canvas, entries, type = 'line', { withAssets = false } = {}) {
  if (!canvas || !entries.length) return null;
  const isBar = type === 'bar';

  const datasets = [{
    label: 'Net worth',
    data: entries.map(computeNet),
    borderColor: CHART_COLORS.accent,
    backgroundColor: isBar ? withAlpha(CHART_COLORS.accent, 0.32) : verticalGradient(canvas, 220),
    borderWidth: 2, fill: !isBar, tension: 0.4,
    pointBackgroundColor: CHART_COLORS.accent, pointRadius: 3, pointHoverRadius: 6,
  }];

  if (withAssets) {
    datasets.push({
      label: 'Total assets',
      data: entries.map(computeAssets),
      borderColor: CHART_COLORS.success,
      backgroundColor: withAlpha(CHART_COLORS.success, 0.08),
      borderWidth: 1.5, fill: false, tension: 0.4,
      pointRadius: 0, pointHoverRadius: 4, borderDash: [4, 4],
    });
  }

  return new Chart(canvas, {
    type: isBar ? 'bar' : 'line',
    data: { labels: entries.map(e => e.date), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: withAssets ? { mode: 'index', intersect: false } : undefined,
      plugins: {
        legend: withAssets
          ? { position: 'top', labels: { usePointStyle: true, pointStyleWidth: 8, padding: 16, font: { size: 11 } } }
          : { display: false },
        tooltip: {
          callbacks: {
            label: ctx => withAssets
              ? ` ${ctx.dataset.label}: ${formatINRFull(ctx.parsed.y)}`
              : ' ' + formatINRFull(ctx.parsed.y),
          },
        },
      },
      scales: {
        x: monthAxis(),
        y: { grid: { color: GRID_LINE }, ticks: { callback: inrTicks } },
      },
    },
  });
}

const ASSET_FIELDS = [
  { key: 'stocks',       label: 'Stocks' },
  { key: 'mutual_funds', label: 'Mutual Funds' },
  { key: 'cash',         label: 'Cash' },
  { key: 'epf',          label: 'EPF' },
  { key: 'gold',         label: 'Gold' },
  { key: 'fds',          label: 'FDs' },
];

/** Asset allocation of one snapshot as a doughnut. Null when there is no snapshot. */
export function allocationDoughnut(canvas, latest) {
  if (!canvas || !latest) return null;
  const fields = ASSET_FIELDS.filter(f => (latest[f.key] || 0) > 0);

  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: fields.map(f => f.label),
      datasets: [{
        data: fields.map(f => latest[f.key] || 0),
        backgroundColor: fields.map(f => ASSET_COLORS[f.key]),
        // Resolved off the document — `var(--bg-card)` never resolves on a canvas.
        borderColor: cssVar('--bg-card', '#162032'),
        borderWidth: 3, hoverOffset: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '72%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true, pointStyleWidth: 8, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatINR(ctx.parsed)}` } },
      },
    },
  });
}

/** Destroy every chart in a `{ key: Chart }` map and return an empty one. */
export function destroyCharts(map) {
  for (const key of Object.keys(map)) destroyChart(map[key]);
  return {};
}
