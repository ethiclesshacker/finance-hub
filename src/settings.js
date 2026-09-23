import { supabase, getCurrentUserId } from './supabase.js';
import { SETTINGS_SCHEMA, SETTING_GROUPS, SETTING_GROUP_NAMES } from './settings-schema.js';

// The catalogue lives in settings-schema.js so that code outside a browser can
// read it too. Re-exported here so every existing import keeps working.
export { SETTINGS_SCHEMA, SETTING_GROUPS, SETTING_GROUP_NAMES };

/** Defaults for every key, used before load and for any row the user has never saved. */
function defaults() {
  return Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => [key, spec.default])
  );
}

let cache = defaults();

/**
 * Coerce a stored value to its declared type. jsonb round-trips types properly,
 * but a hand-edited row (or a schema change that retypes a key) shouldn't be
 * able to poison the whole app with a string where a number belongs.
 */
function coerce(key, raw) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) return undefined; // unknown key — the schema is the allow-list

  if (spec.type === 'number') {
    const n = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isFinite(n)) return spec.default;
    if (spec.min !== undefined && n < spec.min) return spec.min;
    if (spec.max !== undefined && n > spec.max) return spec.max;
    return n;
  }
  if (spec.type === 'enum') {
    return spec.options.some(o => o.value === raw) ? raw : spec.default;
  }
  if (spec.type === 'boolean') return Boolean(raw);
  return raw == null ? spec.default : String(raw);
}

/** Fetch this user's settings and merge them over the defaults. */
export async function loadSettings() {
  const next = defaults();

  const { data, error } = await supabase.from('user_settings').select('key, value');

  if (error) {
    // A missing table (before the migration is run) or a network blip must not
    // take the app down — defaults are always a usable answer.
    console.warn('[settings] falling back to defaults:', error.message);
    cache = next;
    return { settings: cache, error };
  }

  for (const row of data || []) {
    const value = coerce(row.key, row.value);
    if (value !== undefined) next[row.key] = value;
  }

  cache = next;
  return { settings: cache, error: null };
}

/** Synchronous read. Returns the default until loadSettings() has resolved. */
export function get(key) {
  return cache[key];
}

/** The whole settings object (a copy — mutating it does nothing). */
export function all() {
  return { ...cache };
}

/** Persist a patch of {key: value}. Only keys in the schema are written. */
export async function saveSettings(patch) {
  const userId = await getCurrentUserId();
  if (!userId) return { error: new Error('Not signed in.') };

  const rows = Object.entries(patch)
    .filter(([key]) => key in SETTINGS_SCHEMA)
    .map(([key, value]) => ({ user_id: userId, key, value: coerce(key, value) }));

  if (!rows.length) return { error: null };

  const { error } = await supabase
    .from('user_settings')
    .upsert(rows, { onConflict: 'user_id,key' });

  if (!error) {
    for (const row of rows) cache[row.key] = row.value;
  }
  return { error };
}

/** Restore a single key to its schema default by deleting the stored row. */
export async function resetSetting(key) {
  const userId = await getCurrentUserId();
  if (!userId) return { error: new Error('Not signed in.') };

  const { error } = await supabase
    .from('user_settings').delete().eq('user_id', userId).eq('key', key);

  if (!error) cache[key] = SETTINGS_SCHEMA[key].default;
  return { error };
}

// ======================================================
// Derived values — computed from settings, never stored.
// Storing a derived number is how it goes stale.
//
// Each takes an optional `values` object so the Settings screen can preview
// what an unsaved draft would produce; with none given they read the cache.
// ======================================================

export function annualExpenses(values = cache) {
  return values.monthly_expenses * 12;
}

export function fiTarget(values = cache) {
  return annualExpenses(values) * values.fi_multiplier;
}

/** Monthly surplus implied by the budget, before any investment return. */
export function budgetedSurplus(values = cache) {
  return values.monthly_net_income - values.monthly_expenses;
}

/**
 * What the projections should actually contribute each month.
 *
 * An explicit `monthly_contribution` wins; 0 means "I haven't set one", so fall
 * back to what the budget implies. Budgeted surplus is a plan, not a fact — if
 * you've saved a real number, that's the better input.
 */
export function plannedContribution(values = cache) {
  const explicit = values.monthly_contribution;
  return explicit > 0 ? explicit : Math.max(0, budgetedSurplus(values));
}

/** Savings rate the budget implies, as a percentage of take-home. */
export function budgetedSavingsRate(values = cache) {
  const income = values.monthly_net_income;
  return income > 0 ? (budgetedSurplus(values) / income) * 100 : 0;
}

/** Return net of inflation, as a decimal. Fisher equation, not a subtraction. */
export function realReturnRate(values = cache) {
  const nominal = values.expected_return / 100;
  const inflation = values.inflation_rate / 100;
  return (1 + nominal) / (1 + inflation) - 1;
}
