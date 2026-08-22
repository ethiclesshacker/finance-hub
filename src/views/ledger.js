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
import { EVENT_TYPES, STATUSES, SOURCE_TYPES, typeMeta, statusMeta, sourceMeta } from '../ledger/taxonomy.js';
import { parseQuickEntry } from '../ledger/nlparse.js';
import { localDateISO } from '../ledger/normalize.js';
import { isInflow } from '../ledger/summary.js';
import * as settings from '../settings.js';
import {
  escapeHTML, formatINRFull, openModal, closeModal, showToast, todayISO, downloadCSV,
} from '../utils.js';

let events = [];
let total = 0;
let activeTab = 'timeline';       // timeline | review
let filters = { query: '', types: [], statuses: [], sourceTypes: [], from: null, to: null };
let searchDebounce = null;

const timeZone = () => settings.get('ledger_timezone') || 'Asia/Kolkata';

export async function renderLedger(container) {
  activeTab = 'timeline';
  filters = { query: '', types: [], statuses: [], sourceTypes: [], from: null, to: null };

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Life</h2>
        <p>A structured record of what happened — mostly filled in by itself</p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        <span id="lg-ingest-badge" class="badge badge-gray" title="Last ingestion run">
          <i class="fas fa-circle-notch fa-spin" style="font-size:0.6rem"></i> Checking…
        </span>
        <button type="button" class="btn-sm btn-ghost" id="lg-export-btn">
          <i class="fas fa-download"></i> Export
        </button>
      </div>
    </div>

    <div class="page-body">
      <div class="kpi-grid kpi-grid--3col" id="lg-kpi-grid">
        ${Array(4).fill(0).map(() => `
          <div class="kpi-card"><div class="skeleton" style="height:90px;border-radius:var(--radius-md)"></div></div>
        `).join('')}
      </div>

      <div class="table-section">
        <div class="table-toolbar">
          <div class="table-tabs">
            <button type="button" class="table-tab active" id="lg-tab-timeline">
              <i class="fas fa-stream" style="margin-right:0.3rem"></i>Timeline
            </button>
            <button type="button" class="table-tab" id="lg-tab-review">
              <i class="fas fa-circle-question" style="margin-right:0.3rem"></i>Review
              <span class="kpi-badge neutral" id="lg-review-count" style="margin-left:0.35rem">0</span>
            </button>
          </div>
          <div class="table-actions" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
            <select class="form-select lg-filter" id="lg-filter-type" style="width:auto;min-width:8.5rem">
              <option value="">All types</option>
              ${EVENT_TYPES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
            </select>
            <select class="form-select lg-filter" id="lg-filter-source" style="width:auto;min-width:8.5rem">
              <option value="">All sources</option>
              ${SOURCE_TYPES.map(s => `<option value="${s.id}">${escapeHTML(s.label)}</option>`).join('')}
            </select>
            <select class="form-select lg-filter" id="lg-filter-status" style="width:auto;min-width:8.5rem">
              <option value="">All states</option>
              ${STATUSES.map(s => `<option value="${s.id}">${escapeHTML(s.label)}</option>`).join('')}
            </select>
            <input type="date" class="form-input lg-filter" id="lg-filter-from" style="width:auto" title="From" />
            <input type="date" class="form-input lg-filter" id="lg-filter-to" style="width:auto" title="To" />
            <div class="search-input-wrap">
              <i class="fas fa-search"></i>
              <input type="text" class="search-input" id="lg-search" placeholder="Search the ledger…" />
            </div>
            <button type="button" class="btn-icon" id="lg-refresh-btn" title="Refresh" aria-label="Refresh">
              <i class="fas fa-rotate-right"></i>
            </button>
          </div>
        </div>
        <div class="table-inner">
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

  document.querySelectorAll('.lg-filter').forEach(el => el.addEventListener('change', () => {
    filters.types       = pick('lg-filter-type');
    filters.sourceTypes = pick('lg-filter-source');
    filters.statuses    = pick('lg-filter-status');
    filters.from = dayBoundary('lg-filter-from', false);
    filters.to   = dayBoundary('lg-filter-to', true);
    loadData();
  }));

  await loadData();
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
  const container = document.getElementById('lg-timeline');
  if (container) container.innerHTML = `<div class="skeleton" style="height:220px;border-radius:var(--radius-md)"></div>`;

  try {
    const [result, review, runs] = await Promise.all([
      activeTab === 'review' ? api.reviewQueue(100) : api.searchEvents({ ...filters, limit: 200 }),
      api.reviewQueue(100),
      api.recentRuns(3).catch(() => []),
    ]);

    events = result?.events || [];
    total = result?.total ?? events.length;

    const reviewCount = review?.total ?? 0;
    const badge = document.getElementById('lg-review-count');
    if (badge) badge.textContent = reviewCount;

    renderKPIs(reviewCount);
    renderIngestBadge(runs);
    renderTimeline();
  } catch (err) {
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-triangle-exclamation" style="font-size:1.5rem;color:var(--warning)"></i>
          <p style="margin-top:0.75rem">Could not load the ledger.</p>
          <p class="text-muted" style="font-size:0.85rem">${escapeHTML(err.message)}</p>
          <p class="text-muted" style="font-size:0.8rem;margin-top:0.5rem">
            If this says a function is missing, the ledger migrations
            (<code>0003_event_ledger.sql</code>, <code>0004_ledger_api.sql</code>) have not been run yet.
          </p>
        </div>`;
    }
  }
}

function renderIngestBadge(runs) {
  const badge = document.getElementById('lg-ingest-badge');
  if (!badge) return;

  const last = runs?.[0];
  if (!last) {
    badge.className = 'badge badge-gray';
    badge.innerHTML = `<i class="fas fa-plug" style="font-size:0.6rem"></i> No ingestion yet`;
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
  badge.innerHTML = `<i class="fas fa-envelope" style="font-size:0.6rem"></i> ${escapeHTML(last.source_type)} · ${ago}`;
  badge.title = `${last.status} — ${last.items_seen} seen, ${last.events_created} created, ${last.events_updated} updated`;
}

function renderKPIs(reviewCount) {
  const grid = document.getElementById('lg-kpi-grid');
  if (!grid) return;

  const today = localDateISO(new Date(), timeZone());
  const todayCount = events.filter(e => localDateISO(e.occurred_at, timeZone()) === today).length;

  // Refunds and credits carry an amount but are not spending.
  const spend = events.reduce((sum, e) => {
    const amount = Number(e.data?.amount);
    return sum + (Number.isFinite(amount) && !isInflow(e) ? amount : 0);
  }, 0);

  const auto = events.filter(e => e.source_type !== 'manual' && e.source_type !== 'hermes').length;
  const autoPct = events.length ? Math.round((auto / events.length) * 100) : 0;

  const cards = [
    { label: 'Events shown', icon: '🗓️', glow: 'var(--accent-glow)', bg: 'rgba(56,189,248,0.1)',
      value: String(events.length), sub: total > events.length ? `of ${total} matching` : 'all matching events' },
    { label: 'Today', icon: '📍', glow: 'var(--teal-glow)', bg: 'rgba(45,212,191,0.1)',
      value: String(todayCount), sub: todayCount ? 'recorded so far' : 'nothing recorded yet' },
    { label: 'Spend in view', icon: '💸', glow: 'var(--purple-glow)', bg: 'rgba(167,139,250,0.1)',
      value: formatINRFull(spend), sub: 'sum of amounts on these events' },
    { label: 'Needs review', icon: '❓', glow: reviewCount ? 'var(--warning-glow)' : 'var(--success-glow)',
      bg: reviewCount ? 'rgba(245,158,11,0.1)' : 'rgba(16,185,129,0.1)',
      value: String(reviewCount), sub: `${autoPct}% of shown events arrived automatically` },
  ];

  grid.innerHTML = cards.map(card => `
    <div class="kpi-card" style="--kpi-glow:${card.glow}">
      <div class="kpi-header">
        <span class="kpi-label">${escapeHTML(card.label)}</span>
        <div class="kpi-icon" style="background:${card.bg}">${card.icon}</div>
      </div>
      <div class="kpi-value mono">${escapeHTML(card.value)}</div>
      <div class="kpi-sub">${escapeHTML(card.sub)}</div>
    </div>
  `).join('');
}

// ── Timeline ───────────────────────────────────────────

function renderTimeline() {
  const container = document.getElementById('lg-timeline');
  if (!container) return;

  if (!events.length) {
    container.innerHTML = emptyState();
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
    const dayTotal = list.reduce((sum, e) =>
      sum + (isInflow(e) ? 0 : (Number(e.data?.amount) || 0)), 0);
    return `
      <div class="tl-day">
        <div class="tl-day-head">
          <span class="tl-day-label">${escapeHTML(heading)}</span>
          <span class="tl-day-meta">
            ${list.length} event${list.length === 1 ? '' : 's'}${dayTotal ? ` · ${escapeHTML(formatINRFull(dayTotal))}` : ''}
          </span>
        </div>
        ${list.map(renderRow).join('')}
      </div>`;
  }).join('')}</div>`;

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

  // The metadata worth showing inline differs by type — an amount for a
  // purchase, a route for a flight, who was there for a meeting.
  const bits = [];
  if (Number.isFinite(amount)) bits.push(formatINRFull(amount));
  if (event.data?.origin && event.data?.destination) bits.push(`${event.data.origin} → ${event.data.destination}`);
  const where = event.data?.restaurant || event.data?.merchant || event.data?.place;
  if (where && !event.title.includes(where)) bits.push(where);
  const people = (event.entities || []).filter(e => e.type === 'person').map(e => e.name);
  if (people.length) bits.push(people.slice(0, 3).join(', '));

  const needsAttention = event.status === 'needs_review' || event.status === 'inferred';

  return `
    <div class="tl-item ${needsAttention ? 'tl-item--review' : ''}" data-id="${escapeHTML(event.id)}"
         role="button" tabindex="0" aria-label="${escapeHTML(event.title)}">
      <div class="tl-time mono">${escapeHTML(formatTime(event.occurred_at))}</div>
      <div class="tl-icon" style="color:${type.color};background:${type.color}1a">
        <i class="fas ${type.icon}" aria-hidden="true"></i>
      </div>
      <div class="tl-body">
        <div class="tl-title">${escapeHTML(event.title)}</div>
        <div class="tl-meta">
          <span class="tl-type" style="color:${type.color}">${escapeHTML(type.label)}${event.subtype ? ` · ${escapeHTML(event.subtype.replace(/_/g, ' '))}` : ''}</span>
          ${bits.map(b => `<span>${escapeHTML(b)}</span>`).join('')}
        </div>
      </div>
      <div class="tl-tags">
        ${needsAttention ? `<span class="badge ${status.badge}" title="${escapeHTML(status.hint)}">${escapeHTML(status.label)}</span>` : ''}
        ${event.status === 'scheduled' ? `<span class="badge badge-purple" title="${escapeHTML(status.hint)}">Scheduled</span>` : ''}
        <span class="tl-source" title="From ${escapeHTML(source.label)}${event.source_count > 1 ? ` · ${event.source_count} sources agree` : ''}">
          <i class="fas ${source.icon}" aria-hidden="true"></i>${event.source_count > 1 ? `<sup>${event.source_count}</sup>` : ''}
        </span>
      </div>
    </div>`;
}

function emptyState() {
  const filtered = filters.query || filters.types.length || filters.statuses.length
                || filters.sourceTypes.length || filters.from || filters.to;

  if (activeTab === 'review') {
    return `
      <div class="empty-state">
        <i class="fas fa-circle-check" style="font-size:1.5rem;color:var(--success)"></i>
        <p style="margin-top:0.75rem">Nothing waiting for review.</p>
        <p class="text-muted" style="font-size:0.85rem">Uncertain extractions land here to be confirmed, corrected, merged or dismissed.</p>
      </div>`;
  }

  if (filtered) {
    return `
      <div class="empty-state">
        <i class="fas fa-filter-circle-xmark" style="font-size:1.5rem;color:var(--text-muted)"></i>
        <p style="margin-top:0.75rem">No events match those filters.</p>
      </div>`;
  }

  return `
    <div class="empty-state">
      <i class="fas fa-stream" style="font-size:1.5rem;color:var(--accent)"></i>
      <p style="margin-top:0.75rem">The ledger is empty.</p>
      <p class="text-muted" style="font-size:0.85rem;max-width:34rem;margin:0.5rem auto 0">
        It is meant to fill itself. Connect a mailbox in <code>ledger/accounts.json</code> and run
        <code>npm run ledger:ingest</code> — or add something by hand with the + button.
      </p>
    </div>`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timeZone(),
  });
}

function formatDayHeading(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

// ── Detail ─────────────────────────────────────────────

async function openDetail(eventId) {
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Event</div>
      <button class="modal-close" id="lg-detail-close"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-body"><div class="skeleton" style="height:260px;border-radius:var(--radius-md)"></div></div>
  `);
  document.getElementById('lg-detail-close').addEventListener('click', closeModal);

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

  openModal(`
    <div class="modal-header">
      <div class="modal-title">
        <i class="fas ${type.icon}" style="color:${type.color};margin-right:0.5rem" aria-hidden="true"></i>
        ${escapeHTML(event.title)}
      </div>
      <button class="modal-close" id="lg-detail-close"><i class="fas fa-times"></i></button>
    </div>

    <div class="modal-body">
      <div class="lg-detail-head">
        <div>
          <div class="lg-detail-when mono">${escapeHTML(formatFullTime(event.occurred_at))}${
            event.occurred_at_end ? ` → ${escapeHTML(formatTime(event.occurred_at_end))}` : ''}</div>
          <div class="text-muted" style="font-size:0.82rem">
            ${escapeHTML(type.label)}${event.subtype ? ` · ${escapeHTML(event.subtype.replace(/_/g, ' '))}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
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
      ${event.history?.length ? section('History', renderHistory(event.history), 'Corrections are kept, not silently applied.') : ''}
    </div>

    <div class="modal-footer" style="flex-wrap:wrap;gap:0.4rem">
      ${needsAttention ? `<button class="btn-sm btn-accent" id="lg-confirm-btn"><i class="fas fa-check"></i> Confirm</button>` : ''}
      <button class="btn-sm btn-ghost" id="lg-merge-btn"><i class="fas fa-code-merge"></i> Merge</button>
      <button class="btn-sm btn-ghost" id="lg-edit-btn"><i class="fas fa-pencil"></i> Edit</button>
      <button class="btn-sm btn-ghost" id="lg-dismiss-btn"><i class="fas fa-ban"></i> Dismiss</button>
      <button class="btn-sm btn-danger" id="lg-delete-btn"><i class="fas fa-trash"></i> Delete</button>
      <button class="btn-cancel" id="lg-detail-cancel">Close</button>
    </div>
  `);

  document.getElementById('lg-detail-close').addEventListener('click', closeModal);
  document.getElementById('lg-detail-cancel').addEventListener('click', closeModal);

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
    await loadData();
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
  return `<div class="lg-fields">${entries.map(([key, value]) => `
    <div class="lg-field">
      <span class="lg-field-key">${escapeHTML(key.replace(/_/g, ' '))}</span>
      <span class="lg-field-value mono">${escapeHTML(formatValue(key, value))}</span>
    </div>`).join('')}</div>`;
}

function formatValue(key, value) {
  if (key === 'amount' && Number.isFinite(Number(value))) return formatINRFull(Number(value));
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'object' && v !== null ? (v.name || JSON.stringify(v)) : String(v))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderSources(sources) {
  if (!sources?.length) return `<p class="text-muted" style="font-size:0.85rem">No source recorded — this event was created directly.</p>`;
  return `<div class="lg-sources">${sources.map(source => {
    const meta = sourceMeta(source.source_type);
    const subject = source.metadata?.subject;
    return `
      <div class="lg-source">
        <i class="fas ${meta.icon}" style="color:var(--accent)" aria-hidden="true"></i>
        <div style="flex:1;min-width:0">
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
      <div style="flex:1;min-width:0">
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
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Add an event</div>
      <button class="modal-close" id="lg-add-close"><i class="fas fa-times"></i></button>
    </div>

    <div class="modal-body">
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
          <label class="form-label">
            <input type="checkbox" id="lg-add-separate" style="margin-right:0.4rem" />
            Keep this separate even if a similar event already exists
          </label>
          <div class="form-hint">By default a matching event absorbs this as extra evidence instead of being duplicated.</div>
        </div>
      </details>
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" id="lg-add-cancel">Cancel</button>
      <button class="btn-submit" id="lg-add-submit">Add event</button>
    </div>
  `);

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

  document.getElementById('lg-add-close').addEventListener('click', closeModal);
  document.getElementById('lg-add-cancel').addEventListener('click', closeModal);

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

    const event = {
      occurred_at: whenInput ? new Date(whenInput).toISOString() : parsed.event.occurred_at,
      type: document.getElementById('lg-add-type').value || parsed.event.type,
      subtype: parsed.event.subtype,
      title: document.getElementById('lg-add-title').value.trim() || parsed.event.title,
      description: text || null,
      data,
      inference: parsed.event.inference,
      status: 'confirmed',
    };

    await mutate(
      () => api.createEvent(event, parsed.event.entities, {
        allowMerge: !document.getElementById('lg-add-separate').checked,
      }),
      'Event added.');
  });
}

function toLocalInput(iso) {
  const date = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── Edit ───────────────────────────────────────────────

/**
 * Correcting an event is a first-class action, not an escape hatch: automatic
 * extraction is going to be wrong sometimes, and the ledger is only worth
 * trusting if fixing it is easy. The previous values survive in the audit log.
 */
function openEdit(event) {
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Edit event</div>
      <button class="modal-close" id="lg-edit-close"><i class="fas fa-times"></i></button>
    </div>

    <div class="modal-body">
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
          <input type="text" class="form-input" id="lg-e-subtype" value="${escapeHTML(event.subtype || '')}" placeholder="optional" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-desc">Description</label>
        <input type="text" class="form-input" id="lg-e-desc" value="${escapeHTML(event.description || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-data">Facts (JSON)</label>
        <textarea class="form-input" id="lg-e-data" rows="7" spellcheck="false"
                  style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.8rem">${escapeHTML(JSON.stringify(event.data || {}, null, 2))}</textarea>
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
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" id="lg-edit-cancel">Cancel</button>
      <button class="btn-submit" id="lg-edit-save">Save changes</button>
    </div>
  `);

  document.getElementById('lg-edit-close').addEventListener('click', closeModal);
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
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Merge duplicates</div>
      <button class="modal-close" id="lg-merge-close"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-body"><div class="skeleton" style="height:180px;border-radius:var(--radius-md)"></div></div>
  `);
  document.getElementById('lg-merge-close').addEventListener('click', closeModal);

  let candidates = [];
  try {
    candidates = await api.duplicateCandidates(event.id, 8);
  } catch (err) {
    showToast(err.message, 'error');
  }

  openModal(`
    <div class="modal-header">
      <div class="modal-title">Merge into “${escapeHTML(event.title)}”</div>
      <button class="modal-close" id="lg-merge-close"><i class="fas fa-times"></i></button>
    </div>

    <div class="modal-body">
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:0.75rem">
        Pick the event that describes the same real-world thing. Its sources move across and this event keeps its facts.
      </p>
      ${candidates.length ? `<div class="lg-sources">${candidates.map(candidate => `
        <div class="lg-source">
          <i class="fas ${typeMeta(candidate.type).icon}" style="color:${typeMeta(candidate.type).color}" aria-hidden="true"></i>
          <div style="flex:1;min-width:0">
            <div class="lg-source-title">${escapeHTML(candidate.title)}</div>
            <div class="lg-source-meta">
              ${escapeHTML(formatFullTime(candidate.occurred_at))} ·
              ${escapeHTML(String(candidate.minutes_apart))} min apart ·
              name similarity ${escapeHTML(String(candidate.similarity))}
            </div>
          </div>
          <button class="btn-sm btn-accent lg-merge-pick" data-id="${escapeHTML(candidate.id)}">Merge</button>
        </div>`).join('')}</div>`
      : `<p class="text-muted">Nothing similar found nearby in time.</p>`}
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" id="lg-merge-cancel">Close</button>
    </div>
  `);

  document.getElementById('lg-merge-close').addEventListener('click', closeModal);
  document.getElementById('lg-merge-cancel').addEventListener('click', () => openDetail(event.id));

  document.querySelectorAll('.lg-merge-pick').forEach(button => {
    button.addEventListener('click', async () => {
      await mutate(() => api.mergeEvents(event.id, button.dataset.id), 'Merged.');
    });
  });
}

// ── Export ─────────────────────────────────────────────

function exportLedger() {
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Export</div>
      <button class="modal-close" id="lg-x-close"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-body">
      <p class="text-muted" style="font-size:0.87rem">
        Your ledger, in formats nothing else has to be running to read.
      </p>
      <div style="display:flex;flex-direction:column;gap:0.6rem;margin-top:0.9rem">
        <button class="btn-primary" id="lg-x-csv">
          <i class="fas fa-file-csv"></i> Events on screen, as CSV
        </button>
        <button class="btn-primary" id="lg-x-json">
          <i class="fas fa-file-code"></i> Everything, as JSON — events, sources, entities, summaries
        </button>
      </div>
    </div>
    <div class="modal-footer"><button class="btn-cancel" id="lg-x-cancel">Close</button></div>
  `);

  document.getElementById('lg-x-close').addEventListener('click', closeModal);
  document.getElementById('lg-x-cancel').addEventListener('click', closeModal);

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
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ledger-export-${todayISO()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      closeModal();
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  });
}
