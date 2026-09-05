// ======================================================
// Food — what you actually ate.
//
// The Life timeline answers "what happened". This screen answers a narrower
// question the ledger can now support: what was on the plate, when, and how
// often. It reads the same `food` events, so there is nothing here to keep in
// step — the basket is `data.items`, written by the extraction rules straight
// from the receipt, and the meal it counts as is derived from the clock at
// read time (src/ledger/taxonomy.js) rather than stored.
//
// Deriving the meal rather than storing it is what lets the boundaries move.
// Change 19:00 to 18:30 and every dinner in the ledger's history relabels
// itself; nothing is re-ingested and no row is rewritten.
// ======================================================

import { Chart } from '../vendor.js';
import * as api from '../ledger/api.js';
import { mealMeta, mealSlot, sourceMeta } from '../ledger/taxonomy.js';
import { summariseItems } from '../ledger/items.js';
import {
  indexDictionary, eventNutrition, summarise, bucketDays, dishNutrition, SOURCE_LABEL,
} from '../ledger/nutrition.js';
import { localDateISO, entityRef } from '../ledger/normalize.js';
import { isInflow } from '../ledger/summary.js';
import * as settings from '../settings.js';
import {
  escapeHTML, formatINRFull, downloadCSV, openModal, closeModal, showToast,
  comboboxHTML, wireCombobox, destroyChart, CHART_COLORS, renderKpiCards,
} from '../utils.js';
import { openEventDetail } from './ledger.js';

let events = [];            // every food event, all time — the period is a filter
// The dish dictionary, keyed by normalized name. Read once alongside the
// events: it is one row per distinct dish (~150 for a year of eating), not one
// per meal, so the whole thing costs less than a page of the timeline. Empty
// until the resolver has run, which is why every calorie figure below degrades
// to "—" rather than to zero.
let dict = new Map();
let draft = [];             // the basket being edited, until Save
let activeTab = 'meals';    // meals | dishes
// The one period the whole page reads through: KPIs, chart and list all answer
// for the same days, so there is exactly one control. Presets are day counts;
// 'custom' reads the two date inputs instead.
let period = { preset: '30', from: null, to: null };
let query = '';
let onlyEmpty = false;      // "show me only the meals I still have to fill in"
let searchDebounce = null;
let calorieChartRef = null;

const timeZone = () => settings.get('ledger_timezone') || 'Asia/Kolkata';
const kcalTarget = () => Number(settings.get('food_kcal_target')) || 1800;


export async function renderFood(container) {
  activeTab = 'meals';
  period = { preset: '30', from: null, to: null };
  query = '';
  onlyEmpty = false;
  // Chart.js keeps a live handle on a canvas that is about to be replaced by
  // the innerHTML below; leaving it attached leaks the old chart and its
  // resize listener on every visit to this page.
  calorieChartRef = destroyChart(calorieChartRef);

  container.innerHTML = `
    <div class="page-header lg-header fd-header">
      <div class="page-header-left">
        <h2>Food</h2>
        <p>What you ate, off the receipts — measured against ${escapeHTML(String(kcalTarget().toLocaleString('en-IN')))} kcal a day</p>
      </div>
      <div class="lg-header-actions fd-period-wrap">
        <div class="chart-toggle" role="group" aria-label="Period">
          <button type="button" class="chart-toggle-btn" data-preset="7">7D</button>
          <button type="button" class="chart-toggle-btn active" data-preset="30">30D</button>
          <button type="button" class="chart-toggle-btn" data-preset="90">90D</button>
          <button type="button" class="chart-toggle-btn" data-preset="365">1Y</button>
          <button type="button" class="chart-toggle-btn" data-preset="custom" title="Pick two dates" aria-label="Custom period">
            <i class="fas fa-calendar-days" aria-hidden="true"></i>
          </button>
        </div>
        <div class="fd-custom" id="fd-custom" hidden>
          <label class="sr-only" for="fd-from">From</label>
          <input type="date" class="form-input fd-date" id="fd-from" />
          <span class="fd-custom-sep" aria-hidden="true">–</span>
          <label class="sr-only" for="fd-to">To</label>
          <input type="date" class="form-input fd-date" id="fd-to" />
        </div>
        <button type="button" class="btn-sm btn-ghost" id="fd-export-btn">
          <i class="fas fa-download"></i> Export
        </button>
      </div>
    </div>

    <div class="page-body fd-page">
      <div class="kpi-grid fd-kpis" id="fd-stats"></div>

      <div class="fd-layout">
        <!-- Calories against the target. Hidden until the dictionary can
             answer, because an empty chart is a worse answer than no chart. -->
        <!-- Just the graph. What it plots is already said once, in the page
             subtitle; the crossings speak for themselves in red. -->
        <div class="chart-card fd-chart-card" id="fd-chart-card" hidden>
          <div class="chart-canvas-wrap">
            <canvas id="fd-calorie-chart"></canvas>
          </div>
        </div>

        <div class="table-section fd-panel">
          <div class="table-toolbar fd-toolbar">
            <div class="table-tabs">
              <button type="button" class="table-tab active" id="fd-tab-meals">
                <i class="fas fa-utensils" style="margin-right:0.3rem"></i>Meals
              </button>
              <button type="button" class="table-tab" id="fd-tab-dishes">
                <i class="fas fa-ranking-star" style="margin-right:0.3rem"></i>Dishes
              </button>
            </div>
            <div class="lg-controls">
              <div class="search-input-wrap lg-search">
                <i class="fas fa-search"></i>
                <input type="text" class="search-input" id="fd-search" placeholder="Search a dish or a restaurant" />
              </div>
              <button type="button" class="btn-sm btn-ghost fd-gap-toggle" id="fd-gaps"
                      aria-pressed="false" title="Only the meals with nothing recorded in them">
                <i class="fas fa-circle-question" aria-hidden="true"></i>
                Missing <span class="fd-gap-count" id="fd-gap-count">0</span>
              </button>
              <button type="button" class="btn-icon" id="fd-refresh-btn" title="Reload" aria-label="Reload">
                <i class="fas fa-rotate-right"></i>
              </button>
            </div>
          </div>
          <div class="fd-scroll" id="fd-body"></div>
        </div>
      </div>
    </div>

    <button type="button" class="fab" id="fd-fab" title="Add a meal" aria-label="Add a meal">
      <i class="fas fa-plus"></i>
    </button>
  `;

  document.getElementById('fd-fab').addEventListener('click', () => openBasket(null));
  document.getElementById('fd-tab-meals').addEventListener('click', () => switchTab('meals'));
  document.getElementById('fd-tab-dishes').addEventListener('click', () => switchTab('dishes'));
  document.getElementById('fd-refresh-btn').addEventListener('click', () => loadData());
  document.getElementById('fd-export-btn').addEventListener('click', exportItems);

  document.getElementById('fd-gaps').addEventListener('click', () => {
    onlyEmpty = !onlyEmpty;
    // A filter that hides most of the page has to say it is on, and the tab it
    // applies to is the meal list — a dish ranking of empty baskets is empty.
    const button = document.getElementById('fd-gaps');
    button.classList.toggle('is-on', onlyEmpty);
    button.setAttribute('aria-pressed', String(onlyEmpty));
    if (onlyEmpty && activeTab !== 'meals') switchTab('meals');
    else paint();
  });

  // Period flips. Custom reveals the two date fields and reads them; every
  // other flip hides them again. The whole page repaints — KPIs, chart and
  // list answer for the same days by construction.
  const customBox = document.getElementById('fd-custom');
  document.querySelectorAll('.fd-period-wrap [data-preset]').forEach(button => {
    button.addEventListener('click', () => {
      period.preset = button.dataset.preset;
      document.querySelectorAll('.fd-period-wrap [data-preset]').forEach(b =>
        b.classList.toggle('active', b === button));
      customBox.hidden = period.preset !== 'custom';
      if (period.preset === 'custom') {
        // Seed with the last 30 days so switching to Custom changes nothing
        // until a date is actually picked.
        const zone = timeZone();
        const today = localDateISO(new Date(), zone);
        const fromEl = document.getElementById('fd-from');
        const toEl = document.getElementById('fd-to');
        if (!fromEl.value) fromEl.value = shiftDay(today, -29);
        if (!toEl.value) toEl.value = today;
        period.from = fromEl.value; period.to = toEl.value;
      }
      paint();
    });
  });
  for (const id of ['fd-from', 'fd-to']) {
    document.getElementById(id).addEventListener('change', () => {
      period.from = document.getElementById('fd-from').value || null;
      period.to = document.getElementById('fd-to').value || null;
      if (period.preset === 'custom') paint();
    });
  }

  document.getElementById('fd-search').addEventListener('input', e => {
    query = e.target.value.trim().toLowerCase();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(paint, 180);
  });

  await loadData();
}

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('fd-tab-meals').classList.toggle('active', tab === 'meals');
  document.getElementById('fd-tab-dishes').classList.toggle('active', tab === 'dishes');
  paint();
}

async function loadData() {
  const body = document.getElementById('fd-body');
  if (body) body.innerHTML = `<div class="skeleton skeleton--table"></div>`;

  try {
    // Everything, not the selected period: the dish picker offers what you
    // have *ever* eaten, and a page that refetched on every range change could
    // not answer that. Changing the period is then instant and free.
    // Both at once. A missing dictionary is not an error — it is what the page
    // looks like before `npm run ledger:nutrition` has ever run — so its
    // failure is swallowed and the calorie columns simply do not appear.
    const [result, rows] = await Promise.all([
      api.searchEvents({ types: ['food'], limit: 1000 }),
      api.foodDictionary().catch(() => []),
    ]);
    // A dismissed event is one you said did not happen. It stays in the
    // ledger so ingestion cannot recreate it, but it was never eaten.
    events = (result?.events || []).filter(e => e.status !== 'dismissed');
    dict = indexDictionary(rows);
    paint();
  } catch (err) {
    if (body) {
      body.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-triangle-exclamation" style="font-size:1.5rem;color:var(--warning)"></i>
          <p style="margin-top:0.75rem">Could not load your meals.</p>
          <p class="text-muted" style="font-size:0.85rem">${escapeHTML(err.message)}</p>
        </div>`;
    }
  }
}

/**
 * What the period and the search are asking for.
 *
 * The gap filter is deliberately not applied here: it is a work queue, not a
 * lens on the data, and running the header numbers through it reported "0.1
 * meals a day, nothing recorded yet" for someone who had eaten 49 meals that
 * month.
 */
/** The period as two local dates, whatever the control is set to. */
function periodDates() {
  const zone = timeZone();
  const today = localDateISO(new Date(), zone);
  if (period.preset === 'custom') {
    return { from: period.from || '0000-01-01', to: period.to || today };
  }
  return { from: shiftDay(today, -(Number(period.preset) - 1)), to: today };
}

function shiftDay(iso, offset) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function inPeriod() {
  const zone = timeZone();
  const { from, to } = periodDates();
  // Compared as local dates, not instants, so "7D" means seven calendar days
  // on the user's clock — a meal at 00:30 belongs to the day it says.
  const list = events.filter(e => {
    const d = localDateISO(e.occurred_at, zone);
    return d >= from && d <= to;
  });
  if (!query) return list;
  return list.filter(event => {
    const haystack = [
      event.title, event.data?.restaurant, event.data?.merchant, event.data?.ordered_via,
      ...(event.data?.items || []).map(i => `${i.name} ${i.options || ''}`),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

/** What the list below actually shows. */
function visible() {
  const list = inPeriod();
  return onlyEmpty ? list.filter(isEmptyBasket) : list;
}

/** A meal nobody has said anything about yet. */
const isEmptyBasket = event => !(event.data?.items || []).length;

function paint() {
  renderKPIs();
  renderGapCount();
  renderCalorieChart();
  const body = document.getElementById('fd-body');
  if (!body) return;

  const list = visible();
  if (!list.length) { body.innerHTML = emptyState(); return; }

  body.innerHTML = activeTab === 'dishes' ? renderDishes(list) : renderMeals(list);

  // The row's job on this page is "what did I eat", so that is what clicking it
  // does. Provenance — which mail this came from, what else corroborates it —
  // is one chip away, next to the time.
  const edit = id => {
    const event = events.find(x => x.id === id);
    if (event) openBasket(event);
  };

  body.querySelectorAll('[data-basket]').forEach(row => {
    row.addEventListener('click', () => edit(row.dataset.basket));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(row.dataset.basket); }
    });
  });

  body.querySelectorAll('[data-detail]').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      openEventDetail(chip.dataset.detail, loadData);
    });
  });

  body.querySelectorAll('[data-dish]').forEach(row => {
    row.addEventListener('click', () => {
      const input = document.getElementById('fd-search');
      input.value = row.dataset.dish;
      query = row.dataset.dish.toLowerCase();
      switchTab('meals');
    });
  });
}

// ── Meals ──────────────────────────────────────────────

function renderMeals(list) {
  const zone = timeZone();
  const byDay = new Map();
  for (const event of list) {
    const day = localDateISO(event.occurred_at, zone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }

  const today = localDateISO(new Date(), zone);
  const yesterday = localDateISO(new Date(Date.now() - 86_400_000), zone);

  const target = kcalTarget();

  return `<div class="timeline">${[...byDay.entries()].map(([day, dayEvents]) => {
    const heading = day === today ? 'Today' : day === yesterday ? 'Yesterday' : formatDayHeading(day);
    const spend = dayEvents.reduce((sum, e) => sum + (isInflow(e) ? 0 : Number(e.data?.amount) || 0), 0);
    const meals = dayEvents.filter(e => e.subtype !== 'groceries').length;
    // The same thread as the chart: a day that crossed the target carries a red
    // tick here too, so scrolling the list tells the same story as the curve.
    const dayKcal = dict.size
      ? dayEvents.reduce((sum, e) => sum + (eventNutrition(e, dict).kcal || 0), 0) : 0;
    const overTarget = dayKcal > target;

    // Strictly by the clock, earliest first. The meal is a label the row
    // carries, not a section it sits in — grouping by meal meant a 01:00 snack
    // sorted between lunch and dinner, because its position came from which
    // band it belonged to rather than from when it happened.
    const inOrder = [...dayEvents].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

    return `
      <section class="tl-day" aria-label="${escapeHTML(heading)}">
        <header class="tl-day-head">
          <div class="tl-day-id">
            <span class="tl-day-label">${escapeHTML(heading)}</span>
            <span class="tl-day-meta">
              ${dayKcal ? `<span class="fd-day-kcal mono ${overTarget ? 'is-over' : ''}" title="${
                overTarget ? `${(dayKcal - target).toLocaleString('en-IN')} kcal over the ${target.toLocaleString('en-IN')} target` : `under the ${target.toLocaleString('en-IN')} kcal target`}">${
                overTarget ? '<i class="fas fa-circle" aria-hidden="true"></i>' : ''}${dayKcal.toLocaleString('en-IN')} kcal</span> · ` : ''}${
              meals || 'no'} meal${meals === 1 ? '' : 's'}${spend ? ` · ${escapeHTML(formatINRFull(spend))}` : ''}
            </span>
          </div>
        </header>
        ${inOrder.map(event => renderMealRow(event, mealMeta(mealSlot(event.occurred_at, zone, event.subtype) || 'snack'))).join('')}
      </section>`;
  }).join('')}</div>`;
}

function renderMealRow(event, meta) {
  const items = event.data?.items || [];
  const nut = eventNutrition(event, dict);
  const amount = Number(event.data?.amount);
  const source = sourceMeta(event.source_type);

  // The dish leads and the restaurant follows it. On a timeline of everything
  // that happened, "Kapoor's Cafe" is the event; on a page about what you ate,
  // the paratha is, and the restaurant is where it came from.
  const place = event.data?.restaurant || event.data?.merchant || null;
  const label = summariseItems(items) || place || event.title;

  // The columns the order actually needs. An order of single portions has no
  // quantities to show, and most receipts state no per-item price — a column
  // rendered for them anyway is either an empty indent before every dish or,
  // once the empty cells collapse, a grid the next dish slides sideways into.
  const anyQty = items.some(item => (item.qty || 1) > 1);
  const anyPrice = items.some(item => Number.isFinite(Number(item.amount)));

  return `
    <article class="tl-item fd-meal" data-basket="${escapeHTML(event.id)}" role="button" tabindex="0"
             aria-label="Edit what you ate: ${escapeHTML(label)}">
      <div class="tl-when">
        <span class="tl-time mono">${escapeHTML(formatTime(event.occurred_at))}</span>
        <button type="button" class="tl-src fd-src" data-detail="${escapeHTML(event.id)}"
                title="Where this came from${event.source_count > 1 ? ` · ${event.source_count} sources agree` : ''}"
                aria-label="Where this came from">
          <i class="fas ${source.icon}" aria-hidden="true"></i>${event.source_count > 1 ? `<b>${event.source_count}</b>` : ''}
        </button>
      </div>

      <span class="tl-icon" style="--tint:${meta.color}"><i class="fas ${meta.icon}" aria-hidden="true"></i></span>

      <div class="tl-body">
        ${items.length ? `
          <ul class="fd-items ${anyQty ? 'has-qty' : ''} ${anyPrice ? 'has-amt' : ''}">
            ${items.map(item => `
              <li>
                ${anyQty ? `<span class="fd-qty mono">${item.qty > 1 ? `${item.qty}×` : ''}</span>` : ''}
                <span class="fd-item-name">${escapeHTML(item.name)}${
                  item.options ? `<span class="fd-item-opts"> ${escapeHTML(item.options)}</span>` : ''}</span>
                ${anyPrice ? `<span class="fd-item-amt mono">${Number.isFinite(Number(item.amount))
                  ? escapeHTML(formatINRFull(Number(item.amount))) : ''}</span>` : ''}
              </li>`).join('')}
          </ul>`
        // The receipts that carry no dishes are the offline ones — a bill paid
        // at a table, a card alert with no order mail behind it. Those are the
        // meals only you can fill in, so the gap is an invitation rather than a
        // note about a parser.
        : `<div class="fd-add">
             <i class="fas fa-plus" aria-hidden="true"></i>
             ${event.subtype === 'restaurant' ? 'Paid at the table — add what you had' : 'Add what you had'}
           </div>`}
        <div class="tl-meta">
          <span class="fd-tag" style="color:${meta.color}">${escapeHTML(meta.label)}</span>
          ${place ? `<span>${escapeHTML(place)}</span>` : ''}
          ${nut.basis === 'partial' ? `<span class="fd-partial" title="${nut.missing} of ${
            nut.total} items have no nutrition yet, so this total is short">+${nut.missing} unpriced</span>` : ''}
        </div>
      </div>

      <div class="tl-amount mono">
        ${Number.isFinite(amount) ? escapeHTML(formatINRFull(amount)) : ''}
        ${nut.kcal !== null ? `<span class="fd-kcal ${nut.basis === 'partial' ? 'is-partial' : ''}"
          title="Estimated from ${nut.resolved} of ${nut.total} item${nut.total === 1 ? '' : 's'}${
            nut.protein ? ` · ${nut.protein} g protein` : ''}">${nut.kcal.toLocaleString('en-IN')} kcal</span>` : ''}
      </div>
    </article>`;
}

// ── The basket editor ──────────────────────────────────
//
// Not every meal arrives with a receipt: a card alert knows ₹300 was spent at
// Shri Manjunatha Foods and nothing else, and a bill paid at a table itemises
// nothing at all. Those are the plates only you can fill in.
//
// Typing a dish name every time would be the wrong shape for that — you eat
// the same twenty things, and a free-text field turns "Cheese Masala Dosa"
// into four spellings that never aggregate. So the picker leads with
// everything the ledger has ever recorded, and typing is the fallback for a
// dish that is genuinely new.
//
// The same editor also *creates* a meal, because plenty of eating leaves no
// receipt at all: four things arrive from Blinkit as one grocery purchase, and
// eating two of them on Tuesday evening is a different event on a different
// day with no money attached to it. Buying and eating are not the same event,
// so this writes a new one rather than editing the order.

/** Every distinct dish the ledger knows, most-eaten first. */
function dishCatalogue() {
  return aggregateDishes(events);
}

/** Places you have eaten, for the "where" suggestions. */
function placeCatalogue() {
  const seen = new Map();
  for (const event of events) {
    const name = event.data?.restaurant || event.data?.merchant;
    if (name) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort();
}

function openBasket(event) {
  // A copy: nothing is written until Save, so Cancel is a real cancel.
  draft = (event?.data?.items || []).map(item => ({ ...item }));

  const isNew = !event;
  const zone = timeZone();
  const when = event?.occurred_at || new Date().toISOString();
  const where = event ? (event.data?.restaurant || event.data?.merchant || event.title) : null;
  const meal = mealMeta(mealSlot(when, zone, event?.subtype) || 'snack');

  openModal(`
    <div class="modal-header">
      <div class="modal-title">
        <i class="fas ${meal.icon}" style="color:${meal.color};margin-right:0.5rem" aria-hidden="true"></i>
        ${isNew ? 'What did you eat?' : 'What did you have?'}
      </div>
      <button class="modal-close" id="fb-close" aria-label="Close"><i class="fas fa-times"></i></button>
    </div>

    <div class="modal-body">
      ${isNew ? `
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="fb-when">When</label>
            <input type="datetime-local" class="form-input" id="fb-when" value="${escapeHTML(toLocalInput(when))}" />
            <div class="form-hint" id="fb-when-hint">${escapeHTML(meal.label)}</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="fb-where">Where</label>
            ${comboboxHTML({
              id: 'fb-where',
              placeholder: 'Leave blank if it was at home',
              options: placeCatalogue(),
            })}
          </div>
        </div>`
      : `
        <p class="fb-context">
          <strong>${escapeHTML(where)}</strong>
          · ${escapeHTML(formatDayHeading(localDateISO(when, zone)))}
          ${escapeHTML(formatTime(when))}
          · ${escapeHTML(meal.label)}
          ${Number.isFinite(Number(event.data?.amount)) ? `· ${escapeHTML(formatINRFull(Number(event.data.amount)))}` : ''}
        </p>`}

      <div class="form-group">
        <label class="form-label" for="fb-toggle">Things you have eaten before</label>
        <div class="fb-picker">
          <button type="button" class="form-input fb-toggle" id="fb-toggle"
                  aria-expanded="false" aria-controls="fb-panel">
            <span id="fb-toggle-label">Choose dishes</span>
            <i class="fas fa-chevron-down" aria-hidden="true"></i>
          </button>
          <div class="fb-panel" id="fb-panel" hidden>
            <input type="text" class="form-input fb-filter" id="fb-filter"
                   placeholder="Filter" autocomplete="off" aria-label="Filter dishes" />
            <div class="fb-options" id="fb-options" role="group" aria-label="Dishes"></div>
          </div>
        </div>
        <div class="form-hint">Tick as many as you had. Ticking one twice is what the quantity is for.</div>
      </div>

      <div class="form-group">
        <label class="form-label" for="fb-new">Something not in the list</label>
        <div class="fb-new">
          <input type="text" class="form-input" id="fb-new" placeholder="e.g. Filter Coffee" autocomplete="off" />
          <input type="number" class="form-input fb-new-qty" id="fb-new-qty" min="1" step="1" value="1" aria-label="Quantity" />
          <button type="button" class="btn-sm btn-ghost" id="fb-add"><i class="fas fa-plus"></i> Add</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">${isNew ? 'You ate' : 'In this order'}</label>
        <div id="fb-list"></div>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" id="fb-cancel">Cancel</button>
      <button class="btn-submit" id="fb-save">${isNew ? 'Add meal' : 'Save'}</button>
    </div>
  `);

  const $ = id => document.getElementById(id);
  if (isNew) wireCombobox('fb-where');
  const panel = $('fb-panel');
  const toggle = $('fb-toggle');

  const closePanel = () => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };

  // Which meal it counts as is the clock's answer, so show it changing as the
  // time is changed rather than announcing it after the fact.
  $('fb-when')?.addEventListener('input', e => {
    const value = e.target.value;
    const hint = $('fb-when-hint');
    if (!value || !hint) return;
    hint.textContent = mealMeta(mealSlot(new Date(value).toISOString(), timeZone()) || 'snack').label;
  });

  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) $('fb-filter').focus();
  });

  // Clicking anywhere else in the modal closes the list, but a click *inside*
  // it is a selection and must not.
  //
  // The path, not `e.target.closest()`: ticking a dish re-renders the options,
  // so by the time this handler runs the clicked element has been replaced and
  // walking up from it finds nothing — which closed the list on every tick and
  // made a multi-select single-select. composedPath() is fixed at dispatch.
  document.getElementById('modal-overlay').addEventListener('click', e => {
    const inside = (e.composedPath?.() || [])
      .some(node => node instanceof Element && node.classList.contains('fb-picker'));
    if (!panel.hidden && !inside) closePanel();
  });

  $('fb-filter').addEventListener('input', e => paintOptions(e.target.value));

  $('fb-options').addEventListener('click', e => {
    const option = e.target.closest('[data-name]');
    if (!option) return;
    toggleItem(option.dataset.name);
    paintBasket();
    paintOptions($('fb-filter').value);
  });

  const addTyped = () => {
    const name = $('fb-new').value.trim();
    if (!name) return;
    const qty = Math.max(1, parseInt($('fb-new-qty').value, 10) || 1);
    const existing = draft.find(i => sameDish(i.name, name));
    if (existing) existing.qty = (existing.qty || 1) + qty;
    else draft.push({ name, qty });
    $('fb-new').value = '';
    $('fb-new-qty').value = '1';
    $('fb-new').focus();
    paintBasket();
    paintOptions($('fb-filter').value);
  };

  $('fb-add').addEventListener('click', addTyped);
  $('fb-new').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } });

  $('fb-list').addEventListener('click', e => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const index = Number(button.dataset.index);
    const item = draft[index];
    if (!item) return;
    if (button.dataset.act === 'more') item.qty = (item.qty || 1) + 1;
    if (button.dataset.act === 'less') item.qty = Math.max(1, (item.qty || 1) - 1);
    if (button.dataset.act === 'remove') draft.splice(index, 1);
    paintBasket();
    paintOptions($('fb-filter').value);
  });

  $('fb-close').addEventListener('click', closeModal);
  $('fb-cancel').addEventListener('click', closeModal);

  $('fb-save').addEventListener('click', async () => {
    const save = $('fb-save');
    save.disabled = true;
    try {
      if (isNew) await createMeal();
      else {
        // `items` is the only key sent, and the update merges by key, so every
        // other fact the receipt stated is left exactly as it was.
        await api.updateEvent(event.id, { data: { items: draft } });
        showToast(draft.length ? 'Saved.' : 'Cleared.');
      }
      closeModal();
      await loadData();
    } catch (err) {
      save.disabled = false;
      showToast(err.message, 'error');
    }
  });

  async function createMeal() {
    const place = $('fb-where').value.trim();
    if (!draft.length && !place) throw new Error('Add at least one dish, or say where you ate.');

    const whenValue = $('fb-when').value;
    const occurredAt = whenValue ? new Date(whenValue).toISOString() : new Date().toISOString();

    await api.createEvent({
      occurred_at: occurredAt,
      type: 'food',
      subtype: 'meal',
      // The place if there was one, otherwise the food itself: "Idli, Vada" is
      // a better line in a timeline than "Meal".
      title: place || summariseItems(draft, 3) || 'Meal',
      data: prune({ restaurant: place || null, items: draft }),
      status: 'confirmed',
    }, place ? [entityRef('restaurant', place, 'restaurant')].filter(Boolean) : [], {
      sourceType: 'manual',
      // Eating is not buying. A meal recorded here carries no amount, so the
      // fuzzy matcher has only a time to go on — and it would happily fold
      // "ate two things from the fridge at 20:00" into the ₹531 grocery order
      // that paid for them, which is a different event on a different day.
      allowMerge: false,
    });
    showToast('Meal added.');
  }

  paintBasket();
  paintOptions('');
}

/** A datetime-local value for an instant, in the browser's own zone. */
function toLocalInput(iso) {
  const date = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Drop the keys with nothing in them, so `data` holds only what is known. */
function prune(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) =>
    value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)));
}

/** Same dish, whatever the capitals and spaces. */
const sameDish = (a, b) =>
  String(a).toLowerCase().replace(/\s+/g, ' ').trim() === String(b).toLowerCase().replace(/\s+/g, ' ').trim();

function toggleItem(name) {
  const index = draft.findIndex(i => sameDish(i.name, name));
  if (index >= 0) draft.splice(index, 1);
  else draft.push({ name, qty: 1 });
}

function paintOptions(filter) {
  const list = document.getElementById('fb-options');
  const label = document.getElementById('fb-toggle-label');
  if (!list) return;

  const needle = String(filter || '').trim().toLowerCase();
  const dishes = dishCatalogue().filter(d => !needle || d.name.toLowerCase().includes(needle));

  label.textContent = draft.length
    ? `${draft.length} item${draft.length === 1 ? '' : 's'} in this order`
    : 'Choose dishes';

  if (!dishes.length) {
    list.innerHTML = `<p class="fb-none">${needle
      ? 'Nothing matching — add it as something new below.'
      : 'Nothing recorded yet. Add the first one below.'}</p>`;
    return;
  }

  list.innerHTML = dishes.slice(0, 200).map(dish => {
    const on = draft.some(i => sameDish(i.name, dish.name));
    return `
      <button type="button" class="fb-option ${on ? 'is-on' : ''}" data-name="${escapeHTML(dish.name)}"
              aria-pressed="${on}">
        <i class="fas ${on ? 'fa-square-check' : 'fa-square'}" aria-hidden="true"></i>
        <span class="fb-option-name">${escapeHTML(dish.name)}</span>
        <span class="fb-option-count mono">${dish.count}×</span>
      </button>`;
  }).join('');
}

function paintBasket() {
  const list = document.getElementById('fb-list');
  if (!list) return;

  if (!draft.length) {
    list.innerHTML = `<p class="fb-none">Nothing yet. Pick from the list above, or type it in.</p>`;
    return;
  }

  list.innerHTML = `<ul class="fb-basket">${draft.map((item, index) => `
    <li>
      <span class="fb-basket-name">${escapeHTML(item.name)}${
        item.options ? `<span class="fd-item-opts"> ${escapeHTML(item.options)}</span>` : ''}</span>
      <span class="fb-stepper">
        <button type="button" data-act="less" data-index="${index}" aria-label="One fewer ${escapeHTML(item.name)}">
          <i class="fas fa-minus" aria-hidden="true"></i>
        </button>
        <span class="mono">${item.qty || 1}</span>
        <button type="button" data-act="more" data-index="${index}" aria-label="One more ${escapeHTML(item.name)}">
          <i class="fas fa-plus" aria-hidden="true"></i>
        </button>
      </span>
      <button type="button" class="fb-remove" data-act="remove" data-index="${index}"
              aria-label="Remove ${escapeHTML(item.name)}">
        <i class="fas fa-times" aria-hidden="true"></i>
      </button>
    </li>`).join('')}</ul>`;
}

// ── Dishes ─────────────────────────────────────────────

/**
 * The same dish, however often it arrived. Names are compared case- and
 * space-insensitively but displayed as the receipt wrote them, because
 * "Cheese Masala Dosa" is what you would search for.
 */
function aggregateDishes(list) {
  const dishes = new Map();

  for (const event of list) {
    for (const item of event.data?.items || []) {
      if (!item?.name) continue;
      const key = String(item.name).toLowerCase().replace(/\s+/g, ' ').trim();
      const dish = dishes.get(key) || {
        name: item.name, count: 0, spend: 0, priced: 0, lastAt: null, places: new Set(),
      };
      dish.count += Number(item.qty) || 1;
      if (Number.isFinite(Number(item.amount))) { dish.spend += Number(item.amount); dish.priced++; }
      if (!dish.lastAt || event.occurred_at > dish.lastAt) dish.lastAt = event.occurred_at;
      const place = event.data?.restaurant || event.data?.merchant;
      if (place) dish.places.add(place);
      dishes.set(key, dish);
    }
  }

  return [...dishes.values()].sort((a, b) => b.count - a.count || (b.lastAt > a.lastAt ? 1 : -1));
}

function renderDishes(list) {
  const dishes = aggregateDishes(list);
  if (!dishes.length) {
    return `
      <div class="empty-state">
        <i class="fas fa-utensils" style="font-size:1.5rem;color:var(--text-muted)"></i>
        <p style="margin-top:0.75rem">Nothing recorded in this period.</p>
        <p class="text-muted" style="font-size:0.85rem;max-width:34rem;margin:0.5rem auto 0">
          Line items come from the order receipts. Older events predate the parser that reads them —
          <code>npm run ledger:ingest -- --backfill-days 90</code> fills them in.
        </p>
      </div>`;
  }

  // Share of everything eaten in the period, which is a fact about your diet.
  // A bar scaled to the most-eaten dish was not: it restated the count in a
  // second visual channel and said nothing the number did not.
  const total = dishes.reduce((sum, d) => sum + d.count, 0);
  const share = count => {
    const pct = (count / total) * 100;
    return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  };

  // Cards, not rows: a dish is a handful of short values, so a full-width row
  // spent 1,300 pixels of horizontal space to show three of them and pushed
  // the ranking off the screen. A grid fits four or five across and the whole
  // top of the list is visible at once.
  return `<div class="fd-cards">${dishes.slice(0, 200).map(dish => `
    <button type="button" class="fd-card" data-dish="${escapeHTML(dish.name)}"
            title="Show every time you had this">
      <span class="fd-card-top">
        <span class="fd-card-count mono" title="Eaten ${dish.count} time${dish.count === 1 ? '' : 's'}">${dish.count}×</span>
        <span class="fd-card-share mono" title="${share(dish.count)} of everything you ate in this period">${share(dish.count)}</span>
      </span>
      <span class="fd-card-name">${escapeHTML(dish.name)}</span>
      <span class="fd-card-meta">
        <span class="fd-card-where">${escapeHTML([...dish.places].slice(0, 2).join(', '))}${
          dish.places.size > 2 ? ` +${dish.places.size - 2}` : ''}</span>
        <span class="fd-card-last">${escapeHTML(formatDayHeading(String(dish.lastAt).slice(0, 10)))}</span>
      </span>
      <span class="fd-card-foot">
        ${dish.priced ? `<span class="fd-card-spend mono">${escapeHTML(formatINRFull(dish.spend))}</span>` : '<span></span>'}
        ${nutritionChip(dish)}
      </span>
    </button>`).join('')}</div>`;
}

/**
 * The calorie chip on a dish card.
 *
 * Shows the per-serving figure rather than the period total, because that is
 * the number you can act on: "the dosa is 620" changes what you order, "you ate
 * 14,880 kcal of dosa" does not. The provenance is in the tooltip, and a row
 * nobody has checked says so — an estimate presented as a measurement is the
 * one failure mode this whole feature has to avoid.
 */
function nutritionChip(dish) {
  const n = dishNutrition(dish.name, dish.count, dict);
  if (!n) return '';
  const origin = n.verified ? 'checked by you' : SOURCE_LABEL[n.source] || n.source;
  const title = [
    `${n.each} kcal per serving`,
    n.portion ? `assumed ${n.portion} g` : null,
    n.protein ? `${n.protein} g protein` : null,
    `${n.total.toLocaleString('en-IN')} kcal across ${dish.count}`,
    `— ${origin}`,
  ].filter(Boolean).join(' · ');
  return `<span class="fd-card-kcal mono ${n.verified ? 'is-verified' : ''}" title="${escapeHTML(title)}">${
    n.each.toLocaleString('en-IN')} kcal</span>`;
}

// ── Calories over time ─────────────────────────────────

/**
 * The one chart on this page.
 *
 * Plots kcal **per eating day**, at a grain the period chooses for itself —
 * days for a month, weeks for a quarter, months for a year. The grain changes
 * the resolution, never the units: a week bucket is the average of its eating
 * days, not their sum, so widening the period cannot make the line jump by a
 * factor of seven and look like a change in how you eat.
 */
function renderCalorieChart() {
  const card = document.getElementById('fd-chart-card');
  if (!card) return;

  // Nothing to plot before the resolver has run. An empty chart claims the data
  // exists and is flat; no chart claims nothing.
  if (!dict.size) { card.hidden = true; calorieChartRef = destroyChart(calorieChartRef); return; }

  const zone = timeZone();
  const n = summarise(inPeriod(), dict, { dateOf: iso => localDateISO(iso, zone) });
  if (!n.days.length) { card.hidden = true; calorieChartRef = destroyChart(calorieChartRef); return; }
  card.hidden = false;

  // The grain follows the period instead of asking: a week of days reads as
  // days, a year of days reads as months. One control on the page, not two
  // fighting over the same x-axis.
  const { from, to } = periodDates();
  const span = Math.round((new Date(to) - new Date(from)) / 86_400_000) + 1;
  const grain = span <= 45 ? 'day' : span <= 200 ? 'week' : 'month';

  const buckets = bucketDays(n.days, grain);
  const target = kcalTarget();
  const over = buckets.map(b => b.kcal > target);

  calorieChartRef = destroyChart(calorieChartRef);
  const canvas = document.getElementById('fd-calorie-chart');
  if (!canvas) return;

  const gradient = canvas.getContext('2d').createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, 'rgba(56,189,248,0.18)');
  gradient.addColorStop(1, 'rgba(56,189,248,0)');

  calorieChartRef = new Chart(canvas, {
    type: 'line',
    data: {
      labels: buckets.map(b => b.at),
      datasets: [
        {
          label: 'kcal per eating day',
          data: buckets.map(b => b.kcal),
          borderColor: CHART_COLORS.accent,
          backgroundColor: gradient,
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          // The red points ARE the feature: a day that crossed the target is
          // marked on the curve itself, not in a legend. Everything under the
          // line stays quiet so the crossings are the only thing that shouts.
          pointRadius: buckets.map((b, i) => (over[i] ? 4.5 : grain === 'day' && buckets.length > 45 ? 0 : 2.5)),
          pointHoverRadius: 7,
          pointBackgroundColor: over.map(o => (o ? CHART_COLORS.danger : CHART_COLORS.accent)),
          pointBorderColor: over.map(o => (o ? 'rgba(239,68,68,0.35)' : 'transparent')),
          pointBorderWidth: over.map(o => (o ? 3 : 0)),
        },
        {
          // The target as a dataset rather than a plugin: it scales, pans and
          // tooltips with everything else for free.
          label: 'Target',
          data: buckets.map(() => target),
          borderColor: 'rgba(148,163,184,0.5)',
          borderWidth: 1,
          borderDash: [5, 5],
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => item.datasetIndex === 0,
          callbacks: {
            label: (ctx) => {
              const b = buckets[ctx.dataIndex];
              const versus = b.kcal > target
                ? ` — ${(b.kcal - target).toLocaleString('en-IN')} over target`
                : ` — ${(target - b.kcal).toLocaleString('en-IN')} under target`;
              const lines = [` ${b.kcal.toLocaleString('en-IN')} kcal${versus}`];
              if (b.protein) lines.push(` ${b.protein} g protein`);
              // A week averaged over two eating days is a much weaker claim
              // than one averaged over seven, and the chart cannot show that.
              lines.push(grain === 'day'
                ? ` ${b.meals} meal${b.meals === 1 ? '' : 's'}`
                : ` over ${b.days} eating day${b.days === 1 ? '' : 's'}, ${b.meals} meals`);
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: grain === 'month'
            ? { unit: 'month', displayFormats: { month: 'MMM yy' } }
            : { unit: grain === 'week' ? 'week' : 'day', displayFormats: { day: 'd MMM', week: 'd MMM' } },
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkipPadding: 16 },
        },
        y: {
          beginAtZero: true,
          // Keep the target line inside the plot even on a light week.
          suggestedMax: Math.round(target * 1.15),
          grid: { color: 'rgba(148,163,184,0.06)' },
          ticks: { callback: v => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v) },
        },
      },
    },
  });
}

// ── Header numbers ─────────────────────────────────────

function renderKPIs() {
  const grid = document.getElementById('fd-stats');
  if (!grid) return;

  const list = inPeriod();
  const zone = timeZone();
  const today = localDateISO(new Date(), zone);
  const target = kcalTarget();

  const meals = list.filter(e => e.subtype !== 'groceries');
  const todayMeals = meals.filter(e => localDateISO(e.occurred_at, zone) === today);
  const spend = list.reduce((sum, e) => sum + (isInflow(e) ? 0 : Number(e.data?.amount) || 0), 0);
  const top = aggregateDishes(list)[0];

  // Calories only when the dictionary can actually answer. Before the resolver
  // has run there is nothing to show, and a zero would be a claim rather than
  // an absence — so the cards keep their pre-nutrition shape instead.
  const n = dict.size ? summarise(list, dict, { dateOf: iso => localDateISO(iso, zone) }) : null;
  const todayKcal = n ? (n.days.find(d => d.day === today)?.kcal ?? null) : null;
  const overDays = n ? n.days.filter(d => d.kcal > target).length : 0;

  const kpis = n?.kcalPerDay ? [
    // Today leads, phrased against the target — the number that decides what
    // dinner looks like, not a recap of lunch. The meter is the day filling up.
    { id: 'fd-kpi-today', label: 'Today', icon: 'fa-utensils',
      value: todayKcal !== null ? todayKcal.toLocaleString('en-IN') : '—', unit: ' kcal',
      progress: todayKcal !== null ? (todayKcal / target) * 100 : 0,
      tone: todayKcal !== null && todayKcal > target ? 'danger' : 'accent',
      sub: todayKcal === null ? 'nothing priced yet'
        : todayKcal > target ? `${(todayKcal - target).toLocaleString('en-IN')} over target`
        : `${(target - todayKcal).toLocaleString('en-IN')} kcal left`,
      tooltip: `Against your ${target.toLocaleString('en-IN')} kcal daily target`,
      raw: todayKcal ?? 0 },
    // Per *eating* day, never per calendar day: the ledger knows nothing about
    // the days you cooked, and dividing by those would report a diet nobody
    // has. Coverage rides along, because the same average over 40% of meals
    // and over 95% of them are different claims.
    { id: 'fd-kpi-perday', label: 'Per eating day', icon: 'fa-fire',
      value: n.kcalPerDay.toLocaleString('en-IN'), unit: ' kcal',
      tone: n.kcalPerDay > target ? 'warning' : 'teal',
      sub: `${Math.round(n.coverage * 100)}% of meals priced`,
      tooltip: 'Average over days with at least one priced meal',
      raw: n.kcalPerDay },
    { id: 'fd-kpi-over', label: 'Days over target', icon: 'fa-arrow-trend-up',
      value: String(overDays),
      tone: overDays ? 'danger' : 'success',
      badge: overDays ? undefined : { type: 'ok', text: 'On track' },
      sub: `of ${n.activeDays} eating day${n.activeDays === 1 ? '' : 's'}`,
      tooltip: `Days above ${target.toLocaleString('en-IN')} kcal in this period`,
      raw: overDays },
    { id: 'fd-kpi-protein', label: 'Protein', icon: 'fa-dumbbell',
      value: String(n.proteinPerDay), unit: ' g',
      tone: 'purple', sub: 'per eating day', raw: n.proteinPerDay },
    { id: 'fd-kpi-spend', label: 'Spend', icon: 'fa-receipt',
      value: formatINRFull(spend),
      tone: 'pink', sub: `${meals.length} meal${meals.length === 1 ? '' : 's'}`, raw: spend },
  ] : [
    { id: 'fd-kpi-today', label: 'Today', icon: 'fa-utensils',
      value: String(todayMeals.length || '—'),
      sub: todayMeals.length ? todayMeals.map(e => e.data?.restaurant || e.data?.merchant).filter(Boolean)[0] || 'meals' : 'nothing yet',
      raw: todayMeals.length },
    { id: 'fd-kpi-meals', label: 'Meals', icon: 'fa-utensils',
      value: String(meals.length), sub: formatINRFull(spend), raw: meals.length },
    { id: 'fd-kpi-top', label: 'Most eaten', icon: 'fa-ranking-star',
      value: top ? `${top.count}×` : '—', sub: top ? top.name : 'nothing recorded yet', raw: top?.count ?? 0 },
  ];

  renderKpiCards(grid, kpis);
}

/** How many meals in the period still have nothing in them. */
function renderGapCount() {
  const badge = document.getElementById('fd-gap-count');
  if (!badge) return;
  const zone = timeZone();
  const { from, to } = periodDates();
  const gaps = events.filter(e => {
    const d = localDateISO(e.occurred_at, zone);
    return d >= from && d <= to && isEmptyBasket(e);
  }).length;
  badge.textContent = gaps;
  document.getElementById('fd-gaps').disabled = gaps === 0 && !onlyEmpty;
}

function emptyState() {
  if (onlyEmpty) {
    return `
      <div class="empty-state">
        <i class="fas fa-circle-check" style="font-size:1.5rem;color:var(--success)"></i>
        <p style="margin-top:0.75rem">Every meal in this period has its dishes.</p>
      </div>`;
  }
  if (query) {
    return `
      <div class="empty-state">
        <i class="fas fa-filter-circle-xmark" style="font-size:1.5rem;color:var(--text-muted)"></i>
        <p style="margin-top:0.75rem">Nothing matching “${escapeHTML(query)}”.</p>
      </div>`;
  }
  return `
    <div class="empty-state">
      <i class="fas fa-utensils" style="font-size:1.5rem;color:var(--accent)"></i>
      <p style="margin-top:0.75rem">No food events in this period.</p>
      <p class="text-muted" style="font-size:0.85rem;max-width:34rem;margin:0.5rem auto 0">
        Meals arrive with the order receipts. Widen the period, run <code>npm run ledger:ingest</code>,
        or add one yourself with the + button.
      </p>
    </div>`;
}

/** One row per item, not per order — the point of the export is the dishes. */
function exportItems() {
  const zone = timeZone();
  const headers = ['Date', 'Time', 'Meal', 'Place', 'Ordered via', 'Qty', 'Item', 'Item amount', 'Order total'];
  const rows = [];

  for (const event of visible()) {
    const base = [
      localDateISO(event.occurred_at, zone),
      formatTime(event.occurred_at),
      mealMeta(mealSlot(event.occurred_at, zone, event.subtype) || 'snack').label,
      event.data?.restaurant || event.data?.merchant || '',
      event.data?.ordered_via || '',
    ];
    const items = event.data?.items || [];
    if (!items.length) { rows.push([...base, '', '', '', event.data?.amount ?? '']); continue; }
    for (const item of items) {
      rows.push([...base, item.qty ?? 1, item.name, item.amount ?? '', event.data?.amount ?? '']);
    }
  }

  downloadCSV(headers, rows, `food-${localDateISO(new Date(), zone)}.csv`);
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timeZone(),
  });
}

function formatDayHeading(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

