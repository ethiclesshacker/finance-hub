import * as settings from '../settings.js';
import { SETTINGS_SCHEMA, SETTING_GROUPS } from '../settings.js';
import { escapeHTML, showToast, parseNum, formatINR } from '../utils.js';

// ======================================================
// Settings.
//
// The whole screen is still generated from SETTINGS_SCHEMA — adding a setting
// there makes it appear here, with no markup to write. What changed is the
// shape around it:
//
//   · Save used to live in the page header, twenty-four fields above the one
//     being edited. It is a bar at the foot of the screen now, and it only
//     appears once something has actually changed — so it doubles as the
//     answer to "did that take?".
//   · Nothing said which fields were edited. Changed fields are marked, and
//     the bar counts them.
//   · The derived figures — FI target, surplus, real return — scrolled away
//     from the fields that produce them. They stay in view while you type.
//   · The ledger's eleven matching thresholds carried the same weight as
//     monthly income. That group is collapsed until asked for.
// ======================================================

let draft = {};
let saved = {};

export async function renderSettings(container) {
  draft = settings.all();
  saved = settings.all();

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Settings</h2>
        <p>Your numbers. Everything on the other screens is derived from these.</p>
      </div>
    </div>

    <div class="page-body set-body">
      <div class="set-layout">
        <div class="set-groups">
          ${SETTING_GROUPS.map(groupMarkup).join('')}

          <p class="settings-footnote">
            Stored per user in <code>user_settings</code> as key/value pairs, so a new
            setting never needs a database migration. Anything left untouched falls
            back to its default.
          </p>
        </div>

        <aside class="set-aside" aria-label="Derived figures">
          <div class="set-derived" id="set-derived"></div>
        </aside>
      </div>
    </div>

    <!-- Appears only when there is something to save. -->
    <div class="set-bar" id="set-bar" hidden>
      <span class="set-bar-count" id="set-bar-count"></span>
      <div class="set-bar-actions">
        <button type="button" class="btn-sm btn-ghost" id="set-revert">Discard changes</button>
        <button type="button" class="btn-sm btn-accent" id="set-save">Save changes</button>
      </div>
    </div>
  `;

  Object.keys(SETTINGS_SCHEMA).forEach(key => {
    const input = document.getElementById(`set-${key}`);
    input?.addEventListener('input', () => {
      const spec = SETTINGS_SCHEMA[key];
      draft[key] = spec.type === 'number' ? parseNum(input.value) : input.value;
      reflectField(key);
      renderDerived();
      reflectBar();
    });

    document.getElementById(`reset-${key}`)?.addEventListener('click', () => resetOne(key));
  });

  document.getElementById('set-save')?.addEventListener('click', save);
  document.getElementById('set-revert')?.addEventListener('click', async () => {
    await renderSettings(container);
    showToast('Changes discarded.');
  });

  renderDerived();
  reflectBar();
}

// ── Markup ─────────────────────────────────────────────

function groupMarkup(group) {
  const fields = Object.entries(SETTINGS_SCHEMA)
    .filter(([, spec]) => spec.group === group.name)
    .map(([key, spec]) => fieldMarkup(key, spec))
    .join('');

  const head = `
    <div class="set-group-head">
      <span class="set-group-icon" aria-hidden="true"><i class="fas ${group.icon}"></i></span>
      <div>
        <h3 class="set-group-title">${escapeHTML(group.name)}</h3>
        <p class="set-group-blurb">${escapeHTML(group.blurb)}</p>
      </div>
    </div>`;

  // Advanced groups open on demand. Everything else is open by definition.
  return group.advanced
    ? `<details class="set-group is-advanced">
         <summary>${head}</summary>
         <div class="settings-fields">${fields}</div>
       </details>`
    : `<section class="set-group">
         ${head}
         <div class="settings-fields">${fields}</div>
       </section>`;
}

function fieldMarkup(key, spec) {
  const value = draft[key];

  const control = spec.type === 'enum'
    ? `<select class="form-select" id="set-${key}">
         ${spec.options.map(o => `
           <option value="${escapeHTML(o.value)}" ${o.value === value ? 'selected' : ''}>
             ${escapeHTML(o.label)}
           </option>`).join('')}
       </select>`
    : `<div class="set-input ${spec.prefix ? 'has-prefix' : ''} ${spec.suffix ? 'has-suffix' : ''}">
         ${spec.prefix ? `<span class="set-affix is-prefix" aria-hidden="true">${escapeHTML(spec.prefix)}</span>` : ''}
         <input
           type="${spec.type === 'number' ? 'number' : 'text'}"
           class="form-input"
           id="set-${key}"
           value="${escapeHTML(value)}"
           ${spec.min !== undefined ? `min="${spec.min}"` : ''}
           ${spec.max !== undefined ? `max="${spec.max}"` : ''}
           ${spec.step !== undefined ? `step="${spec.step}"` : ''}
           ${spec.hint ? `aria-describedby="hint-${key}"` : ''}
         />
         ${spec.suffix ? `<span class="set-affix is-suffix" aria-hidden="true">${escapeHTML(spec.suffix)}</span>` : ''}
       </div>`;

  return `
    <div class="set-field" id="field-${key}" data-key="${key}">
      <div class="set-field-head">
        <label class="set-field-label" for="set-${key}">${escapeHTML(spec.label)}</label>
        <span class="set-field-state" id="state-${key}"></span>
      </div>
      ${control}
      ${spec.hint ? `<p class="form-hint" id="hint-${key}">${escapeHTML(spec.hint)}</p>` : ''}
    </div>
  `;
}

// ── State ──────────────────────────────────────────────

/** Which keys differ from what is stored. */
function changedKeys() {
  return Object.keys(SETTINGS_SCHEMA).filter(k => draft[k] !== saved[k]);
}

/** Mark one field as edited, or offer to put it back to its default. */
function reflectField(key) {
  const field = document.getElementById(`field-${key}`);
  const state = document.getElementById(`state-${key}`);
  if (!field || !state) return;

  const isChanged = draft[key] !== saved[key];
  const isDefault = draft[key] === SETTINGS_SCHEMA[key].default;
  field.classList.toggle('is-changed', isChanged);

  if (isChanged) {
    state.innerHTML = '<span class="set-chip">Edited</span>';
  } else if (!isDefault) {
    state.innerHTML = `<button type="button" class="settings-reset" id="reset-${key}">Reset to default</button>`;
    document.getElementById(`reset-${key}`)?.addEventListener('click', () => resetOne(key));
  } else {
    state.innerHTML = '';
  }
}

/** The save bar exists only while there is something to save. */
function reflectBar() {
  const bar   = document.getElementById('set-bar');
  const count = document.getElementById('set-bar-count');
  if (!bar || !count) return;

  const n = changedKeys().length;
  bar.hidden = n === 0;
  count.textContent = n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
}

/** Live preview of the numbers that fall out of the current draft. */
function renderDerived() {
  const el = document.getElementById('set-derived');
  if (!el) return;

  const annual   = draft.monthly_expenses * 12;
  const target   = annual * draft.fi_multiplier;
  const surplus  = draft.monthly_net_income - draft.monthly_expenses;
  const rate     = draft.monthly_net_income > 0 ? (surplus / draft.monthly_net_income) * 100 : 0;
  const realRet  = ((1 + draft.expected_return / 100) / (1 + draft.inflation_rate / 100) - 1) * 100;

  const items = [
    { label: 'Annual expenses',       value: formatINR(annual),
      note: 'Monthly baseline × 12' },
    { label: 'FI target',             value: formatINR(target),
      note: `${draft.fi_multiplier}× annual expenses` },
    { label: 'Monthly surplus',       value: formatINR(surplus), warn: surplus < 0,
      note: surplus < 0 ? 'Spending more than you earn' : 'Income − expenses' },
    { label: 'Budgeted savings rate', value: rate.toFixed(1) + '%', warn: rate < 0,
      note: 'Surplus as a share of income' },
    { label: 'Real return',           value: realRet.toFixed(2) + '%', warn: realRet <= 0,
      note: realRet <= 0 ? 'Inflation is eating the return' : 'After inflation' },
  ];

  el.innerHTML = `
    <h3 class="set-derived-title">What these produce</h3>
    <dl class="set-derived-list">
      ${items.map(i => `
        <div class="set-derived-item">
          <dt>${escapeHTML(i.label)}</dt>
          <dd class="mono ${i.warn ? 'text-danger' : ''}">${escapeHTML(i.value)}</dd>
          <p class="set-derived-note">${escapeHTML(i.note)}</p>
        </div>
      `).join('')}
    </dl>
    <p class="set-derived-foot">Updates as you type. Nothing is stored until you save.</p>
  `;
}

// ── Writes ─────────────────────────────────────────────

async function resetOne(key) {
  const { error } = await settings.resetSetting(key);
  if (error) { showToast('Reset failed: ' + error.message, 'error'); return; }

  const value = SETTINGS_SCHEMA[key].default;
  draft[key] = value;
  saved[key] = value;

  const input = document.getElementById(`set-${key}`);
  if (input) input.value = value;
  reflectField(key);
  renderDerived();
  reflectBar();
  showToast(`${SETTINGS_SCHEMA[key].label} reset to its default.`);
}

async function save() {
  const btn = document.getElementById('set-save');
  const keys = changedKeys();

  if (!keys.length) { showToast('Nothing to save.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // Only what actually changed, so untouched keys keep falling back to their
  // defaults instead of being pinned to a copy of the default.
  const patch = Object.fromEntries(keys.map(k => [k, draft[k]]));
  const { error } = await settings.saveSettings(patch);

  if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
  if (error) { showToast('Save failed: ' + error.message, 'error'); return; }

  saved = settings.all();
  keys.forEach(reflectField);
  reflectBar();
  showToast(keys.length === 1 ? 'Setting saved.' : `${keys.length} settings saved.`);
}
