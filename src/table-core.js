// ======================================================
// What a table shows: the pure half.
//
// Grid.js sorted and searched whatever string a cell rendered to, so dates
// sorted as "01 Aug 2026" < "12 Sep 2025" < "30 Jan 2026", amounts sorted by
// the HTML around them, and a search for "sep" missed every September row
// because it looked at the ISO date. Here every column says what its value IS
// (a number, a date, text) and how to show it, and sorting and searching read
// the value while the eye reads the rendering.
//
// No DOM in this file, so every rule below is tested in node.
// ======================================================

/** The raw value of a column for a row, or null. */
export function valueOf(column, row) {
  const v = column.value ? column.value(row) : row[column.key];
  if (v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) return null;
  return v;
}

/**
 * Compare two raw values of one column type, ascending. Nulls are handled by
 * the caller, so "no value" can stay last in both directions.
 */
export function compareValues(a, b, type = 'text') {
  if (type === 'number') return Number(a) - Number(b);
  if (type === 'date') {
    // ISO dates and timestamps compare correctly as strings; Date objects and
    // epoch numbers are normalised to a number first.
    const x = a instanceof Date ? a.getTime() : a;
    const y = b instanceof Date ? b.getTime() : b;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
  }
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * Rows sorted by one column. Stable, so rows that tie keep the order they
 * arrived in (newest first, usually), and rows with no value go last whichever
 * way the column is sorted — an empty cell is never "the biggest".
 */
export function sortRows(rows, columns, sort) {
  if (!sort?.key) return rows.slice();
  const column = columns.find(c => c.key === sort.key);
  if (!column || column.sortable === false) return rows.slice();
  const sign = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, v: valueOf(column, row) }))
    .sort((p, q) => {
      if (p.v === null && q.v === null) return p.index - q.index;
      if (p.v === null) return 1;
      if (q.v === null) return -1;
      return sign * compareValues(p.v, q.v, column.type) || p.index - q.index;
    })
    .map(entry => entry.row);
}

/** The first direction a click on this column sorts in. */
export function firstDirection(column) {
  if (column.firstDir) return column.firstDir;
  return column.type === 'number' || column.type === 'date' ? 'desc' : 'asc';
}

/** The next sort after a click on a column header. */
export function nextSort(current, column) {
  if (current?.key !== column.key) return { key: column.key, dir: firstDirection(column) };
  return { key: column.key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

const stripTags = html => String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** Everything a person might type to find a value: what it is, and how it is shown. */
function searchTextOf(column, row) {
  if (column.searchable === false) return '';
  const parts = [];
  const v = valueOf(column, row);
  if (v !== null) {
    parts.push(String(v));
    if (column.type === 'number' && Number.isFinite(Number(v))) {
      parts.push(Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
    }
    if (column.type === 'date') {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
      if (m) parts.push(`${MONTHS[Number(m[2]) - 1]} ${m[1]}`);
    }
  }
  if (column.search) parts.push(column.search(row));
  if (column.render) parts.push(stripTags(column.render(row)));
  return parts.join(' ');
}

/** Lower-case, and the rupee sign and grouping commas are not what anyone types. */
const fold = s => String(s).toLowerCase().replace(/[₹,]/g, '').replace(/\s+/g, ' ');

/**
 * Rows matching a query. Every word must appear somewhere in the row, in any
 * column, so "uber work" finds Uber rides marked as work.
 */
export function filterRows(rows, columns, query) {
  const words = fold(query || '').trim().split(' ').filter(Boolean);
  if (!words.length) return rows.slice();
  return rows.filter(row => {
    const hay = fold(columns.map(c => searchTextOf(c, row)).join(' '));
    return words.every(w => hay.includes(w));
  });
}

/**
 * Which rows are on a page. `page` is 0-based and clamped, so a filter that
 * shrinks the list lands on its last page rather than an empty one. A size of
 * 0 or Infinity shows everything.
 */
export function paginate(total, page, size) {
  const all = !size || !Number.isFinite(size);
  const pages = all ? 1 : Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
  const start = all ? 0 : p * size;
  const end = all ? total : Math.min(total, start + size);
  return { page: p, pages, start, end };
}

/**
 * The page buttons to draw: always the first and last, a window around the
 * current page, and a gap marker (null) where pages are skipped.
 *   pageWindow(5, 20) → [0, null, 3, 4, 5, 6, 7, null, 19]
 */
export function pageWindow(page, pages, radius = 2) {
  if (pages <= 2 * radius + 5) return Array.from({ length: pages }, (_, i) => i);
  const out = [0];
  let from = Math.max(1, Math.min(page - radius, pages - 2 * radius - 2));
  let to = Math.min(pages - 2, Math.max(page + radius, 2 * radius + 1));
  // A gap that would hide a single page shows that page instead.
  if (from === 2) from = 1;
  if (to === pages - 3) to = pages - 2;
  if (from > 1) out.push(null);
  for (let i = from; i <= to; i++) out.push(i);
  if (to < pages - 2) out.push(null);
  out.push(pages - 1);
  return out;
}
