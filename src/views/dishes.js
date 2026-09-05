// ======================================================
// Dishes — the dish dictionary, editable.
//
// One row per distinct thing you have eaten, with the numbers the Food screen
// prices every meal from. The resolver fills these in; this page is where a
// person overrules it. Two writes matter:
//
//   - An edit is marked manual + verified. It outranks every automatic source,
//     the resolver never revisits it, and — because the rollup reads the
//     dictionary at render time — it re-values every meal that ever had the
//     dish. There is no "apply retroactively" switch; it is the only mode.
//   - A merge folds one spelling into another by rewriting the past meals that
//     used it, so the ranking and the calories stop counting one dish twice.
//
// Names are not editable here. A dish's key is its normalized name, and a
// rename would orphan every meal spelled the old way — that is what merge is
// for.
// ======================================================

import * as api from '../ledger/api.js';
import { SOURCE_LABEL } from '../ledger/nutrition.js';
import { normalizeName } from '../ledger/normalize.js';
import { escapeHTML, showToast } from '../utils.js';

let rows = [];               // the dictionary, every row
let usage = new Map();       // normalized_name -> { count, last }
let query = '';
let filter = 'all';          // all | unverified | unpriced | estimates | verified
let sort = 'eaten';          // eaten | name | kcal | updated
let editingId = null;        // row id in edit mode, or 'new'
let mergingId = null;        // row id showing the merge panel
let resetArmed = null;       // row id whose Reset needs a second click

const NUM_FIELDS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'portion_g'];
const LIMITS = { kcal: [0, 20000], protein_g: [0, 500], carbs_g: [0, 2000], fat_g: [0, 500], portion_g: [0.1, 20000] };

export async function renderDishes(container) {
  query = ''; filter = 'all'; sort = 'eaten';
  editingId = null; mergingId = null; resetArmed = null;

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Dishes</h2>
        <p>Per serving as sold. A change here re-values every meal that ever had the dish.</p>
      </div>
      <div class="table-actions">
        <button type="button" class="btn-sm btn-accent" id="dd-add">
          <i class="fas fa-plus" aria-hidden="true"></i> Add dish
        </button>
      </div>
    </div>

    <div class="page-body">
      <div class="table-section dd-section">
        <div class="table-toolbar dd-toolbar">
          <div class="dd-search-wrap">
            <label class="sr-only" for="dd-search">Search dishes</label>
            <input type="search" class="form-input dd-search" id="dd-search" placeholder="Search dishes" autocomplete="off" />
          </div>
          <div class="dd-controls">
            <label class="sr-only" for="dd-filter">Show</label>
            <select class="form-select dd-select" id="dd-filter">
              <option value="all">All dishes</option>
              <option value="unverified">Not checked by you</option>
              <option value="estimates">Model estimates</option>
              <option value="unpriced">No calories yet</option>
              <option value="verified">Checked by you</option>
            </select>
            <label class="sr-only" for="dd-sort">Sort</label>
            <select class="form-select dd-select" id="dd-sort">
              <option value="eaten">Most eaten</option>
              <option value="name">Name</option>
              <option value="kcal">Highest calories</option>
              <option value="updated">Recently changed</option>
            </select>
            <span class="dd-count text-muted mono" id="dd-count" aria-live="polite"></span>
          </div>
        </div>
        <div class="dd-scroll">
          <table class="dd-table">
            <thead>
              <tr>
                <th scope="col" class="dd-col-name">Dish</th>
                <th scope="col" class="dd-num">Eaten</th>
                <th scope="col" class="dd-num">kcal</th>
                <th scope="col" class="dd-num">Protein</th>
                <th scope="col" class="dd-num">Carbs</th>
                <th scope="col" class="dd-num">Fat</th>
                <th scope="col" class="dd-num">Portion</th>
                <th scope="col">Source</th>
                <th scope="col" class="dd-actions"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody id="dd-rows">
              <tr><td colspan="9"><div class="skeleton skeleton--table"></div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.getElementById('dd-search').addEventListener('input', e => { query = e.target.value.trim(); paint(); });
  document.getElementById('dd-filter').addEventListener('change', e => { filter = e.target.value; paint(); });
  document.getElementById('dd-sort').addEventListener('change', e => { sort = e.target.value; paint(); });
  document.getElementById('dd-add').addEventListener('click', () => {
    editingId = 'new'; mergingId = null; resetArmed = null;
    paint();
    document.querySelector('#dd-rows input[name="display_name"]')?.focus();
  });

  const tbody = document.getElementById('dd-rows');
  tbody.addEventListener('click', onClick);
  tbody.addEventListener('keydown', onKey);

  await load();
}

// ── Data ─────────────────────────────────────────────

async function load() {
  try {
    const [dict, result] = await Promise.all([
      api.foodDictionaryAll(),
      api.searchEvents({ types: ['food'], limit: 1000 }).catch(() => ({ events: [] })),
    ]);
    rows = dict;
    usage = countUsage(result?.events || []);
    paint();
  } catch (err) {
    const tbody = document.getElementById('dd-rows');
    if (tbody) {
      tbody.innerHTML = `
        <tr><td colspan="9">
          <div class="empty-state">
            <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
            <p>Could not load the dictionary.</p>
            <p class="text-muted">${escapeHTML(err.message)}</p>
          </div>
        </td></tr>`;
    }
  }
}

/** How often each dish appears in the ledger, keyed the way the rollup keys it. */
function countUsage(events) {
  const map = new Map();
  for (const event of events) {
    if (event.status === 'dismissed') continue;
    for (const item of event.data?.items || []) {
      const key = normalizeName(item?.name);
      if (!key) continue;
      const qty = Number.isFinite(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : 1;
      const entry = map.get(key) || { count: 0, last: null };
      entry.count += qty;
      if (!entry.last || event.occurred_at > entry.last) entry.last = event.occurred_at;
      map.set(key, entry);
    }
  }
  return map;
}

function visibleRows() {
  const q = query.toLowerCase();
  let list = rows.filter(r => {
    if (q && !r.display_name.toLowerCase().includes(q)) return false;
    switch (filter) {
      case 'unverified': return !r.verified;
      case 'estimates':  return r.source === 'llm' && !r.verified;
      case 'unpriced':   return r.kcal === null || r.kcal === undefined;
      case 'verified':   return Boolean(r.verified);
      default:           return true;
    }
  });
  const eaten = r => usage.get(r.normalized_name)?.count || 0;
  const by = {
    eaten:   (a, b) => eaten(b) - eaten(a) || a.display_name.localeCompare(b.display_name),
    name:    (a, b) => a.display_name.localeCompare(b.display_name),
    kcal:    (a, b) => (Number(b.kcal) || -1) - (Number(a.kcal) || -1) || a.display_name.localeCompare(b.display_name),
    updated: (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')),
  };
  list = list.sort(by[sort] || by.eaten);
  return list;
}

// ── Paint ────────────────────────────────────────────

function paint() {
  const tbody = document.getElementById('dd-rows');
  const count = document.getElementById('dd-count');
  if (!tbody) return;

  const list = visibleRows();
  if (count) {
    const priced = rows.filter(r => r.kcal !== null && r.kcal !== undefined).length;
    count.textContent = `${list.length} of ${rows.length} · ${priced} priced`;
  }

  const html = [];
  if (editingId === 'new') html.push(editRow({ id: 'new', display_name: '' }, true));
  if (!list.length && editingId !== 'new') {
    html.push(`<tr><td colspan="9"><div class="empty-state">
      <i class="fas fa-book-open" aria-hidden="true"></i>
      <p>${rows.length ? 'Nothing matches.' : 'No dishes yet — run <code>npm run ledger:nutrition</code> or log a meal.'}</p>
    </div></td></tr>`);
  }
  for (const r of list) {
    if (r.id === editingId) html.push(editRow(r, false));
    else html.push(viewRow(r));
    if (r.id === mergingId) html.push(mergeRow(r));
  }
  tbody.innerHTML = html.join('');
}

const num = (v, digits = 0) => {
  if (v === null || v === undefined || v === '') return '<span class="text-muted">—</span>';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: digits }) : '<span class="text-muted">—</span>';
};

function sourceBadge(r) {
  if (r.verified) return `<span class="badge dd-badge-verified"><i class="fas fa-check" aria-hidden="true"></i> checked by you</span>`;
  const label = SOURCE_LABEL[r.source] || r.source || 'unknown';
  return `<span class="badge badge-gray">${escapeHTML(label)}</span>`;
}

function viewRow(r) {
  const u = usage.get(r.normalized_name);
  const last = u?.last ? new Date(u.last).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
  return `
    <tr class="dd-row" data-id="${escapeHTML(r.id)}">
      <td class="dd-col-name">
        <div class="dd-name">${escapeHTML(r.display_name)}</div>
        ${r.category ? `<div class="dd-meta text-muted">${escapeHTML(r.category.replace(/_/g, ' '))}</div>` : ''}
      </td>
      <td class="dd-num mono">${u ? `${num(u.count)}<span class="dd-meta text-muted"> × · ${escapeHTML(last)}</span>` : '<span class="text-muted">—</span>'}</td>
      <td class="dd-num mono dd-kcal">${num(r.kcal)}</td>
      <td class="dd-num mono">${num(r.protein_g, 1)}</td>
      <td class="dd-num mono">${num(r.carbs_g, 1)}</td>
      <td class="dd-num mono">${num(r.fat_g, 1)}</td>
      <td class="dd-num mono">${num(r.portion_g)}${r.portion_g ? '<span class="dd-meta text-muted"> g</span>' : ''}</td>
      <td>${sourceBadge(r)}</td>
      <td class="dd-actions">
        <button type="button" class="btn-icon" data-act="edit" title="Edit values" aria-label="Edit ${escapeHTML(r.display_name)}"><i class="fas fa-pen" aria-hidden="true"></i></button>
        <button type="button" class="btn-icon" data-act="merge" title="Merge into another dish" aria-label="Merge ${escapeHTML(r.display_name)}"><i class="fas fa-code-merge" aria-hidden="true"></i></button>
      </td>
    </tr>`;
}

function editRow(r, isNew) {
  const field = (name, value, step, placeholder) => `
    <input type="number" inputmode="decimal" class="form-input dd-input" name="${name}" value="${value ?? ''}" step="${step}" min="0" placeholder="${placeholder}" aria-label="${name.replace('_g', ' g')}" />`;
  return `
    <tr class="dd-row is-editing" data-id="${escapeHTML(r.id)}">
      <td class="dd-col-name">
        ${isNew
          ? `<input type="text" class="form-input dd-input dd-input-name" name="display_name" placeholder="Dish name, as on the receipt" aria-label="Dish name" maxlength="300" />`
          : `<div class="dd-name">${escapeHTML(r.display_name)}</div><div class="dd-meta text-muted">per serving as sold</div>`}
      </td>
      <td class="dd-num mono">${isNew ? '' : num(usage.get(r.normalized_name)?.count)}</td>
      <td class="dd-num">${field('kcal', r.kcal, '1', 'kcal')}</td>
      <td class="dd-num">${field('protein_g', r.protein_g, '0.1', 'g')}</td>
      <td class="dd-num">${field('carbs_g', r.carbs_g, '0.1', 'g')}</td>
      <td class="dd-num">${field('fat_g', r.fat_g, '0.1', 'g')}</td>
      <td class="dd-num">${field('portion_g', r.portion_g, '1', 'g')}</td>
      <td><span class="dd-meta text-muted">saves as checked by you</span></td>
      <td class="dd-actions">
        <div class="dd-edit-btns">
          <button type="button" class="btn-sm btn-accent" data-act="save"><i class="fas fa-check" aria-hidden="true"></i> Save</button>
          <button type="button" class="btn-sm btn-ghost" data-act="cancel">Cancel</button>
          ${isNew ? '' : `<button type="button" class="btn-sm btn-ghost dd-reset ${resetArmed === r.id ? 'is-armed' : ''}" data-act="reset" title="Forget these numbers and let the resolver estimate again">
            ${resetArmed === r.id ? 'Sure?' : 'Reset'}
          </button>`}
        </div>
      </td>
    </tr>`;
}

function mergeRow(r) {
  const others = rows.filter(o => o.id !== r.id).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const suggested = suggestTarget(r, others);
  const count = usage.get(r.normalized_name)?.count || 0;
  return `
    <tr class="dd-merge" data-id="${escapeHTML(r.id)}">
      <td colspan="9">
        <div class="dd-merge-panel">
          <div class="dd-merge-text">
            <strong>Merge “${escapeHTML(r.display_name)}” into</strong>
            <span class="text-muted">— the other name is kept, ${count ? `${count} line item${count === 1 ? '' : 's'} across past meals` : 'no past meals'} rewritten, this row deleted.</span>
          </div>
          <label class="sr-only" for="dd-merge-target">Keep this dish</label>
          <select class="form-select dd-select dd-merge-target" id="dd-merge-target">
            ${others.map(o => `<option value="${escapeHTML(o.id)}" ${o.id === suggested?.id ? 'selected' : ''}>${escapeHTML(o.display_name)}${o.kcal !== null && o.kcal !== undefined ? ` · ${num(o.kcal)} kcal` : ' · unpriced'}</option>`).join('')}
          </select>
          <div class="dd-merge-actions">
            <button type="button" class="btn-sm btn-accent" data-act="merge-confirm"><i class="fas fa-code-merge" aria-hidden="true"></i> Merge</button>
            <button type="button" class="btn-sm btn-ghost" data-act="cancel">Cancel</button>
          </div>
        </div>
      </td>
    </tr>`;
}

/** The most similar other name, by shared words — enough to pre-select "Cheese Slices" for "Cheese Slice". */
function suggestTarget(r, others) {
  const words = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map(w => w.replace(/s$/, '')));
  const mine = words(r.display_name);
  let best = null, bestScore = 0;
  for (const o of others) {
    const theirs = words(o.display_name);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    const score = shared / Math.max(mine.size, theirs.size, 1);
    if (score > bestScore) { best = o; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

// ── Actions ──────────────────────────────────────────

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr?.dataset.id;
  switch (btn.dataset.act) {
    case 'edit':          editingId = id; mergingId = null; resetArmed = null; paint(); tr && focusFirst(id); break;
    case 'merge':         mergingId = mergingId === id ? null : id; editingId = null; resetArmed = null; paint(); break;
    case 'cancel':        editingId = null; mergingId = null; resetArmed = null; paint(); break;
    case 'save':          save(id); break;
    case 'reset':         reset(id); break;
    case 'merge-confirm': merge(id); break;
  }
}

function onKey(e) {
  if (!e.target.matches('input')) return;
  const id = e.target.closest('tr')?.dataset.id;
  if (e.key === 'Enter') { e.preventDefault(); save(id); }
  if (e.key === 'Escape') { editingId = null; resetArmed = null; paint(); }
}

function focusFirst(id) {
  document.querySelector(`#dd-rows tr[data-id="${CSS.escape(id)}"] input`)?.focus();
}

function readForm(id) {
  const tr = document.querySelector(`#dd-rows tr[data-id="${CSS.escape(id)}"]`);
  if (!tr) return null;
  const out = {};
  for (const name of NUM_FIELDS) {
    const raw = tr.querySelector(`input[name="${name}"]`)?.value.trim();
    if (raw === '' || raw === undefined) { out[name] = null; continue; }
    const n = Number(raw);
    const [lo, hi] = LIMITS[name];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name.replace('_g', '')} must be between ${lo} and ${hi.toLocaleString('en-IN')}.`);
    out[name] = n;
  }
  if (out.kcal === null) throw new Error('Calories are required — that is the number every meal reads.');
  const nameInput = tr.querySelector('input[name="display_name"]');
  if (nameInput) {
    out.display_name = nameInput.value.trim();
    if (!out.display_name) throw new Error('Give the dish a name.');
  }
  return out;
}

async function save(id) {
  if (!id) return;
  let fields;
  try { fields = readForm(id); } catch (err) { showToast(escapeHTML(err.message), 'error'); return; }
  if (!fields) return;
  try {
    if (id === 'new') {
      const created = await api.createFoodItem(fields);
      rows = [...rows, created];
      showToast(`Added ${escapeHTML(created.display_name)}`);
    } else {
      const updated = await api.updateFoodItem(id, fields);
      rows = rows.map(r => (r.id === id ? updated : r));
      const count = usage.get(updated.normalized_name)?.count || 0;
      showToast(`Saved ${escapeHTML(updated.display_name)}${count ? ` — re-valued ${count} line item${count === 1 ? '' : 's'}` : ''}`);
    }
    editingId = null; resetArmed = null;
    paint();
  } catch (err) {
    showToast(escapeHTML(err.message), 'error');
  }
}

async function reset(id) {
  if (resetArmed !== id) { resetArmed = id; paint(); return; }
  try {
    const updated = await api.resetFoodItem(id);
    rows = rows.map(r => (r.id === id ? updated : r));
    editingId = null; resetArmed = null;
    paint();
    showToast(`${escapeHTML(updated.display_name)} will be estimated again on the next nutrition run`);
  } catch (err) {
    showToast(escapeHTML(err.message), 'error');
  }
}

async function merge(duplicateId) {
  const targetId = document.getElementById('dd-merge-target')?.value;
  if (!targetId || targetId === duplicateId) { showToast('Pick the dish to keep.', 'error'); return; }
  const btn = document.querySelector('#dd-rows [data-act="merge-confirm"]');
  if (btn) btn.disabled = true;
  try {
    const res = await api.mergeFoodItems(targetId, duplicateId);
    mergingId = null;
    showToast(`Merged ${escapeHTML(res.duplicate)} into ${escapeHTML(res.target)} — ${res.events_updated} meal${res.events_updated === 1 ? '' : 's'} rewritten`);
    await load();
  } catch (err) {
    if (btn) btn.disabled = false;
    showToast(escapeHTML(err.message), 'error');
  }
}
