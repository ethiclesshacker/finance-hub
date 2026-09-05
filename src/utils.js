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
  // The bundled face registers as 'Inter Variable' (@fontsource-variable), not
  // 'Inter'. A canvas font string with only an unknown family falls back to
  // the browser default — which is how every chart spent months quietly
  // rendering its ticks in Times New Roman.
  font: { family: "'Inter Variable', Inter, system-ui, sans-serif", size: 11 },
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
// KPI cards
//
// Four screens rendered this same card from four copies of the same template
// string, which is how they drifted: one called the tint `glow` and another
// called it `color`, the badge and the footnote ran together on one line, and
// the progress bar carried its spacing in an inline style. One renderer now,
// and one place to change the shape of a KPI.
//
// A card is: { id, label, icon, tone, value, unit, raw, sub, badge, progress,
//              tooltip }
//   tone     — a semantic name ('accent' | 'success' | 'warning' | 'danger' |
//              'purple' | 'pink' | 'teal'). It drives both the icon wash and
//              the hover glow, so a card cannot be tinted one colour and
//              washed another, which is what happened when they were two
//              separate hand-written values.
//   unit     — 'months', '/mo', 'pts', '×'. Set apart from the figure rather
//              than concatenated into it, so the number stays the number.
//   progress — 0-100; omit entirely for a card with no meter.
// ======================================================

const KPI_TONES = ['accent', 'success', 'warning', 'danger', 'purple', 'pink', 'teal'];

export function renderKpiCards(container, kpis) {
  if (!container) return;

  container.innerHTML = kpis.map(k => {
    const tone = KPI_TONES.includes(k.tone) ? k.tone : 'accent';
    return `
    <div class="kpi-card" id="${escapeHTML(k.id)}"
         style="--kpi-tint:var(--${tone});--kpi-glow:var(--${tone}-glow)"
         title="${escapeHTML(k.tooltip || '')}">
      <div class="kpi-header">
        <span class="kpi-label">${escapeHTML(k.label)}</span>
        <span class="kpi-icon" aria-hidden="true"><i class="fas ${escapeHTML(k.icon)}"></i></span>
      </div>
      <div class="kpi-value">${escapeHTML(k.value)}${
        k.unit ? `<span class="kpi-unit">${escapeHTML(k.unit)}</span>` : ''}</div>
      ${k.progress !== undefined && k.progress !== null ? `
        <div class="progress-wrap kpi-meter">
          <div class="progress-bar" style="width:${Math.max(0, Math.min(100, k.progress))}%"></div>
        </div>` : ''}
      <div class="kpi-sub">
        ${k.badge ? `<span class="kpi-badge ${escapeHTML(k.badge.type)}">${escapeHTML(k.badge.text)}</span>` : ''}
        ${k.sub ? `<span>${escapeHTML(k.sub)}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  kpis.forEach(k => makeCopyable(container.querySelector('#' + CSS.escape(k.id)), k.raw));
}

// ======================================================
// Table cells
//
// A column of money is read by comparing figures down it, which needs three
// things the tables were not doing: one decimal convention, tabular digits,
// and right alignment. The Amount column showed "₹760", "₹879.4" and
// "₹10,168.64" side by side, because toLocaleString with no options keeps up
// to three fraction digits — so the same column had three different shapes.
// ======================================================

/** A right-aligned numeric table cell. `tone` is a semantic token name. */
export function numCell(text, { tone, bold = false } = {}) {
  const style = [
    tone ? `color:var(--${tone})` : '',
    bold ? 'font-weight:600' : '',
  ].filter(Boolean).join(';');
  return `<span class="num"${style ? ` style="${style}"` : ''}>${escapeHTML(text)}</span>`;
}

/** Edit and delete for one row. Was four copies of the same inline flexbox. */
export function rowActions(editCall, deleteCall, noun = 'row') {
  return `
    <div class="row-actions">
      <button type="button" class="btn-icon" onclick="${editCall}"
              title="Edit ${noun}" aria-label="Edit ${noun}"><i class="fas fa-pencil"></i></button>
      <button type="button" class="btn-icon is-danger" onclick="${deleteCall}"
              title="Delete ${noun}" aria-label="Delete ${noun}"><i class="fas fa-trash"></i></button>
    </div>`;
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
// Combobox — type it, or pick one you have used before.
//
// A select cannot hold a value it was not given, so a field that needs both
// ends up as two controls: a dropdown, and a text box beside it for everything
// the dropdown does not know. That is two decisions ("which of these?" and
// "is my answer in there?") for one piece of information.
//
// This is one control. It is a text input — so anything can be typed, and the
// value is read with `.value` exactly as before — with the answers you have
// already given offered underneath it, filtered as you type.
// ======================================================

/**
 * The markup. `options` is a list of strings, in the order they should be
 * offered — most-used first beats alphabetical for a field you fill in daily.
 */
export function comboboxHTML({ id, value = '', placeholder = '', options = [] }) {
  return `
    <div class="cb" data-cb="${escapeHTML(id)}">
      <input type="text" class="form-input cb-input" id="${escapeHTML(id)}"
             value="${escapeHTML(value)}" placeholder="${escapeHTML(placeholder)}"
             autocomplete="off" role="combobox" aria-expanded="false"
             aria-controls="${escapeHTML(id)}-list" aria-autocomplete="list" />
      <button type="button" class="cb-toggle" tabindex="-1" aria-label="Show what you have used before">
        <i class="fas fa-chevron-down" aria-hidden="true"></i>
      </button>
      <ul class="cb-list" id="${escapeHTML(id)}-list" role="listbox" hidden
          data-options="${escapeHTML(JSON.stringify(options))}"></ul>
    </div>`;
}

/**
 * Wire one up. Safe to call on markup that is already wired — it is idempotent,
 * which matters because the points modal re-renders its body on a tab switch.
 */
export function wireCombobox(id) {
  const input = document.getElementById(id);
  const list = document.getElementById(`${id}-list`);
  if (!input || !list || input.dataset.cbWired) return;
  input.dataset.cbWired = '1';

  const wrap = input.closest('.cb');
  let options = [];
  try { options = JSON.parse(list.dataset.options || '[]'); } catch { options = []; }
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  /**
   * `whole` is for opening the list rather than typing into it: arriving at a
   * field that already holds an answer and wanting a different one is as
   * common as filling an empty one, so focusing shows everything.
   *
   * It is deliberately not applied while typing. "am" is a prefix of Amazon
   * and also, in this ledger, a merchant of its own — so treating an exact
   * match as "show everything" made typing `am` list all fifty merchants.
   */
  const paint = ({ whole = false } = {}) => {
    const needle = input.value.trim().toLowerCase();
    const exact = whole && options.some(o => o.toLowerCase() === needle);
    const matches = (!needle || exact) ? options : options.filter(o => o.toLowerCase().includes(needle));

    if (!matches.length) { close(); return; }

    list.innerHTML = matches.slice(0, 50).map((option, index) => {
      const current = option.toLowerCase() === needle;
      return `
      <li class="cb-option ${index === active ? 'is-active' : ''} ${current ? 'is-selected' : ''}"
          role="option" id="${escapeHTML(id)}-opt-${index}" aria-selected="${current}"
          data-value="${escapeHTML(option)}">${escapeHTML(option)}</li>`;
    }).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');

    // Opening a filled field shows the whole list, which can be fifty long —
    // so put the answer it currently holds where the eye already is.
    list.querySelector('.cb-option.is-selected')?.scrollIntoView({ block: 'nearest' });

    // Up, when there is no room below. The modal body scrolls, so a panel that
    // simply hung downwards would be cut off by it rather than overflowing.
    const room = window.innerHeight - input.getBoundingClientRect().bottom;
    wrap.classList.toggle('is-above', room < 220);
  };

  const commit = (value) => {
    input.value = value;
    // The points preview recalculates on input, so a pick has to look like
    // typing — otherwise choosing a merchant leaves the preview stale.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Closed *after* the event, not before: that handler repaints, and a value
    // that exactly matches an option opens the full list again. Picking one
    // would leave the list standing open over the next field.
    close();
  };

  input.addEventListener('input', () => { active = -1; paint(); });
  input.addEventListener('focus', () => paint({ whole: true }));

  wrap.querySelector('.cb-toggle').addEventListener('mousedown', e => {
    e.preventDefault();                       // keep focus in the input
    if (list.hidden) { input.focus(); paint({ whole: true }); } else close();
  });

  input.addEventListener('keydown', e => {
    const items = [...list.querySelectorAll('.cb-option')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { paint({ whole: true }); return; }
      active = e.key === 'ArrowDown'
        ? Math.min(active + 1, items.length - 1)
        : Math.max(active - 1, 0);
      items.forEach((el, i) => el.classList.toggle('is-active', i === active));
      items[active]?.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', items[active]?.id || '');
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault();
      commit(items[active].dataset.value);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();                     // close the list, not the modal
      close();
    }
  });

  // mousedown, not click: the input's blur fires first and would hide the
  // option before the click landed on it.
  list.addEventListener('mousedown', e => {
    const option = e.target.closest('.cb-option');
    if (!option) return;
    e.preventDefault();
    commit(option.dataset.value);
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
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
