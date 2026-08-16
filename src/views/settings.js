import * as settings from '../settings.js';
import { SETTINGS_SCHEMA, SETTING_GROUPS } from '../settings.js';
import { escapeHTML, showToast, parseNum, formatINR } from '../utils.js';

// The whole screen is generated from SETTINGS_SCHEMA. Adding a setting there
// makes it appear here — no markup to write, nothing to keep in sync.

let draft = {};

export async function renderSettings(container) {
  draft = settings.all();

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Settings</h2>
        <p>Your numbers. Everything on the other screens is derived from these.</p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button type="button" class="btn-sm btn-ghost" id="set-revert">Revert changes</button>
        <button type="button" class="btn-sm btn-accent" id="set-save">Save</button>
      </div>
    </div>

    <div class="page-body">
      <div class="settings-derived" id="set-derived"></div>

      ${SETTING_GROUPS.map(group => `
        <section class="settings-group">
          <h3 class="settings-group-title">${escapeHTML(group)}</h3>
          <div class="settings-fields">
            ${Object.entries(SETTINGS_SCHEMA)
              .filter(([, spec]) => spec.group === group)
              .map(([key, spec]) => fieldMarkup(key, spec))
              .join('')}
          </div>
        </section>
      `).join('')}

      <p class="settings-footnote">
        Stored per user in <code>user_settings</code> as key/value pairs, so a new setting
        never needs a database migration. Anything left untouched falls back to its default.
      </p>
    </div>
  `;

  Object.keys(SETTINGS_SCHEMA).forEach(key => {
    const input = document.getElementById(`set-${key}`);
    input?.addEventListener('input', () => {
      const spec = SETTINGS_SCHEMA[key];
      draft[key] = spec.type === 'number' ? parseNum(input.value) : input.value;
      renderDerived();
    });

    document.getElementById(`reset-${key}`)?.addEventListener('click', () => resetOne(key));
  });

  document.getElementById('set-save')?.addEventListener('click', save);
  document.getElementById('set-revert')?.addEventListener('click', async () => {
    await renderSettings(container);
    showToast('Reverted to saved values.');
  });

  renderDerived();
}

function fieldMarkup(key, spec) {
  const value = draft[key];
  const isDefault = value === spec.default;

  const control = spec.type === 'enum'
    ? `<select class="form-select" id="set-${key}">
         ${spec.options.map(o => `
           <option value="${escapeHTML(o.value)}" ${o.value === value ? 'selected' : ''}>
             ${escapeHTML(o.label)}
           </option>`).join('')}
       </select>`
    : `<input
         type="${spec.type === 'number' ? 'number' : 'text'}"
         class="form-input"
         id="set-${key}"
         value="${escapeHTML(value)}"
         ${spec.min !== undefined ? `min="${spec.min}"` : ''}
         ${spec.max !== undefined ? `max="${spec.max}"` : ''}
         ${spec.step !== undefined ? `step="${spec.step}"` : ''}
       />`;

  return `
    <div class="form-group settings-field">
      <div class="settings-field-head">
        <label class="form-label" for="set-${key}">${escapeHTML(spec.label)}</label>
        ${isDefault ? '' : `<button type="button" class="settings-reset" id="reset-${key}">Reset to default</button>`}
      </div>
      ${control}
      ${spec.hint ? `<div class="form-hint">${escapeHTML(spec.hint)}</div>` : ''}
    </div>
  `;
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
    { label: 'Annual expenses',  value: formatINR(annual) },
    { label: 'FI target',        value: formatINR(target) },
    { label: 'Monthly surplus',  value: formatINR(surplus), warn: surplus < 0 },
    { label: 'Budgeted savings rate', value: rate.toFixed(1) + '%', warn: rate < 0 },
    { label: 'Real return',      value: realRet.toFixed(2) + '%', warn: realRet <= 0 },
  ];

  el.innerHTML = `
    <div class="settings-derived-inner">
      <div class="settings-derived-title">Derived from these settings</div>
      <div class="settings-derived-row">
        ${items.map(i => `
          <div class="settings-derived-item">
            <div class="sdi-label">${escapeHTML(i.label)}</div>
            <div class="sdi-value mono" style="${i.warn ? 'color:var(--danger)' : ''}">${escapeHTML(i.value)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function resetOne(key) {
  const { error } = await settings.resetSetting(key);
  if (error) { showToast('Reset failed: ' + error.message, 'error'); return; }

  draft[key] = SETTINGS_SCHEMA[key].default;
  const input = document.getElementById(`set-${key}`);
  if (input) input.value = draft[key];
  document.getElementById(`reset-${key}`)?.remove();
  renderDerived();
  showToast(`${SETTINGS_SCHEMA[key].label} reset to default.`);
}

async function save() {
  const btn = document.getElementById('set-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // Only send what actually changed, so untouched keys keep falling back to
  // their defaults instead of being pinned to a copy of the default.
  const patch = Object.fromEntries(
    Object.entries(draft).filter(([key, value]) => value !== settings.get(key))
  );

  if (!Object.keys(patch).length) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    showToast('Nothing to save.');
    return;
  }

  const { error } = await settings.saveSettings(patch);

  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }

  if (error) { showToast('Save failed: ' + error.message, 'error'); return; }
  showToast('Settings saved.');
}
