// ======================================================
// Data tables: sort by what a value is, search what is shown, page anywhere.
//
//   const table = createTable(container, {
//     id: 'points-tx',                       // remembers sort and page size
//     columns: [
//       { key: 'date', label: 'Date', type: 'date', render: t => formatDate(t.date) },
//       { key: 'amount', label: 'Amount', type: 'number', align: 'end', render: t => … },
//       { key: 'actions', label: 'Actions', actions: true, render: t => rowActions(…) },
//     ],
//     defaultSort: { key: 'date', dir: 'desc' },
//     empty: 'No transactions yet.',
//   });
//   table.setRows(rows);     // keeps sort and page across redraws
//   table.setQuery('uber');  // back to page one
//   table.rows();            // what is shown, filtered and sorted, every page
//
// The rules themselves live in table-core.js.
// ======================================================

import { escapeHTML } from './utils.js';
import { sortRows, filterRows, paginate, pageWindow, nextSort } from './table-core.js';

const PAGE_SIZES = [10, 25, 50, 100, 0];   // 0 = all

function loadPrefs(id) {
  if (!id) return {};
  try { return JSON.parse(localStorage.getItem(`table:${id}`) || '{}') || {}; } catch { return {}; }
}
function savePrefs(id, prefs) {
  if (!id) return;
  try { localStorage.setItem(`table:${id}`, JSON.stringify(prefs)); } catch { /* private window */ }
}

export function createTable(container, {
  id = null, columns, defaultSort = null, empty = 'Nothing here yet.', pageSize = 10,
} = {}) {
  const cols = columns.map(c => ({
    ...c,
    sortable: c.actions ? false : c.sortable !== false,
    searchable: c.actions ? false : c.searchable !== false,
    align: c.actions ? 'end' : c.align,
  }));
  const prefs = loadPrefs(id);
  const state = {
    rows: [],
    query: '',
    page: 0,
    size: PAGE_SIZES.includes(prefs.size) ? prefs.size : pageSize,
    sort: prefs.sort && cols.some(c => c.key === prefs.sort.key && c.sortable) ? prefs.sort : defaultSort,
  };
  let view = [];

  container.classList.add('dt');
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  container.addEventListener('keydown', onKeydown);

  function recompute() {
    view = sortRows(filterRows(state.rows, cols, state.query), cols, state.sort);
  }

  function header() {
    return cols.map(c => {
      const active = state.sort?.key === c.key;
      const ariaSort = active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const attrs = `scope="col"${c.align === 'end' ? ' data-align="end"' : ''}${c.sortable ? ` aria-sort="${ariaSort}"` : ''}`;
      if (!c.sortable) {
        return `<th ${attrs}>${c.actions ? `<span class="sr-only">${escapeHTML(c.label)}</span>` : escapeHTML(c.label)}</th>`;
      }
      const icon = active ? (state.sort.dir === 'asc' ? 'fa-sort-up' : 'fa-sort-down') : 'fa-sort';
      return `<th ${attrs}>
        <button type="button" class="dt-sort${active ? ' is-active' : ''}" data-sort="${escapeHTML(c.key)}"
                title="Sort by ${escapeHTML(c.label)}">
          <span>${escapeHTML(c.label)}</span><i class="fas ${icon}" aria-hidden="true"></i>
        </button>
      </th>`;
    }).join('');
  }

  function footer(p) {
    const total = view.length;
    const range = total ? `${p.start + 1}–${p.end} of ${total}` : '0 rows';
    const pages = pageWindow(p.page, p.pages).map(i => i === null
      ? '<span class="dt-gap" aria-hidden="true">…</span>'
      : `<button type="button" class="dt-page${i === p.page ? ' is-current' : ''}" data-page="${i}"
                 ${i === p.page ? 'aria-current="page"' : ''} aria-label="Page ${i + 1}">${i + 1}</button>`).join('');
    const nav = (target, icon, label, disabled) =>
      `<button type="button" class="dt-page dt-nav" data-page="${target}" aria-label="${label}" title="${label}"
               ${disabled ? 'disabled' : ''}><i class="fas ${icon}" aria-hidden="true"></i></button>`;
    const sizes = PAGE_SIZES.map(s =>
      `<option value="${s}"${s === state.size ? ' selected' : ''}>${s || 'All'}</option>`).join('');
    return `
      <div class="dt-footer">
        <div class="dt-size">
          <label>Rows <select class="form-select dt-size-select" aria-label="Rows per page">${sizes}</select></label>
          <span class="dt-range mono" aria-live="polite">${range}</span>
        </div>
        ${p.pages > 1 ? `
        <nav class="dt-pager" aria-label="Pages">
          ${nav(0, 'fa-angles-left', 'First page', p.page === 0)}
          ${nav(p.page - 1, 'fa-angle-left', 'Previous page', p.page === 0)}
          <span class="dt-pages">${pages}</span>
          ${nav(p.page + 1, 'fa-angle-right', 'Next page', p.page >= p.pages - 1)}
          ${nav(p.pages - 1, 'fa-angles-right', 'Last page', p.page >= p.pages - 1)}
          <label class="dt-goto">Page
            <input type="number" class="form-input dt-goto-input" min="1" max="${p.pages}" value="${p.page + 1}"
                   inputmode="numeric" aria-label="Go to page"> of ${p.pages}
          </label>
        </nav>` : ''}
      </div>`;
  }

  function render() {
    const p = paginate(view.length, state.page, state.size);
    state.page = p.page;
    const body = view.slice(p.start, p.end).map(row => `<tr>${cols.map(c => {
      const content = c.render ? c.render(row) : escapeHTML(row[c.key] ?? '—');
      return `<td${c.align === 'end' ? ' data-align="end"' : ''}>${content}</td>`;
    }).join('')}</tr>`).join('');
    const none = state.rows.length && state.query
      ? `Nothing matches “${escapeHTML(state.query)}”.`
      : escapeHTML(empty);
    // Focus survives a repaint only if we put it back.
    const focused = document.activeElement && container.contains(document.activeElement)
      ? document.activeElement.dataset.sort ?? (document.activeElement.classList.contains('dt-goto-input') ? 'goto' : null)
      : null;
    container.innerHTML = `
      <div class="dt-scroll">
        <table class="dt-table">
          <thead><tr>${header()}</tr></thead>
          <tbody>${body || `<tr><td class="dt-empty" colspan="${cols.length}">${none}</td></tr>`}</tbody>
        </table>
      </div>
      ${view.length ? footer(p) : ''}`;
    if (focused === 'goto') container.querySelector('.dt-goto-input')?.focus();
    else if (focused) container.querySelector(`[data-sort="${CSS.escape(focused)}"]`)?.focus();
  }

  function goTo(page) {
    state.page = page;
    render();
    // A new page should start at its top row, not wherever the old one ended.
    const top = container.getBoundingClientRect().top;
    if (top < 0) container.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function onClick(event) {
    const sortBtn = event.target.closest('[data-sort]');
    if (sortBtn && container.contains(sortBtn)) {
      const column = cols.find(c => c.key === sortBtn.dataset.sort);
      state.sort = nextSort(state.sort, column);
      state.page = 0;
      savePrefs(id, { size: state.size, sort: state.sort });
      recompute();
      render();
      return;
    }
    const pageBtn = event.target.closest('[data-page]');
    if (pageBtn && container.contains(pageBtn) && !pageBtn.disabled) goTo(Number(pageBtn.dataset.page));
  }

  function onChange(event) {
    if (event.target.classList.contains('dt-size-select')) {
      // Keep the first visible row on screen when the page size changes.
      const first = state.size ? state.page * state.size : 0;
      state.size = Number(event.target.value);
      state.page = state.size ? Math.floor(first / state.size) : 0;
      savePrefs(id, { size: state.size, sort: state.sort });
      render();
    } else if (event.target.classList.contains('dt-goto-input')) {
      goTo(Number(event.target.value) - 1);
    }
  }

  function onKeydown(event) {
    if (event.key === 'Enter' && event.target.classList.contains('dt-goto-input')) {
      event.preventDefault();
      goTo(Number(event.target.value) - 1);
    }
  }

  const api = {
    /** New data. Sort, query and page are kept; the page is clamped if the list shrank. */
    setRows(rows) {
      state.rows = rows || [];
      recompute();
      render();
      return api;
    },
    /** A new search. Back to the first page: page 7 of the old results means nothing. */
    setQuery(query) {
      const q = String(query || '').trim();
      if (q === state.query) return api;
      state.query = q;
      state.page = 0;
      recompute();
      render();
      return api;
    },
    /** Every row the table currently shows, across all pages, in its order. */
    rows() {
      return view.slice();
    },
    destroy() {
      container.removeEventListener('click', onClick);
      container.removeEventListener('change', onChange);
      container.removeEventListener('keydown', onKeydown);
      container.classList.remove('dt');
      container.innerHTML = '';
    },
  };
  return api;
}
