// ======================================================
// Formatting utilities
// ======================================================

export function formatINR(value, decimals = 0) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const abs = Math.abs(value);
  let formatted;
  if (abs >= 1e7) {
    formatted = (value / 1e7).toFixed(2) + ' Cr';
  } else if (abs >= 1e5) {
    formatted = (value / 1e5).toFixed(2) + ' L';
  } else if (abs >= 1000) {
    formatted = (value / 1000).toFixed(1) + 'k';
  } else {
    formatted = value.toFixed(decimals);
  }
  return '₹' + formatted;
}

export function formatINRFull(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return '₹' + Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

export function formatPoints(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return parseFloat(value).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' pts';
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

export function formatMonthYear(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + '-01');
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
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

export function sign(value, prev) {
  if (prev === 0 || prev === undefined) return '';
  const pct = ((value - prev) / Math.abs(prev)) * 100;
  const arrow = pct >= 0 ? '↑' : '↓';
  return `${arrow} ${Math.abs(pct).toFixed(1)}%`;
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
