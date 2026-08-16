import { Chart } from './vendor.js';

// ======================================================
// Formatting utilities
// ======================================================

export function formatINR(value, decimals = 0) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const abs = Math.abs(value);
  // Sign goes in front of the ₹, not inside the number — "−₹1.20 Cr", not "₹-1.20 Cr".
  const sign = value < 0 ? '−' : '';
  let formatted;
  if (abs >= 1e7) {
    formatted = (abs / 1e7).toFixed(2) + ' Cr';
  } else if (abs >= 1e5) {
    formatted = (abs / 1e5).toFixed(2) + ' L';
  } else if (abs >= 1000) {
    formatted = (abs / 1000).toFixed(1) + 'k';
  } else {
    formatted = abs.toFixed(decimals);
  }
  return sign + '₹' + formatted;
}

export function formatINRFull(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  // Keep the sign. Math.abs() alone rendered a negative net worth as a healthy
  // positive number — the worst possible way for this app to be wrong.
  const sign = value < 0 ? '−' : '';
  return sign + '₹' + Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

export function formatPercent(value, decimals = 1) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return value.toFixed(decimals) + '%';
}

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function todayISO() {
  // Local date, not UTC. toISOString() east of UTC returns yesterday's date
  // for anyone opening the app before ~05:30 IST.
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ======================================================
// Chart helpers
// ======================================================

export const CHART_COLORS = {
  accent:  '#38bdf8',
  purple:  '#a78bfa',
  success: '#10b981',
  warning: '#f59e0b',
  danger:  '#ef4444',
  pink:    '#f472b6',
  teal:    '#2dd4bf',
  orange:  '#fb923c',
};

export const ASSET_COLORS = {
  stocks:       '#38bdf8',
  mutual_funds: '#a78bfa',
  cash:         '#10b981',
  epf:          '#f59e0b',
  gold:         '#f472b6',
  fds:          '#2dd4bf',
};

export const CHART_DEFAULTS = {
  color: '#94a3b8',
  borderColor: 'rgba(148,163,184,0.1)',
  font: { family: 'Inter', size: 11 },
};

export function applyChartDefaults() {
  Chart.defaults.color = CHART_DEFAULTS.color;
  Chart.defaults.borderColor = CHART_DEFAULTS.borderColor;
  Chart.defaults.font.family = CHART_DEFAULTS.font.family;
  Chart.defaults.font.size = CHART_DEFAULTS.font.size;
}

export function destroyChart(chartRef) {
  if (chartRef) {
    try { chartRef.destroy(); } catch (_) {}
  }
  return null;
}

// ======================================================
// Toast notification
// ======================================================

let toastTimeout = null;

export function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  if (toastTimeout) clearTimeout(toastTimeout);

  const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fas ${icon}"></i> ${message}`;
  document.body.appendChild(toast);

  toastTimeout = setTimeout(() => toast.remove(), 3000);
}

// ======================================================
// Click-to-copy KPI cards
// ======================================================

export function makeCopyable(cardEl, rawValue) {
  if (!cardEl) return;
  // Clickable, so it has to be reachable and operable from the keyboard too.
  cardEl.tabIndex = 0;
  cardEl.setAttribute('role', 'button');
  cardEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cardEl.click(); }
  });
  cardEl.addEventListener('click', () => {
    navigator.clipboard.writeText(String(rawValue)).catch(() => {});
    cardEl.classList.add('copied');
    setTimeout(() => cardEl.classList.remove('copied'), 1500);
  });
}

// ======================================================
// CSV Export
// ======================================================

export function downloadCSV(headers, rows, filename) {
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ======================================================
// Modal helpers
// ======================================================

export function openModal(html) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal();
  });
  // Close on Escape
  document.addEventListener('keydown', handleEscape);
}

function handleEscape(e) {
  if (e.key === 'Escape') closeModal();
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', handleEscape);
}

// ======================================================
// Number parsing
// ======================================================

export function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ======================================================
// HTML escaping
//
// Every view builds its markup with template strings and innerHTML, so any
// database value dropped into one is executable unless it goes through here.
// ======================================================

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// ======================================================
// Canvas colour resolution
//
// Chart.js paints to a canvas, where `var(--token)` never resolves — it
// silently falls back and the styling is quietly lost. Read the token off the
// document instead.
// ======================================================

export function cssVar(name, fallback = '#000000') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ======================================================
// FX Rate
// ======================================================

export async function fetchEURtoINR(fallback = 110.0) {
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=INR');
    const data = await res.json();
    return data?.rates?.INR ?? fallback;
  } catch {
    return fallback;
  }
}

// ======================================================
// Net worth computations
//
// Moved to ./networth-math.js — pure and import-free, so the maths runs
// (and is testable) outside a browser. Re-exported here so every existing
// `from '../utils.js'` import keeps working unchanged.
// ======================================================

export {
  computeAssets, computeLiquid, computeCashLike, computeEmergencyFund, computeNet,
} from './networth-math.js';
