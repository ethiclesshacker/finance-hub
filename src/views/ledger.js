// ======================================================
// The Life timeline.
//
// A chronological record of what happened, newest first, grouped by day. The
// database is the product here — this screen exists so that a ledger filling
// itself from email is inspectable and correctable, not so that anything has
// to be typed into it.
//
// Three things every row must show, because they are what make the record
// trustworthy: when it happened, where the claim came from, and how sure the
// system is. An event with no visible provenance is indistinguishable from one
// a model made up.
// ======================================================

import * as api from '../ledger/api.js';
import { EVENT_TYPES, STATUSES, SOURCE_TYPES, SUBTYPES, typeMeta, statusMeta, sourceMeta } from '../ledger/taxonomy.js';
import { parseQuickEntry } from '../ledger/nlparse.js';
import { summariseItems } from '../ledger/items.js';
import { localDateISO } from '../ledger/normalize.js';
import { formatTime as fmtTime, formatDayHeading, toLocalInput } from '../ledger/dates.js';
import { isInflow, moneyFlow } from '../ledger/summary.js';
import * as settings from '../settings.js';
import {
  escapeHTML, formatINRFull, openModal, closeModal, showToast, todayISO, downloadCSV, downloadBlob,
  comboboxHTML, wireCombobox, renderKpiCards, emptyState,
} from '../utils.js';

let events = [];
let summaries = {};
let total = 0;
let activeTab = 'timeline';       // timeline | review
let filters = { query: '', types: [], statuses: [], sourceTypes: [], from: null, to: null };
let searchDebounce = null;
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;
// The click-outside handler for the filter panel lives on `document`, so it
// has to be removed on unmount or every visit stacks another one.
let docClickHandler = null;

const timeZone = () => settings.get('ledger_timezone') || 'Asia/Kolkata';
const formatTime = iso => fmtTime(iso, timeZone());

export async function renderLedger(container) {
  activeTab = 'timeline';
  filters = { query: '', types: [], statuses: [], sourceTypes: [], from: null, to: null };

  container.innerHTML = `
    <div class="page-header lg-header">
      <div class="page-header-left">
        <h2>Life</h2>
        <p>A structured record of what happened — mostly filled in by itself</p>
      </div>
      <div class="lg-header-right">
        <div class="lg-header-actions">
          <span id="lg-ingest-badge" class="badge badge-gray" title="Last ingestion run">
            <i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> Checking…
          </span>
          <button type="button" class="btn-sm btn-ghost" id="lg-export-btn">
            <i class="fas fa-download"></i> Export
          </button>
        </div>
      </div>
    </div>

    <div class="page-body lg-body vp-page">
      <div class="kpi-grid lg-kpis" id="lg-stats"></div>

      <div class="table-section vp-panel">
        <div class="table-toolbar fd-toolbar">
          <div class="table-tabs">
            <button type="button" class="table-tab active" id="lg-tab-timeline">
              <i class="fas fa-stream" aria-hidden="true"></i>Timeline
            </button>
            <button type="button" class="table-tab" id="lg-tab-review">
              <i class="fas fa-circle-question" aria-hidden="true"></i>Review
              <span class="kpi-badge neutral" id="lg-review-count">0</span>
            </button>
          </div>
          <div class="lg-controls">
            <div class="search-input-wrap lg-search">
              <i class="fas fa-search"></i>
              <input type="text" class="search-input" id="lg-search" placeholder="Search the ledger" />
            </div>
            <details class="lg-filters" id="lg-filters">
              <summary title="Narrow the timeline">
                <i class="fas fa-sliders" aria-hidden="true"></i>
                <span>Filter</span>
                <span class="lg-filter-count" id="lg-filter-count" hidden></span>
              </summary>
              <div class="lg-filter-grid">
                <label class="lg-field">
                  <span>Type</span>
                  <select class="form-select lg-filter" id="lg-filter-type">
                    <option value="">Any</option>
                    ${EVENT_TYPES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
                  </select>
                </label>
                <label class="lg-field">
                  <span>Source</span>
                  <select class="form-select lg-filter" id="lg-filter-source">
                    <option value="">Any</option>
                    ${SOURCE_TYPES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
                  </select>
                </label>
                <label class="lg-field">
                  <span>State</span>
                  <select class="form-select lg-filter" id="lg-filter-status">
                    <option value="">Any</option>
                    ${STATUSES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
                  </select>
                </label>
                <label class="lg-field">
                  <span>From</span>
                  <input type="date" class="form-input lg-filter" id="lg-filter-from" />
                </label>
                <label class="lg-field">
                  <span>To</span>
                  <input type="date" class="form-input lg-filter" id="lg-filter-to" />
                </label>
                <button type="button" class="btn-sm btn-ghost" id="lg-clear-filters">Clear all</button>
              </div>
            </details>
            <button type="button" class="btn-icon" id="lg-refresh-btn" title="Check for new events" aria-label="Check for new events">
              <i class="fas fa-rotate-right"></i>
            </button>
          </div>
        </div>
        <div class="vp-scroll">
          <div id="lg-timeline"></div>
        </div>
      </div>
    </div>

    <button type="button" class="fab" id="lg-fab" title="Add event" aria-label="Add event">
      <i class="fas fa-plus"></i>
    </button>
  `;

  document.getElementById('lg-tab-timeline').addEventListener('click', () => switchTab('timeline'));
  document.getElementById('lg-tab-review').addEventListener('click', () => switchTab('review'));
  document.getElementById('lg-fab').addEventListener('click', () => openQuickAdd());
  document.getElementById('lg-refresh-btn').addEventListener('click', () => loadData());
  document.getElementById('lg-export-btn').addEventListener('click', exportLedger);

  document.getElementById('lg-search').addEventListener('input', e => {
    filters.query = e.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadData, 250);
  });

  document.getElementById('lg-clear-filters').addEventListener('click', () => {
    document.querySelectorAll('.lg-filter').forEach(el => { el.value = ''; });
    filters = { ...filters, types: [], statuses: [], sourceTypes: [], from: null, to: null };
    reflectFilterCount();
    loadData();
  });

  document.querySelectorAll('.lg-filter').forEach(el => el.addEventListener('change', () => {
    filters.types       = pick('lg-filter-type');
    filters.sourceTypes = pick('lg-filter-source');
    filters.statuses    = pick('lg-filter-status');
    filters.from = dayBoundary('lg-filter-from', false);
    filters.to   = dayBoundary('lg-filter-to', true);
    reflectFilterCount();
    loadData();
  }));

  reflectFilterCount();

  // The filters are a panel floating over the timeline now, so they need the
  // two things every panel needs: a click outside and Escape both close it.
  const filterPanel = document.getElementById('lg-filters');
  if (docClickHandler) document.removeEventListener('click', docClickHandler);
  docClickHandler = e => {
    if (filterPanel.open && !e.target.closest('#lg-filters')) filterPanel.open = false;
  };
  document.addEventListener('click', docClickHandler);
  filterPanel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { filterPanel.open = false; filterPanel.querySelector('summary').focus(); }
  });

  await loadData();
}

export { renderLedger as render };

/** Drop the document listener and the pending search before the DOM goes. */
export function unmount() {
  loadToken++;
  clearTimeout(searchDebounce);
  searchDebounce = null;
  if (docClickHandler) document.removeEventListener('click', docClickHandler);
  docClickHandler = null;
}

/** Show how many filters are on, so a narrowed timeline never looks empty. */
function reflectFilterCount() {
  const active = [...document.querySelectorAll('.lg-filter')].filter(el => el.value).length;
  const badge = document.getElementById('lg-filter-count');
  const wrap = document.getElementById('lg-filters');
  if (!badge || !wrap) return;
  badge.textContent = active;
  badge.hidden = active === 0;
  wrap.classList.toggle('is-active', active > 0);
}

function pick(id) {
  const value = document.getElementById(id)?.value;
  return value ? [value] : [];
}

/** A date input is a local calendar day; the ledger stores instants. */
function dayBoundary(id, exclusiveEnd) {
  const value = document.getElementById(id)?.value;
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + (exclusiveEnd ? 1 : 0)));
  // Approximate the user's zone by asking the browser for the same wall clock.
  return new Date(date.toISOString().slice(0, 10) + 'T00:00:00' + zoneSuffix()).toISOString();
}

function zoneSuffix() {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

async function switchTab(tab) {
  activeTab = tab;
  document.getElementById('lg-tab-timeline').classList.toggle('active', tab === 'timeline');
  document.getElementById('lg-tab-review').classList.toggle('active', tab === 'review');
  await loadData();
}

async function loadData() {
  afterMutate = loadData;
  const token = ++loadToken;
  const container = document.getElementById('lg-timeline');
  if (container) container.innerHTML = `<div class="skeleton skeleton--table"></div>`;

  try {
    const [result, review, runs, written] = await Promise.all([
      activeTab === 'review' ? api.reviewQueue(100) : api.searchEvents({ ...filters, limit: 200 }),
      api.reviewQueue(100),
      api.recentRuns(3).catch(() => []),
      // Written nightly from the same events. Missing summaries are normal —
      // a day the job has not reached yet simply has none.
      api.dailySummaries(null, null).catch(() => ({})),
    ]);
    if (token !== loadToken || !container?.isConnected) return;

    summaries = written || {};

    events = result?.events || [];
    total = result?.total ?? events.length;

    const reviewCount = review?.total ?? 0;
    const badge = document.getElementById('lg-review-count');
    if (badge) badge.textContent = reviewCount;

    renderKPIs(reviewCount);
    renderIngestBadge(runs);
    renderTimeline();
  } catch (err) {
    if (token !== loadToken) return;
    if (container) {
      container.innerHTML = emptyState({
        icon: 'fa-triangle-exclamation', tone: 'warning',
        title: 'Could not load the ledger.', hint: err.message,
        detail: 'If this says a function is missing, the ledger migrations (<code>0003_event_ledger.sql</code>, <code>0004_ledger_api.sql</code>) have not been run yet.',
      });
    }
  }
}

function renderIngestBadge(runs) {
  const badge = document.getElementById('lg-ingest-badge');
  if (!badge) return;

  const last = runs?.[0];
  if (!last) {
    badge.className = 'badge badge-gray';
    badge.innerHTML = `<i class="fas fa-plug" aria-hidden="true"></i> No ingestion yet`;
    badge.title = 'Run: npm run ledger:ingest';
    return;
  }

  const when = new Date(last.started_at);
  const minutes = Math.round((Date.now() - when.getTime()) / 60000);
  const ago = minutes < 60 ? `${minutes}m ago`
            : minutes < 1440 ? `${Math.round(minutes / 60)}h ago`
            : `${Math.round(minutes / 1440)}d ago`;

  const tone = last.status === 'succeeded' ? 'badge-green'
             : last.status === 'partial' ? 'badge-yellow' : 'badge-red';
  badge.className = `badge ${tone}`;
  badge.innerHTML = `<i class="fas fa-envelope" aria-hidden="true"></i> ${escapeHTML(last.source_type)} · ${ago}`;
  badge.title = `${last.status} — ${last.items_seen} seen, ${last.events_created} created, ${last.events_updated} updated`;
}

function renderKPIs(reviewCount) {
  const grid = document.getElementById('lg-stats');
  if (!grid) return;

  const zone = timeZone();
  const today = localDateISO(new Date(), zone);
  const weekAgo = localDateISO(new Date(Date.now() - 6 * 86_400_000), zone);

  const spendOf = list => list.reduce((sum, e) => {
    const amount = Number(e.data?.amount);
    return sum + (Number.isFinite(amount) && !isInflow(e) ? amount : 0);
  }, 0);

  const todayEvents = events.filter(e => localDateISO(e.occurred_at, zone) === today);
  const weekEvents = events.filter(e => localDateISO(e.occurred_at, zone) >= weekAgo);
  const auto = events.filter(e => e.source_type !== 'manual' && e.source_type !== 'hermes').length;
  const autoPct = events.length ? Math.round((auto / events.length) * 100) : 0;

  // Full cards, not the header chips these used to be. The chips existed
  // because four cards pushed a *scrolling* timeline down to three visible
  // rows — but the timeline scrolls inside its own panel now, so the cards no
  // longer cost it anything. Same trade, opposite answer.
  renderKpiCards(grid, [
    { id: 'lg-kpi-today', label: 'Today', icon: 'fa-calendar-day',
      value: String(todayEvents.length || '—'),
      sub: todayEvents.length ? formatINRFull(spendOf(todayEvents)) : 'nothing yet',
      raw: todayEvents.length },
    { id: 'lg-kpi-week', label: '7 days', icon: 'fa-calendar-week', tone: 'teal',
      value: String(weekEvents.length), sub: formatINRFull(spendOf(weekEvents)),
      raw: weekEvents.length },
    { id: 'lg-kpi-auto', label: 'Automatic', icon: 'fa-wand-magic-sparkles', tone: 'purple',
      value: `${autoPct}%`, sub: `${auto} of ${events.length} events`,
      tooltip: 'Events the ledger filled in by itself, from email and card alerts',
      raw: autoPct },
    { id: 'lg-kpi-review', label: 'To review', icon: 'fa-circle-question',
      tone: reviewCount ? 'warning' : 'success',
      value: String(reviewCount),
      badge: reviewCount ? undefined : { type: 'ok', text: 'All clear' },
      sub: reviewCount ? 'needs a look — click to open' : 'nothing waiting',
      tooltip: reviewCount ? 'Open the review queue' : '',
      raw: reviewCount },
  ]);

  // The review card is a door, not just a number.
  const reviewCard = document.getElementById('lg-kpi-review');
  if (reviewCard && reviewCount) {
    reviewCard.addEventListener('click', () => switchTab('review'));
  }
}

// ── Timeline ───────────────────────────────────────────

function renderTimeline() {
  const container = document.getElementById('lg-timeline');
  if (!container) return;

  if (!events.length) {
    container.innerHTML = timelineEmptyState();
    return;
  }

  const days = new Map();
  for (const event of events) {
    const day = localDateISO(event.occurred_at, timeZone());
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(event);
  }

  const today = localDateISO(new Date(), timeZone());
  const yesterday = localDateISO(new Date(Date.now() - 86_400_000), timeZone());

  container.innerHTML = `<div class="timeline">${[...days.entries()].map(([day, list]) => {
    const heading = day === today ? 'Today' : day === yesterday ? 'Yesterday' : formatDayHeading(day);
    // Money out only. A refund landing on a Tuesday should not read as if the
    // day cost less than it did.
    const dayTotal = list.reduce((sum, e) =>
      sum + (isInflow(e) ? 0 : (Number(e.data?.amount) || 0)), 0);
    const written = summaries[day];

    return `
      <section class="tl-day" aria-label="${escapeHTML(heading)}">
        <header class="tl-day-head">
          <div class="tl-day-id">
            <span class="tl-day-label">${escapeHTML(heading)}</span>
            <span class="tl-day-meta">
              ${list.length} event${list.length === 1 ? '' : 's'}${dayTotal ? ` · ${escapeHTML(formatINRFull(dayTotal))}` : ''}
            </span>
          </div>
          ${written?.summary ? `
            <button type="button" class="tl-day-summary is-clamped"
                    aria-expanded="false"
                    title="Written from these events by ${escapeHTML(written.generated_by || 'the system')}">
              ${escapeHTML(written.summary)}
            </button>` : ''}
        </header>
        ${list.map(renderRow).join('')}
      </section>`;
  }).join('')}</div>`;

  // A day's summary opens to full length on click. Clamped, it says enough to
  // decide whether to read on; unclamped on every day, it buries the events it
  // is describing — on a two-event day the paragraph was longer than the day.
  container.querySelectorAll('.tl-day-summary').forEach(el => {
    el.addEventListener('click', () => {
      const open = el.classList.toggle('is-clamped') === false;
      el.setAttribute('aria-expanded', String(open));
    });
  });

  container.querySelectorAll('.tl-item').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.id));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(row.dataset.id); }
    });
  });
}

function renderRow(event) {
  const type = typeMeta(event.type);
  const status = statusMeta(event.status);
  const source = sourceMeta(event.source_type);
  const amount = Number(event.data?.amount);
  // Green and signed only for money that actually arrived — not for a transfer
  // between your own accounts, which is neither in nor out.
  const inflow = moneyFlow(event) === 'inflow';

  // Everything that is not the amount. The amount used to appear twice — once
  // inside the title the extractor wrote and again in this line — so it is now
  // pulled out into its own right-hand column where the figures align down the
  // day and can actually be compared.
  const bits = [];
  if (event.data?.origin && event.data?.destination) bits.push(`${event.data.origin} → ${event.data.destination}`);
  const where = event.data?.restaurant || event.data?.merchant || event.data?.place;
  if (where && !event.title.includes(where)) bits.push(where);
  // What was in the order, when the receipt listed it. On a food row this is
  // the line worth reading: "Kapoor's Cafe" is where, "Matar Paneer Mini
  // Thali" is what actually happened.
  const basket = summariseItems(event.data?.items);
  if (basket) bits.push(basket);
  const people = (event.entities || []).filter(e => e.type === 'person').map(e => e.name);
  if (people.length) bits.push(people.slice(0, 3).join(', '));

  const needsReview = event.status === 'needs_review';
  const scheduled = event.status === 'scheduled';
  // `inferred` is the common case for extracted events, so a badge on every
  // row would be wallpaper. It reads as a dimmed rule on the left edge
  // instead, and only the genuinely uncertain get a badge.
  const uncertain = event.status === 'inferred';

  const title = stripTrailingAmount(event.title);

  return `
    <article class="tl-item ${needsReview ? 'is-review' : ''} ${uncertain ? 'is-inferred' : ''}"
             data-id="${escapeHTML(event.id)}" role="button" tabindex="0"
             aria-label="${escapeHTML(event.title)}">
      <div class="tl-when">
        <span class="tl-time mono">${escapeHTML(formatTime(event.occurred_at))}</span>
        <span class="tl-src" title="From ${escapeHTML(source.label)}${event.source_count > 1 ? ` · ${event.source_count} sources agree` : ''}">
          <i class="fas ${source.icon}" aria-hidden="true"></i>${event.source_count > 1 ? `<b>${event.source_count}</b>` : ''}
        </span>
      </div>

      <span class="tl-icon" style="--tint:${type.color}"><i class="fas ${type.icon}" aria-hidden="true"></i></span>

      <div class="tl-body">
        <h3 class="tl-title">${escapeHTML(title)}</h3>
        <div class="tl-meta">
          <span class="tl-type" style="color:${type.color}">${escapeHTML(type.label)}${event.subtype ? ` · ${escapeHTML(event.subtype.replace(/_/g, ' '))}` : ''}</span>
          ${bits.map(b => `<span>${escapeHTML(b)}</span>`).join('')}
          ${needsReview ? `<span class="tl-flag" title="${escapeHTML(status.hint)}">Needs review</span>` : ''}
          ${scheduled ? `<span class="tl-flag is-scheduled" title="${escapeHTML(status.hint)}">Scheduled</span>` : ''}
        </div>
      </div>

      ${Number.isFinite(amount) ? `
        <div class="tl-amount mono ${inflow ? 'is-in' : ''} ${!inflow && amount >= 5000 ? 'is-large' : ''}">
          ${inflow ? '+' : ''}${escapeHTML(formatINRFull(amount))}
        </div>` : '<div class="tl-amount"></div>'}
    </article>`;
}

/**
 * Extractors put the amount in the title ("Zomato — ₹140") because a title has
 * to stand alone in a search result or a Hermes answer. In the timeline the
 * amount has its own column, so printing it twice on one row is just noise.
 */
function stripTrailingAmount(title) {
  return String(title).replace(/\s*[—–-]\s*[+]?[₹$€£]\s*[\d,]+(?:\.\d{1,2})?\s*$/, '').trim() || title;
}

function timelineEmptyState() {
  const filtered = filters.query || filters.types.length || filters.statuses.length
                || filters.sourceTypes.length || filters.from || filters.to;

  if (activeTab === 'review') {
    return emptyState({
      icon: 'fa-circle-check', tone: 'success', title: 'Nothing waiting for review.',
      hint: 'Uncertain extractions land here to be confirmed, corrected, merged or dismissed.',
    });
  }

  if (filtered) {
    return emptyState({ icon: 'fa-filter-circle-xmark', title: 'No events match those filters.' });
  }

  return emptyState({
    icon: 'fa-stream', tone: 'accent', title: 'The ledger is empty.',
    detail: 'It is meant to fill itself. Connect a mailbox in <code>ledger/accounts.json</code> and run '
          + '<code>npm run ledger:ingest</code> — or add something by hand with the + button.',
  });
}



// ── Detail ─────────────────────────────────────────────

/**
 * The event detail modal, opened from another screen.
 *
 * `onChange` is what to reload after a confirm, edit, merge or dismissal — the
 * Food page needs its own list refreshed, not this one's. It is held on the
 * module rather than threaded through every nested modal, because the edit and
 * merge dialogs are opened *by* the detail modal and have to refresh the same
 * caller.
 */
let afterMutate = loadData;

export function openEventDetail(eventId, onChange) {
  afterMutate = onChange || loadData;
  return openDetail(eventId);
}

async function openDetail(eventId) {
  openModal({ title: 'Event', body: '<div class="skeleton skeleton--table"></div>' });

  let event;
  try {
    event = await api.getEvent(eventId);
  } catch (err) {
    showToast('Could not load that event: ' + err.message, 'error');
    closeModal();
    return;
  }
  if (!event) { showToast('That event no longer exists.', 'error'); closeModal(); return; }

  const type = typeMeta(event.type);
  const status = statusMeta(event.status);
  const automatic = event.source_type !== 'manual' && event.source_type !== 'hermes';
  const needsAttention = event.status === 'needs_review' || event.status === 'inferred';

  openModal({
    title: stripTrailingAmount(event.title),
    icon: type.icon, iconColor: type.color,
    body: `
      <div class="lg-detail-head">
        <div class="lg-detail-when">
          <span class="mono">${escapeHTML(formatFullTime(event.occurred_at))}${
            event.occurred_at_end ? ` → ${escapeHTML(formatTime(event.occurred_at_end))}` : ''}</span>
          <span class="lg-detail-kind">
            ${escapeHTML(type.label)}${event.subtype ? ` · ${escapeHTML(event.subtype.replace(/_/g, ' '))}` : ''}
          </span>
        </div>
        <div class="lg-detail-badges">
          <span class="badge ${status.badge}" title="${escapeHTML(status.hint)}">${escapeHTML(status.label)}</span>
          <span class="badge ${automatic ? 'badge-blue' : 'badge-gray'}">
            ${automatic ? 'Extracted automatically' : 'Entered by you'}
          </span>
          ${event.confidence !== null && event.confidence !== undefined
            ? `<span class="badge badge-gray" title="How sure the extractor was">${Math.round(event.confidence * 100)}% confidence</span>` : ''}
        </div>
      </div>

      ${event.description ? `<p class="lg-detail-desc">${escapeHTML(event.description)}</p>` : ''}

      ${section('Facts', renderFields(event.data), 'What a source actually stated. Never overwritten by an interpretation.')}
      ${Object.keys(event.inference || {}).length
        ? section('Interpretation', renderFields(event.inference), 'Derived, not stated. Safe to disagree with.')
        : ''}

      ${section('Sources', renderSources(event.sources), 'Every piece of evidence for this event.')}
      ${event.entities?.length ? section('Entities', renderEntities(event.entities)) : ''}
      ${event.related_events?.length ? section('Related events', renderRelated(event.related_events)) : ''}
      ${event.history?.length ? section('History', renderHistory(event.history), 'Corrections are kept, not silently applied.') : ''}`,
    footerClass: 'is-wrap',
    footer: `
      ${needsAttention ? `<button type="button" class="btn-sm btn-accent" id="lg-confirm-btn"><i class="fas fa-check"></i> Confirm</button>` : ''}
      <button type="button" class="btn-sm btn-ghost" id="lg-merge-btn"><i class="fas fa-code-merge"></i> Merge</button>
      <button type="button" class="btn-sm btn-ghost" id="lg-edit-btn"><i class="fas fa-pencil"></i> Edit</button>
      <button type="button" class="btn-sm btn-ghost" id="lg-dismiss-btn"><i class="fas fa-ban"></i> Dismiss</button>
      <button type="button" class="btn-sm btn-danger" id="lg-delete-btn"><i class="fas fa-trash"></i> Delete</button>
      <button type="button" class="btn-cancel" data-close>Close</button>`,
  });

  document.getElementById('lg-confirm-btn')?.addEventListener('click', async () => {
    await mutate(() => api.updateEvent(event.id, { status: 'confirmed' }), 'Confirmed.');
  });

  document.getElementById('lg-edit-btn').addEventListener('click', () => openEdit(event));
  document.getElementById('lg-merge-btn').addEventListener('click', () => openMerge(event));

  document.getElementById('lg-dismiss-btn').addEventListener('click', async () => {
    const reason = prompt('Why is this not a real event? (optional)') ?? undefined;
    await mutate(() => api.dismissEvent(event.id, reason || null),
                 'Dismissed. It will not be re-created by a later run.');
  });

  document.getElementById('lg-delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this event permanently? Dismissing is usually better — it keeps the provenance and stops it coming back.')) return;
    const purge = confirm('Also delete the stored source references, if nothing else uses them?');
    await mutate(() => api.deleteEvent(event.id, purge), 'Deleted.');
  });
}

async function mutate(action, successMessage) {
  try {
    await action();
    showToast(successMessage);
    closeModal();
    await afterMutate();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function section(title, body, hint) {
  if (!body) return '';
  return `
    <div class="lg-section">
      <div class="lg-section-title">
        ${escapeHTML(title)}
        ${hint ? `<span class="lg-section-hint">${escapeHTML(hint)}</span>` : ''}
      </div>
      ${body}
    </div>`;
}

function renderFields(data) {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';
  return `<dl class="lg-facts">${entries.map(([key, value]) => {
    const text = formatValue(key, value);
    // Items lists, addresses and snippets need the whole row; a merchant or an
    // amount does not, and pairing those two-up halves the height.
    const wide = Array.isArray(value) || text.length > 38;
    return `
      <dt class="lg-fact-key">${escapeHTML(key.replace(/_/g, ' '))}</dt>
      <dd class="lg-fact-value mono ${wide ? 'is-wide' : ''}">${escapeHTML(text)}</dd>`;
  }).join('')}</dl>`;
}

function formatValue(key, value) {
  // Exact here. The timeline rounds for scanning, but this section is the
  // record of what a source stated, and ₹94.58 is not ₹95.
  if (key === 'amount' && Number.isFinite(Number(value))) {
    const amount = Number(value);
    return Number.isInteger(amount) ? formatINRFull(amount) : `₹${amount.toFixed(2)}`;
  }
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'object' && v !== null ? (v.name || JSON.stringify(v)) : String(v))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderSources(sources) {
  if (!sources?.length) return `<p class="modal-note">No source recorded — this event was created directly.</p>`;
  return `<div class="lg-sources">${sources.map(source => {
    const meta = sourceMeta(source.source_type);
    const subject = source.metadata?.subject;
    return `
      <div class="lg-source">
        <i class="fas ${meta.icon}" aria-hidden="true"></i>
        <div class="lg-source-body">
          <div class="lg-source-title">${escapeHTML(subject || meta.label)}</div>
          <div class="lg-source-meta">
            ${escapeHTML(source.role)} · ${escapeHTML(source.extracted_by || 'unknown')}
            ${source.metadata?.from ? ` · ${escapeHTML(source.metadata.from)}` : ''}
            ${source.source_timestamp ? ` · ${escapeHTML(formatFullTime(source.source_timestamp))}` : ''}
          </div>
          ${source.metadata?.snippet ? `<div class="lg-source-snippet">${escapeHTML(source.metadata.snippet)}</div>` : ''}
        </div>
        ${source.external_url
          ? `<a class="btn-sm btn-ghost" href="${escapeHTML(source.external_url)}" target="_blank" rel="noopener noreferrer">Open</a>`
          : ''}
      </div>`;
  }).join('')}</div>`;
}

function renderEntities(entities) {
  return `<div class="lg-chips">${entities.map(entity => `
    <button type="button" class="lg-chip" data-entity="${escapeHTML(entity.name)}" title="${escapeHTML(entity.type)} · ${escapeHTML(entity.relationship)}">
      ${escapeHTML(entity.name)}
    </button>`).join('')}</div>`;
}

function renderRelated(related) {
  return `<div class="lg-sources">${related.map(item => `
    <div class="lg-source">
      <i class="fas ${typeMeta(item.type).icon}" style="color:${typeMeta(item.type).color}" aria-hidden="true"></i>
      <div class="lg-source-body">
        <div class="lg-source-title">${escapeHTML(item.title)}</div>
        <div class="lg-source-meta">${escapeHTML(item.relationship.replace(/_/g, ' '))} · ${escapeHTML(formatFullTime(item.occurred_at))}</div>
      </div>
    </div>`).join('')}</div>`;
}

function renderHistory(history) {
  return `<div class="lg-history">${history.slice(0, 8).map(entry => `
    <div class="lg-history-row">
      <span class="mono">${escapeHTML(formatFullTime(entry.at))}</span>
      <span>${escapeHTML(entry.action.replace(/_/g, ' '))}</span>
      <span class="text-muted">${escapeHTML(shortActor(entry.actor))}</span>
    </div>`).join('')}</div>`;
}

function shortActor(actor) {
  if (!actor) return '';
  if (actor.startsWith('job:') || actor === 'service_role' || actor === 'hermes') return actor;
  return 'you';
}

function formatFullTime(iso) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timeZone(),
  });
}

// ── Add ────────────────────────────────────────────────

/**
 * Quick add. Type a sentence, see what was understood before committing.
 *
 * Parsing is local and deterministic (src/ledger/nlparse.js), so the preview
 * updates as you type and adding an event never depends on a model being
 * reachable. Whatever the parser guessed is shown as a guess.
 */
function openQuickAdd() {
  openModal({
    title: 'Add an event',
    body: `
      <div class="form-group">
        <label class="form-label" for="lg-add-input">What happened?</label>
        <input type="text" class="form-input" id="lg-add-input" autocomplete="off"
               placeholder="Had lunch at Third Wave around 1pm, ₹320" />
        <div class="form-hint">Plain language. Times, amounts, places and people are picked out as you type.</div>
      </div>

      <div class="lg-preview" id="lg-add-preview">
        <span class="text-muted">Start typing and the parsed event appears here.</span>
      </div>

      <details class="lg-advanced" id="lg-add-advanced">
        <summary>Adjust the details</summary>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="lg-add-when">When</label>
            <input type="datetime-local" class="form-input" id="lg-add-when" />
          </div>
          <div class="form-group">
            <label class="form-label" for="lg-add-type">Type</label>
            <select class="form-select" id="lg-add-type">
              ${EVENT_TYPES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="lg-add-title">Title</label>
            <input type="text" class="form-input" id="lg-add-title" />
          </div>
          <div class="form-group">
            <label class="form-label" for="lg-add-amount">Amount (₹)</label>
            <input type="number" class="form-input" id="lg-add-amount" step="0.01" min="0" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label form-check">
            <input type="checkbox" id="lg-add-separate" />
            Keep this separate even if a similar event already exists
          </label>
          <div class="form-hint">By default a matching event absorbs this as extra evidence instead of being duplicated.</div>
        </div>
      </details>`,
    footer: `
      <button type="button" class="btn-cancel" data-close>Cancel</button>
      <button type="button" class="btn-submit" id="lg-add-submit">Add event</button>`,
  });

  const input = document.getElementById('lg-add-input');
  const preview = document.getElementById('lg-add-preview');
  let parsed = null;

  const update = () => {
    const value = input.value.trim();
    if (!value) {
      parsed = null;
      preview.innerHTML = `<span class="text-muted">Start typing and the parsed event appears here.</span>`;
      return;
    }

    parsed = parseQuickEntry(value, { timeZone: timeZone() });
    if (!parsed) return;

    const { event, parsed: info } = parsed;
    const type = typeMeta(event.type);
    preview.innerHTML = `
      <div class="lg-preview-row">
        <i class="fas ${type.icon}" style="color:${type.color}" aria-hidden="true"></i>
        <strong>${escapeHTML(event.title)}</strong>
      </div>
      <div class="lg-preview-meta">
        <span>${escapeHTML(type.label)}${event.subtype ? ` · ${escapeHTML(event.subtype.replace(/_/g, ' '))}` : ''}</span>
        <span class="mono">${escapeHTML(formatFullTime(event.occurred_at))}</span>
        ${info.amount ? `<span>${escapeHTML(formatINRFull(info.amount))}</span>` : ''}
        ${info.place ? `<span>${escapeHTML(info.place)}</span>` : ''}
        ${info.people?.length ? `<span>${escapeHTML(info.people.join(', '))}</span>` : ''}
        ${event.status === 'scheduled' ? `<span class="badge badge-purple">Scheduled</span>` : ''}
      </div>
      ${info.assumed.length ? `<div class="lg-preview-assumed">
        Assumed: ${escapeHTML(info.assumed.map(a => a.replace('assumed_', '')).join(', '))} — adjust below if wrong.
      </div>` : ''}`;

    // Keep the structured fields in step with the sentence, so opening the
    // details panel shows what is about to be saved rather than a blank form.
    document.getElementById('lg-add-title').value = event.title;
    document.getElementById('lg-add-type').value = event.type;
    document.getElementById('lg-add-amount').value = event.data?.amount ?? '';
    document.getElementById('lg-add-when').value = toLocalInput(event.occurred_at);
  };

  input.addEventListener('input', update);
  input.focus();

  document.getElementById('lg-add-submit').addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text && !document.getElementById('lg-add-title').value.trim()) {
      showToast('Describe what happened first.', 'error');
      return;
    }

    if (!parsed) parsed = parseQuickEntry(text || document.getElementById('lg-add-title').value, { timeZone: timeZone() });
    if (!parsed) { showToast('Could not make an event out of that.', 'error'); return; }

    const whenInput = document.getElementById('lg-add-when').value;
    const amountInput = document.getElementById('lg-add-amount').value;

    const data = { ...parsed.event.data };
    if (amountInput !== '') { data.amount = Number(amountInput); data.currency = data.currency || 'INR'; }
    else delete data.amount;

    const type = document.getElementById('lg-add-type').value || parsed.event.type;
    const occurredAt = whenInput ? new Date(whenInput).toISOString() : parsed.event.occurred_at;
    const event = {
      occurred_at: occurredAt,
      type,
      // A subtype belongs to the type the parser chose; changing the type
      // in the form makes the old subtype a lie.
      subtype: type === parsed.event.type ? parsed.event.subtype : null,
      title: document.getElementById('lg-add-title').value.trim() || parsed.event.title,
      description: text || null,
      data,
      inference: parsed.event.inference,
      // "Dinner with Rahul tomorrow" is a plan until the clock says otherwise.
      status: new Date(occurredAt).getTime() > Date.now() + 60_000 ? 'scheduled' : 'confirmed',
    };

    await mutate(
      () => api.createEvent(event, parsed.event.entities, {
        allowMerge: !document.getElementById('lg-add-separate').checked,
      }),
      'Event added.');
  });
}

/**
 * The subtypes worth offering for a type: the ones this ledger already holds,
 * then the catalogue's.
 *
 * Subtype is open text — a connector may invent one and the database stores it
 * — which is exactly why a plain box was the wrong control. Every typo made a
 * second subtype that filters and totals would never bring back together.
 */
function knownSubtypes(type) {
  const seen = events.filter(e => e.type === type && e.subtype).map(e => e.subtype);
  return [...new Set([...seen, ...(SUBTYPES[type] || [])])];
}


// ── Edit ───────────────────────────────────────────────

/**
 * Correcting an event is a first-class action, not an escape hatch: automatic
 * extraction is going to be wrong sometimes, and the ledger is only worth
 * trusting if fixing it is easy. The previous values survive in the audit log.
 */
function openEdit(event) {
  openModal({
    title: 'Edit event',
    body: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="lg-e-when">When</label>
          <input type="datetime-local" class="form-input" id="lg-e-when" value="${escapeHTML(toLocalInput(event.occurred_at))}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="lg-e-type">Type</label>
          <select class="form-select" id="lg-e-type">
            ${EVENT_TYPES.map(t => `<option value="${t.id}" ${t.id === event.type ? 'selected' : ''}>${escapeHTML(t.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="lg-e-title">Title</label>
          <input type="text" class="form-input" id="lg-e-title" value="${escapeHTML(event.title)}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="lg-e-subtype">Subtype</label>
          ${comboboxHTML({
            id: 'lg-e-subtype',
            value: event.subtype || '',
            placeholder: 'optional',
            options: knownSubtypes(event.type),
          })}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-desc">Description</label>
        <input type="text" class="form-input" id="lg-e-desc" value="${escapeHTML(event.description || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-data">Facts (JSON)</label>
        <textarea class="form-input is-code" id="lg-e-data" rows="7" spellcheck="false">${escapeHTML(JSON.stringify(event.data || {}, null, 2))}</textarea>
        <div class="form-hint">
          What the sources stated. Editing here is a correction by you and replaces the extracted value.
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-status">State</label>
        <select class="form-select" id="lg-e-status">
          ${STATUSES.filter(s => s.id !== 'dismissed').map(s =>
            `<option value="${s.id}" ${s.id === event.status ? 'selected' : ''}>${escapeHTML(s.label)}</option>`).join('')}
        </select>
      </div>`,
    footer: `
      <button type="button" class="btn-cancel" id="lg-edit-cancel">Cancel</button>
      <button type="button" class="btn-submit" id="lg-edit-save">Save changes</button>`,
  });

  wireCombobox('lg-e-subtype');

  // Cancel goes back to the detail it came from; the × closes outright.
  document.getElementById('lg-edit-cancel').addEventListener('click', () => openDetail(event.id));

  document.getElementById('lg-edit-save').addEventListener('click', async () => {
    let data;
    try {
      data = JSON.parse(document.getElementById('lg-e-data').value || '{}');
    } catch (err) {
      showToast('The facts field is not valid JSON: ' + err.message, 'error');
      return;
    }

    const whenValue = document.getElementById('lg-e-when').value;
    await mutate(() => api.updateEvent(event.id, {
      occurred_at: whenValue ? new Date(whenValue).toISOString() : undefined,
      type: document.getElementById('lg-e-type').value,
      subtype: document.getElementById('lg-e-subtype').value.trim() || null,
      title: document.getElementById('lg-e-title').value.trim(),
      description: document.getElementById('lg-e-desc').value.trim() || null,
      status: document.getElementById('lg-e-status').value,
      data,
    }, { replaceData: true }), 'Saved.');
  });
}

// ── Merge ──────────────────────────────────────────────

async function openMerge(event) {
  openModal({ title: 'Merge duplicates', body: '<div class="skeleton skeleton--strip"></div>' });

  let candidates = [];
  try {
    candidates = await api.duplicateCandidates(event.id, 8);
  } catch (err) {
    showToast(err.message, 'error');
  }

  openModal({
    title: `Merge into “${event.title}”`,
    body: `
      <p class="modal-note">
        Pick the event that describes the same real-world thing. Its sources move across and this event keeps its facts.
      </p>
      ${candidates.length ? `<div class="lg-sources">${candidates.map(candidate => `
        <div class="lg-source">
          <i class="fas ${typeMeta(candidate.type).icon}" style="color:${typeMeta(candidate.type).color}" aria-hidden="true"></i>
          <div class="lg-source-body">
            <div class="lg-source-title">${escapeHTML(candidate.title)}</div>
            <div class="lg-source-meta">
              ${escapeHTML(formatFullTime(candidate.occurred_at))} ·
              ${escapeHTML(String(candidate.minutes_apart))} min apart ·
              name similarity ${escapeHTML(String(candidate.similarity))}
            </div>
          </div>
          <button type="button" class="btn-sm btn-accent lg-merge-pick" data-id="${escapeHTML(candidate.id)}">Merge</button>
        </div>`).join('')}</div>`
      : `<p class="modal-note">Nothing similar found nearby in time.</p>`}`,
    footer: `<button type="button" class="btn-cancel" id="lg-merge-cancel">Close</button>`,
  });

  // Close goes back to the detail it came from; the × closes outright.
  document.getElementById('lg-merge-cancel').addEventListener('click', () => openDetail(event.id));

  document.querySelectorAll('.lg-merge-pick').forEach(button => {
    button.addEventListener('click', async () => {
      await mutate(() => api.mergeEvents(event.id, button.dataset.id), 'Merged.');
    });
  });
}

// ── Export ─────────────────────────────────────────────

function exportLedger() {
  openModal({
    title: 'Export',
    body: `
      <p class="modal-note">
        Your ledger, in formats nothing else has to be running to read.
      </p>
      <div class="modal-stack">
        <button type="button" class="btn-primary" id="lg-x-csv">
          <i class="fas fa-file-csv"></i> Events on screen, as CSV
        </button>
        <button type="button" class="btn-primary" id="lg-x-json">
          <i class="fas fa-file-code"></i> Everything, as JSON — events, sources, entities, summaries
        </button>
      </div>`,
    footer: `<button type="button" class="btn-cancel" data-close>Close</button>`,
  });

  document.getElementById('lg-x-csv').addEventListener('click', () => {
    downloadCSV(
      ['Occurred at', 'Type', 'Subtype', 'Title', 'Amount', 'Currency', 'Where', 'Status', 'Confidence', 'Source', 'Sources', 'Event ID'],
      events.map(event => [
        event.occurred_at, event.type, event.subtype || '', event.title,
        event.data?.amount ?? '', event.data?.currency ?? '',
        event.data?.restaurant || event.data?.merchant || event.data?.place || '',
        event.status, event.confidence ?? '', event.source_type, event.source_count, event.id,
      ]),
      `ledger-${todayISO()}.csv`);
    closeModal();
  });

  document.getElementById('lg-x-json').addEventListener('click', async () => {
    try {
      const payload = await api.exportLedger(null, null);
      downloadBlob(JSON.stringify(payload, null, 2), 'application/json', `ledger-export-${todayISO()}.json`);
      closeModal();
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  });
}
